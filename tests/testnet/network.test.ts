import { expect, it } from 'vitest';
import { rpc, Networks } from '@stellar/stellar-sdk';
it('explicit Testnet preflight reports a compatible network', async () => {
  expect(process.env['RUN_TESTNET_TESTS']).toBe('1');
  const network = await new rpc.Server('https://soroban-testnet.stellar.org').getNetwork();
  expect(network.passphrase).toBe(Networks.TESTNET);
  expect(network.protocolVersion).toBeGreaterThanOrEqual(29);
});
