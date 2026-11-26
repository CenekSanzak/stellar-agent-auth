import { Address, StrKey, TransactionBuilder, scValToNative, xdr, type Transaction } from '@stellar/stellar-sdk';
import {
  SimulationRejected, buildTransaction, invokeSigned, loadSource, pipelineLimits, signingAddress, simulate,
  type NetworkContext, type PipelineLimits, type Signer, type TransactionJournal,
} from '@stellar-agent-auth/sdk';
import { x402Facilitator } from '@x402/core/facilitator';
import type { FacilitatorClient } from '@x402/core/server';
import type {
  Network, PaymentPayload, PaymentRequirements, SchemeNetworkFacilitator, SettleResponse,
  VerifyResponse,
} from '@x402/core/types';
import { createEd25519Signer } from '@x402/stellar';
import { ExactStellarScheme as UpstreamFacilitator } from '@x402/stellar/exact/facilitator';
import { x402Network } from './networks.js';

/**
 * Facilitators for x402's `exact` scheme on Stellar that accept a smart wallet as payer.
 *
 * A facilitator takes a payer's signed transfer, checks it against what the service asked for, pays the fee and
 * submits it. The published one (`@x402/stellar`) checks the simulation's events and refuses a payment if any
 * contract event is not the transfer itself. The smart wallet publishes its audit entry while it authorizes the
 * payment, so the published facilitator refuses it, although the scheme's specification asks only that there be no
 * other balance change.
 *
 * Two facilitators here make that one allowance and nothing else:
 *
 * - `StellarExactFacilitator`, written against this project's SDK, for any network including a local one;
 * - `tolerantUpstreamFacilitator`, the published code with its event check told to ignore the payer's own events,
 *   for the networks the published code knows (Testnet and mainnet).
 *
 * Events from any contract other than the asset and the payer are still refused by both.
 */

const X402_VERSION = 2;
const SCHEME = 'exact';
/** A ledger is assumed to take five seconds when a timeout is turned into a ledger bound, as the scheme says. */
const LEDGER_SECONDS = 5;
const EXPIRATION_TOLERANCE_LEDGERS = 2;

export interface FacilitatorOptions {
  context: NetworkContext;
  /** Pays the fee and signs the envelope. It authorizes nothing: it must not appear in the payment at all. */
  signer: Signer;
  journal: TransactionJournal;
  /** Highest total fee in stroops for one settlement. The first payment from a new wallet costs far more than later ones. */
  maxFee?: bigint;
  limits?: Partial<PipelineLimits>;
}

const invalid = (invalidReason: string, payer?: string, invalidMessage?: string): VerifyResponse =>
  ({ isValid: false, invalidReason, ...(payer ? { payer } : {}), ...(invalidMessage ? { invalidMessage } : {}) });

interface Checked {
  response: VerifyResponse;
  operation?: xdr.Operation;
}

export class StellarExactFacilitator implements SchemeNetworkFacilitator {
  readonly scheme = SCHEME;
  readonly caipFamily = 'stellar:*';
  private readonly network: Network;
  private readonly limits: PipelineLimits;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: FacilitatorOptions) {
    this.network = x402Network(options.context.networkPassphrase);
    this.limits = pipelineLimits({ maxFee: options.maxFee ?? 5_000_000n, ...options.limits });
  }

  getExtra(): Record<string, unknown> {
    return { areFeesSponsored: true };
  }

  getSigners(): string[] {
    return [this.options.signer.address];
  }

  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    return (await this.check(payload, requirements)).response;
  }

  /** Every rule of the scheme, in the order the published facilitator applies them. */
  private async check(payload: PaymentPayload, requirements: PaymentRequirements): Promise<Checked> {
    const { context, signer } = this.options;
    if (payload.x402Version !== X402_VERSION) return { response: invalid('invalid_x402_version') };
    if (payload.accepted?.scheme !== SCHEME || requirements.scheme !== SCHEME) return { response: invalid('unsupported_scheme') };
    if (requirements.network !== payload.accepted.network) return { response: invalid('network_mismatch') };
    if (requirements.network !== this.network) return { response: invalid('invalid_network') };

    const encoded = (payload.payload as { transaction?: unknown } | undefined)?.transaction;
    let transaction: Transaction;
    try {
      const parsed = TransactionBuilder.fromXdr(String(encoded), context.networkPassphrase);
      if (!('operations' in parsed) || 'innerTransaction' in parsed) throw new Error('not a plain transaction');
      transaction = parsed as Transaction;
    } catch {
      return { response: invalid('invalid_exact_stellar_payload_malformed') };
    }
    const envelope = transaction.toEnvelope();
    const operations = envelope.type === 'envelopeTypeTx' ? envelope.v1.tx.operations : [];
    const [operation] = operations;
    if (operations.length !== 1 || !operation || operation.body.type !== 'invokeHostFunction') {
      return { response: invalid('invalid_exact_stellar_payload_wrong_operation') };
    }
    if (transaction.source === signer.address || operation.sourceAccount) {
      return { response: invalid('invalid_exact_stellar_payload_unsafe_tx_or_op_source') };
    }
    const { hostFunction, auth } = operation.body.invokeHostFunctionOp;
    if (hostFunction.type !== 'hostFunctionTypeInvokeContract') {
      return { response: invalid('invalid_exact_stellar_payload_wrong_operation') };
    }
    const call = hostFunction.invokeContract;
    if (Address.fromScAddress(call.contractAddress).toString() !== requirements.asset) {
      return { response: invalid('invalid_exact_stellar_payload_wrong_asset') };
    }
    if (call.functionName.toString() !== 'transfer' || call.args.length !== 3) {
      return { response: invalid('invalid_exact_stellar_payload_wrong_function_name') };
    }
    let payer: string;
    let payee: string;
    let amount: bigint;
    try {
      payer = String(scValToNative(call.args[0]!));
      payee = String(scValToNative(call.args[1]!));
      amount = BigInt(scValToNative(call.args[2]!) as bigint);
    } catch {
      return { response: invalid('invalid_exact_stellar_payload_malformed') };
    }
    if (payer === signer.address) return { response: invalid('invalid_exact_stellar_payload_facilitator_is_payer') };
    if (payee !== requirements.payTo) return { response: invalid('invalid_exact_stellar_payload_wrong_recipient', payer) };
    if (amount !== BigInt(requirements.amount)) return { response: invalid('invalid_exact_stellar_payload_wrong_amount', payer) };

    // Authorization: only the payer's own entries, for exactly this transfer, signed, and not long-lived.
    if (!auth.length) return { response: invalid('invalid_exact_stellar_payload_no_auth_entries', payer) };
    const latest = await context.server.getLatestLedger();
    const maxLedger = latest.sequence + Math.ceil((requirements.maxTimeoutSeconds ?? 60) / LEDGER_SECONDS)
      + EXPIRATION_TOLERANCE_LEDGERS;
    for (const entry of auth) {
      const credentials = entry.credentials.type === 'sorobanCredentialsAddress' ? entry.credentials.address
        : entry.credentials.type === 'sorobanCredentialsAddressV2' ? entry.credentials.addressV2 : undefined;
      if (!credentials) return { response: invalid('invalid_exact_stellar_payload_unsupported_credential_type', payer) };
      const address = signingAddress(entry);
      if (address === signer.address) return { response: invalid('invalid_exact_stellar_payload_facilitator_in_auth', payer) };
      if (address !== payer) return { response: invalid('invalid_exact_stellar_payload_unexpected_signer', payer) };
      if (credentials.signature.type === 'scvVoid') {
        return { response: invalid('invalid_exact_stellar_payload_missing_payer_signature', payer) };
      }
      if (credentials.signatureExpirationLedger > maxLedger) {
        return { response: invalid('invalid_exact_stellar_signature_expiration_too_far', payer) };
      }
      const root = entry.rootInvocation;
      const authorized = root.function.type === 'sorobanAuthorizedFunctionTypeContractFn' ? root.function.contractFn : undefined;
      if (root.subInvocations.length || !authorized || authorized.toXdr('base64') !== call.toXdr('base64')) {
        return { response: invalid('invalid_exact_stellar_payload_has_subinvocations', payer) };
      }
    }

    // Simulate as it would be settled: this facilitator as source, the payer's entries enforced.
    let simulation;
    try {
      const source = await loadSource(context, signer.address);
      simulation = await simulate(context, buildTransaction(context, source, operation, this.limits), 'enforce');
    } catch (error) {
      if (!(error instanceof SimulationRejected)) throw error;
      return { response: invalid('invalid_exact_stellar_payload_simulation_failed', payer, error.message) };
    }
    const fee = BigInt(simulation.minResourceFee) + BigInt(this.limits.inclusionFee);
    if (fee > this.limits.maxFee) {
      return { response: invalid('invalid_exact_stellar_payload_fee_exceeds_maximum', payer,
        `simulation-derived fee ${fee} stroops exceeds ceiling ${this.limits.maxFee} stroops`) };
    }
    const events = transferProblem(simulation.events, requirements.asset, payer, payee, amount);
    if (events) return { response: invalid(events, payer) };
    return { response: { isValid: true, payer }, operation };
  }

  /** Verify again, then submit with this facilitator as source. Settlements are made one at a time. */
  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    const run = this.tail.then(() => this.settleNow(payload, requirements));
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async settleNow(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    const { context, signer, journal } = this.options;
    const network = requirements.network;
    const { response, operation } = await this.check(payload, requirements);
    const payer = response.payer;
    const failed = (errorReason: string, transaction = '', errorMessage?: string): SettleResponse =>
      ({ success: false, network, transaction, errorReason, ...(payer ? { payer } : {}), ...(errorMessage ? { errorMessage } : {}) });
    if (!response.isValid || !operation) return failed(response.invalidReason ?? 'verification_failed', '', response.invalidMessage);
    try {
      const outcome = await invokeSigned(context, signer, operation, journal, `x402:${signer.address}`, this.limits);
      if (outcome.status === 'success') return { success: true, network, transaction: outcome.hash, ...(payer ? { payer } : {}) };
      // Pending or unknown is not a failure of the payment; it is reported as not settled, with the hash to ask about.
      return failed(outcome.status === 'failed' ? 'settle_exact_stellar_transaction_failed'
        : `settle_exact_stellar_transaction_${outcome.status}`, outcome.hash, outcome.code);
    } catch (error) {
      if (error instanceof SimulationRejected) return failed('invalid_exact_stellar_payload_simulation_failed', '', error.message);
      return failed('unexpected_settle_error', '', error instanceof Error ? error.message : String(error));
    }
  }
}

/** A contract's address from the identifier an event carries. */
const emitter = (event: xdr.ContractEvent) => (event.contractId
  ? Address.fromScAddress(xdr.ScAddress.scAddressTypeContract(event.contractId)).toString() : undefined);

/**
 * What is wrong with a simulation's contract events, or `undefined` if they show exactly the one transfer asked
 * for. Events from the asset must be that transfer. Events from the payer are the payer's own business when the
 * payer is a contract: a wallet may record what it authorized. Events from anyone else are refused, because they
 * mean the payment did something more than pay.
 */
export function transferProblem(
  events: readonly xdr.DiagnosticEvent[], asset: string, payer: string, payee: string, amount: bigint,
): string | undefined {
  let transfers = 0;
  for (const { event } of events) {
    if (event.type.name !== 'contract') continue;
    const from = emitter(event);
    if (from === undefined) return 'invalid_exact_stellar_payload_event_missing_contract_id';
    if (from === payer && StrKey.isValidContract(payer) && from !== asset) continue;
    if (from !== asset) return 'invalid_exact_stellar_payload_event_wrong_asset';
    const { topics, data } = event.body.v0;
    const [name, sender, receiver] = topics;
    if (topics.length < 3 || name?.type !== 'scvSymbol' || name.sym.toString() !== 'transfer') {
      return 'invalid_exact_stellar_payload_event_not_transfer';
    }
    let moved: unknown;
    try {
      const value: unknown = scValToNative(data);
      // A transfer to a muxed address reports its amount inside a map.
      moved = typeof value === 'object' && value !== null && 'amount' in value ? (value as { amount: unknown }).amount : value;
      if (scValToNative(sender!) !== payer) return 'invalid_exact_stellar_payload_event_wrong_from';
      if (scValToNative(receiver!) !== payee) return 'invalid_exact_stellar_payload_event_wrong_to';
    } catch {
      return 'invalid_exact_stellar_payload_malformed';
    }
    if (moved !== amount) return 'invalid_exact_stellar_payload_event_wrong_amount';
    transfers += 1;
  }
  if (transfers === 0) return 'invalid_exact_stellar_payload_no_transfer_events';
  if (transfers > 1) return 'invalid_exact_stellar_payload_multiple_transfers';
  return undefined;
}

/**
 * The published `@x402/stellar` facilitator, with its event check ignoring contract events the payer itself
 * publishes. Everything else is the published code, unchanged. Only for the networks that code knows.
 *
 * `secret` is the facilitator account's secret key: the published code takes a key, not a signer.
 */
export function tolerantUpstreamFacilitator(
  secret: string, network: Network, options: { rpcUrl?: string; maxTransactionFeeStroops?: number } = {},
): SchemeNetworkFacilitator {
  const scheme = new UpstreamFacilitator([createEd25519Signer(secret, network)], {
    ...(options.rpcUrl ? { rpcConfig: { url: options.rpcUrl } } : {}),
    ...(options.maxTransactionFeeStroops ? { maxTransactionFeeStroops: options.maxTransactionFeeStroops } : {}),
  });
  type EventCheck = (events: xdr.DiagnosticEvent[], payer: string, ...rest: unknown[]) => unknown;
  const patched = scheme as unknown as { validateSimulationEvents: EventCheck };
  const published = patched.validateSimulationEvents;
  if (typeof published !== 'function') throw new Error('This version of @x402/stellar has no event check to adapt');
  patched.validateSimulationEvents = function (this: unknown, events, payer, ...rest) {
    const kept = events.filter(({ event }) => !(event.type.name === 'contract' && StrKey.isValidContract(payer)
      && emitter(event) === payer));
    return published.call(this, kept, payer, ...rest);
  };
  return scheme;
}

/**
 * A facilitator a resource server can call directly, in the same process: x402's own facilitator dispatcher around
 * one scheme on one network.
 */
export function inProcessFacilitator(network: Network, scheme: SchemeNetworkFacilitator): FacilitatorClient {
  const facilitator = new x402Facilitator().register(network, scheme);
  return {
    verify: (payload, requirements) => facilitator.verify(payload, requirements),
    settle: (payload, requirements) => facilitator.settle(payload, requirements),
    getSupported: async () => facilitator.getSupported() as Awaited<ReturnType<FacilitatorClient['getSupported']>>,
  };
}
