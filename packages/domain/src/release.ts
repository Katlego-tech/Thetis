import { DomainError } from "./errors.ts";
import { U64_MAX, U128_MAX } from "./integers.ts";

export interface ReleaseInput {
  principal: bigint;
  bookedInterest: bigint;
  bookedFees: bigint;
  buyerAmount: bigint;
  sellerTopUp: bigint;
  lockedQuantity: bigint;
  soldLockedQuantity: bigint;
  valuePerUnit: bigint;
  haircutBps: bigint;
  maxLtvBps: bigint;
}

export interface ReleasePreview {
  debtBefore: bigint;
  confirmedPayment: bigint;
  applied: bigint;
  debtAfter: bigint;
  quantityAfter: bigint;
  eligibleValueAfter: bigint;
  limitAfter: bigint;
  sellerSurplus: bigint;
  allowed: boolean;
  requiredAdditionalTopUp: bigint;
}

const BPS_DENOMINATOR = 10000n;

export function previewRelease(r: ReleaseInput): ReleasePreview {
  const {
    principal,
    bookedInterest,
    bookedFees,
    buyerAmount,
    sellerTopUp,
    lockedQuantity,
    soldLockedQuantity,
    valuePerUnit,
    haircutBps,
    maxLtvBps,
  } = r;
  for (const bps of [haircutBps, maxLtvBps]) {
    if (bps < 0n || bps > BPS_DENOMINATOR) {
      throw new DomainError("INVALID_BPS", "Haircut and LTV must be between 0 and 10000 bps");
    }
  }
  for (const value of [
    principal,
    bookedInterest,
    bookedFees,
    buyerAmount,
    sellerTopUp,
    lockedQuantity,
    soldLockedQuantity,
    valuePerUnit,
  ]) {
    if (value < 0n || value > U64_MAX) {
      throw new DomainError("OVERFLOW", "Release input is outside u64");
    }
  }
  if (soldLockedQuantity > lockedQuantity) {
    throw new DomainError("SOLD_EXCEEDS_LOCKED", "Sold quantity exceeds locked quantity");
  }

  const debtBefore = principal + bookedInterest + bookedFees;
  const confirmedPayment = buyerAmount + sellerTopUp;
  if (debtBefore > U64_MAX || confirmedPayment > U64_MAX) {
    throw new DomainError("OVERFLOW", "Debt or confirmed payment is outside u64");
  }

  // biome-ignore lint/complexity/useMathMinMax: Math.min does not accept bigint.
  const applied = debtBefore < confirmedPayment ? debtBefore : confirmedPayment;
  const debtAfter = debtBefore - applied;
  const quantityAfter = lockedQuantity - soldLockedQuantity;

  const eligibleValueNumerator = quantityAfter * valuePerUnit * (BPS_DENOMINATOR - haircutBps);
  if (eligibleValueNumerator > U128_MAX) {
    throw new DomainError("OVERFLOW", "Eligible value numerator is outside u128");
  }
  const eligibleValueAfter = eligibleValueNumerator / BPS_DENOMINATOR;
  if (eligibleValueAfter > U64_MAX) {
    throw new DomainError("OVERFLOW", "Eligible value is outside u64");
  }

  const limitAfter = (eligibleValueAfter * maxLtvBps) / BPS_DENOMINATOR;
  const allowed = debtAfter <= limitAfter;
  return {
    debtBefore,
    confirmedPayment,
    applied,
    debtAfter,
    quantityAfter,
    eligibleValueAfter,
    limitAfter,
    sellerSurplus: confirmedPayment - applied,
    allowed,
    requiredAdditionalTopUp: allowed ? 0n : debtAfter - limitAfter,
  };
}
