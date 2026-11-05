import {
  Account, Contract, Keypair, TransactionBuilder, authorizeEntry, hash, xdr, type Transaction,
} from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { fromContractUnits, toContractUnits } from '../../packages/sdk/src/amounts.js';
import { deployedAddress } from '../../packages/sdk/src/client.js';
import {
  auditHash, decodeAction, decodeAudit, decodeAuditEvent, encodeAction, encodeAudit,
} from '../../packages/sdk/src/encoding.js';
import { CONTRACT_ERROR_HELP, contractErrorCode, explainContractError } from '../../packages/sdk/src/errors.js';
import { verifyAuditChain, type AuditRecord } from '../../packages/sdk/src/history.js';
import {
  authSigner, keypairSigner, toBase64, walletAdapterSigner, type WalletAdapter,
} from '../../packages/sdk/src/signers.js';
import { CONTRACT_ERRORS, type AuditEntry, type AuditOutcome } from '../../packages/sdk/src/types.js';
import { account, action, audit, bytes, contract, passphrase, wallet } from '../fixtures/abi-v1.js';

const owner = Keypair.random();

function transaction(): Transaction {
  return new TransactionBuilder(new Account(owner.publicKey(), '10'), { fee: '100', networkPassphrase: passphrase })
    .addOperation(new Contract(contract(5)).call('pause')).setTimeout(60).build();
}

/** A SEP-43 wallet holding `key`, optionally misbehaving. */
function adapter(key: Keypair, behaviour: 'honest' | 'alter' | 'wrong-key' | 'bad-auth' = 'honest'): WalletAdapter {
  return {
    async signTransaction(envelope, { networkPassphrase }) {
      const tx = TransactionBuilder.fromXDR(envelope, networkPassphrase) as Transaction;
      if (behaviour === 'alter') {
        const altered = new TransactionBuilder(new Account(owner.publicKey(), '10'), { fee: '100000', networkPassphrase })
          .addOperation(new Contract(contract(6)).call('withdraw')).setTimeout(60).build();
        altered.sign(key);
        return { signedTxXdr: altered.toXDR() };
      }
      tx.sign(behaviour === 'wrong-key' ? Keypair.random() : key);
      return { signedTxXdr: tx.toXDR() };
    },
    async signAuthEntry(preimage) {
      const payload = hash(Buffer.from(preimage, 'base64'));
      const signer = behaviour === 'bad-auth' ? Keypair.random() : key;
      return { signedAuthEntry: toBase64(signer.sign(payload)) };
    },
  };
}

describe('signers', () => {
  it('adds exactly one verified signature from a browser wallet and nothing else', async () => {
    const tx = transaction();
    const before = tx.hash();
    const signed = await walletAdapterSigner(adapter(owner), owner.publicKey(), passphrase).signTransaction(tx, passphrase);
    expect(signed.hash()).toEqual(before);
    expect(signed.signatures).toHaveLength(1);
  });

  it('refuses a wallet that alters the transaction, signs with another key or uses another network', async () => {
    const signer = (behaviour: Parameters<typeof adapter>[1]) =>
      walletAdapterSigner(adapter(owner, behaviour), owner.publicKey(), passphrase);
    await expect(signer('alter').signTransaction(transaction(), passphrase)).rejects.toThrow('different transaction');
    await expect(signer('wrong-key').signTransaction(transaction(), passphrase)).rejects.toThrow('no valid signature');
    await expect(signer('honest').signTransaction(transaction(), 'Test SDF Network ; September 2015'))
      .rejects.toThrow('different network');
    expect(() => walletAdapterSigner(adapter(owner), contract(1), passphrase)).toThrow('standard account');
  });

  it('signs authorization entries through a browser wallet only with a verified signature', async () => {
    const entry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(new xdr.SorobanAddressCredentials({
        address: xdr.ScAddress.scAddressTypeAccount(xdr.PublicKey.publicKeyTypeEd25519(owner.rawPublicKey())),
        nonce: 3n, signatureExpirationLedger: 0, signature: xdr.ScVal.scvVoid(),
      })),
      rootInvocation: new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(new xdr.InvokeContractArgs({
          contractAddress: xdr.ScAddress.scAddressTypeContract(new xdr.ContractId(bytes(5))), functionName: 'pause',
          args: [],
        })),
        subInvocations: [],
      }),
    });
    const honest = authSigner(walletAdapterSigner(adapter(owner), owner.publicKey(), passphrase));
    const signed = await authorizeEntry(entry, honest, 50, passphrase);
    expect(signed.credentials.type === 'sorobanCredentialsAddress' && signed.credentials.address.signature.type)
      .toBe('scvVec');
    const bad = authSigner(walletAdapterSigner(adapter(owner, 'bad-auth'), owner.publicKey(), passphrase));
    await expect(authorizeEntry(entry, bad, 50, passphrase)).rejects.toThrow('invalid authorization signature');
    await expect(authSigner(keypairSigner(owner))(xdr.HashIdPreimage.envelopeTypeContractId(
      new xdr.HashIdPreimageContractId({
        networkId: hash(Buffer.from(passphrase)),
        contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(new xdr.ContractIdPreimageFromAddress({
          address: xdr.ScAddress.scAddressTypeContract(new xdr.ContractId(bytes(5))), salt: bytes(1),
        })),
      }),
    ), bytes(2))).rejects.toThrow('payload mismatch');
  });
});

describe('amounts', () => {
  it('converts decimals exactly in both directions', () => {
    expect(toContractUnits('3', 7)).toBe(30_000_000n);
    expect(toContractUnits('0.0000001', 7)).toBe(1n);
    expect(toContractUnits('17014118346046923173168730371588.4105727', 7)).toBe((1n << 127n) - 1n);
    expect(fromContractUnits(30_000_000n, 7)).toBe('3');
    expect(fromContractUnits(1n, 7)).toBe('0.0000001');
    expect(fromContractUnits(-15n, 1)).toBe('-1.5');
    expect(fromContractUnits(5n, 0)).toBe('5');
    for (const value of ['20', '0.25', '9007199254740993.1234567']) {
      expect(fromContractUnits(toContractUnits(value, 7), 7)).toBe(value);
    }
  });

  it('refuses rounding, signs, exponents and overflow', () => {
    for (const value of ['0.00000001', '-1', '1e3', '1,5', '', '.5', '17014118346046923173168730371588.4105728']) {
      expect(() => toContractUnits(value, 7), value).toThrow();
    }
    expect(() => toContractUnits('1', 39)).toThrow('decimals');
  });
});

describe('errors and addresses', () => {
  it('explains every v1 error with its stable code', () => {
    expect(Object.keys(CONTRACT_ERROR_HELP)).toEqual([...CONTRACT_ERRORS]);
    expect(contractErrorCode('TransferFailed')).toBe(14);
    expect(explainContractError('Revoked')).toMatch(/^Revoked \(#8\): /);
  });

  it('derives the address createCustomContract assigns', () => {
    const deployer = account(9);
    const salt = bytes(3);
    expect(deployedAddress(passphrase, deployer, salt)).toMatch(/^C/);
    expect(deployedAddress(passphrase, deployer, salt)).not.toBe(deployedAddress(passphrase, deployer, bytes(4)));
  });
});

describe('audit decoding and chain verification', () => {
  it('decodes actions and audit entries strictly', () => {
    expect(decodeAction(encodeAction(action))).toEqual(action);
    expect(decodeAudit(encodeAudit(audit))).toEqual(audit);
    const outcomes: AuditOutcome[] = [
      { kind: 'PolicyCreated', policy_hash: bytes(1) }, { kind: 'PolicyRevoked', policy_hash: bytes(2) },
      { kind: 'PauseChanged', paused: true },
      { kind: 'OwnerWithdrawal', transfer: { asset: contract(3), recipient: account(4), amount: 5n } },
    ];
    for (const outcome of outcomes) expect(decodeAudit(encodeAudit({ ...audit, outcome })).outcome).toEqual(outcome);
    const encoded = encodeAudit(audit);
    const entries = encoded.type === 'scvMap' ? encoded.map ?? [] : [];
    expect(() => decodeAudit(xdr.ScVal.scvMap(entries.slice(1)))).toThrow('AuditEntry');
    const event = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('entry'), val: encoded }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('hash'), val: xdr.ScVal.scvBytes(bytes(9)) }),
    ]);
    expect(decodeAuditEvent(event)).toEqual({ entry: audit, hash: bytes(9) });
  });

  /** A valid chain of `count` entries from genesis. */
  function chain(count: number): AuditRecord[] {
    const records: AuditRecord[] = [];
    let previous: Uint8Array = new Uint8Array(32);
    for (let i = 1; i <= count; i++) {
      const entry: AuditEntry = { ...audit, sequence: BigInt(i), previous_hash: previous, ledger: 100 + i,
        outcome: { kind: 'PauseChanged', paused: i % 2 === 1 } };
      const value = auditHash(passphrase, entry);
      records.push({ entry, hash: value, ledger: 100 + i, transaction: `${i}`.padStart(64, '0'), event_id: `${i}` });
      previous = value;
    }
    return records;
  }
  const head = (records: AuditRecord[]) => ({ sequence: records.at(-1)!.entry.sequence, hash: records.at(-1)!.hash });
  const verify = (records: AuditRecord[], stored = head(records)) => verifyAuditChain(passphrase, wallet, records, stored);

  it('verifies a complete chain and reports an empty wallet as verified', () => {
    expect(verify(chain(4)).status).toBe('verified');
    expect(verifyAuditChain(passphrase, wallet, [], { sequence: 0n, hash: new Uint8Array(32) }).status).toBe('verified');
  });

  it('reports missing history as incomplete, never as verified', () => {
    const records = chain(5);
    expect(verify(records.slice(2), head(records))).toMatchObject({ status: 'incomplete', detail: /before 3/ });
    expect(verify(records.slice(0, 3), head(records))).toMatchObject({ status: 'incomplete', detail: /after 3/ });
    expect(verify([], head(records)).status).toBe('incomplete');
  });

  it('reports altered, missing, duplicated, reordered or foreign entries and a contradicting head as a mismatch', () => {
    const records = chain(4);
    const altered = records.map((record, i) => (i === 1
      ? { ...record, entry: { ...record.entry, actor: account(99) } } : record));
    expect(verify(altered, head(records)).status).toBe('mismatch');
    expect(verify([records[0]!, records[2]!, records[3]!], head(records)).status).toBe('mismatch');
    expect(verify([records[0]!, records[1]!, records[1]!, records[2]!, records[3]!], head(records)).status).toBe('mismatch');
    expect(verify([records[1]!, records[0]!, records[2]!, records[3]!], head(records)).status).toBe('mismatch');
    expect(verify(records, { sequence: 4n, hash: bytes(7) }).status).toBe('mismatch');
    expect(verify(records, { sequence: 3n, hash: records[2]!.hash }).status).toBe('mismatch');
    expect(verifyAuditChain(passphrase, wallet, records, { sequence: 0n, hash: new Uint8Array(32) }).status)
      .toBe('mismatch');
    expect(verifyAuditChain(passphrase, contract(77), records, head(records)).status).toBe('mismatch');
  });
});
