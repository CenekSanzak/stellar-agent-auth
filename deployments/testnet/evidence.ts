/**
 * The acceptance scenario on the kept Testnet deployment: one payment the owner's rules allow, and payments they
 * refuse because they are over the limit, to a recipient that was not approved, made while the wallet is paused,
 * and made after the allowance was revoked.
 *
 *   npm run build
 *   node deployments/testnet/evidence.ts
 *   node deployments/testnet/evidence.ts --market https://stellar-agent-wallet.fly.dev --out deployments/testnet/evidence.json
 *
 * Anyone can run it. It uses only what is public: the Testnet Friendbot, the deployment the hosted service
 * describes at `/v1/config`, and that service's agent setup, verifier and test-asset faucet. It creates a new
 * owner, a new agent and a new wallet each time. Keys are generated into the git-ignored
 * `.local/testnet-evidence/<run>/` and nothing but public addresses and transaction hashes is written to the record.
 *
 * Every refusal is shown twice. First the network is asked: the payment is simulated, and the wallet contract
 * answers with its reason. Then the same signed payment is submitted anyway, so that there is a transaction on the
 * ledger to look at: it fails there, for the same reason, and moves nothing.
 *
 * A payment the wallet refuses cannot be simulated, so the network will not say what ledger entries it needs.
 * The refused payment is therefore sent with the entries a payment the wallet would make needs, which are the
 * same ones: the two differ in an amount or a recipient, or in what the owner has done since.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { rpc, xdr } from '@stellar/stellar-sdk';
import { initAgent, keyReference } from '@stellar-agent-auth/mcp';
import {
  MemoryJournal, SimulationRejected, assemble, authSigner, authWindow, buildTransaction, deployedAddress, encodeAction,
  executeInvocation, fromContractUnits, invoke, keypairSigner, loadSource, networkContext, ownerInvocation,
  pipelineLimits, policyHash, readAgent, readAssetBalance, readCurrentResult, readIndexedHistory, readPolicyState,
  readWalletBalance, signActionAuthorization, simulate, submit, toContractUnits, transferRequest, walletDeployment,
  walletOperation, withAuth,
  type ActionRequest, type ContractErrorName, type Hash32, type Policy, type Signer, type Simulated,
} from '@stellar-agent-auth/sdk';
import { createNamedKey, isMainModule, loadKey, loadKeypair } from '@stellar-agent-auth/sdk/node';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DAY = 86_400n;

/** What the hosted service says about its deployment, as far as this scenario needs it. */
interface Config {
  network: string; rpc_url: string; passphrase: string; explorer?: string | null; indexer_path: string;
  agent_registry: string; verification_registry: string; wallet_wasm_hash: string; wallet_salt: string;
  asset: { contract: string; code: string; issuer: string; decimals: number };
  provider: { address: string; mode: string };
  vendors: { id: string; name: string; address: string }[];
  faucet_amount: string;
}

export interface Step {
  step: string;
  /** `success`: on the ledger and applied. `failed`: on the ledger, refused by the wallet, nothing moved. */
  outcome: 'success' | 'failed';
  transaction: string;
  ledger: number | null;
  /** The transaction in the network's explorer, where the service names one. */
  link: string | null;
  amount?: string;
  recipient?: string;
  /** The wallet's reason, read from the failed transaction. */
  error?: ContractErrorName;
  /** The wallet's reason when the same payment was simulated first. */
  simulated_error?: ContractErrorName;
  /** What the wallet held before and after, in whole units. */
  wallet_balance?: { before: string; after: string };
  /** What the recipient held before and after, for the payment that was made. */
  recipient_balance?: { before: string; after: string };
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const fromHex = (value: string) => Uint8Array.from(Buffer.from(value, 'hex'));

export async function runEvidence(options: {
  market: string;
  out: string;
  /** Where this run's keys go; a new directory under `.local/testnet-evidence` unless given. */
  directory?: string;
  log?: (line: string) => void;
}) {
  const log = options.log ?? console.log;
  const base = new URL(options.market.endsWith('/') ? options.market : `${options.market}/`);
  const config = await (await fetch(new URL('v1/config', base))).json() as Config;
  // The scenario is the same on a local network, which is where its own test runs it.
  if (config.network !== 'testnet' && config.network !== 'local') throw new Error(`${base.origin} is on ${config.network}, not on Testnet`);
  const post = async <T>(path: string, body: unknown) => {
    const response = await fetch(new URL(path, base), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const answer = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(`${path} answered ${response.status}: ${answer.error ?? ''}`);
    return answer;
  };

  const run = new Date().toISOString().replace(/[:.]/g, '-');
  const directory = options.directory ?? resolve(ROOT, '.local/testnet-evidence', run);
  const env = { ...process.env, STELLAR_AGENT_AUTH_KEY_DIR: join(directory, 'keys') };
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const server = new rpc.Server(config.rpc_url, { timeout: 30_000, allowHttp: config.network === 'local' });
  const context = await networkContext(server, config.passphrase);
  const journal = new MemoryJournal();
  const limits = pipelineLimits({ maxFee: 100_000_000n });
  const link = (transaction: string) => (config.explorer ? `${config.explorer}/tx/${transaction}` : null);
  const units = (amount: string) => toContractUnits(amount, config.asset.decimals);
  const whole = (amount: bigint) => fromContractUnits(amount, config.asset.decimals);

  // Two accounts of this run's own: the owner of the wallet, and a relayer that only pays fees and submits what
  // the agent signed. Neither is known to the hosted service.
  log(`Run ${run}: keys in ${join(directory, 'keys')}`);
  const accounts = {} as Record<'owner' | 'relayer', Signer>;
  for (const role of ['owner', 'relayer'] as const) {
    await createNamedKey(role, env);
    accounts[role] = keypairSigner(await loadKeypair(role, env));
    // A busy Friendbot answers 500; asking again is safe, since it does nothing for an account that exists.
    for (let attempt = 1; ; attempt++) {
      try {
        await server.requestAirdrop(accounts[role].address);
        break;
      } catch (error) {
        if (attempt >= 6) throw error;
        await new Promise((retry) => setTimeout(retry, 1_000 * attempt));
      }
    }
  }
  const { owner, relayer } = accounts;
  const read = { server, source: relayer.address, networkPassphrase: config.passphrase };

  log('1. An agent is created, registered and verified, as `stellar-agent-wallet init` does it');
  const home = join(directory, 'agent');
  const requested = (await server.getLatestLedger()).sequence;
  const created = await initAgent({
    market: base.href, owner: owner.address, name: 'Acceptance agent',
    description: 'An agent made by the acceptance scenario in deployments/testnet/evidence.ts', home,
  });
  if ('error' in created.verification) throw new Error(`The agent was not verified: ${created.verification.error}`);
  const agent = await loadKey(keyReference(home, 'agent'), env);
  const agentId = BigInt(created.agent_id);
  const identity = await readAgent({ ...read, contractId: config.agent_registry }, agentId);
  const result = await readCurrentResult({ ...read, contractId: config.verification_registry },
    { agent_id: agentId, revision: identity.revision, provider: config.provider.address });
  const publication = config.network === 'testnet' ? await publicationOf(config, agentId, requested).catch(() => undefined) : undefined;

  log('2. The owner creates the wallet, and the service\'s faucet puts test money in it');
  const wallet = deployedAddress(config.passphrase, owner.address, fromHex(config.wallet_salt));
  if (wallet !== created.wallet) throw new Error('The service names a different wallet for this owner');
  const deployed = await invoke(context, owner, walletDeployment(config.passphrase, owner.address,
    fromHex(config.wallet_wasm_hash), config.agent_registry, config.verification_registry, fromHex(config.wallet_salt)),
  journal, { limits });
  if (deployed.status !== 'success') throw new Error(`The wallet was not created: ${deployed.status}`);
  const funded = await post<{ status: string; tx_hash: string; amount: string }>('v1/fund', { owner: owner.address });
  if (funded.status !== 'success') throw new Error(`The faucet answered ${funded.status}`);
  const walletRead = { ...read, contractId: wallet };
  const balance = async () => whole(await readWalletBalance(walletRead, config.asset.contract));

  log('3. The owner approves an allowance: 5 a payment, 20 a day, one recipient, seven days');
  const vendor = (id: string) => {
    const found = config.vendors.find((candidate) => candidate.id === id);
    if (!found) throw new Error(`The service lists no seller ${id}`);
    return found;
  };
  const approved = vendor('ledger-wire');
  const unapproved = vendor('bargain-data');
  const now = BigInt((await server.getLatestLedger()).closeTime);
  const policy: Policy = {
    schema_version: 1, policy_id: Uint8Array.from(randomBytes(32)), agent_id: agentId, revision: identity.revision,
    signer: agent.address, provider: config.provider.address, required_checks: ['Metadata', 'SignerAccount'],
    max_assessment_age: 30n * DAY, max_risk_score: 10,
    assets: [{ asset: config.asset.contract, per_transaction: units('5'), per_day: units('20'), total: null }],
    allowed_recipients: [approved.address], blocked_recipients: [],
    valid_after: now - 60n, valid_until: now + 7n * DAY, action_kinds: ['Transfer'], service: null,
  };
  const approval = await invoke(context, owner, ownerInvocation(context, wallet, 'approve_policy', { policy }, owner),
    journal, { limits });
  if (approval.status !== 'success') throw new Error(`The allowance was not approved: ${approval.status}`);
  const hash: Hash32 = policyHash(config.passphrase, wallet, policy);

  const steps: Step[] = [];
  const payment = async (sequence: bigint, amount: string, recipient: string): Promise<ActionRequest> => transferRequest({
    wallet, policyHash: hash, sequence, deadline: BigInt((await server.getLatestLedger()).closeTime) + 600n,
    asset: config.asset.contract, recipient, amount: units(amount),
  });
  const ownerStep = async (step: string, method: 'pause' | 'resume' | 'revoke_policy') => {
    const outcome = method === 'revoke_policy'
      ? await invoke(context, owner, ownerInvocation(context, wallet, method, { policy_hash: hash }, owner), journal, { limits })
      : await invoke(context, owner, ownerInvocation(context, wallet, method, {}, owner), journal, { limits });
    if (outcome.status !== 'success') throw new Error(`${step}: ${outcome.status}`);
    steps.push({ step, outcome: 'success', transaction: outcome.hash, ledger: outcome.record.ledger ?? null, link: link(outcome.hash) });
  };

  /**
   * A payment the agent signs, simulated with enforcement but not submitted: the signed operation, and what the
   * network says a payment of this shape needs.
   */
  async function signed(request: ActionRequest) {
    const operation = walletOperation(wallet, 'execute', { request });
    const account = await loadSource(context, relayer.address);
    const recording = await simulate(context, buildTransaction(context, account, operation, limits), 'record');
    const [recorded] = recording.result.auth;
    if (!recorded || recording.result.auth.length !== 1) throw new Error('Expected one authorization entry, the agent\'s');
    const window = authWindow(recording.latestLedger, limits);
    const sign = (entry: xdr.SorobanAuthorizationEntry, of: ActionRequest) => signActionAuthorization({
      entry, request: of, agentAddress: agent.address, networkPassphrase: config.passphrase, ...window, signer: authSigner(agent),
    });
    const authorized = withAuth(operation, [await sign(recorded, request)]);
    const needs = await simulate(context, buildTransaction(context, account, authorized, limits), 'enforce');
    /** Another payment, signed by the agent in the same way and under the same nonce, so that it needs the same entries. */
    const instead = async (other: ActionRequest) => {
      const call = recorded.rootInvocation.function;
      if (call.type !== 'sorobanAuthorizedFunctionTypeContractFn') throw new Error('Expected a contract call');
      const entry = new xdr.SorobanAuthorizationEntry({
        credentials: xdr.SorobanAuthorizationEntry.fromXdr(recorded.toXdr('base64'), 'base64').credentials,
        rootInvocation: new xdr.SorobanAuthorizedInvocation({
          function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(new xdr.InvokeContractArgs({
            contractAddress: call.contractFn.contractAddress, functionName: 'execute',
            args: [encodeAction(other)],
          })),
          subInvocations: [],
        }),
      });
      return withAuth(walletOperation(wallet, 'execute', { request: other }), [await sign(entry, other)]);
    };
    return { operation: authorized, needs, instead };
  }

  /** Ask the network about a signed payment, then submit it whatever the answer, and record what the ledger did. */
  async function refused(
    step: string, operation: xdr.Operation, needs: Simulated, paid: { amount: string; recipient: string }, expected: ContractErrorName,
  ) {
    const before = await balance();
    const tx = buildTransaction(context, await loadSource(context, relayer.address), operation, limits);
    const simulated = await simulate(context, tx, 'enforce').then(() => undefined, (error: unknown) => {
      if (!(error instanceof SimulationRejected)) throw error;
      return error.code;
    });
    if (simulated !== expected) throw new Error(`${step}: the simulation answered ${simulated ?? 'that it would pay'}, not ${expected}`);
    const outcome = await submit(context, await relayer.signTransaction(assemble(tx, needs, limits), config.passphrase),
      journal, `source:${relayer.address}`, limits);
    if (outcome.status !== 'failed') throw new Error(`${step}: the transaction was ${outcome.status}, not failed`);
    const after = await balance();
    if (after !== before) throw new Error(`${step}: the wallet's balance changed`);
    const entry: Step = {
      step, outcome: 'failed', transaction: outcome.hash, ledger: outcome.record.ledger ?? null, link: link(outcome.hash),
      ...paid, simulated_error: simulated,
      ...(outcome.code ? { error: outcome.code } : {}), wallet_balance: { before, after },
    };
    steps.push(entry);
    log(`   refused on the ledger: ${outcome.code ?? simulated} (${outcome.hash})`);
  }

  log('4. A payment inside the allowance: 3 to the approved recipient');
  {
    const before = await balance();
    const held = async () => whole(await readAssetBalance(read, config.asset.contract, approved.address));
    const recipientBefore = await held();
    const request = await payment(1n, '3', approved.address);
    const outcome = await invoke(context, relayer, executeInvocation(context, request, agent), journal, { limits });
    if (outcome.status !== 'success') throw new Error(`The allowed payment was ${outcome.status}${outcome.code ? ` (${outcome.code})` : ''}`);
    steps.push({
      step: 'A payment inside the allowance', outcome: 'success', transaction: outcome.hash,
      ledger: outcome.record.ledger ?? null, link: link(outcome.hash), amount: '3', recipient: approved.address,
      wallet_balance: { before, after: await balance() },
      recipient_balance: { before: recipientBefore, after: await held() },
    });
    log(`   paid (${outcome.hash})`);
  }

  log('5. A payment over the limit: 8, where one payment may be 5 at most');
  {
    const usual = await signed(await payment(2n, '3', approved.address));
    const request = await payment(2n, '8', approved.address);
    await refused('A payment over the limit', await usual.instead(request), usual.needs,
      { amount: '8', recipient: approved.address }, 'PaymentLimitExceeded');
  }

  log('6. A payment to a recipient the owner did not approve');
  {
    const usual = await signed(await payment(2n, '3', approved.address));
    const request = await payment(2n, '3', unapproved.address);
    await refused('A payment to an unapproved recipient', await usual.instead(request), usual.needs,
      { amount: '3', recipient: unapproved.address }, 'RecipientNotAllowed');
  }

  log('7. The owner pauses the wallet; a payment signed before the pause is refused; the owner resumes');
  {
    const waiting = await signed(await payment(2n, '3', approved.address));
    await ownerStep('The owner pauses the wallet', 'pause');
    await refused('A payment while the wallet is paused', waiting.operation, waiting.needs,
      { amount: '3', recipient: approved.address }, 'Paused');
    await ownerStep('The owner resumes the wallet', 'resume');
  }

  log('8. The owner revokes the allowance; a payment signed before the revocation is refused');
  {
    const waiting = await signed(await payment(2n, '3', approved.address));
    await ownerStep('The owner revokes the allowance', 'revoke_policy');
    await refused('A payment after revocation', waiting.operation, waiting.needs,
      { amount: '3', recipient: approved.address }, 'Revoked');
  }

  log('9. What is left: the balances, the allowance\'s state and the wallet\'s record');
  const state = await readPolicyState(walletRead, hash);
  let history = await readIndexedHistory(walletRead, new URL(config.indexer_path.replace(/^\//, ''), base).href);
  // The hosted indexer reads the ledger every few seconds.
  for (let attempt = 0; history.status !== 'verified' && attempt < 12; attempt++) {
    await new Promise((retry) => setTimeout(retry, 5_000));
    history = await readIndexedHistory(walletRead, new URL(config.indexer_path.replace(/^\//, ''), base).href);
  }

  const record = {
    generated_at: new Date().toISOString(),
    service: base.origin,
    network: config.network,
    passphrase: config.passphrase,
    protocol: Number((await server.getNetwork()).protocolVersion),
    contracts: {
      agent_registry: config.agent_registry, verification_registry: config.verification_registry,
      wallet, wallet_wasm_hash: config.wallet_wasm_hash,
      asset: { ...config.asset },
    },
    accounts: {
      owner: owner.address, relayer: relayer.address, agent_signer: agent.address, agent_controller: identity.controller,
      provider: config.provider.address, approved_recipient: approved.address, unapproved_recipient: unapproved.address,
    },
    agent: {
      agent_id: created.agent_id, revision: identity.revision.toString(), metadata_uri: identity.metadata_uri,
      metadata_sha256: hex(identity.metadata_hash),
      ...(created.registration_transaction
        ? { registration: { transaction: created.registration_transaction, link: link(created.registration_transaction) } } : {}),
    },
    verification: {
      provider_mode: config.provider.mode, sequence: result.sequence.toString(), risk_score: result.risk_score,
      issued_at: new Date(Number(result.issued_at) * 1_000).toISOString(),
      expires_at: new Date(Number(result.expires_at) * 1_000).toISOString(),
      checks: result.checks.map(({ kind, outcome }) => ({ kind, outcome })),
      ...(publication ? { publication: { transaction: publication, link: link(publication) } } : {}),
    },
    wallet_created: { transaction: deployed.hash, link: link(deployed.hash) },
    wallet_funded: { transaction: funded.tx_hash, link: link(funded.tx_hash), amount: funded.amount },
    allowance: {
      policy_hash: hex(hash), transaction: approval.hash, link: link(approval.hash),
      per_payment: '5', per_day: '20', recipients: [approved.address],
      valid_until: new Date(Number(policy.valid_until) * 1_000).toISOString(), required_checks: policy.required_checks,
    },
    steps,
    end: {
      wallet_balance: await balance(),
      spent_under_the_allowance: whole(state.total_spend.find(({ asset }) => asset === config.asset.contract)?.amount ?? 0n),
      allowance_revoked: state.revoked,
      history: { status: history.status, detail: history.detail, entries: history.entries.length, read_from: `${base.origin}${config.indexer_path}` },
    },
  };
  await writeFile(options.out, `${JSON.stringify(record, null, 2)}\n`);
  log(`Done. The wallet holds ${record.end.wallet_balance} ${config.asset.code}; its record is ${history.status}. Written to ${options.out}`);
  return record;
}

/**
 * The transaction in which the provider published its result for `agentId`, found among the provider's recent
 * operations. The hosted verifier does not report it, and the registry publishes no event for it.
 */
async function publicationOf(config: Config, agentId: bigint, sinceLedger: number): Promise<string | undefined> {
  const horizon = 'https://horizon-testnet.stellar.org';
  const response = await fetch(`${horizon}/accounts/${config.provider.address}/operations?order=desc&limit=20`);
  if (!response.ok) return undefined;
  const page = await response.json() as {
    _embedded: { records: { type: string; function?: string; transaction_hash: string; transaction_successful: boolean; parameters?: { value: string }[] }[] };
  };
  for (const operation of page._embedded.records) {
    if (operation.type !== 'invoke_host_function' || !operation.transaction_successful) continue;
    const values = (operation.parameters ?? []).map(({ value }) => xdr.ScVal.fromXdr(value, 'base64'));
    if (values[1]?.type !== 'scvSymbol' || values[1].sym.toString() !== 'publish') continue;
    // The result is a map; its agent is one of the fields.
    const fields = values[2]?.type === 'scvMap' ? values[2].map ?? [] : [];
    const named = fields.find(({ key }) => key.type === 'scvSymbol' && key.sym.toString() === 'agent_id')?.val;
    if (named?.type !== 'scvU64' || BigInt(named.u64.toString()) !== agentId) continue;
    const tx = await (await fetch(`${horizon}/transactions/${operation.transaction_hash}`)).json() as { ledger: number };
    if (tx.ledger >= sinceLedger) return operation.transaction_hash;
  }
  return undefined;
}

if (isMainModule(import.meta.url)) {
  const { values } = parseArgs({ options: { market: { type: 'string' }, out: { type: 'string' } } });
  runEvidence({
    market: values.market ?? 'https://stellar-agent-wallet.fly.dev',
    out: resolve(values.out ?? join(ROOT, 'deployments/testnet/evidence.json')),
  }).catch((error: unknown) => {
    console.error(`evidence: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
