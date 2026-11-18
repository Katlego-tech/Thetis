import { describe, expect, it } from "vitest";
import { availableQuantity, checkCapacity, U64_MAX } from "../src/index.ts";

describe("available quantity", () => {
  it("subtracts active locks and separate reservations exactly", () => {
    expect(
      availableQuantity({
        positionQuantity: U64_MAX,
        activeLockedQuantity: U64_MAX - 7n,
        separatelyReservedQuantity: 4n,
      }),
    ).toBe(3n);
  });

  it("refuses a negative result", () => {
    expect(() =>
      availableQuantity({
        positionQuantity: 6n,
        activeLockedQuantity: 4n,
        separatelyReservedQuantity: 3n,
      }),
    ).toThrow(expect.objectContaining({ code: "NEGATIVE" }));
  });

  it("refuses a u64 input of 2^64", () => {
    expect(() =>
      availableQuantity({
        positionQuantity: 2n ** 64n,
        activeLockedQuantity: 0n,
        separatelyReservedQuantity: 0n,
      }),
    ).toThrow(expect.objectContaining({ code: "OVERFLOW" }));
  });
});

describe("capacity", () => {
  it.each([
    [4n, { fits: true, remainingAfter: 1n }],
    [5n, { fits: true, remainingAfter: 0n }],
    [6n, { fits: false, remainingAfter: 0n }],
  ])("includes reservations when checking incoming quantity %s", (incoming, expected) => {
    expect(
      checkCapacity({ occupied: 2n, reservedInbound: 3n, approvedCapacity: 10n, incoming }),
    ).toEqual(expected);
  });

  it("reports no fit when the aggregate exceeds u64", () => {
    expect(
      checkCapacity({
        occupied: U64_MAX,
        reservedInbound: 0n,
        approvedCapacity: U64_MAX,
        incoming: 1n,
      }),
    ).toEqual({ fits: false, remainingAfter: 0n });
  });

  it("refuses a negative capacity input", () => {
    expect(() =>
      checkCapacity({ occupied: 0n, reservedInbound: -1n, approvedCapacity: 10n, incoming: 0n }),
    ).toThrow(expect.objectContaining({ code: "OVERFLOW" }));
  });
});
