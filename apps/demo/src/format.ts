/** Small text helpers shared by the views. Everything rendered goes through `esc`. */

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export const esc = (value: unknown) => String(value).replace(/[&<>"']/g, (char) => ESCAPES[char]!);

/** `GABC…WXYZ`: enough of an address to recognise it. The full value belongs in a `title`. */
export const short = (address: string, edge = 4) =>
  (address.length <= edge * 2 + 1 ? address : `${address.slice(0, edge)}…${address.slice(-edge)}`);

/** An address shown short, with the full value on hover; a link to the explorer when there is one. */
export function addr(address: string, explorer: string | null = null): string {
  const code = `<code class="addr" title="${esc(address)}">${esc(short(address))}</code>`;
  if (!explorer) return code;
  const kind = address.startsWith('C') ? 'contract' : 'account';
  return `<a href="${esc(explorer)}/${kind}/${esc(address)}" target="_blank" rel="noreferrer">${code}</a>`;
}

/** A transaction hash shown short; a link to the explorer when there is one. */
export function tx(hash: string, explorer: string | null, label?: string): string {
  const code = `<code title="${esc(hash)}">${esc(hash.slice(0, 8))}…</code>`;
  // Without an explorer there is nothing to open, so a label that promises a view would mislead.
  return explorer ? `<a class="tx" href="${esc(explorer)}/tx/${esc(hash)}" target="_blank" rel="noreferrer" title="${esc(hash)}">${label ? esc(label) : code}</a>`
    : `<span class="tx muted">tx ${code}</span>`;
}

export const toHex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

export const fromHex = (value: string) => Uint8Array.from(value.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));

/** A span of seconds in the largest unit that reads naturally, rounded: `7 days`, `3 hours`, `40 seconds`. */
export function duration(seconds: bigint | number): string {
  const total = Number(seconds < 0 ? -seconds : seconds);
  const [value, unit] = total >= 129_600 ? [Math.round(total / 86_400), 'day']
    : total >= 5_400 ? [Math.round(total / 3_600), 'hour']
      : total >= 90 ? [Math.round(total / 60), 'minute']
        : [total, 'second'];
  return `${value} ${unit}${value === 1 ? '' : 's'}`;
}

/** A ledger timestamp as a UTC date and time. Policy days are UTC days, so times are shown in UTC throughout. */
export function utc(timestamp: bigint | number): string {
  const date = new Date(Number(timestamp) * 1_000);
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** The time of day of an ISO time, in UTC: `14:02`. */
export const clock = (iso: string) => (/T(\d\d:\d\d)/.exec(iso)?.[1] ?? '');

/** An amount with no trailing zeros beyond two places: `97`, `0.5`, `12.25`. */
export function money(value: string): string {
  const [whole, fraction = ''] = value.split('.');
  const trimmed = fraction.replace(/0+$/, '');
  return trimmed ? `${whole}.${trimmed}` : whole!;
}
