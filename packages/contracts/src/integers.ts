export const U64_MAX = 2n ** 64n - 1n;
export const I64_MIN = -(2n ** 63n);
export const I64_MAX = 2n ** 63n - 1n;

const UNSIGNED_CANONICAL = /^(?:0|[1-9][0-9]*)$/;
const SIGNED_CANONICAL = /^(?:0|-?[1-9][0-9]*)$/;

function toText(value: bigint, min: bigint, max: bigint, type: string): string {
  if (typeof value !== "bigint") throw new TypeError(`${type}: expected a bigint`);
  if (value < min || value > max)
    throw new RangeError(`${type}: ${value} is outside ${min}..${max}`);
  return value.toString(10);
}

function fromText(text: string, pattern: RegExp, min: bigint, max: bigint, type: string): bigint {
  if (typeof text !== "string" || !pattern.test(text)) {
    throw new SyntaxError(`${type}: not a canonical decimal integer: ${JSON.stringify(text)}`);
  }
  const value = BigInt(text);
  if (value < min || value > max)
    throw new RangeError(`${type}: ${text} is outside ${min}..${max}`);
  return value;
}

/** Integer string for a u64, the form used at API boundaries. */
export function toU64String(value: bigint): string {
  return toText(value, 0n, U64_MAX, "u64");
}

/** Parses a canonical unsigned decimal string into a u64. */
export function fromU64String(text: string): bigint {
  return fromText(text, UNSIGNED_CANONICAL, 0n, U64_MAX, "u64");
}

/** Integer string for an i64, the form used at API boundaries. */
export function toI64String(value: bigint): string {
  return toText(value, I64_MIN, I64_MAX, "i64");
}

/** Parses a canonical decimal string (optional leading "-", no "-0") into an i64. */
export function fromI64String(text: string): bigint {
  return fromText(text, SIGNED_CANONICAL, I64_MIN, I64_MAX, "i64");
}
