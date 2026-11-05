/**
 * Exact conversion between decimal asset amounts and integer contract units. No floating point is involved: a value
 * with more fractional digits than the asset has is refused rather than rounded.
 */

const I128_MAX = (1n << 127n) - 1n;

/** `"3.5"` with 7 decimals is `35000000n`. Accepts only plain non-negative decimals. */
export function toContractUnits(value: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 38) throw new Error('Invalid asset decimals');
  const match = /^(\d{1,39})(?:\.(\d{1,38}))?$/.exec(value.trim());
  if (!match) throw new Error(`Invalid amount "${value}": expected a plain decimal such as 3 or 0.25`);
  const [, whole, fraction = ''] = match;
  if (fraction.length > decimals) throw new Error(`Amount "${value}" has more than ${decimals} decimal places`);
  const units = BigInt(whole!) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
  if (units > I128_MAX) throw new Error(`Amount "${value}" is too large`);
  return units;
}

/** `35000000n` with 7 decimals is `"3.5"`. */
export function fromContractUnits(units: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 38) throw new Error('Invalid asset decimals');
  const negative = units < 0n;
  const absolute = negative ? -units : units;
  const scale = 10n ** BigInt(decimals);
  const fraction = (absolute % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${absolute / scale}${fraction ? `.${fraction}` : ''}`;
}
