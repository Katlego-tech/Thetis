import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import LotPage from "@/app/[context]/lots/[lotId]/page";
import { LotDossier } from "@/components/dossier/lot-dossier";
import { referenceReader } from "@/data/reader";
import fixture from "../../../../fixtures/web/demo-scenario.json";

afterEach(cleanup);

const reader = referenceReader(fixture);

function fixtureLot() {
  const lot = reader.lot("CR-0001");
  if (!lot) throw new Error("The dossier fixture is missing CR-0001.");
  return lot;
}

const lot = fixtureLot();

function show(tab?: string, context = "lender-one") {
  return render(
    <LotDossier
      lot={lot}
      context={context}
      tab={tab}
      workItems={reader.workQueue(context)}
      currency={reader.scenario.facilityCurrency}
      minorDigits={reader.scenario.currencyMinorDigits}
    />,
  );
}

describe("Lot dossier", () => {
  it("shows the lot states and nested release quantity in the default overview", () => {
    show();
    expect(
      screen.getByRole("heading", { name: "CR-0001 Chrome ore, single grade class" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Owner Khunou Ore Exports\. Custodian Kopano Stockyard Custody/),
    ).toBeInTheDocument();
    const header = within(screen.getByRole("banner"));
    expect(header.getByText(/Stored/)).toBeInTheDocument();
    expect(header.getByText(/Pledged/)).toBeInTheDocument();
    expect(header.getByText(/Normal/)).toBeInTheDocument();
    expect(header.getByText("Not on chain")).toBeInTheDocument();
    const quantity = screen.getByRole("img", { name: /Quantity/ });
    expect(quantity).toHaveAccessibleName(/Pledged to Lender One Bank 5,000.000 t/);
    expect(quantity).toHaveAccessibleName(/Pending release within pledge 2,000.000 t/);
    expect(quantity).toHaveAccessibleName(/Discrepancy 0.000 t/);
    expect(quantity.querySelector("[data-segment='pledged']")).toHaveStyle({ width: "100%" });
    expect(quantity.querySelector("[data-segment='pending']")).toHaveStyle({ width: "40%" });
    expect(
      screen.getByText(
        "The pending release sits inside the pledged quantity. It is not extra ore.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /Loan to value 60\.00%/ })).toHaveAttribute(
      "data-total",
    );
  });

  it("lists every work item and consequence for the active context", () => {
    const { unmount } = show();
    const next = within(screen.getByRole("complementary", { name: "Next" }));
    for (const item of reader.workQueue("lender-one")) {
      expect(next.getByText(item.action)).toBeInTheDocument();
      expect(next.getByText(item.blocker, { exact: false })).toBeInTheDocument();
    }
    expect(next.getByRole("link", { name: "Open release sheet" })).toHaveAttribute(
      "href",
      "/lender-one/releases/rel-0001",
    );
    expect(next.getAllByRole("link")).toHaveLength(3);
    unmount();
    show("overview", "khunou");
    expect(screen.getByText("Track release request")).toBeInTheDocument();
    expect(screen.queryByText("Renew valuation")).not.toBeInTheDocument();
  });

  it.each(["Overview", "Evidence", "Financing", "Custody", "Activity"])(
    "links to %s and marks it as the current tab",
    (label) => {
      const tab = label.toLowerCase();
      show(tab);
      const links = within(screen.getByRole("navigation", { name: "Lot dossier" })).getAllByRole(
        "link",
      );
      expect(links).toHaveLength(5);
      const current = screen.getByRole("link", { name: label });
      expect(current).toHaveAttribute("href", `?tab=${tab}`);
      expect(links.filter((link) => link.hasAttribute("aria-current"))).toEqual([current]);
    },
  );

  it("shows evidence issuers, statuses, and file availability", () => {
    show("evidence");
    const row = within(screen.getByRole("row", { name: /bill of lading/i }));
    expect(row.getByText("Port Terminal T1")).toBeInTheDocument();
    expect(row.getByText("Uploaded")).toBeInTheDocument();
    expect(row.getByText("No file in the reference scenario")).toBeInTheDocument();
  });

  it("shows the financing results and the release payment and registry separately", () => {
    show("financing");
    expect(screen.getByRole("row", { name: /Recorded debt USD 600,000\.00/ })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /Valuation USD 200\.00\/t/ })).toBeInTheDocument();
    const row = within(screen.getByRole("row", { name: /Buyer Smelter Co/ }));
    expect(row.getByText("2,000.000 t")).toBeInTheDocument();
    expect(row.getByText("Reported by buyer")).toBeInTheDocument();
    expect(row.getByText("Not on chain")).toBeInTheDocument();
  });

  it("shows a checkpoint observation with its time, quantity, parties and registry", () => {
    show("custody");
    const row = within(screen.getByRole("row", { name: /Checkpoint observed, custody unchanged/ }));
    expect(row.getByText("26 Nov 2026, 13:05 SAST")).toBeInTheDocument();
    expect(row.getByText("Border checkpoint")).toBeInTheDocument();
    expect(row.getByText("5,000.000 t")).toBeInTheDocument();
    expect(row.getByText("Mosela Haulage")).toBeInTheDocument();
    expect(row.getByText("Not on chain")).toBeInTheDocument();
  });

  it("shows only dated custody events in Activity, newest first", () => {
    show("activity");
    const times = screen.getAllByRole("time").map((time) => time.textContent);
    expect(times).toEqual([
      "27 Nov 2026, 10:20 SAST",
      "26 Nov 2026, 13:05 SAST",
      "25 Nov 2026, 07:40 SAST",
      "24 Nov 2026, 09:10 SAST",
    ]);
    expect(screen.queryByRole("columnheader", { name: "Quantity" })).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Registry" })).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "Evidence and release events join this list once the API records their times.",
      ),
    ).toBeInTheDocument();
  });

  it("falls back to Overview for an unrecognized tab", () => {
    show("unrecognized");
    expect(screen.getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("heading", { name: "Quantity" })).toBeInTheDocument();
  });

  it("passes the selected tab from the route to the dossier", async () => {
    render(
      await LotPage({
        params: Promise.resolve({ context: "lender-one", lotId: lot.id }),
        searchParams: Promise.resolve({ tab: "evidence" }),
      }),
    );
    expect(screen.getByRole("link", { name: "Evidence" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("columnheader", { name: "Document" })).toBeInTheDocument();
  });

  it("signals notFound for an unknown lot", async () => {
    await expect(
      LotPage({
        params: Promise.resolve({ context: "lender-one", lotId: "missing" }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
  });
});
