import { randomBytes } from 'node:crypto';
import {
  Address, Asset, BASE_FEE, Keypair, Operation, TransactionBuilder, rpc, scValToNative, xdr,
} from '@stellar/stellar-sdk';
import { expect } from 'vitest';
import { MAX_AUTH_WINDOW_LEDGERS, signActionAuthorization } from '../../../packages/sdk/src/actions.js';
import { registryOperation, signRegistryAuthorization } from '../../../packages/sdk/src/agents.js';
import { contractErrorName } from '../../../packages/sdk/src/contract-call.js';
import { signingAddress } from '../../../packages/sdk/src/credentials.js';
import {
  auditHash, decodeIdentity, encodeAction, encodeAudit, encodeRegistryArgs, encodeVerificationConstructorArgs,
  encodeWalletArgs, encodeWalletConstructorArgs,
} from '../../../packages/sdk/src/encoding.js';
import { transferRequest } from '../../../packages/sdk/src/policies.js';
import type {
  ActionRequest, AgentIdentity, AuditHead, AuditOutcome, ContractErrorName, Hash32, Policy, WalletArgs,
  WalletOwnerMethod,
} from '../../../packages/sdk/src/types.js';
import { verificationOperation } from '../../../packages/sdk/src/verification.js';
import {
  readAuditHead, readPolicyState, readWalletBalance, signFundingAuthorization, signWalletAuthorization,
  walletOperation, type WalletRead,
} from '../../../packages/sdk/src/wallet.js';
import { fixtureResult } from '../../fixtures/verification.js';
import {
  contractEvents, localNetwork, readWasm, returnValue, successfulSimulation, type Confirmed, type LocalNetwork,
} from './local-network.js';

type Entry = xdr.SorobanAuthorizationEntry;

/** Contract units per whole asset unit: Stellar assets have seven decimals. */
export const UNIT = 10_000_000n;
export const DAY = 86_400n;

/**
 * A complete local deployment for wallet tests: both registries, a registered agent with a passing SIMULATED fixture
 * result from an approved fixture provider, an issued test asset with its Stellar Asset Contract, and a wallet the
 * owner deployed and a funder funded. Every role is a separate runtime-generated, Friendbot-funded account; the
 * sponsor only pays fees and signs envelopes.
 */
export async function walletWorld() {
  const net = await localNetwork();
  const roles = {
    admin: Keypair.random(), owner: Keypair.random(), controller: Keypair.random(), signer: Keypair.random(),
    sponsor: Keypair.random(), provider: Keypair.random(), funder: Keypair.random(), issuer: Keypair.random(),
    recipient: Keypair.random(), stranger: Keypair.random(), attacker: Keypair.random(),
  };
  const { admin, owner, controller, signer, sponsor, provider, funder, issuer, recipient, stranger, attacker } = roles;
  await net.fund(...Object.values(roles));

  /** Classic operations, which have no Soroban simulation, signed by every key in `signers`. */
  async function classic(source: Keypair, operations: xdr.Operation[], signers: Keypair[] = [source]) {
    const account = await net.server.getAccount(source.publicKey());
    const builder = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: net.passphrase });
    operations.forEach((operation) => builder.addOperation(operation));
    const tx = builder.setTimeout(120).build();
    tx.sign(...signers);
    const sent = await net.server.sendTransaction(tx);
    if (sent.status !== 'PENDING') throw new Error(`Classic submission ${sent.status}`);
    const confirmed = await net.server.pollTransaction(sent.hash, { attempts: 30, sleepStrategy: () => 1_000 });
    if (confirmed.status !== rpc.Api.GetTransactionStatus.SUCCESS) throw new Error(`Classic ${sent.hash} failed`);
  }

  // Registries, provider and agent.
  const agentRegistry = await net.deploy(sponsor, readWasm('agent_registry'));
  const verificationRegistry = await net.deploy(admin, readWasm('verification_registry'),
    encodeVerificationConstructorArgs(admin.publicKey(), agentRegistry));
  await net.invoke(admin, verificationOperation(verificationRegistry, 'approve_provider', {
    provider: provider.publicKey(), mode: 'Fixture',
  }));
  const registration = {
    controller: controller.publicKey(), signer: signer.publicKey(),
    metadata_uri: 'https://agent.example.test/wallet-agent.json', metadata_hash: new Uint8Array(32).fill(4),
  };
  const recording = successfulSimulation(await net.simulate(
    await net.build(controller, registryOperation(agentRegistry, 'register', registration)), 'record'));
  const registryAuth = await Promise.all(recording.result.auth.map((entry) => signingAddress(entry) === undefined
    ? entry
    : signRegistryAuthorization({
      entry, contractId: agentRegistry, method: 'register', args: registration, address: signer.publicKey(),
      networkPassphrase: net.passphrase, latestLedger: recording.latestLedger,
      expirationLedger: recording.latestLedger + MAX_AUTH_WINDOW_LEDGERS, signer,
    })));
  const registerTx = await net.build(controller, Operation.invokeContractFunction({
    contract: agentRegistry, function: 'register', args: encodeRegistryArgs('register', registration),
    auth: registryAuth,
  }));
  const registered = await net.submit(registerTx, successfulSimulation(await net.simulate(registerTx, 'enforce')),
    controller);
  const agent: AgentIdentity = decodeIdentity(returnValue(registered.confirmed));

  const ledgerTime = async () => BigInt((await net.server.getLatestLedger()).closeTime);
  const publishFixture = async (scenario: Parameters<typeof fixtureResult>[0], sequence: bigint) => {
    const now = await ledgerTime();
    const result = fixtureResult(scenario, {
      agent_id: agent.agent_id, revision: agent.revision, provider: provider.publicKey(), sequence,
      issued_at: now, expires_at: now + 30n * DAY,
    });
    await net.invoke(provider, verificationOperation(verificationRegistry, 'publish', { result }));
    return result;
  };
  await publishFixture('passing', 1n);

  // An issued test asset: holders trust it, the issuer pays the funder, and the asset contract is deployed.
  const code = `P4${randomBytes(3).toString('hex').toUpperCase()}`;
  const credit = new Asset(code, issuer.publicKey());
  for (const holder of [funder, recipient, stranger, attacker, owner]) {
    await classic(holder, [Operation.changeTrust({ asset: credit })]);
  }
  await classic(issuer, [Operation.payment({ destination: funder.publicKey(), asset: credit, amount: '10000' })]);
  await net.invoke(sponsor, Operation.createStellarAssetContract({ asset: credit }));
  const asset = credit.contractId(net.passphrase);

  // The owner deploys its own wallet; the constructor requires the owner's authorization.
  const walletWasm = readWasm('smart_wallet');
  const constructorArgs = encodeWalletConstructorArgs(owner.publicKey(), agentRegistry, verificationRegistry);
  const wallet = await net.deploy(owner, walletWasm, constructorArgs);
  const read: WalletRead = {
    server: net.server, contractId: wallet, source: sponsor.publicKey(), networkPassphrase: net.passphrase,
  };

  const window = (latestLedger: number) => ({ latestLedger, expirationLedger: latestLedger + MAX_AUTH_WINDOW_LEDGERS });

  /** A wallet call from `source` (the sponsor by default) carrying `auth`. */
  const walletTx = (method: string, args: xdr.ScVal[], auth: Entry[] = [], source = sponsor) =>
    net.build(source, Operation.invokeContractFunction({ contract: wallet, function: method, args, auth }));

  /** The owner signs exactly `method(args)` through the SDK validator. */
  async function ownerAuth<M extends WalletOwnerMethod>(method: M, args: WalletArgs[M], key = owner) {
    const rec = successfulSimulation(await net.simulate(
      await net.build(sponsor, walletOperation(wallet, method, args)), 'record'));
    expect(rec.result.auth.map(signingAddress), method).toEqual([owner.publicKey()]);
    return Promise.all(rec.result.auth.map((entry) => signWalletAuthorization({
      entry, contractId: wallet, method, args, address: owner.publicKey(), networkPassphrase: net.passphrase,
      ...window(rec.latestLedger), signer: key,
    })));
  }

  /** A hand-built owner entry for `method(args)`, signed by `key` through the SDK validator. */
  async function ownerAuthByHand<M extends WalletOwnerMethod>(method: M, args: WalletArgs[M], key = owner) {
    const latestLedger = await net.latestLedger();
    const entry = unsignedEntry(owner.publicKey(), wallet, method, encodeWalletArgs(method, args));
    return [await signWalletAuthorization({
      entry, contractId: wallet, method, args, address: owner.publicKey(), networkPassphrase: net.passphrase,
      ...window(latestLedger), signer: key,
    })];
  }

  /** An owner call signed by the owner, enforced and submitted by the sponsor. */
  async function ownerCall<M extends WalletOwnerMethod>(method: M, args: WalletArgs[M]) {
    const auth = await ownerAuth(method, args);
    const tx = await walletTx(method, encodeWalletArgs(method, args), auth);
    return net.submit(tx, successfulSimulation(await net.simulate(tx, 'enforce')), sponsor);
  }

  /** The funder signs exactly the transfer into the wallet; the sponsor submits. */
  async function fund(amount: bigint, from = funder) {
    const args = { from: from.publicKey(), asset, amount };
    const rec = successfulSimulation(await net.simulate(
      await net.build(sponsor, walletOperation(wallet, 'fund', args)), 'record'));
    const auth = await Promise.all(rec.result.auth.map((entry) => signFundingAuthorization({
      entry, contractId: wallet, args, networkPassphrase: net.passphrase, ...window(rec.latestLedger), signer: from,
    })));
    const tx = await walletTx('fund', encodeWalletArgs('fund', args), auth);
    return net.submit(tx, successfulSimulation(await net.simulate(tx, 'enforce')), sponsor);
  }

  /** The agent signer signs `request` through the SDK validator; returns the entries and their expiry. */
  async function agentAuth(request: ActionRequest, key = signer, source = sponsor) {
    const rec = successfulSimulation(await net.simulate(
      await net.build(source, walletOperation(wallet, 'execute', { request })), 'record'));
    expect(rec.result.auth.map(signingAddress)).toEqual([signer.publicKey()]);
    const { expirationLedger } = window(rec.latestLedger);
    const auth = await Promise.all(rec.result.auth.map((entry) => signActionAuthorization({
      entry, request, agentAddress: signer.publicKey(), networkPassphrase: net.passphrase,
      ...window(rec.latestLedger), signer: key,
    })));
    return { auth, expirationLedger };
  }

  /**
   * A hand-built agent entry for `request`, signed through the same SDK validator. Recording mode returns no entries
   * for a call the contract rejects, so rejection tests sign this way; the entry is what recording would produce.
   */
  async function agentAuthByHand(request: ActionRequest, key = signer, passphrase = net.passphrase) {
    const latestLedger = await net.latestLedger();
    const entry = unsignedEntry(signer.publicKey(), request.wallet, 'execute', [encodeAction(request)]);
    return [await signActionAuthorization({
      entry, request, agentAddress: signer.publicKey(), networkPassphrase: passphrase, ...window(latestLedger),
      signer: key,
    })];
  }

  /** `execute(request)` with `auth`, simulated with enforcement; the raw argument may differ from the signed one. */
  const enforceExecute = async (auth: Entry[], argument: xdr.ScVal, source = sponsor) =>
    net.simulate(await walletTx('execute', [argument], auth, source), 'enforce');

  /** The full agent path: sign, enforce, submit by the sponsor and confirm. */
  async function execute(request: ActionRequest) {
    const { auth } = await agentAuth(request);
    const tx = await walletTx('execute', [encodeAction(request)], auth);
    const enforced = successfulSimulation(await net.simulate(tx, 'enforce'));
    return { ...await net.submit(tx, enforced, sponsor), enforced };
  }

  /** A correctly signed request the wallet must reject with `code`, before anything is submitted. */
  async function expectRejected(request: ActionRequest, code: ContractErrorName, label: string) {
    const auth = await agentAuthByHand(request);
    expectContractError(await enforceExecute(auth, encodeAction(request)), code, label);
  }

  const policy = async (id: number, overrides: Partial<Policy> = {}): Promise<Policy> => {
    const now = await ledgerTime();
    return {
      schema_version: 1, policy_id: new Uint8Array(32).fill(id), agent_id: agent.agent_id, revision: agent.revision,
      signer: signer.publicKey(), provider: provider.publicKey(),
      required_checks: ['Endpoint', 'Metadata', 'SignerAccount'], max_assessment_age: 30n * DAY, max_risk_score: 10,
      assets: [{ asset, per_transaction: 5n * UNIT, per_day: 20n * UNIT }],
      allowed_recipients: [recipient.publicKey()], blocked_recipients: [],
      valid_after: now - 60n, valid_until: now + 7n * DAY, action_kinds: ['Transfer'], service: null,
      ...overrides,
    };
  };

  const approve = async (value: Policy): Promise<Hash32> => {
    const { confirmed } = await ownerCall('approve_policy', { policy: value });
    return Uint8Array.from(scValToNative(returnValue(confirmed)) as Buffer);
  };

  const payment = async (policyHash: Hash32, sequence: bigint, amount: bigint, to = recipient.publicKey()) =>
    transferRequest({
      wallet, policyHash, sequence, deadline: await ledgerTime() + 600n, asset, recipient: to, amount,
    });

  /** The asset balance of an account or contract, read from the asset contract. */
  const balanceOf = async (holder: string) => {
    const tx = await net.build(sponsor, Operation.invokeContractFunction({
      contract: asset, function: 'balance', args: [Address.fromString(holder).toScVal()],
    }));
    return scValToNative(successfulSimulation(await net.simulate(tx, 'record')).result.retval) as bigint;
  };

  const snapshot = async (policyHash: Hash32) => ({
    state: await readPolicyState(read, policyHash),
    head: await readAuditHead(read),
    wallet: await readWalletBalance(read, asset),
    recipient: await balanceOf(recipient.publicKey()),
  });

  /**
   * Asserts that `confirmed` appended exactly `outcomes` to the audit chain after `before`, as `actor`: each
   * `audit_v1` event carries the entry the SDK rebuilds byte for byte, linked to its predecessor, with the SDK's
   * hash. Returns the new head, which must equal the stored one.
   */
  async function expectAudit(confirmed: Confirmed, before: AuditHead, actor: string, outcomes: AuditOutcome[]) {
    const events = contractEvents(confirmed).filter(({ contractId, body }) =>
      contractId && Address.contract(contractId.value).toString() === wallet
      && body.v0.topics[0]?.toXdr('hex') === xdr.ScVal.scvSymbol('audit_v1').toXdr('hex'));
    expect(events).toHaveLength(outcomes.length);
    let head = before;
    outcomes.forEach((outcome, i) => {
      const { topics, data } = events[i]!.body.v0;
      const sequence = head.sequence + 1n;
      expect(scValToNative(topics[1]!)).toBe(sequence);
      const fields = new Map((data.type === 'scvMap' ? data.map ?? [] : [])
        .map(({ key, val }) => [key.type === 'scvSymbol' ? key.sym.toString() : '', val]));
      const entry = fields.get('entry')!;
      const recorded = new Map((entry.type === 'scvMap' ? entry.map ?? [] : [])
        .map(({ key, val }) => [key.type === 'scvSymbol' ? key.sym.toString() : '', val]));
      const expected = {
        schema_version: 1, wallet, sequence, previous_hash: head.hash, actor, outcome,
        ledger: scValToNative(recorded.get('ledger')!) as number,
        timestamp: scValToNative(recorded.get('timestamp')!) as bigint,
      };
      expect(expected.ledger).toBe(confirmed.ledger);
      expect(entry.toXdr('hex')).toBe(encodeAudit(expected).toXdr('hex'));
      const hash = auditHash(net.passphrase, expected);
      expect(Uint8Array.from(scValToNative(fields.get('hash')!) as Buffer)).toEqual(hash);
      head = { sequence, hash };
    });
    expect(await readAuditHead(read)).toEqual(head);
    return head;
  }

  return {
    net, roles, agentRegistry, verificationRegistry, agent, asset, credit, wallet, walletWasm, constructorArgs, read,
    classic, ledgerTime, publishFixture, walletTx, ownerAuth, ownerAuthByHand, ownerCall, fund, agentAuth, agentAuthByHand,
    enforceExecute, execute,
    expectRejected, policy, approve, payment, balanceOf, snapshot, expectAudit,
  };
}

export type WalletWorld = Awaited<ReturnType<typeof walletWorld>>;

/** What recording mode returns for a native account authorizing `contract.method(args)` with no sub-calls. */
export function unsignedEntry(address: string, contract: string, method: string, args: xdr.ScVal[]) {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(new xdr.SorobanAddressCredentials({
      address: Address.fromString(address).toScAddress(), nonce: randomBytes(8).readBigInt64BE(),
      signatureExpirationLedger: 0, signature: xdr.ScVal.scvVoid(),
    })),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(contract).toScAddress(), functionName: method, args,
      })),
      subInvocations: [],
    }),
  });
}
export type { LocalNetwork };

export function expectContractError(
  simulation: rpc.Api.SimulateTransactionResponse, code: ContractErrorName, label: string,
) {
  expect('error' in simulation ? contractErrorName(simulation.error) : 'success', label).toBe(code);
}
