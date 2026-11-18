import { DomainError } from "./errors.ts";
import { U64_MAX } from "./integers.ts";

export interface CapacityInput {
  occupied: bigint;
  reservedInbound: bigint;
  approvedCapacity: bigint;
  incoming: bigint;
}

export interface CapacityResult {
  fits: boolean;
  remainingAfter: bigint;
}

export function checkCapacity(c: CapacityInput): CapacityResult {
  const { occupied, reservedInbound, approvedCapacity, incoming } = c;
  for (const quantity of [occupied, reservedInbound, approvedCapacity, incoming]) {
    if (quantity < 0n || quantity > U64_MAX) {
      throw new DomainError("OVERFLOW", "Capacity input is outside u64");
    }
  }

  const usedAfter = occupied + reservedInbound + incoming;
  const fits = usedAfter <= approvedCapacity;
  return { fits, remainingAfter: fits ? approvedCapacity - usedAfter : 0n };
}
