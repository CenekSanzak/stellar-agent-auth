import { SponsorRefused, inspectSponsoredOperation, type SponsorPolicy } from '@stellar-agent-auth/sdk';

/**
 * Request admission, before anything reaches the network: body size, shape and the sponsor policy. Enforcement in
 * simulation, the fee ceiling and submission happen in the SDK `Sponsor`.
 */

export const MAX_BODY_BYTES = 64 * 1024;

export class RequestRejected extends Error {
  override readonly name = 'RequestRejected';
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Parse `{ "operation": "<base64 XDR>" }` and check it against the sponsor policy. */
export function admit(body: string, sponsor: string, policy: SponsorPolicy): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new RequestRejected(400, 'Body must be JSON');
  }
  const operation = (parsed as { operation?: unknown } | null)?.operation;
  if (typeof parsed !== 'object' || parsed === null || Object.keys(parsed).length !== 1
    || typeof operation !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(operation)) {
    throw new RequestRejected(400, 'Expected exactly { "operation": "<base64 XDR>" }');
  }
  try {
    inspectSponsoredOperation(operation, sponsor, policy);
  } catch (error) {
    if (error instanceof SponsorRefused) throw new RequestRejected(403, error.message);
    throw error;
  }
  return operation;
}

/** A fixed-window request limit per client. */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  constructor(private readonly perMinute: number, private readonly clock = () => Date.now()) {
    if (!Number.isInteger(perMinute) || perMinute < 1) throw new Error('Rate limit must be a positive integer');
  }

  allow(client: string): boolean {
    const now = this.clock();
    const window = this.windows.get(client);
    if (!window || now - window.start >= 60_000) {
      if (this.windows.size > 10_000) this.windows.clear();
      this.windows.set(client, { start: now, count: 1 });
      return true;
    }
    window.count += 1;
    return window.count <= this.perMinute;
  }
}
