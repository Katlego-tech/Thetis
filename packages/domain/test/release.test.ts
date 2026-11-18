import { describe, expect, it } from "vitest";
import examples from "../../../fixtures/domain/release-examples.json" with { type: "json" };
import { parseU64, previewRelease, type ReleaseInput, U64_MAX } from "../src/index.ts";

const releaseInput: ReleaseInput = {
  principal: 3n,
  bookedInterest: 1n,
  bookedFees: 1n,
  buyerAmount: 1n,
  sellerTopUp: 1n,
  lockedQuantity: 4n,
  soldLockedQuantity: 1n,
  valuePerUnit: 3n,
  haircutBps: 5000n,
  maxLtvBps: 7500n,
};

describe("release preview", () => {
  it.each(examples)("$name", ({ label, input, expected }) => {
    expect(label).toBe("synthetic");
    const parsedInput: ReleaseInput = {
      principal: parseU64(input.principal),
      bookedInterest: parseU64(input.bookedInterest),
      bookedFees: parseU64(input.bookedFees),
      buyerAmount: parseU64(input.buyerAmount),
      sellerTopUp: parseU64(input.sellerTopUp),
      lockedQuantity: parseU64(input.lockedQuantity),
      soldLockedQuantity: parseU64(input.soldLockedQuantity),
      valuePerUnit: parseU64(input.valuePerUnit),
      haircutBps: parseU64(input.haircutBps),
      maxLtvBps: parseU64(input.maxLtvBps),
    };
    const parsedExpected = Object.fromEntries(
      Object.entries(expected).map(([field, value]) => [
        field,
        typeof value === "boolean" ? value : parseU64(value),
      ]),
    );
    expect(previewRelease(parsedInput)).toEqual(parsedExpected);
  });

  it("floors the eligible value before calculating the limit", () => {
    expect(previewRelease({ ...releaseInput, maxLtvBps: 6900n })).toEqual({
      debtBefore: 5n,
      confirmedPayment: 2n,
      applied: 2n,
      debtAfter: 3n,
      quantityAfter: 3n,
      eligibleValueAfter: 4n,
      limitAfter: 2n,
      sellerSurplus: 0n,
      allowed: false,
      requiredAdditionalTopUp: 1n,
    });
  });

  it.each([
    ["LTV of 10001 bps", { maxLtvBps: 10001n }, "INVALID_BPS"],
    ["haircut of 10001 bps", { haircutBps: 10001n }, "INVALID_BPS"],
    ["negative LTV", { maxLtvBps: -1n }, "INVALID_BPS"],
    ["negative haircut", { haircutBps: -1n }, "INVALID_BPS"],
    ["sold quantity above the locked quantity", { soldLockedQuantity: 5n }, "SOLD_EXCEEDS_LOCKED"],
  ] as const)("refuses %s", (_name, fields, code) => {
    expect(() => previewRelease({ ...releaseInput, ...fields })).toThrow(
      expect.objectContaining({ code }),
    );
  });

  it("refuses out-of-range debt and payment outputs", () => {
    for (const fields of [{ principal: U64_MAX }, { buyerAmount: U64_MAX }]) {
      expect(() => previewRelease({ ...releaseInput, ...fields })).toThrow(
        expect.objectContaining({ code: "OVERFLOW" }),
      );
    }
  });

  it("refuses out-of-range valuation outputs and intermediates", () => {
    for (const fields of [
      { valuePerUnit: U64_MAX },
      { lockedQuantity: U64_MAX, valuePerUnit: U64_MAX },
    ]) {
      expect(() => previewRelease({ ...releaseInput, ...fields })).toThrow(
        expect.objectContaining({ code: "OVERFLOW" }),
      );
    }
  });

  it("allows the valuation before the haircut to exceed u64 when the outputs fit", () => {
    const preview = previewRelease({
      ...releaseInput,
      lockedQuantity: U64_MAX,
      soldLockedQuantity: 0n,
      valuePerUnit: 2n,
      maxLtvBps: 10000n,
    });
    expect(preview.eligibleValueAfter).toBe(U64_MAX);
    expect(preview.limitAfter).toBe(U64_MAX);
  });
});
