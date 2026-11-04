import { expect, it } from 'vitest';
import { rpc, Networks } from '@stellar/stellar-sdk';
it('explicit Testnet preflight reports a compatible network', async () => {
  expect(process.env['RUN_TESTNET_TESTS']).toBe('1');
  const network = await new rpc.Server('https://soroban-testnet.stellar.org').getNetwork();
  expect(network.passphrase).toBe(Networks.TESTNET);
  // The local baseline is protocol 29; report drift instead of hiding it behind the lower bound.
  console.info(`Testnet protocol ${network.protocolVersion}; local baseline 29`);
  expect(network.protocolVersion).toBeGreaterThanOrEqual(29);
});
