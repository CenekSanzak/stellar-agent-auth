import { CONTRACT_ERRORS, type ContractErrorName } from './types.js';

/**
 * Stable, actionable explanations for the v1 contract errors. The names and numbers are part of the ABI; these
 * messages are for people and may be reworded, so programs should branch on the name.
 */
export const CONTRACT_ERROR_HELP: Readonly<Record<ContractErrorName, string>> = {
  UnsupportedVersion: 'The request uses a schema version this contract does not support. Upgrade the client.',
  InvalidInput: 'An argument is malformed or out of range. Check amounts, addresses and the policy fields.',
  LimitExceeded: 'A cap or collection limit would be exceeded: the per-transfer cap, today\'s budget, or a size '
    + 'limit. Lower the amount or wait for the UTC day to change.',
  Duplicate: 'This already exists or is already in the requested state.',
  NotFound: 'The agent, result, provider or policy does not exist on this deployment.',
  InvalidSequence: 'The sequence is not the next one expected. Read the current state and sign a fresh request.',
  Expired: 'A deadline, validity window or result age has passed. Sign a fresh request or renew the result.',
  Revoked: 'The policy, result, provider or identity is revoked. Revocation is permanent.',
  IdentityChanged: 'The agent identity changed after this was signed or approved. Re-read the identity, then '
    + 'renew verification and the policy for the new revision.',
  VerificationDenied: 'No current verification result meets the policy requirement.',
  PolicyDenied: 'The policy does not permit this action, asset, recipient or wallet, or is not yet valid.',
  Paused: 'The owner has paused agent execution on this wallet.',
  ArithmeticOverflow: 'An amount calculation would overflow.',
  TransferFailed: 'The asset contract refused the transfer, for example for an insufficient wallet balance or a '
    + 'missing recipient trustline. Nothing was committed.',
};

/** The v1 error code (1-based) for `name`. */
export const contractErrorCode = (name: ContractErrorName) => CONTRACT_ERRORS.indexOf(name) + 1;

export function explainContractError(name: ContractErrorName): string {
  return `${name} (#${contractErrorCode(name)}): ${CONTRACT_ERROR_HELP[name]}`;
}
