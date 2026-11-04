import { expect, it } from 'vitest';
import { rpc } from '@stellar/stellar-sdk';
import { loadConfig } from '../../packages/sdk/src/config.js';
it('local RPC serves the expected network and protocol', async () => {
  const config = loadConfig(process.env);
  expect(config.network).toBe('local');
  const server = new rpc.Server(config.rpcUrl, { allowHttp: true });
  const network = await server.getNetwork();
  expect(network.passphrase).toBe(config.passphrase);
  expect(network.protocolVersion).toBe(29);
  expect((await server.getHealth()).status).toBe('healthy');
});
