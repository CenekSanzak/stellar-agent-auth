import type { rpc } from '@stellar/stellar-sdk';
import { WalletError, fromContractUnits, type Hash32, type NetworkContext, type Signer } from '@stellar-agent-auth/sdk';
import { fetchPaying, quote, walletClient } from '@stellar-agent-auth/x402';
import { PRODUCTS, productOf, vendorOf, type Content, type Product, type VendorId } from './catalogue.js';
import type { Deployment } from './deployment.js';

/**
 * Scout, the agent in the demo. It does research errands for the wallet's owner, and each errand means buying
 * something from a seller over x402. It holds the agent key and no money: every purchase is paid by the owner's
 * wallet, if the wallet's policy allows it and the seller accepts the agent.
 *
 * What Scout does is fixed here. A caller picks a task by name and can choose nothing else, so this process cannot
 * be used to sign an arbitrary payment. What happens is not fixed: the wallet and the sellers answer for
 * themselves, and Scout reports what they said.
 *
 * Scout asks the wallet before it signs. A purchase the policy refuses is therefore never sent, has no
 * transaction and leaves nothing on the ledger; it is recorded as an attempt, beside the audit history.
 */

export interface Task {
  id: string;
  label: string;
  description: string;
}

export const TASKS: readonly Task[] = [
  { id: 'brief', label: 'Get today\'s network brief',
    description: 'Scout buys the brief from Ledger Wire for 1.' },
  { id: 'dataset', label: 'Buy the full ledger dataset',
    description: 'Deep Archive asks 8, which is more than the suggested limit for one purchase.' },
  { id: 'cheapest', label: 'Find the cheapest headlines',
    description: 'Scout asks the sellers for their prices and tries the cheapest first, whoever that is.' },
  { id: 'audited', label: 'Get the audited report',
    description: 'Audited Sources sells only to agents whose code was audited. Scout\'s was not.' },
  { id: 'routine', label: 'Catch up on the week',
    description: 'Scout buys digests at 3 each until the wallet says the day\'s allowance is spent.' },
];

export interface Step {
  vendor: VendorId;
  product: string;
  title: string;
  /** What the seller asked, in whole units; `null` if it could not be asked. */
  amount: string | null;
  payee: string | null;
  /**
   * `paid`: bought, with a transaction. `blocked`: the wallet's policy refused, and nothing was sent. `declined`:
   * the seller refused the agent or the payment, and nothing was paid. `unsettled`: sent, and not known to be final;
   * never treat it as refused.
   */
  status: 'paid' | 'blocked' | 'declined' | 'unsettled';
  /** The wallet's error name, or the seller's reason, when one was given. */
  error: string | null;
  detail: string | null;
  tx_hash: string | null;
  content: Content | null;
}

export interface TaskResult {
  task: string;
  /** What Scout did and found, in order, in its own words. Every line states something that happened. */
  notes: string[];
  steps: Step[];
}

export class UnknownTask extends Error {}

/** Records a purchase that did not happen; failing to record one is not the caller's problem. */
export type AttemptReporter = (attempt: {
  kind: 'simulation'; status: 'blocked' | 'declined'; error: string | null; detail: string;
}) => Promise<void>;

const MAX_ROUTINE_PURCHASES = 6;

export class ScoutAgent {
  constructor(
    private readonly deployment: Deployment, private readonly context: NetworkContext,
    private readonly server: Pick<rpc.Server, 'simulateTransaction' | 'getLatestLedger'>,
    private readonly agent: Signer,
    /** Where the sellers are reached; known once the server listens. */
    private readonly market: () => string,
  ) {}

  private units = (amount: string) => fromContractUnits(BigInt(amount), this.deployment.asset.decimals);

  /** Ask one seller what a product costs. Nothing is signed. */
  private async price(client: ReturnType<typeof walletClient>, product: Product) {
    const terms = await quote(client, new URL(product.path, this.market()));
    const asked = terms?.accepts.find((option) => option.asset === this.deployment.asset.contract) ?? terms?.accepts[0];
    return asked ? { amount: this.units(asked.amount), payee: asked.payTo } : undefined;
  }

  /** Try to buy one product. The wallet can refuse, and so can the seller; either way nothing is paid. */
  private async buy(wallet: string, policyHash: Hash32, product: Product, report: AttemptReporter): Promise<Step> {
    const { code } = this.deployment.asset;
    const vendor = vendorOf(product.vendor);
    const client = walletClient({ wallet, policyHash, agent: this.agent, context: this.context, server: this.server });
    const asked = await this.price(client, product);
    const base = {
      vendor: product.vendor, product: product.id, title: product.title, amount: asked?.amount ?? null,
      payee: asked?.payee ?? null, tx_hash: null, content: null,
    };
    const what = `${vendor.name}, ${product.title}${asked ? `, ${asked.amount} ${code}` : ''}`;
    const refused = async (status: 'blocked' | 'declined', error: string | null, detail: string): Promise<Step> => {
      await report({ kind: 'simulation', status, error, detail: `${what}. ${detail}` });
      return { ...base, status, error, detail };
    };

    let paid: Awaited<ReturnType<typeof fetchPaying>>;
    try {
      paid = await fetchPaying(client, new URL(product.path, this.market()));
    } catch (error) {
      // The wallet said no before anything was signed for the seller.
      if (error instanceof WalletError) return refused('blocked', error.code, error.message);
      throw error;
    }
    if (paid.response.status === 402) {
      const reason = paid.required?.error ?? null;
      return refused('declined', reason, reason?.startsWith('payee_gate_')
        ? `${vendor.name} checked the agent and refused to sell.` : `${vendor.name} did not accept the payment.`);
    }
    if (!paid.response.ok || !paid.settlement?.success) {
      // Paid or not is not known from here; the transaction hash, if there is one, says which.
      return {
        ...base, status: 'unsettled', error: paid.settlement?.errorReason ?? null,
        detail: `${vendor.name} answered ${paid.response.status}.`, tx_hash: paid.settlement?.transaction || null,
      };
    }
    const content = await paid.response.json().catch(() => null) as Content | null;
    return { ...base, status: 'paid', error: null, detail: null, tx_hash: paid.settlement.transaction, content };
  }

  /** Run one task for `wallet` under the policy `policyHash`. */
  async run(taskId: string, wallet: string, policyHash: Hash32, report: AttemptReporter): Promise<TaskResult> {
    if (!TASKS.some(({ id }) => id === taskId)) throw new UnknownTask(`Unknown task ${taskId}`);
    const { code } = this.deployment.asset;
    const notes: string[] = [];
    const steps: Step[] = [];
    const say = (step: Step) => {
      const vendor = vendorOf(step.vendor).name;
      const price = step.amount ? ` for ${step.amount} ${code}` : '';
      notes.push(step.status === 'paid' ? `Bought "${step.title}" from ${vendor}${price}.`
        : step.status === 'blocked' ? `The wallet blocked the purchase from ${vendor}${price}: ${step.error ?? 'no reason given'}.`
          : step.status === 'declined' ? `${vendor} refused to sell: ${step.error ?? 'no reason given'}. Nothing was paid.`
            : `The purchase from ${vendor} was sent and is not confirmed yet.`);
    };
    const attempt = async (productId: string) => {
      const step = await this.buy(wallet, policyHash, productOf(productId)!, report);
      steps.push(step);
      say(step);
      return step;
    };

    switch (taskId) {
      case 'brief':
        await attempt('wire-brief');
        break;
      case 'dataset':
        await attempt('archive-ledgers');
        break;
      case 'audited':
        await attempt('audited-report');
        break;
      case 'cheapest': {
        // Ask everyone who sells the day's headlines, then start with whoever asks least.
        const client = walletClient({ wallet, policyHash, agent: this.agent, context: this.context, server: this.server });
        const offers: { product: Product; amount: string }[] = [];
        for (const product of PRODUCTS.filter(({ kind }) => kind === 'brief' || kind === 'headlines')) {
          const asked = await this.price(client, product);
          if (asked) offers.push({ product, amount: asked.amount });
        }
        offers.sort((a, b) => Number(a.amount) - Number(b.amount));
        notes.push(`Asked ${offers.length} sellers for a price: `
          + `${offers.map(({ product, amount }) => `${vendorOf(product.vendor).name} ${amount} ${code}`).join(', ')}.`);
        for (const [index, { product }] of offers.entries()) {
          const step = await attempt(product.id);
          if (step.status === 'paid' || step.status === 'unsettled') break;
          if (index < offers.length - 1) notes.push('Trying the next cheapest.');
        }
        break;
      }
      case 'routine': {
        for (let bought = 0; bought < MAX_ROUTINE_PURCHASES; bought++) {
          const step = await attempt('wire-digest');
          if (step.status !== 'paid') break;
        }
        const count = steps.filter(({ status }) => status === 'paid').length;
        notes.push(`Stopped after ${count} purchase${count === 1 ? '' : 's'}.`);
        break;
      }
      default:
        throw new UnknownTask(`Unknown task ${taskId}`);
    }
    return { task: taskId, notes, steps };
  }
}
