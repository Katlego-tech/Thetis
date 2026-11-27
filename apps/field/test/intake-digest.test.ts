import { describe, expect, it } from "vitest";
import { intakeDigest, normaliseTicket } from "../src/intake-digest";

describe("intake digest (field-app.md §6.4 known answer)", () => {
  it("normalises the typed ticket", () => {
    expect(normaliseTicket("wb 2611-0042")).toBe("WB2611-0042");
  });

  it("reproduces the pinned digest", () => {
    expect(intakeDigest("KOPANO-YARD-1", "WB2611-0042")).toBe(
      "71813b946d9d53f619f3cd4e1fce2d7d8dd6cbe8e0fc44876ac5e09a3c1483de",
    );
  });

  it.each([
    ["a tab", "WB\t2611"],
    ["an accented letter", "é2611"],
    ["only spaces", "    "],
    ["empty", ""],
    ["a line break", "WB\n2611"],
    ["65 characters", "A".repeat(65)],
  ])("refuses %s", (_, raw) => {
    expect(normaliseTicket(raw)).toBeNull();
  });

  it("accepts 64 characters, counted after spaces are removed", () => {
    expect(normaliseTicket("a".repeat(64))).toBe("A".repeat(64));
    expect(normaliseTicket(`${"a".repeat(64)}   `)).toBe("A".repeat(64));
  });
});
