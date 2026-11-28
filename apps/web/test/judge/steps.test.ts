import { expect, test } from "vitest";
import { formatKg, pageState, shorten, toSteps } from "@/data/judge/steps";
import { INTAKE, LOAN, LOCK, loadedView, sig } from "./fixture";

test("pageState follows the stated order: not configured, halted, indexing, loaded", () => {
  expect(pageState({ configured: false })).toBe("not_configured");
  const view = loadedView();
  expect(pageState(view)).toBe("loaded");
  // More transactions than the run recorded is still loaded.
  expect(pageState({ ...view, expectedTransactions: 3 })).toBe("loaded");
  expect(pageState({ ...view, expectedTransactions: 10 })).toBe("indexing");
  expect(pageState({ ...view, checkpoint: null })).toBe("indexing");
  const checkpoint =
    view.checkpoint ??
    (() => {
      throw new Error("fixture");
    })();
  expect(pageState({ ...view, checkpoint: { ...checkpoint, status: "backfilling" } })).toBe(
    "indexing",
  );
  const halted = {
    ...checkpoint,
    status: "halted" as const,
    haltReason: "EVENT_GAP",
    haltedAt: "2026-11-28T00:10:00.000Z",
  };
  // Halted wins over indexing; a stream mismatch wins over halted.
  expect(pageState({ ...view, expectedTransactions: 10, checkpoint: halted })).toBe("halted");
  expect(pageState({ ...view, streamMatches: false, checkpoint: halted })).toBe("not_configured");
});

test("toSteps merges transactions and refusals in (slot, signature) order", () => {
  const steps = toSteps(loadedView());
  expect(steps.map((s) => [s.slot, s.kind])).toEqual([
    [100, "setup"],
    [110, "setup"],
    [200, "run"],
    [300, "run"],
    [305, "refusal"],
    [310, "run"],
    [500, "refusal"],
    [500, "run"],
    [600, "run"],
    [800, "run"],
    [850, "run"],
  ]);
  expect(steps[6]?.signature).toBe(sig(12));
  expect(steps[7]?.signature).toBe(sig(5));
});

test("each step carries the table's title, facts, signers, mark and explorer link", () => {
  const steps = toSteps(loadedView());
  const by = (instruction: string) => {
    const step = steps.find((s) => s.instruction === instruction);
    if (!step) throw new Error(`no step for ${instruction}`);
    return step;
  };
  expect(by("IssueLot")).toMatchObject({
    title: "Lot issued",
    facts: [
      { label: "Quantity", value: "5,000 t (5,000,000 kg)" },
      { label: "Owner", value: "Khunou Ore Exports" },
      { label: "Intake", value: shorten(INTAKE), mono: true },
    ],
    mark: "confirmed",
    explorerUrl: `https://explorer.solana.com/tx/${sig(3)}?cluster=devnet`,
  });
  expect(by("Pledge").facts).toEqual([
    { label: "Locked", value: "5,000 t (5,000,000 kg)" },
    { label: "Loan", value: shorten(LOAN), mono: true },
    { label: "Lock", value: shorten(LOCK), mono: true },
  ]);
  // Amounts in the run's one facility currency, from FacilityOpened (hex bytes "USD", 2 decimals).
  expect(by("RecordAdvance").facts).toEqual([
    { label: "Advance", value: "USD 600,000.00" },
    { label: "Debt", value: "USD 600,000.00" },
  ]);
  expect(by("Handover")).toMatchObject({
    title: "Handover at departure",
    signedBy: ["Kopano Stockyard Custody", "Mosela Haulage"],
  });
  expect(by("RecordObservation")).toMatchObject({ title: "Border observation", mark: "finalized" });
  expect(by("RecordObservation").facts).toContainEqual({
    label: "Holder unchanged",
    value: "Mosela Haulage",
  });
  expect(by("RecordLoading").facts).toEqual([
    { label: "Quantity", value: "3,000.5 t (3,000,500 kg)" },
    { label: "Terminal", value: "Port Terminal T1" },
    { label: "Lot loaded", value: "Yes" },
    { label: "Loan", value: "ExternalHandoff" },
    { label: "Debt recorded", value: "USD 200,000.00" },
  ]);
  expect(by("OpenFacility")).toMatchObject({
    kind: "setup",
    facts: [
      { label: "Lender", value: "Lender One Bank" },
      { label: "Borrower", value: "Khunou Ore Exports" },
      { label: "Rate", value: "12.00%" },
      { label: "Max LTV", value: "60.00%" },
    ],
  });
  // An instruction outside the table is shown with its raw name, never hidden or guessed.
  expect(by("SetRestriction")).toMatchObject({ kind: "run", title: "SetRestriction", facts: [] });
  expect(by("refused_driver")).toMatchObject({
    kind: "refusal",
    title: "Refused: a driver with no authority signs the handover",
    mark: "failed",
    facts: [
      { label: "Error", value: "Anchor3012", mono: true },
      { label: "Result", value: "Failed on chain. Nothing changed." },
    ],
  });
});

test("an address that names no organisation is shortened, and mixed currencies show minor units", () => {
  const view = loadedView();
  const unnamed = "8dqQB2d9phZbmEGMHkrpsvDCawmk7Baf97K9ax4hReSt";
  const issue = view.transactions[3]?.events[0];
  if (!issue) throw new Error("fixture");
  issue.data.owner = unnamed;
  view.transactions.push({
    signature: sig(13),
    slot: 120,
    blockTime: "2026-11-28T00:02:00.000Z",
    commitment: "confirmed",
    events: [
      {
        index: 0,
        instruction: "OpenFacility",
        event: "FacilityOpened",
        data: {
          lender: unnamed,
          borrower: unnamed,
          currency: "5a4152",
          currencyDecimals: 2,
          rateBps: 1,
          maxLtvBps: 1,
        },
      },
    ],
  });
  const steps = toSteps(view);
  expect(steps.find((s) => s.instruction === "IssueLot")?.facts[1]).toEqual({
    label: "Owner",
    value: "8dqQ\u2026ReSt",
  });
  expect(steps.find((s) => s.instruction === "RecordAdvance")?.facts[0]).toEqual({
    label: "Advance",
    value: "60,000,000 minor units",
  });
});

test("kilograms format exactly, never through Number", () => {
  expect(formatKg(18446744073709551615n)).toBe(
    "18,446,744,073,709,551.615 t (18,446,744,073,709,551,615 kg)",
  );
  expect(formatKg(0n)).toBe("0 t (0 kg)");
  expect(formatKg(2000000n)).toBe("2,000 t (2,000,000 kg)");
});
