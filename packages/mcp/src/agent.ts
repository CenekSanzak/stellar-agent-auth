import { StrKey, type rpc } from '@stellar/stellar-sdk';
import {
  CONTRACT_ERROR_HELP, WalletError, accountPaymentAction, fromContractUnits, readActivePolicies, readPaused,
  readPaymentCheck, readPolicy, readPolicyState, readWalletBalance, stateAsOf,
  type ContractErrorName, type Hash32, type NetworkContext, type Policy, type PolicyState, type Signer,
} from '@stellar-agent-auth/sdk';
import { fetchPaying, quote, walletClient } from '@stellar-agent-auth/x402';

/**
 * What an AI agent can do with a policy-limited wallet: see what it is allowed, ask what something costs, and buy
 * it. It holds the agent's key and nothing else. It has no limits of its own, on purpose: the limits are the
 * owner's policy, enforced by the wallet contract, and this code could not loosen them if it tried.
 *
 * Every function returns plain data that says what happened, including when the wallet or a seller said no. A
 * refusal is an answer, not an error; only a fault (no network, a malformed address) throws.
 */

/** Stellar assets have seven decimal places. */
const DECIMALS = 7;

export interface AgentOptions {
  server: Pick<rpc.Server, 'simulateTransaction' | 'getLatestLedger'>;
  context: NetworkContext;
  /** The agent's key. It signs authorization entries for one policy at a time, and nothing else. */
  agent: Signer;
  /** The owner's smart wallet. */
  wallet: string;
  /** Pay under this policy only. Without it, the newest policy that is in force for this agent's key is used. */
  policyHash?: Hash32;
  /** Sellers the agent is told about; see `Offer`. */
  offers?: () => Promise<Offer[]>;
  fetch?: typeof fetch;
}

/** Something a seller offers at an address, as a catalogue describes it. The price is whatever the seller asks. */
export interface Offer {
  seller: string;
  title: string;
  url: string;
  /** The catalogue's price, in whole units, for information; the seller's own answer is what counts. */
  listed_price?: string;
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const units = (value: bigint) => fromContractUnits(value, DECIMALS);
const explain = (code: string) => (CONTRACT_ERROR_HELP as Record<string, string | undefined>)[code as ContractErrorName] ?? code;

export function createWalletAgent(options: AgentOptions) {
  const { server, context, agent, wallet } = options;
  const fetcher = options.fetch ?? fetch;
  const read = { server, contractId: wallet, source: agent.address, networkPassphrase: context.networkPassphrase };
  const ledgerTime = async () => BigInt((await server.getLatestLedger()).closeTime);

  /** The policy this agent pays under now, or why there is none. */
  async function current(): Promise<{ hash: Hash32; policy: Policy; state: PolicyState } | { none: string }> {
    const now = await ledgerTime();
    let hashes: Hash32[];
    try {
      hashes = options.policyHash ? [options.policyHash] : await readActivePolicies(read);
    } catch (error) {
      if (error instanceof WalletError) return { none: `The wallet could not be read: ${error.message}` };
      return { none: 'There is no wallet at this address yet. The owner has to create it first.' };
    }
    const mine: { hash: Hash32; policy: Policy; state: PolicyState }[] = [];
    for (const hash of hashes) {
      const policy = await readPolicy(read, hash);
      if (policy.signer !== agent.address) continue;
      mine.push({ hash, policy, state: stateAsOf(await readPolicyState(read, hash), now) });
    }
    // A pinned policy is used whatever its state, so that the wallet's refusal can be seen.
    if (options.policyHash) return mine[0] ?? { none: 'The policy this agent was given is not for its key.' };
    const live = mine.filter(({ policy, state }) => !state.revoked && now >= policy.valid_after && now < policy.valid_until)
      .sort((a, b) => (a.policy.valid_after < b.policy.valid_after ? 1 : -1));
    return live[0] ?? { none: 'The owner has not approved an allowance for this agent, or it has ended. Nothing can be bought until they approve one.' };
  }

  /** What the owner allows, what is spent, and what the wallet holds. */
  async function allowance() {
    const found = await current();
    if ('none' in found) return { wallet, agent: agent.address, allowed: false as const, reason: found.none };
    const { hash, policy, state } = found;
    const now = await ledgerTime();
    const frozen = await readPaused(read);
    const spentOf = (rows: PolicyState['daily_spend'], asset: string) => rows.find((row) => row.asset === asset)?.amount ?? 0n;
    const assets = await Promise.all(policy.assets.map(async (limit) => {
      const today = spentOf(state.daily_spend, limit.asset);
      const ever = spentOf(state.total_spend, limit.asset);
      const leftToday = limit.per_day > today ? limit.per_day - today : 0n;
      const leftEver = limit.total === null ? null : limit.total > ever ? limit.total - ever : 0n;
      return {
        asset: limit.asset, wallet_balance: units(await readWalletBalance(read, limit.asset)),
        per_purchase: units(limit.per_transaction), per_day: units(limit.per_day),
        total: limit.total === null ? null : units(limit.total),
        spent_today: units(today), spent_in_total: units(ever),
        left_today: units(leftEver !== null && leftEver < leftToday ? leftEver : leftToday),
      };
    }));
    return {
      wallet, agent: agent.address, allowed: true as const, frozen, policy: hex(hash), assets,
      // An empty list would mean anyone; the wallet reads it the same way.
      may_pay: policy.allowed_recipients.length ? policy.allowed_recipients : 'anyone not blocked',
      never_pay: policy.blocked_recipients,
      ends_at: new Date(Number(policy.valid_until) * 1_000).toISOString(),
      ends_in_seconds: Number(policy.valid_until > now ? policy.valid_until - now : 0n),
      note: frozen ? 'The owner has frozen the wallet. Every purchase will be refused until they unfreeze it.'
        : 'These limits are enforced by the wallet contract. A purchase outside them is refused, and that is the owner\'s decision.',
    };
  }

  function checked(url: string): URL {
    const parsed = new URL(url);
    const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) {
      throw new Error('Only https addresses can be bought from');
    }
    return parsed;
  }

  /** Ask a seller what something costs, and ask the wallet whether it would pay that. Nothing is signed. */
  async function price(url: string) {
    const target = checked(url);
    const found = await current();
    if ('none' in found) return { url: target.href, priced: false as const, reason: found.none };
    const client = walletClient({ wallet, policyHash: found.hash, agent, context, server });
    const terms = await quote(client, target, {}, fetcher);
    if (!terms) return { url: target.href, priced: false as const, reason: 'This address does not ask for payment.' };
    const asked = terms.accepts.find((option) => found.policy.assets.some((limit) => limit.asset === option.asset)) ?? terms.accepts[0];
    if (!asked) return { url: target.href, priced: false as const, reason: 'The seller named no way to pay.' };
    const offer = { url: target.href, priced: true as const, amount: units(BigInt(asked.amount)), asset: asked.asset, pay_to: asked.payTo };
    if (!StrKey.isValidContract(asked.asset)) return { ...offer, wallet_would: 'refuse', reason: 'The seller named an invalid asset.' };
    try {
      await readPaymentCheck(read, {
        policy_hash: found.hash,
        action: accountPaymentAction({ wallet, policyHash: found.hash, asset: asked.asset, recipient: asked.payTo, amount: BigInt(asked.amount) }),
      });
      return { ...offer, wallet_would: 'pay' as const };
    } catch (error) {
      if (!(error instanceof WalletError)) throw error;
      return { ...offer, wallet_would: 'refuse' as const, error: error.code, reason: explain(error.code) };
    }
  }

  /**
   * Buy what is at `url`: pay what the seller asks, from the wallet, if the wallet's policy allows it and the
   * seller accepts this agent.
   */
  async function buy(url: string) {
    const target = checked(url);
    const found = await current();
    if ('none' in found) return { url: target.href, outcome: 'blocked' as const, by: 'wallet', reason: found.none };
    const client = walletClient({ wallet, policyHash: found.hash, agent, context, server });
    let paid: Awaited<ReturnType<typeof fetchPaying>>;
    try {
      paid = await fetchPaying(client, target, {}, fetcher);
    } catch (error) {
      // The wallet said no before anything was signed for the seller.
      if (!(error instanceof WalletError)) throw error;
      return {
        url: target.href, outcome: 'blocked' as const, by: 'wallet', error: error.code, reason: explain(error.code),
        note: 'Nothing was paid and nothing was sent to the seller. This is the owner\'s rule; do not try to get around it.',
      };
    }
    const asked = paid.required?.accepts[0];
    const cost = asked ? { amount: units(BigInt(asked.amount)), asset: asked.asset, pay_to: asked.payTo } : {};
    if (paid.response.status === 402) {
      const reason = paid.required?.error ?? 'no reason given';
      return {
        url: target.href, outcome: 'declined' as const, by: 'seller', ...cost, error: reason,
        reason: reason.startsWith('payee_gate_') ? 'The seller checked this agent\'s verification and refused to sell.' : 'The seller did not accept the payment.',
        note: 'Nothing was paid.',
      };
    }
    if (!asked) return { url: target.href, outcome: 'free' as const, status: paid.response.status, content: await body(paid.response) };
    if (!paid.response.ok || !paid.settlement?.success) {
      return {
        url: target.href, outcome: 'unsettled' as const, ...cost, status: paid.response.status,
        transaction: paid.settlement?.transaction || null,
        note: 'The payment was sent and its outcome is not known. Do not buy this again until the allowance shows whether it was spent.',
      };
    }
    return {
      url: target.href, outcome: 'paid' as const, ...cost, transaction: paid.settlement.transaction,
      content: await body(paid.response),
    };
  }

  async function offers(): Promise<Offer[]> {
    return options.offers ? options.offers() : [];
  }

  return { allowance, price, buy, offers };
}

/** A response body as data when it is JSON, as text otherwise, cut to a size an agent can read. */
async function body(response: Response): Promise<unknown> {
  const text = (await response.text()).slice(0, 20_000);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export type WalletAgent = ReturnType<typeof createWalletAgent>;
