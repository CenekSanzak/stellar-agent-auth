#!/usr/bin/env node
import { createServer, type Server } from 'node:http';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBackend } from './backend.js';
import { loadDeployment } from './deployment.js';
import { demoDirectory, recordPath } from './setup.js';
import { isMainModule } from '@stellar-agent-auth/sdk/node';

export { createBackend, rateLimiter, DEFAULT_LIMITS, type BackendOptions, type Limits } from './backend.js';
export { ScoutAgent, TASKS, type Task, type TaskResult, type Step } from './agent.js';
export { PRODUCTS, VENDORS, VENDOR_IDS, produce, type Content, type Product, type Vendor, type VendorId } from './catalogue.js';
export { assertDeployment, loadDeployment, saveDeployment, type Deployment } from './deployment.js';
export { setupDeployment, demoDirectory, recordPath, FIXTURE_LABEL, type SetupOptions } from './setup.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * Start the demo's server side from a deployment record. It serves the built web app too, so after `npm run build`
 * the whole demo is one address. During development, run Vite beside it (`npm run dev -w @stellar-agent-auth/demo`),
 * which proxies `/v1` and `/indexer` here.
 *
 * By default it listens on loopback. To host it, set `DEMO_HOST` to the address to listen on and `DEMO_PUBLIC_URL`
 * to the address visitors use; it then expects to sit behind a proxy that terminates TLS and names the client.
 */
export async function startDemo(
  env: Record<string, string | undefined>,
): Promise<{ server: Server; url: string; stop: () => Promise<void> }> {
  const port = Number(env['DEMO_PORT'] || env['PORT'] || '8790');
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('DEMO_PORT must be 0-65535');
  const host = env['DEMO_HOST'] || '127.0.0.1';
  const publicUrl = env['DEMO_PUBLIC_URL'] || undefined;
  if (publicUrl !== undefined && !/^https?:\/\/[^/]+\/?$/.test(publicUrl)) {
    throw new Error('DEMO_PUBLIC_URL must be an origin, such as https://scout.example');
  }
  // This process signs as the agent and hands out the test asset. Beyond loopback it must know its public name, so
  // that it accepts requests for that name only and limits visitors by their own address.
  if (!LOOPBACK_HOSTS.has(host) && !publicUrl) throw new Error('Listening beyond loopback requires DEMO_PUBLIC_URL');
  const deployment = await loadDeployment(env['DEMO_DEPLOYMENT'] ?? recordPath(env));
  const webRoot = fileURLToPath(new URL('../web', import.meta.url));
  const built = await stat(join(webRoot, 'index.html')).then((info) => info.isFile(), () => false);
  const backend = await createBackend({
    deployment, directory: env['DEMO_STATE_DIRECTORY'] ?? join(demoDirectory(env), 'state', deployment.epoch), env,
    ...(built ? { webRoot } : {}), ...(publicUrl ? { publicUrl } : {}),
    allowedOrigins: (env['DEMO_ALLOWED_ORIGINS'] ?? (publicUrl ? '' : 'http://localhost:5173,http://127.0.0.1:5173')).split(',')
      .map((origin) => origin.trim()).filter(Boolean),
  });
  const server = createServer((request, response) => { void backend.handler(request, response); });
  // A task can make several purchases, each waiting for a ledger.
  server.requestTimeout = 180_000;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => resolve());
    });
  } catch (error) {
    await backend.stop();
    throw error;
  }
  const address = server.address();
  const bound = typeof address === 'object' && address ? address.port : port;
  // Scout reaches the sellers on this machine, whatever name visitors use.
  backend.listening(`http://127.0.0.1:${bound}/`);
  return {
    server, url: publicUrl ?? `http://127.0.0.1:${bound}/`,
    async stop() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await backend.stop();
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
