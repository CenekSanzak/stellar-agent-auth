import type { rpc } from '@stellar/stellar-sdk';
import {
  SimulationRejected, SponsorOutcomeUnknown, SponsorRefused, SubmissionUnsettled, WalletError,
  accountPaymentAction, accountPaymentInvocation, executeInvocation, fromContractUnits, pipelineLimits,
  readPaymentCheck, readPolicy, readPolicyState, signForSponsor, sponsoredInvoke, toContractUnits, transferRequest,
  type AccountPayment, type Hash32, type Invocation, type NetworkContext, type Signer, type SponsorEndpoint,
  type TransactionJournal,
} from '@stellar-agent-auth/sdk';
import { fetchPaying, walletClient } from '@stellar-agent-auth/x402';
import type { Deployment } from './deployment.js';
import { hexToBytes } from './deployment.js';

/**
 * The agent's side of the demo. It holds the agent key and does a fixed set of things with it: each scenario is a
 * payment whose recipient and amount are decided here, from the deployment and from the policy as the wallet stores
 * it. A caller chooses a scenario by name and can choose nothing else, so this process cannot be used to sign an
 * arbitrary payment.
 *
 * A refusal is found in simulation, before anything is signed for submission, and nothing is submitted for it. That
 * is how a well-behaved agent works; it also means a refusal has no transaction and leaves nothing on the ledger.
 */

export interface Scenario {
  id: string;
  label: string;
  description: string;
  /** What the wallet is expected to answer, as a contract error name, or `paid`. */
  expected: string;
}

export const SCENARIOS: readonly Scenario[] = [
  { id: 'allowed', label: 'Pay within the limits', expected: 'paid',
    description: 'A payment to the approved recipient, inside the per-payment and daily limits.' },
  { id: 'over-limit', label: 'Pay above the per-payment limit', expected: 'PaymentLimitExceeded',
    description: 'One unit more than the policy allows in a single payment.' },
  { id: 'unknown-recipient', label: 'Pay someone not on the list', expected: 'RecipientNotAllowed',
    description: 'A small payment to an account the policy does not name.' },
  { id: 'daily-limit', label: 'Spend the daily limit, then one more', expected: 'DailyLimitExceeded',
    description: 'Real payments up to today\'s limit, then one that would pass it. This spends from the wallet.' },
  { id: 'account-transfer', label: 'Pay as an account', expected: 'paid',
    description: 'The wallet authorizes a plain asset transfer itself, signed by the agent key, under the same limits.' },
  { id: 'service', label: 'Pay the demo service', expected: 'paid',
    description: 'The service takes its price from the wallet inside its own call. Needs a policy that names the service.' },
  { id: 'x402', label: 'Buy a report from a paid API (x402)', expected: 'paid',
    description: 'The API answers 402, the wallet pays through an x402 facilitator, and the API checks the agent before it serves.' },
  { id: 'x402-strict', label: 'Buy from an API that wants more', expected: 'payee_gate_CheckNotPassed',
    description: 'This API requires a code check the agent\'s result does not have. The API refuses; the wallet is not charged.' },
];

export interface Step {
  /**
   * `execute` is the wallet's own call; `account` and `service` are the account payment path; `x402` is an account
   * payment asked for by an HTTP API and submitted by an x402 facilitator.
   */
  path: 'execute' | 'account' | 'service' | 'x402';
  amount: string;
  recipient: string;
  /** `unsettled`: submitted or possibly submitted, and not yet known to be final. Never treat it as refused. */
  status: 'paid' | 'refused' | 'failed' | 'unsettled';
  /** The contract error that refused or failed it, when the network named one. */
  error: string | null;
  detail: string | null;
  tx_hash: string | null;
}

export interface ScenarioResult {
  scenario: string;
  expected: string;
  steps: Step[];
}

export class UnknownScenario extends Error {}

/** Reports something that did not become an audit entry; failures to report are not the caller's problem. */
export type AttemptReporter = (attempt: {
  kind: 'simulation' | 'transaction'; status: string; error: string | null; detail: string | null; tx_hash: string | null;
}) => Promise<void>;

/** The paid API's routes: one any verified agent may buy from, and one that asks for a check this agent lacks. */
export const PAID_REPORT = '/x402/report';
export const PAID_STRICT = '/x402/audited-agents-only';

const UNIT_DECIMALS = 7;
const MAX_DAILY_STEPS = 12;

export class DemoAgent {
  private readonly limits = pipelineLimits({ maxFee: 10_000_000n });

  constructor(
    private readonly deployment: Deployment, private readonly context: NetworkContext,
    private readonly server: Pick<rpc.Server, 'simulateTransaction' | 'getLatestLedger'>,
    private readonly agent: Signer, private readonly sponsor: SponsorEndpoint,
    private readonly journal: TransactionJournal, private readonly report: AttemptReporter,
    /** Where the paid API is served; known once the server listens. */
    private readonly paidApi: () => string,
  ) {}

  private read(wallet: string) {
    return {
      server: this.server, contractId: wallet, source: this.agent.address,
      networkPassphrase: this.context.networkPassphrase,
    };
  }

  private units = (value: string) => toContractUnits(value, UNIT_DECIMALS);

  /** Sign for the sponsor and submit; classify whatever comes back without guessing. */
  private async submit(
    invocation: Invocation, scope: string, base: Pick<Step, 'path' | 'amount' | 'recipient'>,
  ): Promise<Step> {
    const step = (status: Step['status'], rest: Partial<Step> = {}): Step =>
      ({ ...base, status, error: null, detail: null, tx_hash: null, ...rest });
    let result: Step;
    try {
      const operation = await signForSponsor(this.context, this.sponsor.address, invocation, this.limits);
      const outcome = await sponsoredInvoke(this.context, this.sponsor, operation, this.journal, scope);
      result = outcome.status === 'success' ? step('paid', { tx_hash: outcome.hash })
        : step('failed', { tx_hash: outcome.hash, error: outcome.code ?? null, detail: `The transaction was ${outcome.status}` });
    } catch (error) {
      if (error instanceof SimulationRejected) {
        result = step('refused', { error: error.code ?? null, detail: error.message });
      } else if (error instanceof SponsorRefused) {
        result = step('refused', { detail: `The sponsor declined: ${error.message}` });
      } else if (error instanceof SubmissionUnsettled || error instanceof SponsorOutcomeUnknown) {
        return step('unsettled', { detail: error.message });
      } else {
        throw error;
      }
    }
    if (result.status === 'refused') {
      await this.report({ kind: 'simulation', status: 'refused', error: result.error, detail: result.detail, tx_hash: null });
    } else if (result.status === 'failed') {
      await this.report({ kind: 'transaction', status: 'failed', error: result.error, detail: result.detail, tx_hash: result.tx_hash });
    }
    return result;
  }

  /** A payment through the wallet's `execute`, with the policy's next sequence and a five-minute deadline. */
  private async execute(wallet: string, policyHash: Hash32, recipient: string, amount: bigint): Promise<Step> {
    const state = await readPolicyState(this.read(wallet), policyHash);
    const now = BigInt((await this.server.getLatestLedger()).closeTime);
    const request = transferRequest({
      wallet, policyHash, sequence: state.next_sequence, deadline: now + 300n, asset: this.deployment.asset.contract,
      recipient, amount,
    });
    return this.submit(executeInvocation(this.context, request, this.agent), `execute:${wallet}`,
      { path: 'execute', amount: fromContractUnits(amount, UNIT_DECIMALS), recipient });
  }

  /** A payment on the account path. The wallet is asked first, because a refusal there has no reason attached. */
  private async account(wallet: string, policyHash: Hash32, amount: bigint, service: boolean): Promise<Step> {
    const { asset, service: demoService, roles } = this.deployment;
    const payment: AccountPayment = {
      wallet, policyHash, asset: asset.contract, recipient: roles.recipient, amount,
      ...(service ? { service: { contract: demoService.contract, service_id: hexToBytes(demoService.service_id) } } : {}),
    };
    const base = {
      path: service ? 'service' as const : 'account' as const, amount: fromContractUnits(amount, UNIT_DECIMALS),
      recipient: roles.recipient,
    };
    try {
      await readPaymentCheck(this.read(wallet), { policy_hash: policyHash, action: accountPaymentAction(payment) });
    } catch (error) {
      if (!(error instanceof WalletError)) throw error;
      const refused: Step = { ...base, status: 'refused', error: error.code, detail: error.message, tx_hash: null };
      await this.report({ kind: 'simulation', status: 'refused', error: error.code, detail: error.message, tx_hash: null });
      return refused;
    }
    return this.submit(accountPaymentInvocation(this.context, payment, this.agent), `account:${wallet}`, base);
  }

  /**
   * Ask a paid API for something and pay what it asks through x402. The wallet can refuse (its policy), and so can
   * the API (its own check on the agent); either way nothing is paid.
   */
  private async x402(wallet: string, policyHash: Hash32, path: string): Promise<Step> {
    const { asset, roles } = this.deployment;
    const client = walletClient({ wallet, policyHash, agent: this.agent, context: this.context, server: this.server });
    const base = { path: 'x402' as const, amount: '?', recipient: roles.recipient };
    const refused = async (error: string | null, detail: string, known: Partial<Step> = {}): Promise<Step> => {
      await this.report({ kind: 'simulation', status: 'refused', error, detail, tx_hash: null });
      return { ...base, ...known, status: 'refused', error, detail, tx_hash: null };
    };
    let paid: Awaited<ReturnType<typeof fetchPaying>>;
    try {
      paid = await fetchPaying(client, new URL(path, this.paidApi()));
    } catch (error) {
      // The wallet said no before anything was signed for the API.
      if (error instanceof WalletError) return refused(error.code, error.message);
      throw error;
    }
    const asked = paid.required?.accepts.find((option) => option.asset === asset.contract) ?? paid.required?.accepts[0];
    const known = asked ? { amount: fromContractUnits(BigInt(asked.amount), UNIT_DECIMALS), recipient: asked.payTo } : {};
    if (paid.response.status === 402) {
      const reason = paid.required?.error ?? null;
      return refused(reason, `The API refused the payment${reason ? `: ${reason}` : ''}`, known);
    }
    if (!paid.response.ok || !paid.settlement?.success) {
      // Paid or not is not known from here; the transaction hash, if there is one, says which.
      return { ...base, ...known, status: 'unsettled', error: paid.settlement?.errorReason ?? null,
        detail: `The API answered ${paid.response.status}`, tx_hash: paid.settlement?.transaction || null };
    }
    const answer = JSON.stringify(await paid.response.json().catch(() => null));
    return { ...base, ...known, status: 'paid', error: null, detail: `The API answered ${answer.slice(0, 200)}`,
      tx_hash: paid.settlement.transaction };
  }

  /** Run one scenario against `wallet` under the policy `policyHash`. Amounts follow the policy as stored. */
  async run(scenarioId: string, wallet: string, policyHash: Hash32): Promise<ScenarioResult> {
    const scenario = SCENARIOS.find(({ id }) => id === scenarioId);
    if (!scenario) throw new UnknownScenario(`Unknown scenario ${scenarioId}`);
    const { asset, roles } = this.deployment;
    const policy = await readPolicy(this.read(wallet), policyHash);
    const limit = policy.assets.find((entry) => entry.asset === asset.contract);
    // A policy without the demo asset still gets an answer: the wallet refuses, and says why.
    const perPayment = limit?.per_transaction ?? this.units('5');
    const within = (value: string) => (this.units(value) < perPayment ? this.units(value) : perPayment);
    const steps: Step[] = [];

    switch (scenario.id) {
      case 'allowed':
        steps.push(await this.execute(wallet, policyHash, roles.recipient, within('3')));
        break;
      case 'over-limit':
        steps.push(await this.execute(wallet, policyHash, roles.recipient, perPayment + this.units('1')));
        break;
      case 'unknown-recipient':
        steps.push(await this.execute(wallet, policyHash, roles.stranger, within('1')));
        break;
      case 'daily-limit': {
        // Pay the largest allowed amount until the wallet refuses: the last step is the one over today's limit.
        for (let i = 0; i < MAX_DAILY_STEPS; i++) {
          const step = await this.execute(wallet, policyHash, roles.recipient, perPayment);
          steps.push(step);
          if (step.status !== 'paid') break;
        }
        break;
      }
      case 'account-transfer':
        steps.push(await this.account(wallet, policyHash, within('1'), false));
        break;
      case 'service':
        steps.push(await this.account(wallet, policyHash, this.units(this.deployment.service.price), true));
        break;
      case 'x402':
        steps.push(await this.x402(wallet, policyHash, PAID_REPORT));
        break;
      case 'x402-strict':
        steps.push(await this.x402(wallet, policyHash, PAID_STRICT));
        break;
      default:
        throw new UnknownScenario(`Unknown scenario ${scenarioId}`);
    }
    return { scenario: scenario.id, expected: scenario.expected, steps };
  }
}
