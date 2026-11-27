import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { StrKey, hash, type Keypair, type rpc } from '@stellar/stellar-sdk';
import {
  AgentRegistryError, VerificationRegistryError, buildResult, invoke, keypairSigner, nextResultSequence, pipelineLimits,
  readAgent, readLatestResult, verificationInvocation, verificationOperation,
  type AgentIdentity, type CheckResult, type NetworkContext, type TransactionJournal, type VerificationResult,
} from '@stellar-agent-auth/sdk';
import { assess } from '@stellar-agent-auth/verifier';
import type { Deployment } from './deployment.js';
import { FIXTURE_CHECKS, FIXTURE_LABEL, verifierContext } from './setup.js';

/**
 * What lets someone bring their own agent: an AI agent in their own terminal, with a key of its own, that the
 * wallet treats exactly as it treats the built-in one.
 *
 * An agent needs three things before a wallet will pay for it: an identity in the agent registry, a metadata
 * document at a public address whose hash the identity carries, and a current verification result from a provider
 * the owner trusts. The agent registers itself, with its own keys. This service does the two parts it cannot do
 * alone: it serves the metadata document, and it runs the verifier and publishes what it found.
 *
 * It also remembers which agents asked to work for which owner, so that the owner's page can show them. That is a
 * hint and nothing more: an agent can spend only under a policy the owner signs.
 */

const DAY = 86_400n;
/** A result is published for this long, and published again once less than `RENEW_WITHIN` of it is left. */
const VALIDITY = 30n * DAY;
const RENEW_WITHIN = 7n * DAY;
const MAX_LINKS_PER_OWNER = 8;
const MAX_OWNERS = 20_000;
export const AGENT_METADATA_SCHEMA = 'stellar-agent-auth/agent-metadata/v1';

export class AgentServiceError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface AgentServiceOptions {
  deployment: Deployment;
  server: rpc.Server;
  context: NetworkContext;
  /** Where the metadata documents, the links and the verifier's reports are kept. */
  directory: string;
  /**
   * The public origin metadata is served from, such as `https://scout.example`. The agent registry accepts only
   * `https` addresses, so on a public network agents can be set up only when this is set.
   */
  publicOrigin?: string;
  /** The provider's key. Without it this server serves metadata and cannot verify anyone. */
  provider?: Keypair;
  /** Asked before each publication; answering `false` refuses it. For a limit on how many are made. */
  allowPublish?: () => boolean;
  journal: TransactionJournal;
}

export interface LinkedAgent {
  agent_id: string;
  name: string;
  signer: string;
}

/** What a result says, as far as a caller needs it. */
const summary = (result: VerificationResult) => ({
  sequence: result.sequence.toString(), mode: result.mode, risk_score: result.risk_score,
  issued_at: result.issued_at.toString(), expires_at: result.expires_at.toString(),
  checks: result.checks.map(({ kind, outcome }) => ({ kind, outcome })),
});

export function createAgentService(options: AgentServiceOptions) {
  const { deployment, server, context, provider } = options;
  const live = deployment.provider.mode === 'Live';
  const metadataDirectory = join(options.directory, 'agents', 'metadata');
  const linksPath = join(options.directory, 'agents', 'links.json');
  const agents = { server, contractId: deployment.agent_registry, source: deployment.roles.facilitator, networkPassphrase: deployment.passphrase };
  const results = { ...agents, contractId: deployment.verification_registry };
  const missing = (error: unknown) =>
    (error instanceof AgentRegistryError || error instanceof VerificationRegistryError) && error.code === 'NotFound';

  /** Whether agents can be set up here at all, and whether this server can verify them. */
  const capabilities = () => ({ setup: !live || options.publicOrigin !== undefined, verify: provider !== undefined });

  /**
   * Where an agent's metadata is registered. On a local network nothing fetches it and the address is a
   * placeholder: the registry accepts only `https`, and a local server has none.
   */
  const uriOf = (signer: string) => (live ? `${options.publicOrigin}/agents/${signer}.json` : `https://agents.example.test/${signer}.json`);
  const pathOf = (signer: string) => join(metadataDirectory, `${signer}.json`);

  async function document(signer: string): Promise<Buffer | undefined> {
    if (!StrKey.isValidEd25519PublicKey(signer)) return undefined;
    return readFile(pathOf(signer)).catch(() => undefined);
  }

  const plain = (value: unknown, name: string, max: number, required: boolean): string | undefined => {
    if (value === undefined || value === null || value === '') {
      if (required) throw new AgentServiceError(400, `${name} is required`);
      return undefined;
    }
    // Printable text on one line: this is shown to an owner who is about to trust the agent with money.
    if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f<>]/.test(value) || value.trim() !== value) {
      throw new AgentServiceError(400, `${name} must be plain text of at most ${max} characters`);
    }
    return value;
  };

  /**
   * Write the metadata document for an agent's key, once. The bytes never change afterwards, since the agent
   * registers their hash; asking again returns the same document.
   */
  async function metadata(body: Record<string, unknown>) {
    if (!capabilities().setup) throw new AgentServiceError(503, 'This server has no public address, so agents cannot be set up through it');
    const signer = body['signer'];
    if (typeof signer !== 'string' || !StrKey.isValidEd25519PublicKey(signer)) {
      throw new AgentServiceError(400, 'Expected { signer } with the agent key\'s G... address');
    }
    const name = plain(body['name'], 'name', 64, true)!;
    const description = plain(body['description'], 'description', 300, false);
    let bytes = await document(signer);
    if (!bytes) {
      bytes = Buffer.from(`${JSON.stringify({ schema: AGENT_METADATA_SCHEMA, name, ...(description ? { description } : {}), endpoints: [] }, null, 2)}\n`);
      await mkdir(metadataDirectory, { recursive: true, mode: 0o700 });
      // `wx`: two requests for one key cannot both write.
      await writeFile(pathOf(signer), bytes, { flag: 'wx' }).catch(async () => { bytes = (await document(signer))!; });
    }
    return { metadata_uri: uriOf(signer), metadata_hash: createHash('sha256').update(bytes).digest('hex') };
  }

  async function nameOf(signer: string): Promise<string | undefined> {
    const bytes = await document(signer);
    if (!bytes) return undefined;
    try {
      return String((JSON.parse(bytes.toString('utf8')) as { name: unknown }).name);
    } catch {
      return undefined;
    }
  }

  async function identityOf(agentId: unknown): Promise<AgentIdentity> {
    if (typeof agentId !== 'string' || !/^[1-9]\d{0,18}$/.test(agentId)) throw new AgentServiceError(400, 'Expected { agent_id } as a decimal number');
    try {
      return await readAgent(agents, BigInt(agentId));
    } catch (error) {
      if (missing(error)) throw new AgentServiceError(404, 'The agent registry has no such agent');
      throw error;
    }
  }

  /** An agent this server will speak for: the deployment's own, or one whose metadata it serves. */
  async function known(identity: AgentIdentity) {
    if (identity.agent_id.toString() === deployment.agent.agent_id) return true;
    return identity.metadata_uri === uriOf(identity.signer) && (await document(identity.signer)) !== undefined;
  }

  // The provider is one account: its publications are made one at a time.
  let queue: Promise<unknown> = Promise.resolve();

  /**
   * Make sure the agent has a current result, assessing it if it has none or its result is about to expire. On a
   * public network this is the real verifier: it fetches the registered metadata, checks its hash and schema and the
   * signer's account, and publishes what it found, pass or fail. On a local network it publishes labelled fixture
   * data, as the setup does.
   */
  function verify(agentId: unknown) {
    const work = async () => {
      const identity = await identityOf(agentId);
      if (!(await known(identity))) throw new AgentServiceError(403, 'This server verifies only agents whose metadata it serves');
      const key = { agent_id: identity.agent_id, revision: identity.revision, provider: deployment.provider.address };
      const now = BigInt((await server.getLatestLedger()).closeTime);
      const latest = await readLatestResult(results, key).catch((error: unknown) => {
        if (missing(error)) return undefined;
        throw error;
      });
      if (latest && !latest.revoked && latest.expires_at - now > RENEW_WITHIN) return { status: 'current' as const, result: summary(latest) };
      if (!provider) throw new AgentServiceError(503, 'This server does not hold a provider key, so it cannot verify agents');
      if (options.allowPublish && !options.allowPublish()) {
        throw new AgentServiceError(429, 'This server has published all the verifications it publishes in a day; try again tomorrow');
      }
      if (live) {
        const outcome = await assess(verifierContext(deployment, server, join(options.directory, 'verifier')), {
          agentId: identity.agent_id, publisher: provider, validitySeconds: VALIDITY,
        });
        return { status: 'published' as const, result: summary(outcome.assessment.result) };
      }
      // A self-made agent declares no endpoints, so there is nothing for that check to look at.
      const own = identity.agent_id.toString() !== deployment.agent.agent_id;
      const checks: CheckResult[] = FIXTURE_CHECKS.map((check) =>
        (own && check.kind === 'Endpoint' ? { kind: 'Endpoint', outcome: 'NotApplicable', score: null } : check));
      const result = buildResult({
        ...key, sequence: await nextResultSequence(results, key), mode: 'Fixture', checks, serious_wallet_risks: 0,
        evidence_hash: Uint8Array.from(hash(Buffer.from(`${FIXTURE_LABEL}: passing`))), issued_at: now, expires_at: now + VALIDITY,
      });
      const signer = keypairSigner(provider);
      const published = await invoke(context, signer, verificationInvocation(context, deployment.verification_registry, 'publish',
        { result }, signer, verificationOperation(deployment.verification_registry, 'publish', { result })), options.journal,
      { limits: pipelineLimits({ maxFee: 50_000_000n }) });
      if (published.status !== 'success') throw new Error(`The result was not published: ${published.status}`);
      return { status: 'published' as const, result: summary(result) };
    };
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  }

  // ---- Which agents asked to work for which owner ----

  let links: Record<string, string[]> | undefined;
  async function loadLinks() {
    if (!links) {
      try {
        const stored: unknown = JSON.parse(await readFile(linksPath, 'utf8'));
        links = typeof stored === 'object' && stored !== null && !Array.isArray(stored) ? stored as Record<string, string[]> : {};
      } catch {
        links = {};
      }
    }
    return links;
  }

  async function link(body: Record<string, unknown>) {
    const owner = body['owner'];
    if (typeof owner !== 'string' || !StrKey.isValidEd25519PublicKey(owner)) throw new AgentServiceError(400, 'Expected { owner } with a G... account address');
    const identity = await identityOf(body['agent_id']);
    if (!(await known(identity)) || identity.agent_id.toString() === deployment.agent.agent_id) {
      throw new AgentServiceError(403, 'Only an agent set up through this server can be linked');
    }
    const all = await loadLinks();
    const id = identity.agent_id.toString();
    const mine = all[owner] ?? [];
    if (!mine.includes(id)) {
      if (!all[owner] && Object.keys(all).length >= MAX_OWNERS) throw new AgentServiceError(503, 'No more agents can be linked on this server');
      // The newest are kept: an owner who has tried many agents sees the ones they are trying now.
      all[owner] = [...mine, id].slice(-MAX_LINKS_PER_OWNER);
      await mkdir(join(options.directory, 'agents'), { recursive: true, mode: 0o700 });
      await writeFile(`${linksPath}.tmp`, JSON.stringify(all));
      await rename(`${linksPath}.tmp`, linksPath);
    }
    return { owner, agent_id: id };
  }

  /** The agents that asked to work for `owner`, newest last. */
  async function linked(owner: string): Promise<LinkedAgent[]> {
    const ids = (await loadLinks())[owner] ?? [];
    const found: LinkedAgent[] = [];
    for (const id of ids) {
      const identity = await readAgent(agents, BigInt(id)).catch(() => undefined);
      if (identity) found.push({ agent_id: id, name: (await nameOf(identity.signer)) ?? `Agent ${id}`, signer: identity.signer });
    }
    return found;
  }

  return { capabilities, metadata, document, verify, link, linked, uriOf };
}

export type AgentService = ReturnType<typeof createAgentService>;
