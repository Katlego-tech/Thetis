import { DomainError } from "./errors.ts";
import { U64_MAX, U128_MAX } from "./integers.ts";

export interface AccrualInput {
  principal: bigint;
  rateBps: bigint;
  elapsedSeconds: bigint;
  carriedRemainder: bigint;
}

export interface AccrualResult {
  interest: bigint;
  remainder: bigint;
}

export const ACCRUAL_DENOMINATOR: bigint = 10000n * 365n * 86400n;

export function accrueSimple(a: AccrualInput): AccrualResult {
  const { principal, rateBps, elapsedSeconds, carriedRemainder } = a;
  for (const value of [principal, rateBps, elapsedSeconds, carriedRemainder]) {
    if (value < 0n || value > U64_MAX) {
      throw new DomainError("OVERFLOW", "Accrual input is outside u64");
    }
  }
  if (carriedRemainder >= ACCRUAL_DENOMINATOR) {
    throw new DomainError("INVALID_INTEGER", "Carried remainder must be below the denominator");
  }

  const numerator = principal * rateBps * elapsedSeconds + carriedRemainder;
  if (numerator > U128_MAX) {
    throw new DomainError("OVERFLOW", "Accrual numerator is outside u128");
  }
  const interest = numerator / ACCRUAL_DENOMINATOR;
  if (interest > U64_MAX) {
    throw new DomainError("OVERFLOW", "Accrued interest is outside u64");
  }
  return { interest, remainder: numerator % ACCRUAL_DENOMINATOR };
}
