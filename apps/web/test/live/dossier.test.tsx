import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { LotDossier } from "@/components/dossier/lot-dossier";
import { liveReader } from "@/data/live/map";
import type { LiveSnapshot } from "@/data/live/rows";
import {
  address,
  BUYER_POSITION,
  document,
  KHUNOU_POSITION,
  lotRow,
  NOW,
  position,
  transferredSnapshot,
} from "./snapshot";

afterEach(cleanup);

function show(snapshot: LiveSnapshot, tab?: string, stale: "halted" | "skew" | null = null) {
  const reader = liveReader(snapshot, NOW);
  const lot = reader.lot("CR-0001", "khunou");
  if (!lot) throw new Error("CR-0001 is not visible to khunou");
  return render(
    <LotDossier
      lot={lot}
      context="khunou"
      tab={tab}
      workItems={reader.workQueue("khunou")}
      currency={reader.scenario.facilityCurrency}
      minorDigits={reader.scenario.currencyMinorDigits}
      source="live"
      stale={stale}
    />,
  );
}

// A cell's text without the label the stacked mobile layout prints inside it.
function cellText(cell: HTMLElement) {
  const copy = cell.cloneNode(true) as HTMLElement;
  for (const label of copy.querySelectorAll(".result-mobile-label")) label.remove();
  return copy.textContent;
}

function rowCells(row: HTMLElement) {
  return within(row).getAllByRole("cell").map(cellText);
}

function cells(name: RegExp) {
  return rowCells(screen.getByRole("row", { name }));
}

const noLoanRows = [
  [
    "Recorded debt",
    "None recorded",
    "No loan on chain for this lot",
    "Not attested yet",
    "Not on chain",
  ],
  [
    "Valuation",
    "None recorded",
    "No valuation on chain for this lot's class, grade and site",
    "Not attested yet",
    "Not on chain",
  ],
  ["Eligible value", "Not computed", "Needs a valuation", "Not attested yet", "Not on chain"],
  [
    "Loan to value",
    "Not computed",
    "Needs a loan and a valuation",
    "Not attested yet",
    "Not on chain",
  ],
];

describe("live lot dossier", () => {
  test("the dossier renders the no-loan rows, the holding line and No current holder", () => {
    const { container, unmount } = show(transferredSnapshot());
    expect(
      screen.getByRole("heading", { level: 1, name: "CR-0001 CHROME v1, grade G1" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "at PORT-STOCKYARD. Owner Khunou Ore Exports. Custodian Kopano Stockyard Custody.",
        {
          exact: false,
        },
      ),
    ).toBeInTheDocument();
    const header = within(screen.getByRole("banner"));
    expect(header.getByText("Confirmed")).toBeInTheDocument();
    expect(header.getByText(/Available/)).toBeInTheDocument();

    expect(
      screen.getByText("Khunou Ore Exports holds 3,000.000 t of this lot's 5,000.000 t."),
    ).toBeInTheDocument();
    const bar = screen.getByRole("img", { name: /Quantity/ });
    expect(bar).toHaveAccessibleName(/Total 3,000\.000 t/);
    expect(bar).toHaveAccessibleName(/Available 3,000\.000 t/);

    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(rows.map(rowCells)).toEqual([
      [
        "Lot quantity",
        "5,000.000 t",
        "Supply on chain, kg atomic unit",
        "Not attested yet",
        "Confirmed",
      ],
      ...noLoanRows,
    ]);
    expect(screen.getByRole("row", { name: /Loan to value/ })).toHaveAttribute(
      "data-total",
      "true",
    );
    expect(container.textContent).not.toMatch(/[\u2013\u2014]/);
    expect(screen.queryByText(/USD/)).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    unmount();

    show(transferredSnapshot(), "financing");
    // The first table is the results; the owner also sees the chromium-products reference (web.md §10).
    const [results] = screen.getAllByRole("table");
    if (!results) throw new Error("no results table");
    const financing = within(results).getAllByRole("row").slice(1);
    expect(financing.map(rowCells)).toEqual(noLoanRows);
    expect(screen.getByText("No releases for this lot.")).toBeInTheDocument();
    expect(screen.queryByText("Principal")).not.toBeInTheDocument();
    cleanup();

    // The whole lot held by the viewer: no holding line, the bar is the lot.
    const whole = transferredSnapshot();
    whole.positions = [
      position(KHUNOU_POSITION, "khunou", "5000000"),
      position(BUYER_POSITION, "buyer-smelter", "0"),
    ];
    show(whole);
    expect(screen.queryByText(/holds/)).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Quantity/ })).toHaveAccessibleName(
      /Total 5,000\.000 t/,
    );
    cleanup();

    // Every position at 0 kg.
    const redeemed = transferredSnapshot();
    redeemed.lots = [lotRow({ state: "Redeemed", supply_kg: "0", commitment: "finalized" })];
    redeemed.positions = [
      position(KHUNOU_POSITION, "khunou", "0"),
      position(BUYER_POSITION, "buyer-smelter", "0"),
    ];
    show(redeemed);
    expect(screen.getByText(/No current holder\./)).toBeInTheDocument();
    expect(screen.queryByText(/Owner /)).not.toBeInTheDocument();
    const marks = within(screen.getByRole("banner"));
    expect(marks.queryByText("Finance")).not.toBeInTheDocument();
    expect(marks.getByText(/Collected/)).toBeInTheDocument();
    expect(marks.getByText("Finalized")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /Quantity/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/holds/)).not.toBeInTheDocument();
    const legend = screen.getByText("Available").closest("dl");
    expect(legend?.textContent).toBe(
      "Pledged0.000 tPending release within pledge0.000 tAvailable0.000 tDiscrepancy0.000 t",
    );
  });

  test("the live dossier shows the lot stale note, the chain digest file cell and the custody mark", () => {
    const { unmount } = show(transferredSnapshot(), "overview", "halted");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Indexing has stopped, so this lot may have changed since. The figures below may be out of date.",
    );
    unmount();
    const skew = show(transferredSnapshot(), "overview", "skew");
    expect(screen.getByRole("status")).toHaveTextContent(
      "This lot's supply and holder quantities were read at different moments. The figures below may be out of date; reload to read them again.",
    );
    skew.unmount();

    const attested = transferredSnapshot();
    attested.documents = [document(address(60), 0)];
    const evidence = show(attested, "evidence");
    expect(cells(/Origin attestation, version 0/)).toEqual([
      "Origin attestation, version 0",
      "Port Terminal T1",
      "Human-attested",
      "Digest on chain",
    ]);
    evidence.unmount();

    show(transferredSnapshot(), "custody");
    expect(cells(/Intake/)).toEqual([
      "26 Nov 2026, 02:00 SAST",
      "Intake",
      "PORT-STOCKYARD",
      "5,000.000 t",
      "Kopano Stockyard Custody",
      "Confirmed",
    ]);
  });
});
