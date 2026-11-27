import { Account, StrKey, type rpc } from '@stellar/stellar-sdk';
import {
  MAX_AUTH_WINDOW_LEDGERS, accountPaymentAction, accountPaymentInvocation, buildTransaction, pipelineLimits,
  readPaymentCheck, signForSponsor,
  type AccountPayment, type Hash32, type NetworkContext, type Signer,
} from '@stellar-agent-auth/sdk';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import type { PaymentRequired, PaymentRequirements, SchemeNetworkClient, SettleResponse } from '@x402/core/types';
import { x402Network } from './networks.js';

/**
 * The paying side of x402's `exact` scheme, for a smart wallet.
 *
 * On Stellar the scheme is a plain `asset.transfer(payer, payee, amount)`. The payer signs only its authorization
 * entry, and a facilitator builds the transaction around it, pays the fee and submits it. That is the shape the
 * wallet's account path authorizes, so the wallet can be the payer. What differs from the published client is who
 * signs and how: here the entry is the wallet's own, signed by the agent's key for one named policy, in the form the
 * wallet's `__check_auth` reads. The published client signs in the form a plain account uses, which the wallet
 * refuses.
 *
 * The wallet is asked first (`check_payment`). A payment its policy refuses fails here, with the wallet's own
 * reason, before anything is signed or sent to the service.
 */

export interface WalletPayer {
  /** The smart wallet that pays. */
  wallet: string;
  /** The policy the agent pays under; it is part of what the agent signs. */
  policyHash: Hash32;
  /** The policy's agent key. It must be able to sign a message, so a headless key. */
  agent: Signer;
  context: NetworkContext;
  server: Pick<rpc.Server, 'simulateTransaction'>;
}

/** Seconds a ledger is assumed to take when turning the service's timeout into a signature lifetime. */
const LEDGER_SECONDS = 6;
/** An account that exists on no network; a facilitator replaces the transaction source anyway. */
const NO_ACCOUNT = StrKey.encodeEd25519PublicKey(Buffer.alloc(32));

export class WalletExactScheme implements SchemeNetworkClient {
  readonly scheme = 'exact';

  constructor(private readonly payer: WalletPayer) {}

  async createPaymentPayload(x402Version: number, requirements: PaymentRequirements) {
    const { wallet, policyHash, agent, context, server } = this.payer;
    const { scheme, network, asset, payTo, amount, maxTimeoutSeconds, extra } = requirements;
    if (scheme !== 'exact') throw new Error(`Unsupported x402 scheme ${scheme}`);
    if (network !== x402Network(context.networkPassphrase)) {
      throw new Error(`The service asks for payment on ${network}; this wallet is on another network`);
    }
    if (extra?.['areFeesSponsored'] !== true) throw new Error('The wallet cannot pay fees: the facilitator must sponsor them');
    if (!/^[1-9]\d{0,38}$/.test(amount)) throw new Error('The service asked for an invalid amount');
    if (!StrKey.isValidContract(asset)) throw new Error('The service named an invalid asset');
    const payment: AccountPayment = { wallet, policyHash, asset, recipient: payTo, amount: BigInt(amount) };

    // The wallet's own answer, with its reason. Past this point a refusal would be a bare authorization failure.
    await readPaymentCheck({ server, contractId: wallet, source: agent.address, networkPassphrase: context.networkPassphrase },
      { policy_hash: policyHash, action: accountPaymentAction(payment) });

    // The signature must not outlive the service's timeout; the facilitator refuses one that does.
    const authLedgers = Math.max(2, Math.min(MAX_AUTH_WINDOW_LEDGERS, Math.floor((maxTimeoutSeconds ?? 60) / LEDGER_SECONDS)));
    const limits = pipelineLimits({ authLedgers, timeoutSeconds: Math.max(5, Math.min(600, maxTimeoutSeconds ?? 60)) });
    const operation = await signForSponsor(context, NO_ACCOUNT, accountPaymentInvocation(context, payment, agent), limits);
    const transaction = buildTransaction(context, new Account(NO_ACCOUNT, '0'), operation, limits);
    return { x402Version, payload: { transaction: transaction.toXdr() } };
  }
}

/**
 * An x402 client that pays from `payer` on its network.
 *
 * The client library's own spend controls are switched off. They are a list kept in the agent's process, which the
 * agent could change. Here the limits are the wallet's policy, set by the owner and enforced on the ledger: which
 * assets, how much at a time, how much in a day, and to whom. `createPaymentPayload` asks the wallet before it
 * signs, so a payment outside the policy is refused with the wallet's reason.
 */
export function walletClient(payer: WalletPayer): x402Client {
  return new x402Client().setSpendControls(false)
    .register(x402Network(payer.context.networkPassphrase), new WalletExactScheme(payer));
}

/**
 * Ask what `url` costs without paying: the payment terms of its 402 answer, or `undefined` when it asks for none.
 * Nothing is signed. An agent can compare sellers this way before it decides where to buy.
 */
export async function quote(
  client: x402Client, url: string | URL, init: RequestInit = {}, fetcher: typeof fetch = fetch,
): Promise<PaymentRequired | undefined> {
  const response = await fetcher(url, init);
  if (response.status !== 402) return undefined;
  return new x402HTTPClient(client).getPaymentRequiredResponse((name) => response.headers.get(name),
    await response.clone().json().catch(() => undefined));
}

export interface PaidResponse {
  response: Response;
  /** What the service asked for, when it asked for payment. */
  required?: PaymentRequired;
  /** The settlement the service reported, when it took the payment. */
  settlement?: SettleResponse;
}

/**
 * Fetch `url`, paying if the service answers 402. One payment at most: a second 402 is returned as it is, with the
 * service's reason in `required.error`. Creating the payment can throw, most usefully a `WalletError` when the
 * wallet's policy refuses it; nothing has been sent to the service then.
 */
export async function fetchPaying(
  client: x402Client, url: string | URL, init: RequestInit = {}, fetcher: typeof fetch = fetch,
): Promise<PaidResponse> {
  const http = new x402HTTPClient(client);
  const first = await fetcher(url, init);
  if (first.status !== 402) return { response: first };
  const header = (response: Response) => (name: string) => response.headers.get(name);
  const required = http.getPaymentRequiredResponse(header(first), await first.clone().json().catch(() => undefined));
  const payload = await http.createPaymentPayload(required);
  const paid = await fetcher(url, {
    ...init, headers: { ...(init.headers as Record<string, string> | undefined), ...http.encodePaymentSignatureHeader(payload) },
  });
  if (paid.status === 402) {
    // A seller may refuse without repeating its terms in the form x402 gives them. That is still a refusal, not a
    // fault: the answer is returned as it is, and its body says why if anything does.
    try {
      return {
        response: paid,
        required: http.getPaymentRequiredResponse(header(paid), await paid.clone().json().catch(() => undefined)),
      };
    } catch {
      return { response: paid };
    }
  }
  let settlement: SettleResponse | undefined;
  try {
    settlement = http.getPaymentSettleResponse(header(paid));
  } catch {
    settlement = undefined;
  }
  return { response: paid, required, ...(settlement ? { settlement } : {}) };
}
