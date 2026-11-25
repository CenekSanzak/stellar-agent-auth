import { holdsScope, recoverSponsored, settle } from '@stellar-agent-auth/sdk';
import type { Command } from '../index.js';
import { EXIT, OutcomeError, UsageError, hex32, settled } from '../runtime.js';

/**
 * The transaction journal. Every envelope this CLI signs or has sponsored is recorded before its outcome is known,
 * so an uncertain submission is settled by querying its hash here, never by repeating the command that made it.
 */
export const txCommands: Record<string, Command> = {
  status: {
    sponsored: true,
    summary: 'Settle and show a transaction without submitting anything: --hash <hex>, or --operation <hex> to ask '
      + 'the sponsor what it did with a signed operation whose answer was lost',
    options: { hash: 'string', operation: 'string' },
    async run(runtime, values) {
      if ((values['hash'] === undefined) === (values['operation'] === undefined)) {
        throw new UsageError('Pass exactly one of --hash and --operation');
      }
      if (values['operation'] !== undefined) {
        const operation = Buffer.from(hex32(values['operation'], 'operation')).toString('hex');
        const sponsor = runtime.sponsor();
        if (!sponsor) throw new UsageError('--operation asks a sponsor: set --sponsor-url or SUBMITTER_URL');
        // The sponsor's transaction is accepted only if it carries exactly this operation, and its outcome is read
        // from the network. If the sponsor submitted nothing, this exits as a rejection: nothing was sent.
        const outcome = await recoverSponsored(await runtime.context(), await sponsor, operation, runtime.journal,
          `recovered:${operation}`);
        const result = settled({ outcome }, (value) => ({ return_value: value.toXdr('base64') }));
        return { ...result, operation, source: outcome.record.source };
      }
      const hash = Buffer.from(hex32(values['hash'], 'hash')).toString('hex');
      const record = await runtime.journal.get(hash);
      if (!record) throw new UsageError(`No journal record for ${hash} in ${runtime.journal.directory}`);
      const outcome = await settle(await runtime.context(), record);
      await runtime.journal.put(outcome.record);
      const result = settled({ outcome }, (value) => ({ return_value: value.toXdr('base64') }));
      return { ...result, scope: record.scope, source: record.source };
    },
  },
  list: {
    summary: 'List journaled transactions that still hold their scope; --all for every record',
    options: { all: 'boolean' },
    async run(runtime, _values, flags) {
      const records = (await runtime.journal.all()).filter((record) => flags['all'] || holdsScope(record));
      return {
        journal: runtime.journal.directory,
        transactions: records.map((record) => ({
          transaction: record.hash, status: record.status, scope: record.scope, source: record.source,
          created_at: record.created_at, ...(record.error ? { error: record.error } : {}),
          ...(record.acknowledged_at ? { acknowledged_at: record.acknowledged_at } : {}),
        })),
      };
    },
  },
  acknowledge: {
    summary: 'Stop an unknowable transaction from holding its scope: --hash <hex>. Only for a transaction that can '
      + 'no longer be included and whose outcome the RPC can no longer show',
    options: { hash: 'string' },
    dryRun: false,
    async run(runtime, values) {
      const hash = Buffer.from(hex32(values['hash'], 'hash')).toString('hex');
      const record = await runtime.journal.get(hash);
      if (!record) throw new UsageError(`No journal record for ${hash} in ${runtime.journal.directory}`);
      const context = await runtime.context();
      const outcome = await settle(context, record);
      await runtime.journal.put(outcome.record);
      // Anything the network can still decide is left to it. Acknowledging is for what it can no longer tell.
      if (outcome.status !== 'unknown') {
        throw new OutcomeError(outcome.status === 'pending' ? EXIT.pending : EXIT.usage,
          `Transaction ${hash} is ${outcome.status}, not unknown; there is nothing to acknowledge.`,
          { status: outcome.status, transaction: hash });
      }
      const latest = await context.server.getLatestLedger();
      if (BigInt(latest.closeTime) <= BigInt(record.max_time)) {
        throw new OutcomeError(EXIT.pending, `Transaction ${hash} can still be included until its time bound passes.`,
          { status: 'unknown', transaction: hash, max_time: record.max_time });
      }
      const acknowledged = { ...outcome.record, acknowledged_at: new Date().toISOString() };
      await runtime.journal.put(acknowledged);
      return {
        status: 'acknowledged', transaction: hash, scope: record.scope,
        note: 'Its outcome is still unknown. Read the on-chain state before signing a new request for this action.',
      };
    },
  },
};
