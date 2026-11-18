import { describe, expect, it } from "vitest";
import { ACCRUAL_DENOMINATOR, accrueSimple, U64_MAX } from "../src/index.ts";

describe("simple-interest accrual", () => {
  it("books twelve percent over a fixed 365-day year", () => {
    expect(ACCRUAL_DENOMINATOR).toBe(315360000000n);
    expect(
      accrueSimple({
        principal: 60000000n,
        rateBps: 1200n,
        elapsedSeconds: 31536000n,
        carriedRemainder: 0n,
      }),
    ).toEqual({ interest: 7200000n, remainder: 0n });
  });

  it("matches split and whole accrual over 256 seeded cases", () => {
    let state = 0x4d595df4d0f33173n;
    const next = () => {
      state = (state * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
      return state >> 16n;
    };

    for (let sample = 0; sample < 256; sample += 1) {
      const principal = next();
      const rateBps = next() % 50001n;
      const firstElapsed = next() % 100000000n;
      const secondElapsed = next() % 100000000n;
      const carriedRemainder = next() % ACCRUAL_DENOMINATOR;
      const terms = { principal, rateBps };
      const first = accrueSimple({ ...terms, elapsedSeconds: firstElapsed, carriedRemainder });
      const second = accrueSimple({
        ...terms,
        elapsedSeconds: secondElapsed,
        carriedRemainder: first.remainder,
      });
      const whole = accrueSimple({
        ...terms,
        elapsedSeconds: firstElapsed + secondElapsed,
        carriedRemainder,
      });

      expect({ interest: first.interest + second.interest, remainder: second.remainder }).toEqual(
        whole,
      );
    }
  });

  it("preserves the carried remainder when elapsed seconds are zero", () => {
    expect(
      accrueSimple({
        principal: U64_MAX,
        rateBps: U64_MAX,
        elapsedSeconds: 0n,
        carriedRemainder: ACCRUAL_DENOMINATOR - 1n,
      }),
    ).toEqual({ interest: 0n, remainder: ACCRUAL_DENOMINATOR - 1n });
  });

  it("refuses an out-of-range carried remainder", () => {
    expect(() =>
      accrueSimple({
        principal: 1n,
        rateBps: 1n,
        elapsedSeconds: 1n,
        carriedRemainder: ACCRUAL_DENOMINATOR,
      }),
    ).toThrow(expect.objectContaining({ code: "INVALID_INTEGER" }));
  });

  it("refuses overflow in the numerator or the interest output", () => {
    for (const elapsedSeconds of [1n, 2n]) {
      expect(() =>
        accrueSimple({
          principal: U64_MAX,
          rateBps: U64_MAX,
          elapsedSeconds,
          carriedRemainder: 0n,
        }),
      ).toThrow(expect.objectContaining({ code: "OVERFLOW" }));
    }
  });
});
