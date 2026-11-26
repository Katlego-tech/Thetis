import { expect, test } from "vitest";
import { freshnessOf } from "@/data/live/freshness";
import { formatSlot } from "@/lib/format";
import { checkpoint } from "./snapshot";

const reported = "2026-11-26T00:00:00.000Z";
const at = (seconds: number, millis = 0) =>
  new Date(Date.parse(reported) + seconds * 1000 + millis);

test("freshnessOf returns halted, stalled, behind and current at the stated thresholds", () => {
  const live = checkpoint({ last_success_at: reported, indexed_through_slot: 13_000 });

  const current = freshnessOf(live, at(30));
  expect(current).toEqual({
    state: "current",
    indexedThroughSlot: 13_000n,
    lastSuccessAt: reported,
    haltReason: null,
    haltedAt: null,
    checkedAt: at(30).toISOString(),
  });
  expect(freshnessOf(live, at(0)).state).toBe("current");
  expect(freshnessOf(live, at(30, 1)).state).toBe("behind");
  expect(freshnessOf(live, at(120)).state).toBe("behind");
  expect(freshnessOf(live, at(120, 1)).state).toBe("stalled");

  const backfilling = checkpoint({ status: "backfilling", last_success_at: reported });
  expect(freshnessOf(backfilling, at(1)).state).toBe("behind");
  expect(freshnessOf(backfilling, at(121)).state).toBe("stalled");

  expect(freshnessOf(null, at(1))).toEqual({
    state: "stalled",
    indexedThroughSlot: null,
    lastSuccessAt: null,
    haltReason: null,
    haltedAt: null,
    checkedAt: at(1).toISOString(),
  });
  const neverReported = checkpoint({
    status: "backfilling",
    last_success_at: null,
    indexed_through_slot: null,
  });
  expect(freshnessOf(neverReported, at(1)).state).toBe("stalled");

  const halted = checkpoint({
    status: "halted",
    last_success_at: reported,
    halt_reason: "MIXED_INSTANCE",
    halted_at: "2026-11-26T00:00:05.000Z",
  });
  expect(freshnessOf(halted, at(1))).toEqual({
    state: "halted",
    indexedThroughSlot: 12_000n,
    lastSuccessAt: reported,
    haltReason: "MIXED_INSTANCE",
    haltedAt: "2026-11-26T00:00:05.000Z",
    checkedAt: at(1).toISOString(),
  });
  expect(freshnessOf(halted, at(500)).state).toBe("halted");
});

test("formatSlot groups the digits of a slot", () => {
  expect(formatSlot(526242298n)).toBe("526,242,298");
  expect(formatSlot(0n)).toBe("0");
});
