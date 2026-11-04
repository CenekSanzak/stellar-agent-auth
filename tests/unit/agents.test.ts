import { readFileSync } from 'node:fs';
import {
  Address, Keypair, Networks, SorobanDataBuilder, hash, scValToNative, xdr,
} from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import {
  AgentRegistryError, contractErrorName, readAgent, readAgentCount, readCurrent, registryOperation,
  signRegistryAuthorization, validateAgentMetadata,
} from '../../packages/sdk/src/agents.js';
import { decodeIdentity, encodeIdentity, encodeRegistryArgs } from '../../packages/sdk/src/encoding.js';
import {
  CONTRACT_ERRORS, type AgentIdentity, type ContractErrorName, type RegistryArgs, type RegistryAuthMethod,
} from '../../packages/sdk/src/types.js';
import { account, bytes, contract, passphrase } from '../fixtures/abi-v1.js';

const MAX_U64 = (1n << 64n) - 1n;
const prefix = 'https://';
const registry = contract(40);
const controller = Keypair.random();
const signer = Keypair.random();

function codeOf(run: () => unknown): ContractErrorName | 'ok' {
  try {
    run();
    return 'ok';
  } catch (error) {
    if (error instanceof AgentRegistryError) return error.code;
    throw error;
  }
}

describe('metadata validation mirrors the registry contract', () => {
  it.each<[string, string, Uint8Array, ContractErrorName | 'ok']>([
    ['2048-byte URI', prefix + 'a'.repeat(2_040), bytes(1), 'ok'],
    ['shortest https URI', prefix + 'a', bytes(1), 'ok'],
    ['2049-byte URI', prefix + 'a'.repeat(2_041), bytes(1), 'LimitExceeded'],
    ['2049 UTF-8 bytes in 2048 UTF-16 units', prefix + 'a'.repeat(2_039) + 'é', bytes(1), 'LimitExceeded'],
    ['empty URI', '', bytes(1), 'InvalidInput'],
    ['http scheme', 'http://example.test/agent', bytes(1), 'InvalidInput'],
    ['uppercase scheme', 'HTTPS://example.test/agent', bytes(1), 'InvalidInput'],
    ['scheme only', prefix, bytes(1), 'InvalidInput'],
    ['space', `${prefix}example.test/a b`, bytes(1), 'InvalidInput'],
    ['newline', `${prefix}example.test/\n`, bytes(1), 'InvalidInput'],
    ['tab', `${prefix}example.test/\t`, bytes(1), 'InvalidInput'],
    ['DEL', `${prefix}example.test/\x7f`, bytes(1), 'InvalidInput'],
    ['NUL', `${prefix}example.test/\0`, bytes(1), 'InvalidInput'],
    ['non-ASCII', `${prefix}example.test/é`, bytes(1), 'InvalidInput'],
    ['zero hash', `${prefix}example.test/agent`, new Uint8Array(32), 'InvalidInput'],
    ['short hash', `${prefix}example.test/agent`, new Uint8Array(31).fill(1), 'InvalidInput'],
    ['oversized URI before zero hash', prefix + 'a'.repeat(2_041), new Uint8Array(32), 'LimitExceeded'],
  ])('%s', (_, uri, metadataHash, expected) => {
    expect(codeOf(() => validateAgentMetadata(uri, metadataHash))).toBe(expected);
  });

  it('applies the same checks before building register and update_metadata', () => {
    const register: RegistryArgs['register'] = {
      controller: controller.publicKey(), signer: signer.publicKey(), metadata_uri: `${prefix}x`, metadata_hash: bytes(1),
    };
    expect(codeOf(() => registryOperation(registry, 'register', register))).toBe('ok');
    expect(codeOf(() => registryOperation(registry, 'register', { ...register, signer: register.controller })))
      .toBe('InvalidInput');
    expect(codeOf(() => registryOperation(registry, 'register', { ...register, signer: contract(3) })))
      .toBe('InvalidInput');
    expect(codeOf(() => registryOperation(registry, 'update_metadata', {
      agent_id: 1n, expected_revision: 1n, metadata_uri: 'http://x', metadata_hash: bytes(1),
    }))).toBe('InvalidInput');
    expect(codeOf(() => registryOperation(registry, 'rotate_signer', {
      agent_id: 1n, expected_revision: 1n, new_signer: contract(3),
    }))).toBe('InvalidInput');
    expect(() => registryOperation(account(1), 'get', { agent_id: 1n })).toThrow('contract address');
    // The raw encoder stays structural so on-chain validation can be exercised directly.
    expect(encodeRegistryArgs('update_metadata', {
      agent_id: 1n, expected_revision: 1n, metadata_uri: 'http://x', metadata_hash: new Uint8Array(32),
    })).toHaveLength(4);
    expect(() => encodeRegistryArgs('get', { agent_id: MAX_U64 + 1n })).toThrow('u64');
    expect(() => encodeRegistryArgs('toString' as 'get', { agent_id: 1n })).toThrow('Unknown');
  });
});

describe('identity decoding', () => {
  const identity: AgentIdentity = {
    agent_id: MAX_U64, controller: contract(5), signer: account(6), metadata_uri: `${prefix}example.test/agent`,
    metadata_hash: bytes(7), revision: 1n << 63n, disabled: true,
  };
  const encoded = encodeIdentity(identity);
  const entries = encoded.type === 'scvMap' ? encoded.map! : [];
  const withEntries = (next: xdr.ScMapEntry[]) => xdr.ScVal.scvMap(next);
  const replace = (key: string, val: xdr.ScVal) => withEntries(entries.map((entry) =>
    entry.key.toXdr('hex') === xdr.ScVal.scvSymbol(key).toXdr('hex') ? new xdr.ScMapEntry({ key: entry.key, val }) : entry,
  ));

  it('round-trips the canonical encoding', () => {
    const decoded = decodeIdentity(xdr.ScVal.fromXdr(encoded.toXdr()));
    expect(decoded).toEqual(identity);
    expect(encodeIdentity(decoded).toXdr('hex')).toBe(encoded.toXdr('hex'));
  });

  it.each<[string, xdr.ScVal]>([
    ['not a map', xdr.ScVal.scvVec(entries.map(({ val }) => val))],
    ['missing field', withEntries(entries.slice(1))],
    ['extra field', withEntries([...entries, new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('z'), val: xdr.ScVal.scvVoid() })])],
    ['unsorted fields', withEntries([...entries].reverse())],
    ['renamed field', withEntries([new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('agentid'), val: entries[0]!.val }), ...entries.slice(1)])],
    ['u32 agent id', replace('agent_id', xdr.ScVal.scvU32(1))],
    ['i64 revision', replace('revision', xdr.ScVal.scvI64(1n))],
    ['31-byte hash', replace('metadata_hash', xdr.ScVal.scvBytes(new Uint8Array(31)))],
    ['symbol URI', replace('metadata_uri', xdr.ScVal.scvSymbol('https'))],
    ['invalid UTF-8 URI', replace('metadata_uri', xdr.ScVal.scvString(new Uint8Array([0x68, 0xff])))],
    ['oversized URI', replace('metadata_uri', xdr.ScVal.scvString(prefix + 'a'.repeat(2_041)))],
    ['u32 disabled flag', replace('disabled', xdr.ScVal.scvU32(0))],
    ['string signer', replace('signer', xdr.ScVal.scvString(account(6)))],
    ['muxed signer', replace('signer', xdr.ScVal.scvAddress(xdr.ScAddress.scAddressTypeMuxedAccount(
      new xdr.MuxedEd25519Account({ id: 1n, ed25519: bytes(6) }),
    )))],
  ])('rejects %s', (_, value) => {
    expect(() => decodeIdentity(value)).toThrow();
  });
});

describe('contract error names', () => {
  it('match shared_types::errors::Error codes', () => {
    const rust = readFileSync(new URL('../../contracts/shared-types/src/errors.rs', import.meta.url), 'utf8');
    const codes = [...rust.matchAll(/^\s*(\w+) = (\d+),$/gm)].map(([, name, code]) => [name, Number(code)]);
    expect(codes).toEqual(CONTRACT_ERRORS.map((name, i) => [name, i + 1]));
  });

  it.each<[string, ContractErrorName | undefined]>([
    ['HostError: Error(Contract, #9)\n\nEvent log (newest first): ...', 'IdentityChanged'],
    ['Error(Contract, #1)', 'UnsupportedVersion'],
    ['Error(Contract, #13)', 'ArithmeticOverflow'],
    ['Error(Contract, #14)', undefined],
    ['Error(Contract, #0)', undefined],
    ['HostError: Error(Auth, InvalidAction)', undefined],
    // Shape of a real local-network signature failure: the account check quotes a host-internal code.
    ['HostError: Error(Auth, InvalidAction)\n\nEvent log (newest first):\n   0: [Diagnostic Event] topics:[error, '
      + 'Error(Auth, InvalidAction)], data:["failed account authentication with error", GA..., Error(Contract, #5)]', undefined],
    ['Error(Contract, InvalidInput)', undefined],
    ['Error(Contract, 9)', undefined],
  ])('parses %j', (message, expected) => {
    expect(contractErrorName(message)).toBe(expected);
  });
});

describe('registry authorization signing', () => {
  const latestLedger = 1_000;
  const expirationLedger = latestLedger + 20;
  const update: RegistryArgs['update_metadata'] = {
    agent_id: 3n, expected_revision: 2n, metadata_uri: `${prefix}example.test/v2`, metadata_hash: bytes(8),
  };

  function invocation(
    method: string, args: xdr.ScVal[], target = registry, subInvocations: xdr.SorobanAuthorizedInvocation[] = [],
  ) {
    return new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(target).toScAddress(), functionName: method, args,
      })),
      subInvocations,
    });
  }

  function entry(root: xdr.SorobanAuthorizedInvocation, address = controller.publicKey()) {
    return new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(new xdr.SorobanAddressCredentials({
        address: Address.fromString(address).toScAddress(), nonce: 42n, signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      })),
      rootInvocation: root,
    });
  }

  const root = invocation('update_metadata', encodeRegistryArgs('update_metadata', update));
  const input = {
    entry: entry(root), contractId: registry, method: 'update_metadata' as RegistryAuthMethod, args: update,
    address: controller.publicKey(), networkPassphrase: passphrase, latestLedger, expirationLedger, signer: controller,
  };

  it('signs the exact expected call for the configured network and expiry', async () => {
    const signed = await signRegistryAuthorization(input);
    const credentials = signed.credentials;
    if (credentials.type !== 'sorobanCredentialsAddress') throw new Error('Expected address credentials');
    expect(credentials.address.signatureExpirationLedger).toBe(expirationLedger);
    expect(signed.rootInvocation.toXdr('hex')).toBe(root.toXdr('hex'));
    const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(new xdr.HashIdPreimageSorobanAuthorization({
      networkId: hash(new TextEncoder().encode(passphrase)), nonce: 42n,
      signatureExpirationLedger: expirationLedger, invocation: root,
    }));
    const [signature] = scValToNative(credentials.address.signature) as { public_key: Uint8Array; signature: Uint8Array }[];
    expect(Address.account(Buffer.from(signature!.public_key)).toString()).toBe(controller.publicKey());
    expect(controller.verify(Buffer.from(hash(preimage.toXdr())), Buffer.from(signature!.signature))).toBe(true);
    expect(input.entry.credentials.type === 'sorobanCredentialsAddress'
      && input.entry.credentials.address.signature.type).toBe('scvVoid');
  });

  it('signs a register entry for the signer proving control', async () => {
    const register: RegistryArgs['register'] = {
      controller: controller.publicKey(), signer: signer.publicKey(), metadata_uri: `${prefix}x`, metadata_hash: bytes(1),
    };
    const registerRoot = invocation('register', encodeRegistryArgs('register', register));
    await expect(signRegistryAuthorization({
      ...input, entry: entry(registerRoot, signer.publicKey()), method: 'register', args: register,
      address: signer.publicKey(), signer,
    })).resolves.toBeDefined();
  });

  const sourceOnly = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(), rootInvocation: root,
  });
  const updateArgs = (next: Partial<RegistryArgs['update_metadata']>) =>
    encodeRegistryArgs('update_metadata', { ...update, ...next });

  it.each<[string, Partial<typeof input>, string]>([
    ['source-account credentials', { entry: sourceOnly }, 'signing account'],
    ['credential for another address', { entry: entry(root, signer.publicKey()) }, 'signing account'],
    ['contract signing address', { address: contract(9) }, 'signing account'],
    ['subinvocation', { entry: entry(invocation('update_metadata', updateArgs({}), registry, [root])) }, 'single'],
    ['read-only method', { method: 'get' as RegistryAuthMethod }, 'single'],
    ['invalid contract id', { contractId: account(9) }, 'single'],
    ['other contract', { entry: entry(invocation('update_metadata', updateArgs({}), contract(41))) }, 'does not match'],
    ['other method', { entry: entry(invocation('disable', encodeRegistryArgs('disable', update))) }, 'does not match'],
    ['metadata hash', { entry: entry(invocation('update_metadata', updateArgs({ metadata_hash: bytes(9) }))) }, 'does not match'],
    ['metadata URI', { entry: entry(invocation('update_metadata', updateArgs({ metadata_uri: `${prefix}y` }))) }, 'does not match'],
    ['expected revision', { entry: entry(invocation('update_metadata', updateArgs({ expected_revision: 1n }))) }, 'does not match'],
    ['agent id', { entry: entry(invocation('update_metadata', updateArgs({ agent_id: 4n }))) }, 'does not match'],
    ['extra argument', { entry: entry(invocation('update_metadata', [...updateArgs({}), xdr.ScVal.scvVoid()])) }, 'does not match'],
    ['expiry at latest ledger', { expirationLedger: latestLedger }, '20 ledgers'],
    ['expiry beyond window', { expirationLedger: latestLedger + 21 }, '20 ledgers'],
    ['negative latest ledger', { latestLedger: -1 }, '20 ledgers'],
    ['fractional expiry', { expirationLedger: latestLedger + 0.5 }, '20 ledgers'],
  ])('rejects %s before signing', async (_, override, message) => {
    let called = false;
    const spy = async () => { called = true; return new Uint8Array(64); };
    await expect(signRegistryAuthorization({ ...input, ...override, signer: spy })).rejects.toThrow(message);
    expect(called).toBe(false);
  });
});

describe('registry reads', () => {
  const identity: AgentIdentity = {
    agent_id: 2n, controller: controller.publicKey(), signer: signer.publicKey(), metadata_uri: `${prefix}x`,
    metadata_hash: bytes(1), revision: 3n, disabled: false,
  };
  const base = { id: '1', latestLedger: 10, events: [], _parsed: true };
  const reader = (response: object) => ({
    server: { simulateTransaction: async () => response as never },
    contractId: registry, source: Keypair.random().publicKey(), networkPassphrase: Networks.STANDALONE,
  });
  const success = (retval: xdr.ScVal) => reader({
    ...base, transactionData: new SorobanDataBuilder(), minResourceFee: '0', result: { auth: [], retval },
  });

  it('decodes identities and counts', async () => {
    await expect(readAgent(success(encodeIdentity(identity)), 2n)).resolves.toEqual(identity);
    await expect(readCurrent(success(encodeIdentity(identity)), 2n, 3n)).resolves.toEqual(identity);
    await expect(readAgentCount(success(xdr.ScVal.scvU64(7n)))).resolves.toBe(7n);
  });

  it('rejects mismatched results and maps contract errors', async () => {
    await expect(readAgent(success(encodeIdentity(identity)), 1n)).rejects.toThrow('different agent');
    await expect(readCurrent(success(encodeIdentity(identity)), 2n, 2n)).rejects.toThrow('different identity');
    await expect(readCurrent(success(encodeIdentity({ ...identity, disabled: true })), 2n, 3n))
      .rejects.toThrow('different identity');
    for (const [code, name] of [[5, 'NotFound'], [9, 'IdentityChanged'], [8, 'Revoked']] as const) {
      const failure = readCurrent(reader({ ...base, error: `HostError: Error(Contract, #${code})` }), 2n, 3n);
      await expect(failure).rejects.toBeInstanceOf(AgentRegistryError);
      await expect(failure).rejects.toHaveProperty('code', name);
    }
    await expect(readAgent(reader({ ...base, error: 'HostError: Error(Budget, ExceededLimit)' }), 2n))
      .rejects.toThrow('simulation failed');
    await expect(readAgent({ ...success(xdr.ScVal.scvVoid()), source: contract(1) }, 2n)).rejects.toThrow('source');
  });
});
