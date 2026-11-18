import { DomainError } from "./errors.ts";
import { U64_MAX } from "./integers.ts";

export interface PositionQuantities {
  positionQuantity: bigint;
  activeLockedQuantity: bigint;
  separatelyReservedQuantity: bigint;
}

export function availableQuantity(p: PositionQuantities): bigint {
  const { positionQuantity, activeLockedQuantity, separatelyReservedQuantity } = p;
  for (const quantity of [positionQuantity, activeLockedQuantity, separatelyReservedQuantity]) {
    if (quantity < 0n || quantity > U64_MAX) {
      throw new DomainError("OVERFLOW", "Position quantity input is outside u64");
    }
  }

  const available = positionQuantity - activeLockedQuantity - separatelyReservedQuantity;
  if (available < 0n) {
    throw new DomainError("NEGATIVE", "Locks and separate reservations exceed position quantity");
  }
  return available;
}
