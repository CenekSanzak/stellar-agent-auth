/** Small text helpers shared by the views. Everything rendered goes through `esc`. */

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export const esc = (value: unknown) => String(value).replace(/[&<>"']/g, (char) => ESCAPES[char]!);

/** `GABC…WXYZ`: enough of an address to recognise it. The full value belongs in a `title`. */
export const short = (address: string, edge = 4) =>
  (address.length <= edge * 2 + 1 ? address : `${address.slice(0, edge)}…${address.slice(-edge)}`);

/** An address shown short, with the full value on hover and for copying. */
export const addr = (address: string) => `<code class="addr" title="${esc(address)}">${esc(short(address))}</code>`;

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
