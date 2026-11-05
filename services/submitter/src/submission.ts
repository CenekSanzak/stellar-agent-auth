import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  FeeCeilingExceeded, SimulationRejected, SponsorRefused, SubmissionUnsettled, isSettled,
  type Sponsor, type SponsorPolicy,
} from '@stellar-agent-auth/sdk';
import { MAX_BODY_BYTES, RateLimiter, RequestRejected, admit } from './simulation.js';

/**
 * HTTP routes over one SDK `Sponsor`:
 * - `POST /v1/transactions` with `{ "operation": "<base64 XDR>" }` sponsors one signed operation;
 * - `GET /v1/transactions/<hash>` settles a hash this sponsor submitted;
 * - `GET /v1/health` reports the sponsor address and policy.
 *
 * A settled result is HTTP 200 whatever its status, a pending or unknown one 202. A simulation rejection is 422 with
 * the contract error name, so a client can tell "nothing happened" from every submitted outcome.
 */

export interface SubmitterOptions {
  sponsor: Sponsor;
  policy: SponsorPolicy;
  network: string;
  /** Bearer token clients must present; required unless the server listens on loopback only. */
  token?: string | undefined;
  rateLimit: RateLimiter;
}

const json = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
};

async function readBody(request: IncomingMessage): Promise<string> {
  const declared = Number(request.headers['content-length'] ?? 0);
  if (declared > MAX_BODY_BYTES) throw new RequestRejected(413, 'Body too large');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new RequestRejected(413, 'Body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function authorized(request: IncomingMessage, token: string | undefined) {
  if (!token) return true;
  const header = request.headers['authorization'] ?? '';
  const expected = Buffer.from(`Bearer ${token}`);
  const supplied = Buffer.from(header);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function createHandler(options: SubmitterOptions) {
  const { sponsor, policy } = options;
  return async (request: IncomingMessage, response: ServerResponse) => {
    try {
      const url = new URL(request.url ?? '/', 'http://submitter.invalid');
      if (request.method === 'GET' && url.pathname === '/v1/health') {
        return json(response, 200, {
          status: 'ok', network: options.network, sponsor: sponsor.address, contracts: policy.contracts,
          methods: policy.methods ?? null, max_fee: policy.limits.maxFee.toString(),
        });
      }
      if (!authorized(request, options.token)) return json(response, 401, { error: 'Unauthorized' });
      if (!options.rateLimit.allow(request.socket.remoteAddress ?? 'unknown')) {
        return json(response, 429, { error: 'Too many requests' });
      }
      if (request.method === 'POST' && url.pathname === '/v1/transactions') {
        const operation = admit(await readBody(request), sponsor.address, policy);
        const result = await sponsor.sponsor(operation);
        return json(response, isSettled(result.status) ? 200 : 202, result);
      }
      const match = /^\/v1\/transactions\/([0-9a-f]{64})$/.exec(url.pathname);
      if (request.method === 'GET' && match) {
        const result = await sponsor.status(match[1]!);
        return json(response, isSettled(result.status) ? 200 : 202, result);
      }
      return json(response, 404, { error: 'Not found' });
    } catch (error) {
      if (error instanceof RequestRejected) return json(response, error.status, { error: error.message });
      if (error instanceof SimulationRejected) {
        return json(response, 422, {
          kind: 'simulation', error: error.message, code: error.code ?? null, auth: error.auth ?? null,
          detail: error.detail.slice(0, 4_000),
        });
      }
      if (error instanceof SponsorRefused) return json(response, 403, { error: error.message });
      if (error instanceof FeeCeilingExceeded) return json(response, 403, { error: error.message });
      if (error instanceof SubmissionUnsettled) {
        return json(response, 503, { error: `Sponsor is settling ${error.record.hash}; retry later` });
      }
      console.error('submitter:', error);
      return json(response, 500, { error: 'Internal error' });
    }
  };
}
