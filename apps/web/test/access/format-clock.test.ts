import { expect, test } from "vitest";
import { formatClockTime } from "@/lib/format";

test("formatClockTime shows Johannesburg time with seconds", () => {
  expect(formatClockTime("2026-11-23T12:46:07.218Z")).toBe("14:46:07 SAST");
  expect(formatClockTime("2026-11-23T22:00:00Z")).toBe("00:00:00 SAST");
});
