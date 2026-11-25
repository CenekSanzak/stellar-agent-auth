import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { Account, Address, Asset, Keypair, Operation, xdr } from '@stellar/stellar-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_AUTH_WINDOW_LEDGERS } from '../../packages/sdk/src/actions.js';
import { keypairSigner } from '../../packages/sdk/src/signers.js';
import {
  Sponsor, SponsorOutcomeUnknown, SponsorRefused, assertSuppliedAuth, httpSponsor, inspectSponsoredOperation,
  recoverSponsored, sponsorPolicy, sponsoredInvoke, type SponsorEndpoint, type SponsorshipResult,
} from '../../packages/sdk/src/sponsor.js';
import {
  MemoryJournal, SimulationRejected, SubmissionUnsettled, buildTransaction, operationHash, type TransactionRecord,
  type TransactionStatus,
} from '../../packages/sdk/src/transactions.js';
import { RateLimiter, admit, createHandler } from '../../services/submitter/src/index.js';
import { contract } from '../fixtures/abi-v1.js';
import { FakeRpc, hex, success } from './support/fake-rpc.js';

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
  nonce?: bigint;
}

function entry(options: EntryOptions = {}) {
  const { address = agent, credentials = 'address', signed = true, contractId = wallet, method = 'execute',
    callArgs = args, nonce = 1n } = options;
  const body = new xdr.SorobanAddressCredentials({
    address: Address.fromString(address).toScAddress(), nonce, signatureExpirationLedger: 120,
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
    const results = await Promise.all([
      sponsor.sponsor(operation([entry()])), sponsor.sponsor(operation([entry({ nonce: 2n })])),
    ]);
    expect(results.map(({ status }) => status)).toEqual(['success', 'success']);
    expect(events).toEqual(['build 1001', 'send 1001', 'commit 1001', 'build 1002', 'send 1002']);
  });

  it('submits an operation once however often it is sent, and can say what it did with it', async () => {
    const rpc = new FakeRpc();
    const journal = new MemoryJournal();
    const sponsor = new Sponsor(rpc.context(), keypairSigner(sponsorKey), policy, journal);
    const signed = operation([entry()]);
    const key = operationHash(xdr.Operation.fromXdr(signed, 'base64'));
    expect(await sponsor.lookup(key)).toEqual({ status: 'not-submitted' });

    let release = () => {};
    rpc.sendResults.push(() => {
      const tx = rpc.sent.at(-1)!;
      release = () => rpc.commit(tx, xdr.ScVal.scvU32(7));
      return { status: 'PENDING' } as never;
    });
    // The same operation sent twice while the first is in hand: one transaction, one answer.
    const first = sponsor.sponsor(signed);
    const second = sponsor.sponsor(signed);
    expect(await sponsor.lookup(key)).toEqual({ status: 'in-progress' });
    await expect.poll(() => rpc.sent.length).toBe(1);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toMatchObject({ status: 'success', record: { operation_hash: key } });
    expect(b.hash).toBe(a.hash);

    // Sent again afterwards, and after a restart on the same journal: still that one transaction.
    expect((await sponsor.sponsor(signed)).hash).toBe(a.hash);
    const restarted = new Sponsor(rpc.context(), keypairSigner(sponsorKey), policy, journal);
    expect((await restarted.sponsor(signed)).hash).toBe(a.hash);
    expect(await restarted.lookup(key)).toMatchObject({ status: 'success', hash: a.hash });
    expect(rpc.sent).toHaveLength(1);
    await expect(sponsor.lookup('nope')).rejects.toBeInstanceOf(SponsorRefused);
  });

  it('builds a new transaction for an operation only when the earlier one can never be included', async () => {
    const rpc = new FakeRpc();
    const journal = new MemoryJournal();
    const sponsor = new Sponsor(rpc.context(), keypairSigner(sponsorKey), policy, journal);
    const signed = operation([entry()]);
    rpc.sendResults.push(() => ({ status: 'ERROR', errorResult: undefined }) as never);
    expect((await sponsor.sponsor(signed)).status).toBe('rejected');
    rpc.sendResults.push(() => {
      rpc.commit(rpc.sent.at(-1)!);
      return { status: 'PENDING' } as never;
    });
    expect((await sponsor.sponsor(signed)).status).toBe('success');
    expect(rpc.sent).toHaveLength(2);
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

describe('sponsored client', () => {
  const scope = 'execute:a';
  const signedOperation = () => xdr.Operation.fromXdr(operation([entry()]), 'base64');

  /** The transaction an honest sponsor builds around `operationXdr`, and the report it sends back. */
  function sponsored(rpc: FakeRpc, operationXdr: string, source = sponsorKey.publicKey()) {
    const tx = buildTransaction(rpc.context(), new Account(source, '1000'),
      xdr.Operation.fromXdr(operationXdr, 'base64'), policy.limits);
    const now = new Date().toISOString();
    const report = (status: TransactionStatus, overrides: Partial<TransactionRecord> = {}): SponsorshipResult => ({
      status, hash: hex(tx.hash()),
      record: {
        scope: 'sponsor', hash: hex(tx.hash()), envelope: tx.toXDR(), source: tx.source,
        max_time: tx.timeBounds!.maxTime, submitted_after_ledger: 100, status, created_at: now, updated_at: now,
        ...overrides,
      },
    });
    return { tx, report };
  }
  const endpoint = (sponsor: SponsorEndpoint['sponsor'], lookup?: SponsorEndpoint['lookup']): SponsorEndpoint => ({
    address: sponsorKey.publicKey(), sponsor, status: async () => {
      throw new Error('unused');
    },
    ...(lookup ? { lookup } : {}),
  });
  const quick = { lookupWaitMs: 0 };

  it('settles the transaction it can tie to its own operation, read from the network', async () => {
    const rpc = new FakeRpc();
    const journal = new MemoryJournal();
    const outcome = await sponsoredInvoke(rpc.context(), endpoint(async (operationXdr) => {
      const { tx, report } = sponsored(rpc, operationXdr);
      rpc.commit(tx, xdr.ScVal.scvU32(7));
      return report('success');
    }), signedOperation(), journal, scope);
    expect(outcome).toMatchObject({ status: 'success', record: { scope, status: 'success', source: sponsorKey.publicKey() } });
    expect(outcome.returnValue?.toXdr('base64')).toBe(xdr.ScVal.scvU32(7).toXdr('base64'));
    expect((await journal.get(outcome.hash))?.status).toBe('success');
  });

  it('does not accept another transaction passed off as this one', async () => {
    const rpc = new FakeRpc();
    const cases: [string, (operationXdr: string) => SponsorshipResult][] = [
      ['another committed operation', () => {
        const other = sponsored(rpc, operation([entry({ callArgs: [xdr.ScVal.scvU32(2)] })]));
        rpc.commit(other.tx);
        return other.report('success');
      }],
      ['a different source', (operationXdr) => {
        const other = sponsored(rpc, operationXdr, Keypair.random().publicKey());
        rpc.commit(other.tx);
        return other.report('success');
      }],
      ['a hash that is not the envelope\'s', (operationXdr) => {
        const { report } = sponsored(rpc, operationXdr);
        const forged = report('success');
        return { ...forged, record: { ...forged.record, hash: 'cd'.repeat(32) } };
      }],
      ['no readable envelope', (operationXdr) => sponsored(rpc, operationXdr).report('success', { envelope: 'AAAA' })],
    ];
    for (const [label, answer] of cases) {
      const journal = new MemoryJournal();
      const error = await sponsoredInvoke(rpc.context(), endpoint(async (operationXdr) => answer(operationXdr)),
        signedOperation(), journal, scope).catch((thrown: unknown) => thrown);
      expect(error, label).toBeInstanceOf(SponsorOutcomeUnknown);
      expect(error, label).toMatchObject({ expirationLedger: 120 });
      expect(journal.records.size, label).toBe(0);
    }
  });

  it('counts a reported rejection or success only once the network shows it', async () => {
    const rpc = new FakeRpc();
    for (const status of ['rejected', 'expired', 'success'] as const) {
      const journal = new MemoryJournal();
      // The sponsor claims the envelope is dead (or applied) and backdates its time bound; it is still includable.
      const error = await sponsoredInvoke(rpc.context(), endpoint(async (operationXdr) =>
        sponsored(rpc, operationXdr).report(status, { max_time: '1' })), signedOperation(), journal, scope)
        .catch((thrown: unknown) => thrown);
      expect(error, status).toBeInstanceOf(SubmissionUnsettled);
      const [pending] = await journal.unsettled(scope);
      expect(pending, status).toMatchObject({ status: 'pending', submitted_after_ledger: 100 });
      expect(Number(pending!.max_time), status).toBeGreaterThan(rpc.latest.closeTime);
    }
  });

  it('recovers a lost answer by asking the sponsor about the operation, and still checks what comes back', async () => {
    const rpc = new FakeRpc();
    const journal = new MemoryJournal();
    const key = operationHash(signedOperation());
    let report: SponsorshipResult | undefined;
    // The sponsor submits, and its answer is lost on the way back.
    const lossy = async (operationXdr: string) => {
      const built = sponsored(rpc, operationXdr);
      rpc.commit(built.tx, xdr.ScVal.scvU32(7));
      report = built.report('success');
      throw new TypeError('fetch failed');
    };
    const asked: string[] = [];
    const outcome = await sponsoredInvoke(rpc.context(), endpoint(lossy, async (hash) => {
      asked.push(hash);
      return asked.length < 2 ? { status: 'in-progress' } : report!;
    }), signedOperation(), journal, scope, quick);
    expect(asked).toEqual([key, key]);
    expect(outcome).toMatchObject({ status: 'success', record: { scope, operation_hash: key } });

    // A sponsor that says it submitted nothing has refused: nothing is journaled and the caller may sign again.
    const empty = new MemoryJournal();
    await expect(sponsoredInvoke(rpc.context(), endpoint(async () => {
      throw new TypeError('fetch failed');
    }, async () => ({ status: 'not-submitted' })), signedOperation(), empty, scope, quick))
      .rejects.toThrow('submitted nothing for this operation');
    expect(empty.records.size).toBe(0);

    // One that cannot say, never finishes, or passes off another transaction leaves the outcome unknown.
    const other = sponsored(rpc, operation([entry({ callArgs: [xdr.ScVal.scvU32(2)] })])).report('success');
    for (const lookup of [
      async () => { throw new Error('Submitter cannot look up operations (HTTP 404)'); },
      async () => ({ status: 'in-progress' as const }),
      async () => other,
    ]) {
      const error = await sponsoredInvoke(rpc.context(), endpoint(async () => {
        throw new TypeError('fetch failed');
      }, lookup), signedOperation(), empty, scope, quick).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(SponsorOutcomeUnknown);
      expect(error).toMatchObject({ expirationLedger: 120, operationHash: key });
    }
    expect(empty.records.size).toBe(0);
  });

  it('recovers from the operation hash alone, in another process', async () => {
    const rpc = new FakeRpc();
    const journal = new MemoryJournal();
    const signed = operation([entry()]);
    const key = operationHash(signedOperation());
    const built = sponsored(rpc, signed);
    rpc.commit(built.tx, xdr.ScVal.scvU32(7));
    const found = endpoint(async () => { throw new Error('unused'); }, async () => built.report('success'));
    const outcome = await recoverSponsored(rpc.context(), found, key, journal, `recovered:${key}`, { waitMs: 0 });
    expect(outcome).toMatchObject({ status: 'success', record: { operation_hash: key, source: sponsorKey.publicKey() } });
    // The earliest ledger comes from the signatures, never from the sponsor's report, which said 100 here: they
    // expire at 120 and were signed at most the longest authorization window before that.
    expect(outcome.record.submitted_after_ledger).toBe(120 - MAX_AUTH_WINDOW_LEDGERS - 1);

    const other = sponsored(rpc, operation([entry({ callArgs: [xdr.ScVal.scvU32(2)] })])).report('success');
    await expect(recoverSponsored(rpc.context(), endpoint(async () => other, async () => other), key, journal, 'r', { waitMs: 0 }))
      .rejects.toThrow('other than the one this client signed');
    await expect(recoverSponsored(rpc.context(), endpoint(async () => other, async () => ({ status: 'not-submitted' })), key,
      journal, 'r', { waitMs: 0 })).rejects.toBeInstanceOf(SponsorRefused);
    await expect(recoverSponsored(rpc.context(), endpoint(async () => other), key, journal, 'r', { waitMs: 0 }))
      .rejects.toBeInstanceOf(SponsorOutcomeUnknown);
    await expect(recoverSponsored(rpc.context(), found, 'short', journal, 'r')).rejects.toThrow('operation hash');
  });

  it('treats a sponsor that does not answer as an unknown outcome, and a refusal as a refusal', async () => {
    const rpc = new FakeRpc();
    const journal = new MemoryJournal();
    const lost = await sponsoredInvoke(rpc.context(), endpoint(async () => {
      throw new TypeError('fetch failed');
    }), signedOperation(), journal, scope).catch((thrown: unknown) => thrown);
    expect(lost).toBeInstanceOf(SponsorOutcomeUnknown);
    expect(lost).toMatchObject({ expirationLedger: 120, message: expect.stringContaining('until ledger 120') });
    for (const refusal of [new SponsorRefused('no'), new SimulationRejected('HostError: Error(Contract, #8)')]) {
      await expect(sponsoredInvoke(rpc.context(), endpoint(async () => {
        throw refusal;
      }), signedOperation(), journal, scope)).rejects.toBe(refusal);
    }
    expect(journal.records.size).toBe(0);
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
    // Busy is a refusal: nothing was built for this request.
    const busy = await client.sponsor(operation([entry()])).catch((error: unknown) => error);
    expect(busy).toBeInstanceOf(SponsorRefused);
    expect(busy).toHaveProperty('message', expect.stringContaining('settling'));

    // A server error may follow a submission, so the client must not read it as "nothing was sent".
    next = async () => {
      throw new Error('journal write failed');
    };
    const crashed = await client.sponsor(operation([entry()])).catch((error: unknown) => error);
    expect(crashed).toBeInstanceOf(Error);
    expect(crashed).not.toBeInstanceOf(SponsorRefused);

    await expect(client.sponsor(operation([entry({ address: sponsorKey.publicKey() })])))
      .rejects.toThrow('sponsor does not authorize');
    expect(() => client.status('nothex')).toThrow('transaction hash');
  });

  it('answers what it did with an operation, in a way a client cannot mistake for a missing route', async () => {
    let answer: Awaited<ReturnType<NonNullable<SponsorEndpoint['lookup']>>> = { status: 'not-submitted' };
    const url = await start({ ...fake(async () => record('success')), lookup: async () => answer });
    const client = httpSponsor(url, sponsorKey.publicKey());
    const key = 'ab'.repeat(32);
    expect(await client.lookup!(key)).toEqual({ status: 'not-submitted' });
    answer = { status: 'in-progress' };
    expect((await fetch(new URL(`v1/operations/${key}`, url))).status).toBe(202);
    expect(await client.lookup!(key)).toEqual({ status: 'in-progress' });
    answer = record('success');
    expect(await client.lookup!(key)).toMatchObject({ status: 'success', hash: 'ef'.repeat(32) });
    answer = record('pending');
    expect((await fetch(new URL(`v1/operations/${key}`, url))).status).toBe(202);
    await expect(client.lookup!('short')).rejects.toThrow('operation hash');

    // An older submitter has no such route. Its 404 is "cannot say", never "nothing was submitted".
    const old = createServer((_request, response) => {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'Not found' }));
    });
    old.listen(0, '127.0.0.1');
    await once(old, 'listening');
    try {
      const address = old.address();
      const legacy = httpSponsor(`http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/`,
        sponsorKey.publicKey());
      await expect(legacy.lookup!(key)).rejects.toThrow('cannot look up operations');
    } finally {
      old.close();
    }
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

