import { describe, expect, it } from "vitest";
import {
  fromI64String,
  fromU64String,
  I64_MAX,
  I64_MIN,
  toI64String,
  toU64String,
  U64_MAX,
} from "../src/index.ts";

describe("u64 strings", () => {
  it("round-trips both range edges and ordinary values", () => {
    for (const [text, value] of [
      ["0", 0n],
      ["1", 1n],
      ["10", 10n],
      ["9007199254740993", 9007199254740993n],
      ["18446744073709551615", 2n ** 64n - 1n],
    ] as const) {
      expect(fromU64String(text)).toBe(value);
      expect(toU64String(value)).toBe(text);
    }
    expect(U64_MAX).toBe(2n ** 64n - 1n);
  });

  it.each([
    ["a plus sign", "+1"],
    ["a minus sign", "-1"],
    ["negative zero", "-0"],
    ["a leading zero", "01"],
    ["a doubled zero", "00"],
    ["leading whitespace", " 1"],
    ["trailing whitespace", "1 "],
    ["a newline", "1\n"],
    ["a decimal point", "1.0"],
    ["a bare decimal point", "."],
    ["an exponent", "1e3"],
    ["hex", "0x10"],
    ["the empty string", ""],
    ["a separator", "1,000"],
    ["one above 2^64 - 1", "18446744073709551616"],
    ["a much larger number", "99999999999999999999999999"],
    ["non-ASCII digits", "１２"],
  ])("rejects %s", (_name, text) => {
    expect(() => fromU64String(text)).toThrow();
  });

  it("rejects values outside 0..2^64 - 1 when formatting", () => {
    expect(() => toU64String(-1n)).toThrow(RangeError);
    expect(() => toU64String(2n ** 64n)).toThrow(RangeError);
  });

  it("rejects a number passed where a bigint is required", () => {
    expect(() => toU64String(1 as unknown as bigint)).toThrow(TypeError);
  });
});

describe("i64 strings", () => {
  it("round-trips both range edges, zero and negatives", () => {
    for (const [text, value] of [
      ["0", 0n],
      ["1", 1n],
      ["-1", -1n],
      ["9223372036854775807", 2n ** 63n - 1n],
      ["-9223372036854775808", -(2n ** 63n)],
    ] as const) {
      expect(fromI64String(text)).toBe(value);
      expect(toI64String(value)).toBe(text);
    }
    expect(I64_MAX).toBe(2n ** 63n - 1n);
    expect(I64_MIN).toBe(-(2n ** 63n));
  });

  it.each([
    ["a plus sign", "+1"],
    ["negative zero", "-0"],
    ["a leading zero", "01"],
    ["a leading zero after the sign", "-01"],
    ["a lone minus sign", "-"],
    ["a double minus sign", "--1"],
    ["whitespace", " 1"],
    ["a decimal point", "1.5"],
    ["an exponent", "1e3"],
    ["hex", "0x10"],
    ["the empty string", ""],
    ["one above 2^63 - 1", "9223372036854775808"],
    ["one below -2^63", "-9223372036854775809"],
  ])("rejects %s", (_name, text) => {
    expect(() => fromI64String(text)).toThrow();
  });

  it("rejects values outside the i64 range when formatting", () => {
    expect(() => toI64String(2n ** 63n)).toThrow(RangeError);
    expect(() => toI64String(-(2n ** 63n) - 1n)).toThrow(RangeError);
  });
});
