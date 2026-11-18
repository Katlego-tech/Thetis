import { expect, test } from "vitest";
import { formatBpsPercent, formatDateTime, formatMoney, formatTonnes } from "@/lib/format";

test("formats tonnes with grouping and three decimal places", () => {
  expect(formatTonnes(2000000n)).toBe("2,000.000 t");
  expect(formatTonnes(1n)).toBe("0.001 t");
  expect(formatTonnes(9007199254740993n)).toBe("9,007,199,254,740.993 t");
});

test("formats money with the given currency and number of minor digits", () => {
  expect(formatMoney(40000000n, "USD", 2)).toBe("USD 400,000.00");
  expect(formatMoney(5n, "USD", 2)).toBe("USD 0.05");
  expect(formatMoney(1234n, "JPY", 0)).toBe("JPY 1,234");
  expect(formatMoney(-5n, "USD", 2)).toBe("USD -0.05");
  expect(formatMoney(9007199254740993n, "KWD", 3)).toBe("KWD 9,007,199,254,740.993");
});

test("formats basis points as percentages", () => {
  expect(formatBpsPercent(3333n)).toBe("33.33%");
  expect(formatBpsPercent(0n)).toBe("0.00%");
  expect(formatBpsPercent(1n)).toBe("0.01%");
});

test("formats instants in Johannesburg time", () => {
  expect(formatDateTime("2026-11-28T17:00:00+02:00")).toBe("28 Nov 2026, 17:00 SAST");
  expect(formatDateTime("2026-11-28T22:05:00Z")).toBe("29 Nov 2026, 00:05 SAST");
});
