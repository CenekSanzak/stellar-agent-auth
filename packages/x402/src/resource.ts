import type { IncomingMessage, ServerResponse } from 'node:http';
import { x402HTTPResourceServer, x402ResourceServer, type FacilitatorClient } from '@x402/core/server';
import type { Network } from '@x402/core/types';
import { ExactStellarScheme as ExactServerScheme } from '@x402/stellar/exact/server';
import type { payeeGate } from './gate.js';

/**
 * A resource that costs something, served over plain `node:http` by x402's own resource server: it answers 402
 * with what it wants, verifies the payment it is then sent, runs the handler, and settles. This file only connects
 * that server to an HTTP request and response.
 */

export interface PaidRoute {
  /** Such as `/report`; matched exactly, `GET` only. */
  path: string;
  description: string;
  /** What it costs, in the asset's smallest units. */
  price: { asset: string; amount: string };
  payTo: string;
  /** Seconds the payer's signature may live; the scheme's default is 60. */
  maxTimeoutSeconds?: number;
  /** A check on the payer made before the payment is verified; see `payeeGate`. */
  gate?: ReturnType<typeof payeeGate>;
  /** Produces the paid content. It runs only for a verified payment, before settlement. */
  handler: (payer: string | undefined) => unknown | Promise<unknown>;
}

export interface PaidService {
  /** Serve `request` if it is for a paid route. Resolves `false` when it is not, leaving the response untouched. */
  handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
}

const write = (response: ServerResponse, status: number, headers: Record<string, string>, body: unknown) => {
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? {});
  response.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json',
    'cache-control': 'no-store', ...headers });
  response.end(text);
};

export async function createPaidService(
  network: Network, facilitator: FacilitatorClient, routes: readonly PaidRoute[],
): Promise<PaidService> {
  // One resource server per route, because a gate belongs to a route and the server's hooks are its own.
  const servers = new Map<string, { route: PaidRoute; http: x402HTTPResourceServer }>();
  for (const route of routes) {
    const resource = new x402ResourceServer(facilitator).register(network, new ExactServerScheme());
    if (route.gate) resource.onBeforeVerify(route.gate as never);
    const http = new x402HTTPResourceServer(resource, {
      [`GET ${route.path}`]: {
        accepts: {
          scheme: 'exact', network, payTo: route.payTo, price: route.price,
          maxTimeoutSeconds: route.maxTimeoutSeconds ?? 60,
        },
        description: route.description, mimeType: 'application/json',
      },
    });
    await http.initialize();
    servers.set(route.path, { route, http });
  }

  return {
    async handle(request, response) {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
      const found = servers.get(url.pathname);
      if (!found || request.method !== 'GET') return false;
      const { route, http } = found;
      const header = (name: string) => {
        const value = request.headers[name.toLowerCase()];
        return Array.isArray(value) ? value[0] : value;
      };
      const context = {
        adapter: {
          getHeader: header, getMethod: () => 'GET', getPath: () => url.pathname, getUrl: () => url.href,
          getAcceptHeader: () => header('accept') ?? '', getUserAgent: () => header('user-agent') ?? '',
        },
        path: url.pathname, method: 'GET',
      };
      const result = await http.processHTTPRequest(context);
      if (result.type === 'no-payment-required') return false;
      if (result.type === 'payment-error') {
        write(response, result.response.status, result.response.headers, result.response.body);
        return true;
      }
      const payer = (result.paymentPayload.payload as { payer?: string }).payer;
      const body = JSON.stringify(await route.handler(payer));
      const settled = await http.processSettlement(result.paymentPayload, result.paymentRequirements,
        result.declaredExtensions, { request: context, responseBody: Buffer.from(body) });
      if (!settled.success) {
        write(response, settled.response.status, { ...settled.headers, ...settled.response.headers }, settled.response.body);
        return true;
      }
      write(response, 200, settled.headers, JSON.parse(body) as unknown);
      return true;
    },
  };
}
