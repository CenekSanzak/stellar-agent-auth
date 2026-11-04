import { describe, expect, it } from 'vitest';
import { Keypair, Networks } from '@stellar/stellar-sdk';
import { loadConfig } from '../../packages/sdk/src/config.js';
describe('network configuration boundary', () => {
  it('defaults to local without invented deployment addresses', () => {
    const config = loadConfig({});
    expect(config.passphrase).toBe(Networks.STANDALONE);
    expect(config.contracts).toEqual({});
    expect(config.networkId).toMatch(/^[a-f0-9]{64}$/);
  });
  it('separates local and testnet signing domains', () => {
    expect(loadConfig({}).networkId).not.toBe(loadConfig({ STELLAR_NETWORK: 'testnet' }).networkId);
  });
  it.each([
    { STELLAR_NETWORK: 'pubnet' },
    { STELLAR_NETWORK: 'testnet', STELLAR_NETWORK_PASSPHRASE: Networks.STANDALONE },
    { STELLAR_NETWORK_ID: 'wrong' },
    { STELLAR_NETWORK: 'testnet', STELLAR_RPC_URL: 'http://localhost:8000/rpc' },
    { STELLAR_RPC_URL: 'http://example.com/rpc' },
    { STELLAR_RPC_URL: 'https://user:password@example.com' },
    { WALLET_ID: Keypair.random().publicKey() },
    { VERIFIER_PUBLIC_ADDRESS: 'invalid' },
  ])('rejects inconsistent or invalid configuration %j', (env) => expect(() => loadConfig(env)).toThrow());
});
