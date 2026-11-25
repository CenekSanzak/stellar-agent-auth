#!/usr/bin/env node
import { createServer, type Server } from 'node:http';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBackend } from './backend.js';
import { loadDeployment } from './deployment.js';
import { demoDirectory, recordPath } from './setup.js';
import { isMainModule } from '@stellar-agent-auth/sdk/node';

export { createBackend, type BackendOptions } from './backend.js';
export { DemoAgent, SCENARIOS, type Scenario, type ScenarioResult, type Step } from './agent.js';
export { assertDeployment, loadDeployment, saveDeployment, type Deployment } from './deployment.js';
export { setupDeployment, demoDirectory, recordPath, FIXTURE_LABEL, type SetupOptions } from './setup.js';

/**
 * Start the demo's server side from the deployment record the setup wrote. It serves the built web app too, so
 * after `npm run build` the whole demo is one address. During development, run Vite beside it (`npm run dev -w
 * @stellar-agent-auth/demo`), which proxies `/v1` here.
 */
export async function startDemo(
  env: Record<string, string | undefined>,
): Promise<{ server: Server; url: string; stop: () => Promise<void> }> {
  const port = Number(env['DEMO_PORT'] || '8790');
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('DEMO_PORT must be 0-65535');
  const deployment = await loadDeployment(env['DEMO_DEPLOYMENT'] ?? recordPath(env));
  const webRoot = fileURLToPath(new URL('../web', import.meta.url));
  const built = await stat(join(webRoot, 'index.html')).then((info) => info.isFile(), () => false);
  const backend = await createBackend({
    deployment, directory: join(demoDirectory(env), 'state', deployment.epoch), env,
    ...(built ? { webRoot } : {}),
    allowedOrigins: (env['DEMO_ALLOWED_ORIGINS'] ?? 'http://localhost:5173,http://127.0.0.1:5173').split(',')
      .map((origin) => origin.trim()).filter(Boolean),
  });
  const server = createServer((request, response) => { void backend.handler(request, response); });
  // A scenario can make several payments, each waiting for a ledger.
  server.requestTimeout = 180_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // Loopback only: this process signs as the agent and hands out the test asset to whoever asks.
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const bound = typeof address === 'object' && address ? address.port : port;
  return {
    server, url: `http://127.0.0.1:${bound}/`,
    async stop() {
      await backend.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

if (isMainModule(import.meta.url)) {
  startDemo(process.env).then(({ url }) => {
    console.log(JSON.stringify({ status: 'listening', url }));
  }, (error: unknown) => {
    console.error(`demo: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
