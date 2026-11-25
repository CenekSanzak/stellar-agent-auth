import { recoverSponsored, settle } from '@stellar-agent-auth/sdk';
import type { Command } from '../index.js';
import { UsageError, hex32, settled } from '../runtime.js';

/**
 * The transaction journal. Every envelope this CLI signs or has sponsored is recorded before its outcome is known,
 * so an uncertain submission is settled by querying its hash here, never by repeating the command that made it.
 */
export const txCommands: Record<string, Command> = {
  status: {
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
      if (!record) throw new UsageError(`No journal record for ${hash} in ${runtime.stateDirectory}`);
      const outcome = await settle(await runtime.context(), record);
      await runtime.journal.put(outcome.record);
      const result = settled({ outcome }, (value) => ({ return_value: value.toXdr('base64') }));
      return { ...result, scope: record.scope, source: record.source };
    },
  },
};
