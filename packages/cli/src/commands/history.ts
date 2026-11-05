import { readAuditHistory, type AuditRecord } from '@stellar-agent-auth/sdk';
import type { Command } from '../index.js';
import { OutcomeError, EXIT, integer, type Runtime } from '../runtime.js';
import { walletId } from './wallet.js';

/** Wallet history from the network's audit events, verified against the stored audit head. */

function summarize(record: AuditRecord) {
  const { entry } = record;
  return {
    sequence: entry.sequence, ledger: entry.ledger, timestamp: entry.timestamp, actor: entry.actor,
    outcome: entry.outcome, hash: record.hash, transaction: record.transaction,
  };
}

export const historyCommand = {
  summary: 'Show and verify wallet audit history [--start-ledger <n>]; exits 1 on a chain mismatch',
  options: { wallet: 'string', 'start-ledger': 'string' },
  async run(runtime: Runtime, values: Record<string, string | undefined>) {
    const wallet = walletId(runtime, values['wallet']);
    const history = await readAuditHistory({ ...runtime.read(wallet), server: runtime.server },
      values['start-ledger'] === undefined ? {} : { startLedger: Number(integer(values['start-ledger'], 'start-ledger')) });
    const result = {
      wallet, status: history.status, detail: history.detail, head: history.head,
      ledgers: { from: history.from_ledger, to: history.to_ledger }, entries: history.entries.map(summarize),
    };
    if (history.status === 'mismatch') throw new OutcomeError(EXIT.error, `Audit mismatch: ${history.detail}`, result);
    return result;
  },
} satisfies Command;
