import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { Address, Asset, Keypair, Operation, xdr } from '@stellar/stellar-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { keypairSigner } from '../../packages/sdk/src/signers.js';
import {
  Sponsor, SponsorRefused, assertSuppliedAuth, httpSponsor, inspectSponsoredOperation, sponsorPolicy,
  type SponsorEndpoint, type SponsorshipResult,
} from '../../packages/sdk/src/sponsor.js';
import {
  MemoryJournal, SimulationRejected, SubmissionUnsettled, type TransactionRecord,
} from '../../packages/sdk/src/transactions.js';
import { RateLimiter, admit, createHandler } from '../../services/submitter/src/index.js';
import { contract } from '../fixtures/abi-v1.js';
import { FakeRpc, success } from './support/fake-rpc.js';

const wallet = contract(31);
const sponsorKey = Keypair.random();
const agent = Keypair.random().publicKey();
const args = [xdr.ScVal.scvU32(1)];
const policy = sponsorPolicy([wallet], { methods: ['execute'], limits: { pollIntervalMs: 0, timeoutSeconds: 5 } });

interface EntryOptions {
  address?: string;
  credentials?: 'address' | 'v2' | 'source';
  signed?: boolean;
  contractId?: string;
  method?: string;
  callArgs?: xdr.ScVal[];
}

function entry(options: EntryOptions = {}) {
  const { address = agent, credentials = 'address', signed = true, contractId = wallet, method = 'execute',
    callArgs = args } = options;
  const body = new xdr.SorobanAddressCredentials({
    address: Address.fromString(address).toScAddress(), nonce: 1n, signatureExpirationLedger: 120,
    signature: signed ? xdr.ScVal.scvVec([xdr.ScVal.scvU32(0)]) : xdr.ScVal.scvVoid(),
  });
  return new xdr.SorobanAuthorizationEntry({
    credentials: credentials === 'source' ? xdr.SorobanCredentials.sorobanCredentialsSourceAccount()
      : credentials === 'v2' ? xdr.SorobanCredentials.sorobanCredentialsAddressV2(body)
        : xdr.SorobanCredentials.sorobanCredentialsAddress(body),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(contractId).toScAddress(), functionName: method, args: callArgs,
      })),
      subInvocations: [],
    }),
  });
}

function operation(auth: xdr.SorobanAuthorizationEntry[], contractId = wallet, method = 'execute') {
  return Operation.invokeContractFunction({ contract: contractId, function: method, args, auth }).toXdr('base64');
}

describe('sponsorship admission', () => {
  it('accepts exactly the configured call carrying signed address entries for it', () => {
    expect(inspectSponsoredOperation(operation([entry()]), sponsorKey.publicKey(), policy))
      .toMatchObject({ contract: wallet, method: 'execute', signers: [agent] });
    expect(inspectSponsoredOperation(operation([entry({ credentials: 'v2' })]), sponsorKey.publicKey(), policy).signers)
      .toEqual([agent]);
  });

  it('refuses everything that would let the sponsor act or pay for something unconfigured', () => {
    const refusals: [string, string][] = [
      ['not-base64!', 'not valid XDR'],
      [Operation.payment({ destination: agent, asset: Asset.native(), amount: '1' }).toXdr('base64'), 'Only contract'],
      [Operation.uploadContractWasm({ wasm: new Uint8Array([0, 97, 115, 109]) }).toXdr('base64'), 'not uploads'],
      [operation([entry({ contractId: contract(32) })], contract(32)), 'not sponsored'],
      [operation([entry({ method: 'withdraw' })], wallet, 'withdraw'), 'Method withdraw'],
      [operation([]), 'signed authorization entries'],
      [operation([entry(), entry(), entry(), entry(), entry()]), 'signed authorization entries'],
      [operation([entry({ credentials: 'source' })]), 'address credentials'],
      [operation([entry({ address: sponsorKey.publicKey() })]), 'sponsor does not authorize'],
      [operation([entry({ signed: false })]), 'unsigned'],
      [operation([entry({ callArgs: [xdr.ScVal.scvU32(2)] })]), 'sponsored contract call'],
      [operation([entry({ contractId: contract(33) })]), 'sponsored contract call'],
    ];
    for (const [encoded, message] of refusals) {
      expect(() => inspectSponsoredOperation(encoded, sponsorKey.publicKey(), policy), message).toThrow(message);
    }
    const sourced = Operation.invokeContractFunction({
      contract: wallet, function: 'execute', args, auth: [entry()], source: agent,
    }).toXdr('base64');
    expect(() => inspectSponsoredOperation(sourced, sponsorKey.publicKey(), policy)).toThrow('source accounts');
  });

  it('refuses an enforced simulation that used authorization the client did not supply', () => {
    const op = xdr.Operation.fromXdr(operation([entry()]), 'base64');
    expect(() => assertSuppliedAuth(op, [entry()])).not.toThrow();
    expect(() => assertSuppliedAuth(op, [entry({ address: sponsorKey.publicKey() })])).toThrow(SponsorRefused);
  });
});

describe('sponsor serialization', () => {
  it('builds the next transaction only after the previous one is final', async () => {
    const rpc = new FakeRpc();
    const events: string[] = [];
    rpc.simulateWith = (tx) => {
      events.push(`build ${tx.sequence}`);
      return success();
    };
    rpc.sendResults.push(
      () => {
        const tx = rpc.sent.at(-1)!;
        events.push(`send ${tx.sequence}`);
        setTimeout(() => {
          events.push(`commit ${tx.sequence}`);
          rpc.commit(tx);
          rpc.sequences.set(sponsorKey.publicKey(), BigInt(tx.sequence));
        }, 20);
        return { status: 'PENDING' } as never;
      },
      () => {
        const tx = rpc.sent.at(-1)!;
        events.push(`send ${tx.sequence}`);
        rpc.commit(tx);
        return { status: 'PENDING' } as never;
      },
    );
    const sponsor = new Sponsor(rpc.context(), keypairSigner(sponsorKey), policy, new MemoryJournal());
    const results = await Promise.all([sponsor.sponsor(operation([entry()])), sponsor.sponsor(operation([entry()]))]);
    expect(results.map(({ status }) => status)).toEqual(['success', 'success']);
    expect(events).toEqual(['build 1001', 'send 1001', 'commit 1001', 'build 1002', 'send 1002']);
  });

  it('blocks new sponsorship while an earlier submission is unsettled, including after a restart', async () => {
    const rpc = new FakeRpc();
    const journal = new MemoryJournal();
    const now = new Date().toISOString();
    const stuck: TransactionRecord = {
      scope: `sponsor:${sponsorKey.publicKey()}`, hash: 'ab'.repeat(32), envelope: '', source: sponsorKey.publicKey(),
      max_time: String(rpc.latest.closeTime + 600), submitted_after_ledger: 100, status: 'pending',
      created_at: now, updated_at: now,
    };
    await journal.put(stuck);
    const sponsor = new Sponsor(rpc.context(), keypairSigner(sponsorKey), policy, journal);
    await expect(sponsor.recover()).rejects.toBeInstanceOf(SubmissionUnsettled);
    await expect(sponsor.sponsor(operation([entry()]))).rejects.toBeInstanceOf(SubmissionUnsettled);
    expect(rpc.sent).toHaveLength(0);
    await expect(sponsor.status('cd'.repeat(32))).rejects.toThrow('Unknown transaction');
    expect((await sponsor.status(stuck.hash)).status).toBe('pending');
  });
});

describe('submitter HTTP adapter', () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  async function start(sponsor: SponsorEndpoint, options: { token?: string; perMinute?: number } = {}) {
    server = createServer(createHandler({
      sponsor: sponsor as Sponsor, policy, network: 'local', token: options.token,
      rateLimit: new RateLimiter(options.perMinute ?? 100),
    }));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/`;
  }

  const record = (status: TransactionRecord['status']): SponsorshipResult => ({
    status, hash: 'ef'.repeat(32), record: { status } as TransactionRecord,
  });

  const fake = (behaviour: () => Promise<SponsorshipResult>): SponsorEndpoint => ({
    address: sponsorKey.publicKey(), sponsor: behaviour, status: behaviour,
  });

  it('reports health, settled and pending outcomes, and maps rejections for the client', async () => {
    let next: () => Promise<SponsorshipResult> = async () => record('success');
    const url = await start(fake(() => next()));
    const health = await (await fetch(new URL('v1/health', url))).json() as Record<string, unknown>;
    expect(health).toMatchObject({ status: 'ok', network: 'local', sponsor: sponsorKey.publicKey(), contracts: [wallet] });

    const client = httpSponsor(url, sponsorKey.publicKey());
    expect((await client.sponsor(operation([entry()]))).status).toBe('success');
    next = async () => record('pending');
    const pending = await fetch(new URL('v1/transactions', url), {
      method: 'POST', body: JSON.stringify({ operation: operation([entry()]) }),
    });
    expect(pending.status).toBe(202);

    next = async () => {
      throw new SimulationRejected('HostError: Error(Contract, #8)');
    };
    const rejection = await client.sponsor(operation([entry()])).catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(SimulationRejected);
    expect(rejection).toHaveProperty('code', 'Revoked');

    next = async () => {
      throw new SubmissionUnsettled(record('pending').record);
    };
    await expect(client.sponsor(operation([entry()]))).rejects.toThrow('settling');

    await expect(client.sponsor(operation([entry({ address: sponsorKey.publicKey() })])))
      .rejects.toThrow('sponsor does not authorize');
    expect(() => client.status('nothex')).toThrow('transaction hash');
  });

  it('enforces the body shape and size, the bearer token and the rate limit', async () => {
    const token = 't'.repeat(40);
    const url = await start(fake(async () => record('success')), { token, perMinute: 3 });
    const post = (body: string, auth = `Bearer ${token}`) => fetch(new URL('v1/transactions', url), {
      method: 'POST', body, headers: { authorization: auth },
    });
    expect((await post('{}', 'Bearer wrong')).status).toBe(401);
    expect((await post('not json')).status).toBe(400);
    expect((await post(JSON.stringify({ operation: operation([entry()]), extra: 1 }))).status).toBe(400);
    expect((await post('x'.repeat(70_000))).status).toBe(413);
    expect((await post(JSON.stringify({ operation: operation([entry()]) }))).status).toBe(429);
  });

  it('admits only a single base64 operation field', () => {
    expect(() => admit('[]', sponsorKey.publicKey(), policy)).toThrow('Expected exactly');
    expect(() => admit(JSON.stringify({ operation: 5 }), sponsorKey.publicKey(), policy)).toThrow('Expected exactly');
    expect(admit(JSON.stringify({ operation: operation([entry()]) }), sponsorKey.publicKey(), policy))
      .toBe(operation([entry()]));
  });

  it('limits each client per minute window', () => {
    let now = 0;
    const limiter = new RateLimiter(2, () => now);
    expect([limiter.allow('a'), limiter.allow('a'), limiter.allow('a'), limiter.allow('b')]).toEqual([true, true, false, true]);
    now = 60_000;
    expect(limiter.allow('a')).toBe(true);
  });
});

