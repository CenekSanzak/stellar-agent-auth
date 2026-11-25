import { CONTRACT_ERRORS, type ContractErrorName } from './types.js';

/**
 * Stable, actionable explanations for the v1 contract errors. The names and numbers are part of the ABI; these
 * messages are for people and may be reworded, so programs should branch on the name.
 */
export const CONTRACT_ERROR_HELP: Readonly<Record<ContractErrorName, string>> = {
  UnsupportedVersion: 'The request uses a schema version this contract does not support. Upgrade the client.',
  InvalidInput: 'An argument is malformed or out of range. Check amounts, addresses and the policy fields.',
  LimitExceeded: 'A structural limit would be exceeded: too many assets, recipients, checks or active policies, or '
    + 'a value that is too long.',
  Duplicate: 'This already exists or is already in the requested state.',
  NotFound: 'The agent, result, provider or policy does not exist on this deployment.',
  InvalidSequence: 'The sequence is not the next one expected. Read the current state and sign a fresh request.',
  Expired: 'The policy\'s validity window has ended. The owner must approve a new policy.',
  Revoked: 'The owner revoked this policy. Revocation is permanent; the owner must approve a new policy.',
  IdentityChanged: 'The agent identity changed after this was signed or approved. Re-read the identity, then '
    + 'renew verification and the policy for the new revision.',
  VerificationDenied: 'A registry answered in a way the wallet did not expect, so verification could not be '
    + 'confirmed.',
  PolicyDenied: 'The policy does not permit this kind of action, or the request names another wallet. On the '
    + 'account path it also means the wallet was asked to authorize something other than a permitted payment.',
  Paused: 'The owner has paused agent execution on this wallet.',
  ArithmeticOverflow: 'An amount calculation would overflow.',
  TransferFailed: 'The asset contract refused the transfer, for example for an insufficient wallet balance or a '
    + 'missing recipient trustline. Nothing was committed.',
  AgentDisabled: 'The agent\'s controller disabled this identity in the agent registry.',
  ProviderNotApproved: 'The verification provider the policy names was never approved in the verification registry.',
  ProviderDisabled: 'The verification provider was disabled. That is permanent; the policy needs another provider.',
  ResultRevoked: 'The provider revoked its latest verification result for this agent. A new assessment is needed.',
  ResultExpired: 'The verification result has expired or is older than the policy allows. Run the verifier again.',
  RiskFlagged: 'The verification result carries a serious wallet-risk flag, which blocks payment whatever the score.',
  CheckNotPassed: 'A check the policy requires did not pass in the current verification result, or was not performed.',
  RiskTooHigh: 'The verification result\'s risk score is above the policy\'s threshold, or no score could be computed.',
  RequestExpired: 'The request\'s own deadline has passed. Sign a fresh request.',
  NotYetValid: 'The policy\'s validity window has not started yet.',
  AssetNotAllowed: 'The policy does not list this asset.',
  RecipientNotAllowed: 'The recipient is not on the policy\'s allowlist, or is on its blocklist.',
  PaymentLimitExceeded: 'The amount is above the policy\'s cap for a single payment of this asset.',
  DailyLimitExceeded: 'The amount would take today\'s spend of this asset above the policy\'s daily cap. The budget '
    + 'resets at midnight UTC.',
  TotalLimitExceeded: 'The amount would take everything spent of this asset under the policy above its total cap. '
    + 'That cap never resets; the owner must approve a new policy.',
};

/** The v1 error code (1-based) for `name`. */
export const contractErrorCode = (name: ContractErrorName) => CONTRACT_ERRORS.indexOf(name) + 1;

export function explainContractError(name: ContractErrorName): string {
  return `${name} (#${contractErrorCode(name)}): ${CONTRACT_ERROR_HELP[name]}`;
}
