import { describe, expect, it } from "vitest";
import { DomainError, formatTonnes, formatU64, parseU64, U64_MAX, U128_MAX } from "../src/index.ts";

describe("decimal integer boundaries", () => {
  it("round-trips zero and the largest u64 exactly", () => {
    expect(U64_MAX).toBe(18446744073709551615n);
    expect(U128_MAX).toBe(340282366920938463463374607431768211455n);
    expect(parseU64("0")).toBe(0n);
    expect(parseU64("18446744073709551615")).toBe(U64_MAX);
    expect(formatU64(U64_MAX)).toBe("18446744073709551615");
  });

  it.each(["01", "-1", "1.0", "1e3", " 1", "", "+1", "1 ", "1\n"])(
    "refuses non-canonical decimal %j",
    (input) => {
      expect(() => parseU64(input)).toThrow(DomainError);
      expect(() => parseU64(input)).toThrow(expect.objectContaining({ code: "INVALID_INTEGER" }));
    },
  );

  it("refuses to parse 2^64", () => {
    expect(() => parseU64("18446744073709551616")).toThrow(
      expect.objectContaining({ code: "OVERFLOW" }),
    );
  });

  it.each([-1n, 2n ** 64n])("refuses to format an out-of-range integer %s", (input) => {
    expect(() => formatU64(input)).toThrow(expect.objectContaining({ code: "OVERFLOW" }));
    expect(() => formatTonnes(input)).toThrow(expect.objectContaining({ code: "OVERFLOW" }));
  });
});

describe("tonnes formatting", () => {
  it.each([
    [0n, "0.000"],
    [1n, "0.001"],
    [1234567n, "1234.567"],
    [5000000n, "5000.000"],
    [18446744073709551615n, "18446744073709551.615"],
  ])("formats %s kg as %s tonnes", (kg, expected) => {
    expect(formatTonnes(kg)).toBe(expected);
  });
});
