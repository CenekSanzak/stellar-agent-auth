import { readAuditHistory, readIndexedHistory, type AuditRecord } from '@stellar-agent-auth/sdk';
import type { Command } from '../index.js';
import { OutcomeError, EXIT, UsageError, integer, type Runtime } from '../runtime.js';
import { walletId } from './wallet.js';

/**
 * Wallet history, verified against the stored audit head. By default the entries come from the RPC's events, which
 * reach back only as far as the RPC retains them; with `--indexer` they come from an indexer that has kept them.
 * The indexer is only a source: the entries are hashed and linked again here, against the head read from the network.
 */

function summarize(record: AuditRecord) {
  const { entry } = record;
  return {
    sequence: entry.sequence, ledger: entry.ledger, timestamp: entry.timestamp, actor: entry.actor,
    outcome: entry.outcome, hash: record.hash, transaction: record.transaction,
  };
}

export const historyCommand = {
  summary: 'Show and verify wallet audit history [--start-ledger <n> | --indexer <url>]; exits 1 on a chain mismatch',
  options: { wallet: 'string', 'start-ledger': 'string', indexer: 'string' },
  async run(runtime: Runtime, values: Record<string, string | undefined>) {
    const wallet = walletId(runtime, values['wallet']);
    const indexer = values['indexer'];
    if (indexer !== undefined) {
      if (values['start-ledger'] !== undefined) throw new UsageError('--start-ledger does not apply with --indexer');
      let url: URL;
      try {
        url = new URL(indexer);
      } catch {
        throw new UsageError('--indexer must be a URL');
      }
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
        throw new UsageError('--indexer requires HTTPS except on loopback');
      }
      const history = await readIndexedHistory(runtime.read(wallet), url.toString());
      const result = {
        wallet, source: 'indexer', status: history.status, detail: history.detail, head: history.head,
        indexer: history.indexer, entries: history.entries.map(summarize),
      };
      if (history.status === 'mismatch') throw new OutcomeError(EXIT.error, `Audit mismatch: ${history.detail}`, result);
      return result;
    }
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
