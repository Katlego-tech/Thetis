import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { LiveBanner } from "@/components/shell/live-banner";
import type { Freshness, HaltReason } from "@/data/live/types";

afterEach(cleanup);

const base: Freshness = {
  state: "current",
  indexedThroughSlot: 13_000n,
  lastSuccessAt: "2026-11-26T00:00:06.000Z",
  haltReason: null,
  haltedAt: null,
  checkedAt: "2026-11-26T00:00:10.000Z",
};

function line(freshness: Freshness) {
  const { container, unmount } = render(<LiveBanner freshness={freshness} />);
  const banner = container.querySelector(".reference-banner");
  const status = screen.getByRole("status");
  const result = {
    banner: banner?.textContent,
    status: status.textContent,
    warns: status.querySelector("svg") !== null,
  };
  unmount();
  return result;
}

const left =
  "Devnet test environment. Synthetic organisations. Records are read from the Thetis program on Solana devnet.";
const stopped = (reason: string) =>
  `Indexing stopped 26 Nov 2026, 02:05 SAST: ${reason}. What you see may be out of date; the chain itself is unaffected.`;

test("LiveBanner renders each freshness line verbatim", () => {
  const current = line(base);
  expect(current.status).toBe(
    "Live from devnet. Indexed through slot 13,000, last reported 02:00:06 SAST.",
  );
  expect(current.banner).toBe(`${left}${current.status}`);
  expect(current.warns).toBe(false);

  const behind = line({ ...base, state: "behind" });
  expect(behind.status).toBe(
    "Catching up with devnet. Indexed through slot 13,000, last reported 02:00:06 SAST. Recent changes may not show yet.",
  );
  expect(behind.warns).toBe(false);
  expect(line({ ...base, state: "behind", indexedThroughSlot: null }).status).toBe(
    "Catching up with devnet. Indexed through slot none, last reported 02:00:06 SAST. Recent changes may not show yet.",
  );

  const stalled = line({ ...base, state: "stalled" });
  expect(stalled.status).toBe(
    "The indexer last reported 26 Nov 2026, 02:00 SAST. What you see may be out of date.",
  );
  expect(stalled.warns).toBe(true);

  const never = line({ ...base, state: "stalled", indexedThroughSlot: null, lastSuccessAt: null });
  expect(never.status).toBe("The indexer has not reported yet. Nothing here is current.");
  expect(never.warns).toBe(true);

  const groups: [HaltReason[], string][] = [
    [
      ["UNKNOWN_INSTRUCTION", "UNKNOWN_EVENT", "UNKNOWN_ENUM", "EVENT_MISMATCH", "MIXED_INSTANCE"],
      "the program sent something this version of Thetis does not recognise",
    ],
    [
      ["EVENT_DECODE_FAILED", "ACCOUNT_DECODE_FAILED", "TRANSACTION_UNREADABLE"],
      "a program record could not be read",
    ],
    [
      ["REVISION_SEQUENCE", "EVENT_GAP", "ACCOUNT_VANISHED", "HISTORY_INCOMPLETE"],
      "the indexed history does not match the chain",
    ],
    [["CONFIRMED_DROPPED"], "the network did not confirm a recorded transaction"],
  ];
  expect(groups.flatMap(([reasons]) => reasons)).toHaveLength(13);
  for (const [reasons, reason] of groups) {
    for (const haltReason of reasons) {
      const halted = line({
        ...base,
        state: "halted",
        haltReason,
        haltedAt: "2026-11-26T00:05:00.000Z",
      });
      expect(halted.status, haltReason).toBe(stopped(reason));
      expect(halted.warns).toBe(true);
      expect(halted.banner).toBe(`${left}${halted.status}`);
    }
  }
});
