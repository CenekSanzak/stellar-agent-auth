import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  Address, Asset, BASE_FEE, Contract, Keypair, Networks, Operation, TransactionBuilder,
  authorizeEntry, hash, nativeToScVal, rpc, scValToNative, xdr, type Transaction,
} from '@stellar/stellar-sdk';
import { expect, it } from 'vitest';
import { signActionAuthorization } from '../../packages/sdk/src/actions.js';
import { loadConfig } from '../../packages/sdk/src/config.js';
import {
  actionHash, auditHash, encodeAction, encodeAudit, encodeIdentity, encodePolicy, encodeVerification, policyHash,
} from '../../packages/sdk/src/encoding.js';
import {
  CHECK_KINDS, MAX_ASSETS, MAX_METADATA_URI_BYTES, MAX_RECIPIENTS,
  type ActionRequest, type AgentIdentity, type AuditEntry, type Policy, type Transfer, type VerificationResult,
} from '../../packages/sdk/src/types.js';
import { account, bytes, contract } from '../fixtures/abi-v1.js';
import { assertResourceFit, resourceLimits } from './phase1-resources.js';

function successfulSimulation(response: rpc.Api.SimulateTransactionResponse) {
  if (!rpc.Api.isSimulationSuccess(response) || !response.result) {
    throw new Error('error' in response ? response.error : 'Missing simulation result');
  }
  return { ...response, result: response.result };
}

function assertAuthFailure(simulation: rpc.Api.SimulateTransactionResponse, label: string) {
  expect(simulation, label).toHaveProperty('error');
  expect(simulation, label).toHaveProperty('error', expect.stringMatching(/Error\(Auth,/));
}

function returnValue(result: rpc.Api.GetSuccessfulTransactionResponse) {
  if (!result.returnValue) throw new Error('Missing confirmed return value');
  return result.returnValue;
}

function auditEvent(result: rpc.Api.GetSuccessfulTransactionResponse) {
  const event = result.events.contractEventsXdr.flat().find(({ body }) =>
    body.v0.topics[0]?.toXdr('hex') === xdr.ScVal.scvSymbol('audit_v1').toXdr('hex'),
  );
  if (!event) throw new Error('Missing audit event');
  return event;
}

it('confirms native agent authorization and a sponsor-paid token transfer on local Stellar', async () => {
  const config = loadConfig(process.env);
  const endpoint = new URL(config.rpcUrl);
  expect(config.network).toBe('local');
  expect(['localhost', '127.0.0.1', '[::1]']).toContain(endpoint.hostname);
  const server = new rpc.Server(config.rpcUrl, { allowHttp: true, timeout: 15_000 });
  const network = await server.getNetwork();
  expect(network.passphrase).toBe(Networks.STANDALONE);
  expect(Number(network.protocolVersion)).toBe(29);
  const limits = await resourceLimits(server);
  console.info('Local protocol 29 transaction limits', limits);

  const wasm = readFileSync(new URL('../../target/wasm32v1-none/release/stellar_agent_auth_probe.wasm', import.meta.url));
  const owner = Keypair.random();
  const agent = Keypair.random();
  const sponsor = Keypair.random();
  const recipient = Keypair.random();
  const passphrase = config.passphrase;
  for (const role of [owner, agent, sponsor, recipient]) {
    await server.requestAirdrop(role.publicKey());
  }

  async function build(source: Keypair, operation: xdr.Operation): Promise<Transaction> {
    const account = await server.getAccount(source.publicKey());
    return new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: passphrase })
      .addOperation(operation)
      .setTimeout(120)
      .build();
  }

  const simulate = (tx: Transaction, mode: rpc.Api.SimulationAuthMode) =>
    server.simulateTransaction(tx, undefined, mode, false);

  async function submit(
    tx: Transaction,
    simulation: rpc.Api.SimulateTransactionSuccessResponse,
    signer: Keypair,
  ) {
    const prepared = rpc.assembleTransaction(tx, simulation).build();
    prepared.sign(signer);
    const sent = await server.sendTransaction(prepared);
    if (sent.status !== 'PENDING') {
      throw new Error(`Submission ${sent.status}: ${'errorResult' in sent ? sent.errorResult?.toXdr('base64') : sent.hash}`);
    }
    const confirmed = await server.pollTransaction(sent.hash, { attempts: 30, sleepStrategy: () => 1_000 });
    if (confirmed.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      const details = 'diagnosticEventsXdr' in confirmed
        ? confirmed.diagnosticEventsXdr?.map((event) => event.toXdr('base64')).join(', ')
        : '';
      throw new Error(`Transaction ${sent.hash}: ${confirmed.status} ${details ?? ''}`);
    }
    return { prepared, confirmed };
  }

  async function invoke(source: Keypair, operation: xdr.Operation) {
    const tx = await build(source, operation);
    const simulation = successfulSimulation(await simulate(tx, 'record'));
    return { ...await submit(tx, simulation, source), simulation };
  }

  const wasmHash = hash(wasm);
  await invoke(sponsor, Operation.uploadContractWasm({ wasm }));
  const native = Asset.native();
  const asset = native.contractId(passphrase);
  const sac = new Contract(asset);
  const assetEntry = await server.getLedgerEntries(sac.getFootprint());
  if (!assetEntry.entries.length) await invoke(sponsor, Operation.createStellarAssetContract({ asset: native }));

  const addr = (value: string) => Address.fromString(value).toScVal();
  const deployment = (deployer: Keypair) => Operation.createCustomContract({
    address: Address.fromString(deployer.publicKey()),
    wasmHash,
    salt: randomBytes(32),
    constructorArgs: [addr(owner.publicKey()), addr(agent.publicKey()), addr(asset)],
  });
  const unauthorizedDeploy = await build(sponsor, deployment(sponsor));
  const constructorRecording = successfulSimulation(await simulate(unauthorizedDeploy, 'record_allow_nonroot'));
  expect(constructorRecording.result.auth.map(({ credentials }) => credentials.type)).toContain('sorobanCredentialsAddress');
  assertAuthFailure(await simulate(unauthorizedDeploy, 'enforce'), 'constructor needs the owner');
  async function deploy() {
    const { confirmed } = await invoke(owner, deployment(owner));
    return Address.fromScVal(returnValue(confirmed)).toString();
  }
  const wallet = await deploy();
  const secondWallet = await deploy();

  const now = BigInt((await server.getLatestLedger()).closeTime);
  const policy: Policy = {
    schema_version: 1, policy_id: bytes(1), agent_id: 1n, revision: 1n,
    signer: agent.publicKey(), provider: account(34), required_checks: ['Endpoint', 'Metadata'],
    max_assessment_age: 600n, max_risk_score: 10, assets: [{ asset, per_transaction: 500n, per_day: 1_000n }],
    allowed_recipients: [recipient.publicKey()], blocked_recipients: [],
    valid_after: now, valid_until: now + 3_600n, action_kinds: ['Transfer'], service: null,
  };
  const identity: AgentIdentity = {
    agent_id: policy.agent_id, controller: owner.publicKey(), signer: policy.signer, revision: policy.revision,
    metadata_uri: 'https://example.test/agent', metadata_hash: bytes(2), disabled: false,
  };
  const assessment: VerificationResult = {
    schema_version: 1, agent_id: policy.agent_id, revision: policy.revision, provider: policy.provider, sequence: 1n,
    mode: 'Fixture', checks: policy.required_checks.map((kind) => ({ kind, outcome: 'Passed', score: 1 })),
    risk_score: 1, serious_wallet_risks: 0, evidence_hash: bytes(3), issued_at: now, expires_at: now + 600n, revoked: false,
  };
  const prefix = 'https://example.test/';
  const fullPolicy: Policy = {
    ...policy,
    required_checks: [...CHECK_KINDS].reverse(),
    assets: Array.from({ length: MAX_ASSETS }, (_, i) => ({
      asset: contract(70 - i), per_transaction: (1n << 126n) - 1n, per_day: (1n << 127n) - 1n,
    })),
    allowed_recipients: Array.from({ length: MAX_RECIPIENTS }, (_, i) => account(150 - i)),
    blocked_recipients: Array.from({ length: MAX_RECIPIENTS }, (_, i) => account(200 - i)),
    action_kinds: ['Transfer', 'ServicePayment'],
    service: { contract: contract(222), service_id: bytes(9) },
  };
  const fullIdentity = { ...identity, metadata_uri: prefix + 'a'.repeat(MAX_METADATA_URI_BYTES - prefix.length) };
  const maxAssessment: VerificationResult = {
    ...assessment, checks: CHECK_KINDS.map((kind) => ({ kind, outcome: 'Inconclusive', score: 100 })), risk_score: 100,
  };

  async function measure(label: string, input: Policy, id: AgentIdentity, result: VerificationResult, reverseSets = false) {
    const encodedPolicy = encodePolicy(input);
    if (encodedPolicy.type !== 'scvMap') throw new Error('Expected a policy map');
    // Exercise on-chain normalization even when a caller bypasses the SDK's set ordering.
    const setFields = new Set(['action_kinds', 'allowed_recipients', 'assets', 'blocked_recipients', 'required_checks']);
    const policyVal = reverseSets ? xdr.ScVal.scvMap(encodedPolicy.value!.map((field) => {
      const { key, val } = field;
      if (val.type !== 'scvVec' || !setFields.has(scValToNative(key))) return field;
      return new xdr.ScMapEntry({ key, val: xdr.ScVal.scvVec([...val.value!].reverse()) });
    })) : encodedPolicy;
    const identityVal = encodeIdentity(id);
    const resultVal = encodeVerification(result);
    const { confirmed, prepared, simulation } = await invoke(owner, new Contract(wallet).call(
      'measure', policyVal, identityVal, resultVal,
    ));
    expect(scValToNative(returnValue(confirmed))).toEqual(policyHash(passphrase, wallet, input));
    const events = confirmed.events.contractEventsXdr.flat();
    expect(events).toHaveLength(3);
    expect(events[0]?.body.v0.data.toXdr('hex')).toBe(identityVal.toXdr('hex'));
    expect(events[1]?.body.v0.data.toXdr('hex')).toBe(resultVal.toXdr('hex'));
    console.info(label, {
      policyXdrBytes: policyVal.toXdr().length,
      identityXdrBytes: identityVal.toXdr().length,
      assessmentXdrBytes: resultVal.toXdr().length,
    });
    assertResourceFit(label, simulation, prepared, events, limits);
    return auditEvent(confirmed);
  }

  await measure('maximum policy and assessment', fullPolicy, fullIdentity, maxAssessment, true);
  const policyEvent = await measure('representative policy and assessment', policy, identity, assessment);
  const policyAuditHash = (scValToNative(policyEvent.body.v0.data) as { hash: Uint8Array }).hash;

  const funding = 1_000n;
  await invoke(sponsor, sac.call('transfer', addr(sponsor.publicKey()), addr(wallet), nativeToScVal(funding, { type: 'i128' })));
  const transfer: Transfer = { asset, recipient: recipient.publicKey(), amount: 123n };
  const request: ActionRequest = {
    schema_version: 1,
    wallet,
    policy_hash: policyHash(passphrase, wallet, policy),
    sequence: 0n,
    deadline: now + 900n,
    action: { kind: 'Transfer', transfer },
  };
  const txFor = (
    value: ActionRequest,
    auth: xdr.SorobanAuthorizationEntry[] = [],
    target = wallet,
  ) => build(sponsor, Operation.invokeContractFunction({ contract: target, function: 'execute', args: [encodeAction(value)], auth }));
  const unsigned = await txFor(request);
  const recording = successfulSimulation(await simulate(unsigned, 'record'));
  expect(recording.result.auth).toHaveLength(1);
  const [entry] = recording.result.auth;
  const expirationLedger = recording.latestLedger + 20;
  const signInput = {
    entry: entry!, request, agentAddress: agent.publicKey(), networkPassphrase: passphrase,
    latestLedger: recording.latestLedger, expirationLedger, signer: agent,
  };
  const signed = await signActionAuthorization(signInput);

  const mutations: [string, ActionRequest, string?][] = [
    ['amount', { ...request, action: { kind: 'Transfer', transfer: { ...transfer, amount: 124n } } }],
    ['recipient', { ...request, action: { kind: 'Transfer', transfer: { ...transfer, recipient: owner.publicKey() } } }],
    ['asset', { ...request, action: { kind: 'Transfer', transfer: { ...transfer, asset: contract(66) } } }],
    ['policy hash', { ...request, policy_hash: bytes(80) }],
    ['sequence', { ...request, sequence: 1n }],
    ['deadline', { ...request, deadline: request.deadline + 1n }],
    ['wallet argument', { ...request, wallet: secondWallet }],
    ['target contract', { ...request, wallet: secondWallet }, secondWallet],
  ];
  for (const [label, mutated, target] of mutations) {
    await expect(signActionAuthorization({ ...signInput, request: mutated })).rejects.toThrow('does not match');
    assertAuthFailure(await simulate(await txFor(mutated, [signed], target), 'enforce'), label);
  }
  const sourceOnly = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: entry!.rootInvocation,
  });
  await expect(signActionAuthorization({ ...signInput, entry: sourceOnly })).rejects.toThrow('agent account');
  assertAuthFailure(await simulate(await txFor(request, [sourceOnly]), 'enforce'), 'sponsor only');

  const wrongNetwork = await authorizeEntry(entry!, agent, expirationLedger, Networks.TESTNET);
  assertAuthFailure(await simulate(await txFor(request, [wrongNetwork]), 'enforce'), 'wrong signing network');
  const expired = await authorizeEntry(entry!, agent, recording.latestLedger - 1, passphrase);
  assertAuthFailure(await simulate(await txFor(request, [expired]), 'enforce'), 'expired ledger authorization');
  await expect(signActionAuthorization({ ...signInput, expirationLedger: recording.latestLedger })).rejects.toThrow('20 ledgers');
  await expect(signActionAuthorization({ ...signInput, expirationLedger: expirationLedger + 1 })).rejects.toThrow('20 ledgers');

  const balance = async (who: string) => scValToNative(successfulSimulation(await simulate(
    await build(sponsor, sac.call('balance', addr(who))), 'enforce',
  )).result.retval) as bigint;
  const before = await balance(transfer.recipient);
  expect(await balance(wallet)).toBe(funding);

  const signedTx = await txFor(request, [signed]);
  const enforced = successfulSimulation(await simulate(signedTx, 'enforce'));
  const { confirmed, prepared } = await submit(signedTx, enforced, sponsor);
  expect(prepared.source).toBe(sponsor.publicKey());
  expect(prepared.signatures).toHaveLength(1);
  const expectedActionHash = actionHash(passphrase, request);
  expect(scValToNative(returnValue(confirmed))).toEqual(expectedActionHash);
  expect(await balance(wallet)).toBe(funding - transfer.amount);
  expect(await balance(transfer.recipient)).toBe(before + transfer.amount);
  assertAuthFailure(await simulate(await txFor(request, [signed]), 'enforce'), 'replayed nonce');

  const auditData = auditEvent(confirmed).body.v0.data;
  const audit = scValToNative(auditData) as { hash: Uint8Array };
  const entryExpected: AuditEntry = {
    schema_version: 1, wallet, sequence: 2n, previous_hash: policyAuditHash,
    ledger: confirmed.ledger, timestamp: BigInt(confirmed.createdAt), actor: agent.publicKey(),
    outcome: { kind: 'Executed', policy_hash: request.policy_hash, action_hash: expectedActionHash, action: request.action },
  };
  expect(audit.hash).toEqual(auditHash(passphrase, entryExpected));
  if (auditData.type !== 'scvMap') throw new Error('Expected an audit event map');
  expect(auditData.value?.find(({ key }) => scValToNative(key) === 'entry')?.val.toXdr('hex'))
    .toBe(encodeAudit(entryExpected).toXdr('hex'));
  assertResourceFit('sponsored transfer', enforced, prepared, confirmed.events.contractEventsXdr.flat(), limits);
}, 180_000);
