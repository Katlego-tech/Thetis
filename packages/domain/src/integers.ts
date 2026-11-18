import { DomainError } from "./errors.ts";

export const U64_MAX: bigint = 2n ** 64n - 1n;
export const U128_MAX: bigint = 2n ** 128n - 1n;

const MAX_U64_DIGITS = U64_MAX.toString().length;

export function parseU64(s: string): bigint {
  if (typeof s !== "string" || !/^(0|[1-9][0-9]*)$/.test(s)) {
    throw new DomainError("INVALID_INTEGER", "Expected a canonical unsigned decimal string");
  }
  if (s.length > MAX_U64_DIGITS) {
    throw new DomainError("OVERFLOW", "Decimal integer is outside u64");
  }
  const value = BigInt(s);
  assertU64(value);
  return value;
}

export function formatU64(n: bigint): string {
  assertU64(n);
  return n.toString();
}

export function formatTonnes(kg: bigint): string {
  assertU64(kg);
  const tonnes = kg / 1000n;
  const fraction = (kg % 1000n).toString().padStart(3, "0");
  return `${tonnes}.${fraction}`;
}

function assertU64(value: bigint): void {
  if (value < 0n || value > U64_MAX) {
    throw new DomainError("OVERFLOW", "Integer is outside u64");
  }
}
