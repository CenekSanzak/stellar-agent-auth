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

export type ContentSource = Pick<rpc.Server, 'getLatestLedger' | 'getFeeStats' | 'getLedgers'>;

const count = (value: number | string) => Number(value).toLocaleString('en-US');
const clock = (seconds: number | string) => `${new Date(Number(seconds) * 1_000).toISOString().slice(11, 19)} UTC`;
const day = (seconds: number | string) => new Date(Number(seconds) * 1_000).toISOString().slice(0, 10);

async function latest(source: ContentSource) {
  const ledger = await source.getLatestLedger();
  return { sequence: ledger.sequence, closeTime: Number(ledger.closeTime), protocol: String(ledger.protocolVersion) };
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

/** Up to `span` of the most recent ledgers, oldest first; fewer on a young network. */
async function recentLedgers(source: ContentSource, newest: number, span: number) {
  for (const reach of [span, Math.ceil(span / 4), 2]) {
    try {
      const page = await source.getLedgers({ startLedger: Math.max(2, newest - reach + 1), pagination: { limit: reach } });
      return page.ledgers.map((ledger) => ({
        sequence: ledger.sequence, closeTime: Number(ledger.ledgerCloseTime), hash: ledger.hash,
      }));
    } catch {
      // The window asked for may reach past what this RPC still keeps; ask for less.
    }
  }
  return [];
}

function feeFacts(stats: Awaited<ReturnType<typeof fees>>) {
  if (!stats) return [];
  return [
    { label: 'Contract fee, median', value: `${count(stats.soroban.p50)} stroops` },
    { label: 'Contract fee, 99th percentile', value: `${count(stats.soroban.p99)} stroops` },
    { label: 'Classic fee, median', value: `${count(stats.classic.p50)} stroops` },
  ];
}

/** Produce what `product` sells, from `network` as it is now. */
export async function produce(product: Product, source: ContentSource, network: string): Promise<Content> {
  const vendor = vendorOf(product.vendor).name;
  const now = await latest(source);
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
      const ledgers = await recentLedgers(source, now.sequence, 120);
      const gaps = ledgers.slice(1).map((ledger, i) => ledger.closeTime - ledgers[i]!.closeTime);
      const mean = gaps.length ? gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length : undefined;
      return {
        ...head, title: `Close-time digest · ${count(ledgers.length)} ledgers`,
        summary: mean === undefined ? `Ledger ${count(now.sequence)} is the latest; there is not enough history to measure close times.`
          : `The last ${count(ledgers.length)} ledgers closed ${mean.toFixed(2)} seconds apart on average, `
            + `the slowest after ${Math.max(...gaps)} seconds.`,
        facts: [
          ...basics,
          ...(mean === undefined ? [] : [
            { label: 'Average time between ledgers', value: `${mean.toFixed(2)} s` },
            { label: 'Slowest', value: `${Math.max(...gaps)} s` },
            { label: 'Fastest', value: `${Math.min(...gaps)} s` },
          ]),
          ...feeFacts(await fees(source)),
        ],
      };
    }
    case 'dataset': {
      const ledgers = await recentLedgers(source, now.sequence, 40);
      return {
        ...head, title: `Recent ledgers · ${count(ledgers.length)} rows`,
        summary: `${count(ledgers.length)} consecutive ledgers up to ${count(now.sequence)}, with close time and hash.`,
        facts: basics,
        table: {
          columns: ['Ledger', 'Closed at', 'Hash'],
          rows: ledgers.reverse().map((ledger) => [String(ledger.sequence), clock(ledger.closeTime), ledger.hash]),
        },
      };
    }
  }
}
