import {
  CONTRACT_ERROR_HELP, fromContractUnits,
  type AgentIdentity, type AuditOutcome, type ContractErrorName, type Policy, type PolicyState, type ProviderRecord,
  type VerificationResult,
} from '@stellar-agent-auth/sdk';
import { duration, short, toHex, utc } from './format.js';

/**
 * What the views say, worked out from what was read. These are plain functions of their inputs, so the wording for
 * every state, including the ones that are hard to reach on a live network, is covered by unit tests.
 */

export interface AssetInfo {
  contract: string;
  code: string;
  decimals: number;
}

export type Tone = 'good' | 'warn' | 'bad' | 'muted';

export interface Verdict {
  tone: Tone;
  label: string;
  detail: string;
}

/** Whether the agent's verification result can be relied on now, and why not when it cannot. */
export function verificationVerdict(input: {
  identity: AgentIdentity | undefined;
  result: VerificationResult | undefined;
  provider: ProviderRecord | undefined;
  now: bigint;
}): Verdict {
  const { identity, result, provider, now } = input;
  if (!identity) return { tone: 'bad', label: 'No agent', detail: 'The agent registry has no such agent.' };
  if (identity.disabled) {
    return { tone: 'bad', label: 'Agent disabled', detail: 'The agent\'s controller disabled it. Every payment is refused.' };
  }
  if (!provider || !provider.approved) {
    return { tone: 'bad', label: 'Provider not approved', detail: 'The verification provider is not approved, so its results do not count.' };
  }
  if (!result) return { tone: 'bad', label: 'Not verified', detail: 'The provider has published no result for this agent.' };
  if (result.revision !== identity.revision) {
    return { tone: 'bad', label: 'Out of date', detail: `The result is for revision ${result.revision}; the agent is now at revision ${identity.revision}.` };
  }
  if (result.revoked) return { tone: 'bad', label: 'Revoked', detail: 'The provider revoked its result. Every payment is refused.' };
  if (now >= result.expires_at) {
    return { tone: 'bad', label: 'Expired', detail: `The result expired ${duration(now - result.expires_at)} ago, on ${utc(result.expires_at)}.` };
  }
  if (result.serious_wallet_risks !== 0) {
    return { tone: 'bad', label: 'Risk flagged', detail: 'The result carries a serious wallet-risk flag.' };
  }
  const failed = result.checks.filter((check) => check.outcome === 'Failed').map((check) => check.kind);
  if (failed.length) return { tone: 'bad', label: 'Check failed', detail: `Failed: ${failed.join(', ')}.` };
  const age = now > result.issued_at ? now - result.issued_at : 0n;
  return {
    tone: 'good', label: 'Verified',
    detail: `Issued ${duration(age)} ago; expires in ${duration(result.expires_at - now)}, on ${utc(result.expires_at)}.`,
  };
}

/** What a result does and does not cover. The project's verifier is limited, and the view must not hide that. */
export function coverage(result: VerificationResult) {
  const kinds = (outcome: string) => result.checks.filter((check) => check.outcome === outcome).map((check) => check.kind);
  return {
    passed: kinds('Passed'), failed: kinds('Failed'), inconclusive: kinds('Inconclusive'),
    notChecked: [...kinds('Unsupported'), ...kinds('NotApplicable')],
  };
}

export type PolicyStatus = 'active' | 'revoked' | 'expired' | 'not-yet-valid';

export function policyStatus(policy: Policy, state: PolicyState, now: bigint): PolicyStatus {
  if (state.revoked) return 'revoked';
  if (now >= policy.valid_until) return 'expired';
  if (now < policy.valid_after) return 'not-yet-valid';
  return 'active';
}

const amount = (units: bigint, asset: AssetInfo) => `${fromContractUnits(units, asset.decimals)} ${asset.code}`;

/** A policy in plain sentences: who may pay how much to whom, until when, and on what condition. */
export function policySentences(policy: Policy, asset: AssetInfo, now: bigint): string[] {
  const lines: string[] = [];
  const limit = policy.assets.find((entry) => entry.asset === asset.contract);
  if (limit) {
    lines.push(`Agent ${policy.agent_id} may pay up to ${amount(limit.per_transaction, asset)} at a time and `
      + `${amount(limit.per_day, asset)} per UTC day${limit.total === null ? ', with no overall cap' : `, and ${amount(limit.total, asset)} in total`}.`);
  } else {
    lines.push(`Agent ${policy.agent_id} may not pay in ${asset.code} under this policy.`);
  }
  const others = policy.assets.length - (limit ? 1 : 0);
  if (others > 0) lines.push(`It also covers ${others} other asset${others === 1 ? '' : 's'}.`);
  lines.push(policy.allowed_recipients.length
    ? `Only to ${policy.allowed_recipients.map((id) => short(id)).join(', ')}.`
    : 'To any recipient that is not blocked.');
  if (policy.blocked_recipients.length) lines.push(`Never to ${policy.blocked_recipients.map((id) => short(id)).join(', ')}.`);
  if (policy.service) lines.push(`It may also pay the service ${short(policy.service.contract)} in the service's own call.`);
  lines.push(now >= policy.valid_until ? `It ended on ${utc(policy.valid_until)}.`
    : `Valid until ${utc(policy.valid_until)}, ${duration(policy.valid_until - now)} from now.`);
  lines.push(`Each payment needs a result from ${short(policy.provider)} no older than ${duration(policy.max_assessment_age)}, `
    + `with a risk score of at most ${policy.max_risk_score}, covering ${policy.required_checks.join(', ')}.`);
  return lines;
}

/** Spent and left today under one policy, for the demo asset. */
export function policyBudget(policy: Policy, state: PolicyState, asset: AssetInfo) {
  const limit = policy.assets.find((entry) => entry.asset === asset.contract);
  const of = (rows: PolicyState['daily_spend']) => rows.find((entry) => entry.asset === asset.contract)?.amount ?? 0n;
  const spentToday = of(state.daily_spend);
  const spentEver = of(state.total_spend);
  if (!limit) return undefined;
  return {
    perDay: limit.per_day, spentToday, leftToday: limit.per_day > spentToday ? limit.per_day - spentToday : 0n,
    total: limit.total, spentEver,
    share: limit.per_day === 0n ? 0 : Math.min(100, Number((spentToday * 100n) / limit.per_day)),
  };
}

/** One audit entry as a title and a detail line. Recipients that are sellers are called by name. */
export function describeOutcome(
  outcome: AuditOutcome, asset: AssetInfo, names: Readonly<Record<string, string>> = {},
): { title: string; detail: string; tone: Tone } {
  const pay = (transfer: { asset: string; recipient: string; amount: bigint }) =>
    `${transfer.asset === asset.contract ? amount(transfer.amount, asset) : `${transfer.amount} units of ${short(transfer.asset)}`} to ${names[transfer.recipient] ?? short(transfer.recipient)}`;
  switch (outcome.kind) {
    case 'PolicyCreated':
      return { title: 'Allowance approved', detail: `Policy ${toHex(outcome.policy_hash).slice(0, 12)}…`, tone: 'muted' };
    case 'PolicyRevoked':
      return { title: 'Allowance ended', detail: `Policy ${toHex(outcome.policy_hash).slice(0, 12)}…`, tone: 'warn' };
    case 'PauseChanged':
      return outcome.paused ? { title: 'Agent frozen', detail: 'No agent can pay until the owner unfreezes.', tone: 'warn' }
        : { title: 'Agent unfrozen', detail: 'Agents can pay again under their allowances.', tone: 'muted' };
    case 'OwnerWithdrawal':
      return { title: 'Owner withdrawal', detail: pay(outcome.transfer), tone: 'muted' };
    case 'Executed':
    case 'AccountPayment': {
      const { action } = outcome;
      const transfer = action.kind === 'Transfer' ? action.transfer : action.payment;
      const how = outcome.kind === 'Executed' ? 'Agent payment'
        : action.kind === 'ServicePayment' ? 'Service payment' : 'Purchase';
      return {
        title: how, tone: 'good',
        detail: `${pay(transfer)}${action.kind === 'ServicePayment' ? `, through service ${short(action.service.contract)}` : ''}`,
      };
    }
  }
}

/** An allowance in the owner's terms: what Scout may spend, what it has spent, and how long it lasts. */
export function allowanceView(policy: Policy, state: PolicyState, asset: AssetInfo, now: bigint) {
  const limit = policy.assets.find((entry) => entry.asset === asset.contract);
  const of = (rows: PolicyState['daily_spend']) => rows.find((entry) => entry.asset === asset.contract)?.amount ?? 0n;
  const spentToday = of(state.daily_spend);
  const spentEver = of(state.total_spend);
  const perDay = limit?.per_day ?? 0n;
  const total = limit?.total ?? null;
  const text = (units: bigint) => fromContractUnits(units, asset.decimals);
  const leftToday = perDay > spentToday ? perDay - spentToday : 0n;
  const leftEver = total === null ? null : total > spentEver ? total - spentEver : 0n;
  return {
    status: policyStatus(policy, state, now),
    perPurchase: text(limit?.per_transaction ?? 0n), perDay: text(perDay), total: total === null ? null : text(total),
    spentToday: text(spentToday), spentEver: text(spentEver),
    // What Scout can still spend today: the day's remainder, or the overall remainder when that is smaller.
    leftToday: text(leftEver !== null && leftEver < leftToday ? leftEver : leftToday),
    share: perDay === 0n ? 0 : Math.min(100, Number((spentToday * 100n) / perDay)),
    endsIn: policy.valid_until > now ? policy.valid_until - now : 0n,
    recipients: policy.allowed_recipients,
  };
}

export type Allowance = ReturnType<typeof allowanceView>;

export interface StepLike {
  status: 'paid' | 'blocked' | 'declined' | 'unsettled';
  error: string | null;
}

/**
 * What became of one purchase, in the owner's words. The wallet's limits are named with their numbers when the
 * allowance is known; anything this page has no plain sentence for falls back to the contract's own description.
 */
export function explainStep(
  step: StepLike, context: { vendor: string; code: string; allowance?: Pick<Allowance, 'perPurchase' | 'perDay' | 'total'> | undefined },
): Verdict {
  const { vendor, code, allowance } = context;
  if (step.status === 'paid') return { tone: 'good', label: 'Paid', detail: '' };
  if (step.status === 'unsettled') {
    return { tone: 'warn', label: 'Not confirmed yet', detail: 'The payment was sent and its outcome is not known yet. It may still go through.' };
  }
  const help = (name: string) => (CONTRACT_ERROR_HELP as Record<string, string | undefined>)[name as ContractErrorName];
  if (step.status === 'declined') {
    const gate = /^payee_gate_(.+)$/.exec(step.error ?? '')?.[1];
    const reason = gate === 'CheckNotPassed' ? `${vendor} requires a check that Scout's verification does not include.`
      : gate === 'unknown_payer' ? `${vendor} does not recognise this wallet.`
        : gate ? `${vendor}'s own check on the agent failed (${help(gate) ?? gate.replaceAll('_', ' ')}).`
          : step.error ? `${vendor} did not accept the payment (${step.error}).` : `${vendor} did not accept the payment.`;
    return { tone: 'bad', label: 'Refused by the seller', detail: `${reason} Nothing was paid.` };
  }
  const of = (value: string | undefined | null) => (value ? ` of ${value} ${code}` : '');
  const reasons: Record<string, string> = {
    PaymentLimitExceeded: `That is more than your limit${of(allowance?.perPurchase)} for one purchase.`,
    DailyLimitExceeded: `That would pass today's limit${of(allowance?.perDay)}. It resets at midnight UTC.`,
    TotalLimitExceeded: `That would pass the allowance's overall limit${of(allowance?.total)}.`,
    RecipientNotAllowed: `${vendor} is not one of the sellers you approved.`,
    Paused: 'You froze Scout. Nothing can be paid until you unfreeze it.',
    Revoked: 'You ended this allowance. Scout can spend nothing until you approve a new one.',
    Expired: 'This allowance has run out of time. Approve a new one to let Scout buy again.',
    TransferFailed: 'The wallet does not hold enough to pay for this.',
    ResultExpired: 'Scout\'s verification has expired, so your wallet will not pay for it until it is renewed.',
  };
  const known = step.error ? reasons[step.error] ?? help(step.error) : undefined;
  return {
    tone: 'warn', label: 'Blocked by your wallet',
    detail: `${known ?? (step.error ? step.error : 'The network gave no reason.')} Nothing was sent to the seller.`,
  };
}

/** A recorded refusal, for the wallet's record: who refused, and the reason in the contract's terms. */
export function explainRefusal(error: string | null): string {
  if (error === null) return 'No reason was given.';
  const help = (name: string) => (CONTRACT_ERROR_HELP as Record<string, string | undefined>)[name as ContractErrorName];
  // A seller's own check on the agent, made before it takes the payment.
  const gate = /^payee_gate_(.+)$/.exec(error)?.[1];
  if (gate) {
    const reason = help(gate);
    return `The seller's own check refused the agent. ${reason ? `${gate}: ${reason}` : gate.replaceAll('_', ' ')}`;
  }
  const known = help(error);
  return known ? `${error}: ${known}` : error;
}

/**
 * The connected wallet must be on the deployment's network. A wallet on another network would sign transactions
 * that cannot be submitted here, or worse, ones meant for a network with real funds.
 */
export function networkProblem(expectedPassphrase: string, walletPassphrase: string | undefined): string | null {
  if (walletPassphrase === undefined) return 'The wallet did not say which network it is on.';
  if (walletPassphrase !== expectedPassphrase) {
    return `The wallet is on "${walletPassphrase}". Switch it to "${expectedPassphrase}" and connect again.`;
  }
  return null;
}

export type Stage = 'preparing' | 'signing' | 'submitted' | 'confirmed' | 'failed' | 'refused' | 'unsettled' | 'error';

/**
 * How far an owner action has got. `submitted` is not `confirmed`: between the two the action has not happened yet,
 * and an agent payment can still go through. `unsettled` means the outcome is not known, which is not a failure.
 */
export function stageVerdict(stage: Stage): Verdict {
  switch (stage) {
    case 'preparing': return { tone: 'muted', label: 'Preparing', detail: 'Checking it against the network.' };
    case 'signing': return { tone: 'muted', label: 'Waiting for your signature', detail: 'Approve it in your wallet.' };
    case 'submitted': return { tone: 'warn', label: 'Submitted, not confirmed', detail: 'It has not taken effect yet.' };
    case 'confirmed': return { tone: 'good', label: 'Confirmed', detail: 'It is on the ledger.' };
    case 'failed': return { tone: 'bad', label: 'Failed on the ledger', detail: 'It was included and changed nothing.' };
    case 'refused': return { tone: 'bad', label: 'Refused', detail: 'Nothing was submitted.' };
    case 'unsettled': return { tone: 'warn', label: 'Outcome not known yet', detail: 'Do not repeat it; it may still be applied.' };
    case 'error': return { tone: 'bad', label: 'Could not be done', detail: 'Nothing was submitted.' };
  }
}
