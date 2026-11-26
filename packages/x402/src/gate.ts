import { Address, Contract, TransactionBuilder, scValToNative, type rpc, type xdr } from '@stellar/stellar-sdk';
import {
  VerificationRegistryError, checkVerification, readPolicy, readWalletRegistries, signingAddress,
  type Hash32, type VerificationRequirement,
} from '@stellar-agent-auth/sdk';
import type { PaymentPayload } from '@x402/core/types';

/**
 * A payee's own check on who is paying.
 *
 * The wallet checks its agent's verification under the owner's policy before it pays. A payee may want something
 * else: a provider it trusts, checks it requires, a risk it accepts. It can decide from the payment it was handed
 * and from the ledger, before taking the money:
 *
 * 1. the payer is a contract running wallet code the payee knows, by its code hash;
 * 2. that wallet is bound to the registries the payee trusts;
 * 3. the wallet's signed entry names a policy, the wallet says which agent the policy is for, and the verification
 *    registry says whether that agent has a result that meets the payee's requirement now.
 *
 * The first step is what makes the other two worth anything: only known wallet code can be believed about its
 * policy. A contract of unknown code could name any agent it liked.
 */

export interface PayeeTerms {
  server: Pick<rpc.Server, 'getLedgerEntries' | 'simulateTransaction'>;
  networkPassphrase: string;
  /** Hex code hashes of the wallet contracts this payee accepts. */
  walletCode: readonly string[];
  agentRegistry: string;
  verificationRegistry: string;
  /** The verification provider this payee trusts. */
  provider: string;
  requirement: VerificationRequirement;
}

export type GateAnswer =
  | { ok: true; payer: string; agentId: bigint }
  | { ok: false; payer?: string; reason: string; message: string };

const refuse = (reason: string, message: string, payer?: string): GateAnswer =>
  ({ ok: false, reason, message, ...(payer ? { payer } : {}) });

/** The policy hash a wallet's signed entry carries in its signature. */
export function policyHashOf(entry: xdr.SorobanAuthorizationEntry): Hash32 | undefined {
  const { credentials } = entry;
  const signature = credentials.type === 'sorobanCredentialsAddress' ? credentials.address.signature
    : credentials.type === 'sorobanCredentialsAddressV2' ? credentials.addressV2.signature : undefined;
  if (signature?.type !== 'scvMap') return undefined;
  const field = (signature.map ?? []).find(({ key }) => key.type === 'scvSymbol' && key.sym.toString() === 'policy_hash')?.val;
  return field?.type === 'scvBytes' && field.bytes.value.length === 32 ? Uint8Array.from(field.bytes.value) : undefined;
}

/** The hex hash of the code a contract runs; `undefined` if it is not a WASM contract or does not exist. */
export async function contractCodeHash(
  server: Pick<rpc.Server, 'getLedgerEntries'>, contractId: string,
): Promise<string | undefined> {
  const { entries } = await server.getLedgerEntries(new Contract(contractId).getFootprint());
  const data = entries[0]?.val;
  if (data?.type !== 'contractData' || data.contractData.val.type !== 'scvContractInstance') return undefined;
  const { executable } = data.contractData.val.instance;
  return executable.type === 'contractExecutableWasm' ? executable.wasmHash.toXdr('hex') : undefined;
}

/** Decide whether the payer of `entry`, a wallet at `payer`, meets `terms`. */
export async function checkPayer(payer: string, entry: xdr.SorobanAuthorizationEntry, terms: PayeeTerms): Promise<GateAnswer> {
  const code = await contractCodeHash(terms.server, payer);
  if (!code || !terms.walletCode.includes(code)) {
    return refuse('payee_gate_unknown_payer', 'The payer is not a wallet this service knows', payer);
  }
  const read = { server: terms.server, contractId: payer, source: terms.provider, networkPassphrase: terms.networkPassphrase };
  const registries = await readWalletRegistries(read);
  if (registries.agent_registry !== terms.agentRegistry || registries.verification_registry !== terms.verificationRegistry) {
    return refuse('payee_gate_other_registries', 'The paying wallet is bound to registries this service does not use', payer);
  }
  const policyHash = policyHashOf(entry);
  if (!policyHash) return refuse('payee_gate_no_policy', 'The payment does not name the policy it is made under', payer);
  const policy = await readPolicy(read, policyHash);
  try {
    await checkVerification({ ...read, contractId: terms.verificationRegistry },
      { agent_id: policy.agent_id, revision: policy.revision, provider: terms.provider }, terms.requirement);
  } catch (error) {
    if (!(error instanceof VerificationRegistryError)) throw error;
    return refuse(`payee_gate_${error.code}`, `The paying agent does not meet this service's requirement: ${error.code}`, payer);
  }
  return { ok: true, payer, agentId: policy.agent_id };
}

/** The payer and its authorization entry, read from an x402 `exact` payment for Stellar. */
export function payerOf(payload: Pick<PaymentPayload, 'payload'>, networkPassphrase: string):
  { payer: string; entry: xdr.SorobanAuthorizationEntry } | undefined {
  try {
    const transaction = TransactionBuilder.fromXdr(String((payload.payload as { transaction?: unknown }).transaction), networkPassphrase);
    const envelope = transaction.toEnvelope();
    const [operation] = envelope.type === 'envelopeTypeTx' ? envelope.v1.tx.operations : [];
    if (operation?.body.type !== 'invokeHostFunction') return undefined;
    const { hostFunction, auth } = operation.body.invokeHostFunctionOp;
    if (hostFunction.type !== 'hostFunctionTypeInvokeContract') return undefined;
    const payer = String(scValToNative(hostFunction.invokeContract.args[0]!));
    Address.fromString(payer);
    const entry = auth.find((candidate) => signingAddress(candidate) === payer);
    return entry ? { payer, entry } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The gate as a hook for an x402 resource server (`onBeforeVerify`): a payment whose payer does not meet `terms` is
 * refused before the facilitator is asked to verify it, so nothing is settled for it.
 */
export function payeeGate(terms: PayeeTerms) {
  return async (context: { paymentPayload: Pick<PaymentPayload, 'payload'> }) => {
    const found = payerOf(context.paymentPayload as Pick<PaymentPayload, 'payload'>, terms.networkPassphrase);
    if (!found) return { abort: true as const, reason: 'payee_gate_unreadable_payment', message: 'The payment could not be read' };
    const answer = await checkPayer(found.payer, found.entry, terms);
    return answer.ok ? undefined : { abort: true as const, reason: answer.reason, message: answer.message };
  };
}
