import { resolve } from 'node:path';
import type { Keypair } from '@stellar/stellar-sdk';
import { readAgent, readLatestResult } from '@stellar-agent-auth/sdk';
import { ReportStore, assess, revoke, type VerifierContext } from '@stellar-agent-auth/verifier';
import type { Command } from '../index.js';
import { UsageError, address, integer, type Runtime } from '../runtime.js';

/**
 * Verification through the limited verifier. `run` assesses one live agent revision and stores its report; with
 * `--publish` the provider key signs and publishes the result. Without it nothing is signed. The verifier submits
 * its own publications with the provider as source and keeps its own pending-publication journal.
 */

async function verifier(runtime: Runtime, provider: string, values: Record<string, string | undefined>) {
  const state = resolve(runtime.env['VERIFIER_STATE_DIR'] ?? resolve(runtime.stateDirectory, 'verifier'));
  await runtime.context();
  const context: VerifierContext = {
    server: runtime.server, networkPassphrase: runtime.config.passphrase,
    agentRegistry: runtime.contract(values['agent-registry'], 'AGENT_REGISTRY_ID', 'agent-registry'),
    verificationRegistry: runtime.contract(values['verification-registry'], 'VERIFICATION_REGISTRY_ID',
      'verification-registry'),
    provider, reports: new ReportStore(resolve(state, 'reports')), stateDirectory: resolve(state, 'pending'),
  };
  return context;
}

const registries = { 'agent-registry': 'string', 'verification-registry': 'string' } as const;

export const verifyCommands: Record<string, Command> = {
  run: {
    summary: 'Assess an agent: --agent <id> [--revision <n>] [--validity <seconds>] [--publish --provider <key>]',
    options: { agent: 'string', revision: 'string', validity: 'string', publish: 'boolean', provider: 'string',
      ...registries },
    async run(runtime, values, flags) {
      let publisher: Keypair | undefined;
      let provider: string;
      if (flags['publish']) {
        if (runtime.options.dryRun) throw new UsageError('--dry-run and --publish are exclusive');
        publisher = await runtime.keypair(values['provider'], 'provider');
        provider = publisher.publicKey();
      } else {
        provider = address(values['provider'] ?? runtime.config.provider, 'provider (or VERIFIER_PUBLIC_ADDRESS)');
      }
      const outcome = await assess(await verifier(runtime, provider, values), {
        agentId: integer(values['agent'], 'agent'),
        revision: values['revision'] === undefined ? undefined : integer(values['revision'], 'revision'),
        validitySeconds: values['validity'] === undefined ? undefined : integer(values['validity'], 'validity'),
        publisher,
      });
      return {
        status: outcome.published ? 'published' : 'assessed', report: outcome.reportPath,
        result: outcome.assessment.result,
        findings: outcome.findings.map(({ kind, outcome: result, summary }) => ({ kind, outcome: result, summary })),
        ...(outcome.published ? { transaction: outcome.published.hash, ledger: outcome.published.ledger } : {}),
      };
    },
  },
  show: {
    summary: 'Show the latest result: --agent <id> [--revision <n>] [--provider <address>]',
    options: { agent: 'string', revision: 'string', provider: 'string', ...registries },
    async run(runtime, values) {
      const provider = address(values['provider'] ?? runtime.config.provider, 'provider (or VERIFIER_PUBLIC_ADDRESS)');
      const context = await verifier(runtime, provider, values);
      const agentId = integer(values['agent'], 'agent');
      const revision = values['revision'] === undefined
        ? (await readAgent(runtime.read(context.agentRegistry), agentId)).revision
        : integer(values['revision'], 'revision');
      const result = await readLatestResult(runtime.read(context.verificationRegistry), {
        agent_id: agentId, revision, provider,
      });
      return { result, report: context.reports.path(result.evidence_hash) };
    },
  },
  revoke: {
    summary: 'Revoke a published result: --agent <id> --revision <n> --sequence <n> --provider <key>',
    options: { agent: 'string', revision: 'string', sequence: 'string', provider: 'string', ...registries },
    async run(runtime, values) {
      const provider = await runtime.keypair(values['provider'], 'provider');
      const revoked = await revoke(await verifier(runtime, provider.publicKey(), values), provider,
        integer(values['agent'], 'agent'), integer(values['revision'], 'revision'),
        integer(values['sequence'], 'sequence'));
      return { status: 'success', transaction: revoked.hash, result: revoked.result };
    },
  },
};
