import { readFileSync } from 'node:fs';
import { Networks } from '@stellar/stellar-sdk';
import { expect, it } from 'vitest';
import { actionHash, auditHash, encodeAction, policyHash } from '../../packages/sdk/src/encoding.js';
import { action, audit, policy, passphrase, wallet, contract } from '../fixtures/abi-v1.js';

it('matches the shared Rust policy, action and audit hashes', () => {
  const golden = readFileSync(new URL('../fixtures/abi-v1.sha256', import.meta.url), 'utf8').trim().split('\n');
  const hashes = [policyHash(passphrase, wallet, policy), actionHash(passphrase, action), auditHash(passphrase, audit)];
  expect(hashes.map((hash) => Buffer.from(hash).toString('hex'))).toEqual(golden);
});

it('normalizes policy sets and separates wallet and network domains', () => {
  const normalized = policyHash(passphrase, wallet, policy);
  expect(policyHash(passphrase, wallet, {
    ...policy,
    assets: [...policy.assets].reverse(),
    required_checks: [...policy.required_checks].reverse(),
    allowed_recipients: [...policy.allowed_recipients].reverse(),
    blocked_recipients: [...policy.blocked_recipients].reverse(),
    action_kinds: [...policy.action_kinds].reverse(),
  })).toEqual(normalized);
  expect(policyHash(passphrase, contract(42), policy)).not.toEqual(normalized);
  expect(policyHash(Networks.TESTNET, wallet, policy)).not.toEqual(normalized);
  expect(() => policyHash(passphrase, wallet, {
    ...policy, allowed_recipients: [wallet, wallet],
  })).toThrow('Duplicate');
});

it.each([0n, -1n, 1n << 127n])('rejects amount %s outside the positive i128 range', (amount) => {
  const { action: payment } = action;
  if (payment.kind !== 'Transfer') throw new Error('Expected a transfer fixture');
  expect(() => encodeAction({
    ...action, action: { kind: 'Transfer', transfer: { ...payment.transfer, amount } },
  })).toThrow('positive i128');
});
