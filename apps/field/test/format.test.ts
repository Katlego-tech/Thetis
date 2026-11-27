import { describe, expect, it } from "vitest";
import {
  formatDate,
  formatKg,
  formatSast,
  formatSize,
  formatSlot,
  formatTimeOfDay,
  formatTonnes,
  parseTonnes,
  shortAddress,
} from "../src/format";

describe("formatTonnes (message.rs tonnes_known_answers)", () => {
  it.each([
    [1n, "0.001 t"],
    [999n, "0.999 t"],
    [1_000n, "1.000 t"],
    [2_000_000n, "2,000.000 t"],
    [1_234_567_890n, "1,234,567.890 t"],
    [18_446_744_073_709_551_615n, "18,446,744,073,709,551.615 t"],
    [5_000_000n, "5,000.000 t"],
  ])("%s kg is %s", (kg, text) => {
    expect(formatTonnes(kg)).toBe(text);
  });
});

describe("formatSast (message.rs sast_known_answers)", () => {
  it.each([
    [0n, "1970-01-01 02:00:00 SAST"],
    [951_782_400n, "2000-02-29 02:00:00 SAST"],
    [1_795_098_725n, "2026-11-19 16:32:05 SAST"],
    [1_795_105_799n, "2026-11-19 18:29:59 SAST"],
    [4_102_444_799n, "2100-01-01 01:59:59 SAST"],
    [1_795_767_275n, "2026-11-27 10:14:35 SAST"],
  ])("%s is %s", (unix, text) => {
    expect(formatSast(unix)).toBe(text);
  });

  it("gives the sign-before time 30 s before validUntil", () => {
    expect(formatTimeOfDay(1_795_767_275n - 30n)).toBe("10:14:05 SAST");
  });

  it("formats the SAST date", () => {
    expect(formatDate(1_795_767_275n + 29n * 86_400n)).toBe("2026-12-26");
  });
});

describe("parseTonnes", () => {
  it.each([
    ["5000", 5_000_000n],
    ["4999.875", 4_999_875n],
    ["0.001", 1n],
    ["12.5", 12_500n],
  ])("accepts %s", (text, kg) => {
    expect(parseTonnes(text)).toBe(kg);
  });

  it.each([
    ["5,000", "shape"],
    ["1.2345", "shape"],
    ["-1", "shape"],
    ["05", "shape"],
    ["1.", "shape"],
    ["0", "zero"],
    ["0.000", "zero"],
    ["", "empty"],
    ["   ", "empty"],
  ])("refuses %j as %s", (text, reason) => {
    expect(parseTonnes(text)).toBe(reason);
  });
});

describe("other formats", () => {
  it("formats kilograms, slots, sizes and addresses", () => {
    expect(formatKg(5_000_000n)).toBe("5,000,000 kg");
    expect(formatSlot(526_890_114n)).toBe("526,890,114");
    expect(formatSize(24_536_678)).toBe("23.4 MB");
    expect(formatSize(20_971_520)).toBe("20.0 MB");
    expect(shortAddress("G7sTxBJ1geeqZF7T3JuPX4bEqhQzyBLYPKAye11RXLrp")).toBe("G7sT…XLrp");
  });
});
