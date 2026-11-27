import type { rpc } from '@stellar/stellar-sdk';
import type { CheckKind } from '@stellar-agent-auth/sdk';

/**
 * The sellers in the demo and what they sell. Each stands for someone else's business: it has its own account to be
 * paid at, its own price, and its own rule about which agents it sells to. They run inside the demo server for
 * convenience and know nothing of the visitor or of the agent's tasks; each is an ordinary x402 resource.
 *
 * What they sell is read from the network when it is bought, so every purchase returns something true and current.
 */

export const VENDOR_IDS = ['ledger-wire', 'deep-archive', 'audited-sources', 'bargain-data'] as const;
export type VendorId = (typeof VENDOR_IDS)[number];

export interface Vendor {
  id: VendorId;
  name: string;
  tagline: string;
  /** What the seller requires of a paying agent, beyond a wallet it recognises. */
  requires: readonly CheckKind[];
  /** In plain words, for the page. */
  sells_to: string;
  /** Whether the allowance form ticks this seller to begin with. */
  suggested: boolean;
}

export const VENDORS: readonly Vendor[] = [
  { id: 'ledger-wire', name: 'Ledger Wire', tagline: 'Network briefs, written for agents',
    requires: ['Metadata', 'SignerAccount'], sells_to: 'Any agent with a current verification', suggested: true },
  { id: 'deep-archive', name: 'Deep Archive', tagline: 'Ledger-by-ledger datasets',
    requires: ['Metadata', 'SignerAccount'], sells_to: 'Any agent with a current verification', suggested: true },
  { id: 'audited-sources', name: 'Audited Sources', tagline: 'Reports for audited agents only',
    requires: ['Code', 'Metadata', 'SignerAccount'], sells_to: 'Only agents whose code was audited', suggested: true },
  { id: 'bargain-data', name: 'Bargain Data', tagline: 'The same headlines at half the price',
    requires: ['Metadata', 'SignerAccount'], sells_to: 'Any agent with a current verification', suggested: false },
];

export type ProductKind = 'brief' | 'digest' | 'dataset' | 'report' | 'headlines';

export interface Product {
  id: string;
  vendor: VendorId;
  kind: ProductKind;
  title: string;
  /** Whole units of the demo asset. */
  price: string;
  /** Where it is sold; `GET` only. */
  path: string;
}

export const PRODUCTS: readonly Product[] = [
  { id: 'wire-brief', vendor: 'ledger-wire', kind: 'brief', title: 'Network brief', price: '1', path: '/x402/ledger-wire/brief' },
  { id: 'wire-digest', vendor: 'ledger-wire', kind: 'digest', title: 'Close-time digest', price: '3', path: '/x402/ledger-wire/digest' },
  { id: 'archive-ledgers', vendor: 'deep-archive', kind: 'dataset', title: 'Recent ledgers dataset', price: '8', path: '/x402/deep-archive/ledgers' },
  { id: 'audited-report', vendor: 'audited-sources', kind: 'report', title: 'Audited fee report', price: '2', path: '/x402/audited-sources/report' },
  { id: 'bargain-headlines', vendor: 'bargain-data', kind: 'headlines', title: 'Headlines', price: '0.5', path: '/x402/bargain-data/headlines' },
];

export const vendorOf = (id: VendorId) => VENDORS.find((vendor) => vendor.id === id)!;
export const productOf = (id: string) => PRODUCTS.find((product) => product.id === id);

/** What a purchase returns. Plain data, so the page can show it and an agent can read it. */
export interface Content {
  title: string;
  summary: string;
  facts: { label: string; value: string }[];
  table?: { columns: string[]; rows: string[][] };
  as_of_ledger: number;
  source: string;
}

/** One closed ledger, as far as the sellers care about it. */
export interface LedgerSample {
  sequence: number;
  closeTime: number;
  hash: string;
}

/**
 * The recent ledgers this server has seen close.
 *
 * An RPC returns a ledger together with everything that happened in it, which on a busy network is megabytes.
 * Asking for a hundred ledgers at once, to learn a hundred close times, exhausts a small machine's memory. So the
 * server looks at the latest ledger every few seconds and keeps three numbers from each. What the sellers sell
 * about recent ledgers comes from here.
 */
export class LedgerWatch {
  private readonly seen = new Map<number, LedgerSample>();
  /** The oldest and newest ledgers the RPC still keeps, when it last said. */
  window: { oldest: number; oldestCloseTime: number; latest: number; latestCloseTime: number } | undefined;

  constructor(private readonly keep = 240) {}

  record(sample: LedgerSample) {
    this.seen.set(sample.sequence, sample);
    while (this.seen.size > this.keep) this.seen.delete(Math.min(...this.seen.keys()));
  }

  /** Up to `count` of the newest ledgers seen, oldest first. They need not be consecutive. */
  recent(count: number): LedgerSample[] {
    return [...this.seen.values()].sort((a, b) => a.sequence - b.sequence).slice(-count);
  }
}

/** The raw reads: nothing in a ledger is decoded, since only its number, time and hash are wanted. */
export type ContentSource = Pick<rpc.Server, '_getLatestLedger' | 'getFeeStats'>;
export type LedgerSource = Pick<rpc.Server, '_getLatestLedger' | '_getLedgers'>;

const count = (value: number | string) => Number(value).toLocaleString('en-US');
const clock = (seconds: number | string) => `${new Date(Number(seconds) * 1_000).toISOString().slice(11, 19)} UTC`;
const day = (seconds: number | string) => new Date(Number(seconds) * 1_000).toISOString().slice(0, 10);

/** Read the latest ledger and remember it. */
export async function observe(source: Pick<rpc.Server, '_getLatestLedger'>, watch: LedgerWatch) {
  const ledger = await source._getLatestLedger();
  const sample = { sequence: ledger.sequence, closeTime: Number(ledger.closeTime), hash: ledger.id };
  watch.record(sample);
  return { ...sample, protocol: String(ledger.protocolVersion) };
}

/**
 * Fill the watch with the ledgers just before now, so that there is something to sell straight after a start. One
 * ledger is asked for at a time, newest first, and it stops quietly at the first one the RPC will not give.
 */
export async function backfill(source: LedgerSource, watch: LedgerWatch, ledgers = 40) {
  const newest = (await observe(source, watch)).sequence;
  for (let sequence = newest - 1; sequence > newest - ledgers && sequence >= 2; sequence--) {
    try {
      const page = await source._getLedgers({ startLedger: sequence, pagination: { limit: 1 } });
      const ledger = page.ledgers[0];
      if (!ledger) return;
      watch.record({ sequence: ledger.sequence, closeTime: Number(ledger.ledgerCloseTime), hash: ledger.hash });
      watch.window = {
        oldest: page.oldestLedger, oldestCloseTime: Number(page.oldestLedgerCloseTime),
        latest: page.latestLedger, latestCloseTime: Number(page.latestLedgerCloseTime),
      };
    } catch {
      return;
    }
  }
}

/** Fee statistics, or `undefined` when the RPC has none to give; a brief is still worth selling without them. */
async function fees(source: ContentSource) {
  try {
    const stats = await source.getFeeStats();
    return { soroban: stats.sorobanInclusionFee, classic: stats.inclusionFee };
  } catch {
    return undefined;
  }
}

function feeFacts(stats: Awaited<ReturnType<typeof fees>>) {
  if (!stats) return [];
  return [
    { label: 'Contract fee, median', value: `${count(stats.soroban.p50)} stroops` },
    { label: 'Contract fee, 99th percentile', value: `${count(stats.soroban.p99)} stroops` },
    { label: 'Classic fee, median', value: `${count(stats.classic.p50)} stroops` },
  ];
}

/** Produce what `product` sells, from `network` as it is now and from the ledgers `watch` has seen. */
export async function produce(product: Product, source: ContentSource, network: string, watch: LedgerWatch): Promise<Content> {
  const vendor = vendorOf(product.vendor).name;
  const now = await observe(source, watch);
  const head = { as_of_ledger: now.sequence, source: `${vendor}, from the ${network} network` };
  const basics = [
    { label: 'Latest ledger', value: count(now.sequence) },
    { label: 'Closed at', value: `${day(now.closeTime)} ${clock(now.closeTime)}` },
    { label: 'Protocol', value: now.protocol },
  ];

  switch (product.kind) {
    case 'headlines':
      return {
        ...head, title: `Headlines · ledger ${count(now.sequence)}`, facts: basics.slice(0, 2),
        summary: `Ledger ${count(now.sequence)} closed at ${clock(now.closeTime)}.`,
      };
    case 'brief':
    case 'report': {
      const stats = await fees(source);
      const traffic = stats && Number(stats.soroban.transactionCount) > 0
        ? ` Over the last ${count(stats.soroban.ledgerCount)} ledgers, ${count(stats.soroban.transactionCount)} contract `
          + `transactions paid a median inclusion fee of ${count(stats.soroban.p50)} stroops.`
        : ' Contract traffic has been too light to report a fee level.';
      return {
        ...head, facts: [...basics, ...feeFacts(stats)],
        title: `${product.kind === 'report' ? 'Audited fee report' : 'Network brief'} · ledger ${count(now.sequence)}`,
        summary: `Ledger ${count(now.sequence)} closed at ${clock(now.closeTime)} on protocol ${now.protocol}.${traffic}`,
      };
    }
    case 'digest': {
      const ledgers = watch.recent(240);
      // Only ledgers seen one after the other say how long one took.
      const gaps = ledgers.slice(1).flatMap((ledger, i) =>
        (ledger.sequence === ledgers[i]!.sequence + 1 ? [ledger.closeTime - ledgers[i]!.closeTime] : []));
      const mean = gaps.length ? gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length : undefined;
      const kept = watch.window && watch.window.latest > watch.window.oldest ? watch.window : undefined;
      const longRun = kept ? (kept.latestCloseTime - kept.oldestCloseTime) / (kept.latest - kept.oldest) : undefined;
      return {
        ...head, title: `Close-time digest · ${count(gaps.length)} ledgers`,
        summary: mean === undefined ? `Ledger ${count(now.sequence)} is the latest; too few ledgers have been watched yet to measure close times.`
          : `The last ${count(gaps.length)} ledgers watched closed ${mean.toFixed(2)} seconds apart on average, `
            + `the slowest after ${Math.max(...gaps)} seconds.`,
        facts: [
          ...basics,
          ...(mean === undefined ? [] : [
            { label: 'Average time between ledgers', value: `${mean.toFixed(2)} s` },
            { label: 'Slowest', value: `${Math.max(...gaps)} s` },
            { label: 'Fastest', value: `${Math.min(...gaps)} s` },
          ]),
          ...(longRun === undefined ? [] : [{
            label: `Average over the last ${count(kept!.latest - kept!.oldest)} ledgers`, value: `${longRun.toFixed(2)} s`,
          }]),
          ...feeFacts(await fees(source)),
        ],
      };
    }
    case 'dataset': {
      const ledgers = watch.recent(40);
      return {
        ...head, title: `Recent ledgers · ${count(ledgers.length)} rows`,
        summary: `The ${count(ledgers.length)} most recent ledgers watched, up to ${count(now.sequence)}, with close time and hash.`,
        facts: basics,
        table: {
          columns: ['Ledger', 'Closed at', 'Hash'],
          rows: ledgers.reverse().map((ledger) => [String(ledger.sequence), clock(ledger.closeTime), ledger.hash]),
        },
      };
    }
  }
}
