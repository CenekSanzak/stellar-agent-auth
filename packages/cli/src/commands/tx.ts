import { settle } from '@stellar-agent-auth/sdk';
import type { Command } from '../index.js';
import { UsageError, hex32, settled } from '../runtime.js';

/**
 * The transaction journal. Every envelope this CLI signs or has sponsored is recorded before its outcome is known,
 * so an uncertain submission is settled by querying its hash here, never by repeating the command that made it.
 */
export const txCommands: Record<string, Command> = {
  status: {
    summary: 'Settle and show a journaled transaction without submitting anything: --hash <hex>',
    options: { hash: 'string' },
    async run(runtime, values) {
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
