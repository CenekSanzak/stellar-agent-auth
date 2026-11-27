import { rpc } from '@stellar/stellar-sdk';
import {
  AgentRegistryError, SimulationRejected, SubmissionUnsettled, VerificationRegistryError, WalletError,
  canonicalPolicy, holdsScope, networkContext, newestForOperation, ownerInvocation, pipelineLimits, policyExposure, policyHash, prepare,
  readActivePolicies, readAgent, readAuditHead, readIndexedHistory, readLatestResult, readPaused, readPolicy,
  readPolicyState, readProvider, readWalletBalance, readWalletOwner, settleScope, submit, toContractUnits,
  walletDeployment,
  type AgentIdentity, type AuditHead, type Exposure, type IndexedHistory, type Invocation, type NetworkContext,
  type CheckKind, type Policy, type PolicyState, type ProviderRecord, type Signer, type TransactionJournal, type TransactionRecord,
  type VerificationResult, type WalletArgs, type WalletOwnerMethod,
} from '@stellar-agent-auth/sdk';
import type { Config } from './backend.js';
import { fromHex, toHex } from './format.js';
import type { Stage } from './model.js';

/**
 * Everything the page reads from the network and every transaction the owner signs. The page talks to the RPC
 * itself: balances, policies, the agent's identity and its verification result all come from the contracts, not
 * from the demo server.
 */

/** A journal in the browser's local storage, so a reload does not forget a transaction that is still in flight. */
export class StorageJournal implements TransactionJournal {
  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'>, private readonly key: string) {}

  private all(): TransactionRecord[] {
    try {
      const value: unknown = JSON.parse(this.storage.getItem(this.key) ?? '[]');
      return Array.isArray(value) ? value as TransactionRecord[] : [];
    } catch {
      return [];
    }
  }

  async get(hash: string) {
    return this.all().find((record) => record.hash === hash);
  }

  async unsettled(scope: string) {
    return this.all().filter((record) => record.scope === scope && holdsScope(record))
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async byOperation(scope: string, operationHash: string) {
    return newestForOperation(this.all(), scope, operationHash);
  }

  async inScope(scope: string) {
    return this.all().filter((record) => record.scope === scope).sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async put(record: TransactionRecord) {
    // Settled records are kept only briefly; the ledger is the record of what happened.
    const rest = this.all().filter((existing) => existing.hash !== record.hash).slice(-20);
    this.storage.setItem(this.key, JSON.stringify([...rest, record]));
  }
}

export interface PolicyView {
  hash: string;
  policy: Policy;
  state: PolicyState;
}

export interface AgentView {
  identity: AgentIdentity | undefined;
  result: VerificationResult | undefined;
  provider: ProviderRecord | undefined;
}

export interface WalletView {
  balance: bigint;
  paused: boolean;
  head: AuditHead;
}

export interface OwnerOutcome {
  stage: Extract<Stage, 'confirmed' | 'failed' | 'refused' | 'unsettled' | 'error'>;
  detail: string;
  hash: string | null;
}

/** An allowance as the owner fills it in. Amounts are whole units of the demo asset. */
export interface AllowanceDraft {
  perPurchase: string;
  perDay: string;
  /** Empty for no overall cap. */
  total: string;
  days: number;
  /** IDs of the sellers the agent may pay. */
  vendors: string[];
  /** The agent the allowance is for. */
  agentId: string;
  /** The checks its verification must show as passed. */
  requiredChecks: CheckKind[];
  maxRisk: number;
  maxAgeDays: number;
}

export function createChain(config: Config, journal: TransactionJournal) {
  const server = new rpc.Server(config.rpc_url, { allowHttp: config.network === 'local', timeout: 30_000 });
  let context: Promise<NetworkContext> | undefined;
  const network = () => (context ??= networkContext(server, config.passphrase).catch((error: unknown) => {
    context = undefined;
    throw error;
  }));
  // Reads are simulations; any existing account can be named as their source, and its sequence is not used.
  const read = (contractId: string) => ({
    server, contractId, source: config.read_source, networkPassphrase: config.passphrase,
  });
  const missing = (error: unknown) =>
    (error instanceof AgentRegistryError || error instanceof VerificationRegistryError || error instanceof WalletError)
    && error.code === 'NotFound';

  async function ledgerTime(): Promise<bigint> {
    return BigInt((await server.getLatestLedger()).closeTime);
  }

  async function accountExists(address: string): Promise<boolean> {
    try {
      await server.getAccount(address);
      return true;
    } catch {
      return false;
    }
  }

  /** Ask Friendbot for test XLM, trying again if it is busy. Only test networks have one. */
  async function requestTestXlm(address: string) {
    for (let attempt = 1; ; attempt++) {
      try {
        await server.requestAirdrop(address);
        return;
      } catch (error) {
        if (attempt >= 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }
    }
  }

  async function walletExists(wallet: string, owner: string): Promise<boolean> {
    try {
      return await readWalletOwner(read(wallet)) === owner;
    } catch {
      return false;
    }
  }

  async function readAgentView(id: string = config.agent.agent_id): Promise<AgentView> {
    const agentId = BigInt(id);
    const optional = async <T>(work: Promise<T>) => work.catch((error: unknown) => {
      if (missing(error)) return undefined;
      throw error;
    });
    const identity = await optional(readAgent(read(config.agent_registry), agentId));
    const provider = await optional(readProvider(read(config.verification_registry), config.provider.address));
    const result = identity && await optional(readLatestResult(read(config.verification_registry), {
      agent_id: agentId, revision: identity.revision, provider: config.provider.address,
    }));
    return { identity, provider, result };
  }

  async function readWalletView(wallet: string): Promise<WalletView> {
    const [balance, paused, head] = await Promise.all([
      readWalletBalance(read(wallet), config.asset.contract), readPaused(read(wallet)), readAuditHead(read(wallet)),
    ]);
    return { balance, paused, head };
  }

  /** Active policies, plus any others named in `known` (revoked ones, which the wallet no longer lists). */
  async function readPolicies(wallet: string, known: readonly string[]): Promise<PolicyView[]> {
    const active = (await readActivePolicies(read(wallet))).map(toHex);
    const hashes = [...new Set([...known, ...active])];
    const views = await Promise.all(hashes.map(async (hash) => {
      const bytes = fromHex(hash);
      const [policy, state] = await Promise.all([readPolicy(read(wallet), bytes), readPolicyState(read(wallet), bytes)]);
      return { hash, policy, state };
    }));
    // Newest first, by when each became valid.
    return views.sort((a, b) => (a.policy.valid_after < b.policy.valid_after ? 1 : -1));
  }

  const exposure = (policies: readonly PolicyView[], now: bigint): Exposure[] => policyExposure(policies, now);

  async function history(wallet: string, indexer: string): Promise<IndexedHistory> {
    return readIndexedHistory(read(wallet), indexer);
  }

  /**
   * The policy an allowance stands for: this deployment's agent and provider, the demo asset with the owner's
   * limits, and the chosen sellers' accounts as the only permitted recipients.
   */
  async function draftAllowance(draft: AllowanceDraft): Promise<Policy> {
    const now = await ledgerTime();
    const units = (value: string) => toContractUnits(value, config.asset.decimals);
    const id = crypto.getRandomValues(new Uint8Array(32));
    const agent = await readAgent(read(config.agent_registry), BigInt(draft.agentId));
    const recipients = config.vendors.filter((vendor) => draft.vendors.includes(vendor.id)).map((vendor) => vendor.address);
    // An empty list would mean any recipient at all, which is the opposite of approving nobody.
    if (!recipients.length) throw new Error('Approve at least one seller, or the agent has nowhere to buy');
    if (!draft.requiredChecks.length) throw new Error('This agent has no verification to require yet; wait until it is verified');
    return canonicalPolicy({
      schema_version: 1, policy_id: id, agent_id: agent.agent_id, revision: agent.revision, signer: agent.signer,
      provider: config.provider.address, required_checks: draft.requiredChecks,
      max_assessment_age: BigInt(draft.maxAgeDays) * 86_400n, max_risk_score: draft.maxRisk,
      assets: [{
        asset: config.asset.contract, per_transaction: units(draft.perPurchase), per_day: units(draft.perDay),
        total: draft.total.trim() === '' ? null : units(draft.total),
      }],
      allowed_recipients: recipients, blocked_recipients: [],
      valid_after: now - 60n, valid_until: now + BigInt(draft.days) * 86_400n,
      action_kinds: ['Transfer'], service: null,
    });
  }

  /**
   * Prepare, sign and submit one transaction with the owner as its source, reporting each stage. The owner signs
   * the envelope once; that signature is also the owner's authorization for the call.
   */
  async function send(
    owner: Signer, invocation: Invocation, onStage: (stage: Stage, hash?: string) => void, maxFee = 50_000_000n,
  ): Promise<OwnerOutcome> {
    const scope = `source:${owner.address}`;
    const limits = pipelineLimits({ maxFee });
    try {
      const current = await network();
      // An earlier transaction that is still in flight must settle first; building another could apply both.
      await settleScope(current, journal, scope);
      onStage('preparing');
      const { transaction } = await prepare(current, owner.address, invocation, limits);
      onStage('signing');
      const signed = await owner.signTransaction(transaction, config.passphrase);
      const hash = toHex(signed.hash());
      onStage('submitted', hash);
      const outcome = await submit(current, signed, journal, scope, limits);
      if (outcome.status === 'success') return { stage: 'confirmed', detail: `Ledger ${outcome.record.ledger ?? '?'}`, hash };
      if (outcome.status === 'failed') {
        return { stage: 'failed', hash, detail: outcome.code ? `The contract answered ${outcome.code}.` : 'The network gave no reason.' };
      }
      if (outcome.status === 'rejected' || outcome.status === 'expired') {
        return { stage: 'refused', hash, detail: `The network did not include it (${outcome.record.error ?? outcome.status}).` };
      }
      return { stage: 'unsettled', hash, detail: 'It was sent and has not been confirmed. Check again before repeating it.' };
    } catch (error) {
      if (error instanceof SimulationRejected) return { stage: 'refused', hash: null, detail: error.message };
      if (error instanceof SubmissionUnsettled) {
        return { stage: 'unsettled', hash: error.record.hash, detail: 'An earlier transaction from this account is not settled yet.' };
      }
      return { stage: 'error', hash: null, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  const ownerCall = <M extends WalletOwnerMethod>(
    owner: Signer, wallet: string, method: M, args: WalletArgs[M], onStage: (stage: Stage, hash?: string) => void,
  ) => network().then((current) => send(owner, ownerInvocation(current, wallet, method, args, owner), onStage));

  /** Deploy the owner's wallet: the installed wallet code, this deployment's registries, and the shared salt. */
  const createWallet = (owner: Signer, onStage: (stage: Stage, hash?: string) => void) => send(owner,
    walletDeployment(config.passphrase, owner.address, fromHex(config.wallet_wasm_hash), config.agent_registry,
      config.verification_registry, fromHex(config.wallet_salt)), onStage, 200_000_000n);

  const hashOf = (wallet: string, policy: Policy) => toHex(policyHash(config.passphrase, wallet, policy));

  return {
    ledgerTime, accountExists, requestTestXlm, walletExists, readAgentView, readWalletView, readPolicies, exposure,
    history, draftAllowance, ownerCall, createWallet, hashOf,
  };
}

export type Chain = ReturnType<typeof createChain>;
