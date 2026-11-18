import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, assert, describe, expect, it } from "vitest";
import { getQueueData, WorkQueueScreen } from "@/components/queue/work-queue-screen";
import { referenceReader } from "@/data/reader";
import fixture from "../../../../fixtures/web/demo-scenario.json";

afterEach(cleanup);

const reader = referenceReader(fixture);
const beforeDeadlines = Date.parse("2026-11-18T12:00:00+02:00");

function showQueue(organisationId = "lender-one", filter?: string, now = beforeDeadlines) {
  return render(
    <WorkQueueScreen
      organisationId={organisationId}
      data={getQueueData(reader, organisationId)}
      filter={filter}
      now={now}
    />,
  );
}

describe("Work queue", () => {
  it("shows the three lender tasks with registry marks, amounts, and basis lines", () => {
    showQueue();
    expect(screen.getByRole("heading", { name: "Work requiring attention" })).toBeVisible();
    expect(screen.getByText("FIAT_ATTESTATION_TEST · devnet")).toBeVisible();
    expect(screen.getByText("Facility currency USD")).toBeVisible();
    const table = within(screen.getByRole("table"));
    const [, paymentRow, handoffRow, valuationRow, ...extraRows] = table.getAllByRole("row");
    assert(paymentRow && handoffRow && valuationRow, "Expected three task rows");
    expect(extraRows).toHaveLength(0);
    expect(table.getAllByText("Not on chain")).toHaveLength(3);

    const payment = within(paymentRow);
    expect(payment.getByText("Review payment evidence")).toBeVisible();
    expect(payment.getByText("CR-0001")).toBeVisible();
    expect(
      payment.getByText(
        "Chrome ore, single grade class · Port terminal stockyard, east-coast port",
      ),
    ).toBeVisible();
    expect(payment.getByText(/Due 28 Nov 2026, 17:00 SAST/)).toBeVisible();
    expect(payment.getByText("2,000.000 t")).toBeVisible();
    expect(payment.getByText("of 5,000.000 t pledged")).toBeVisible();
    expect(payment.getByText("USD 400,000.00")).toBeVisible();
    expect(payment.getByText("debt after USD 200,000.00")).toBeVisible();
    expect(payment.getByRole("link", { name: "Review evidence" })).toHaveAttribute(
      "href",
      "/lender-one/releases/rel-0001",
    );
    expect(payment.getByRole("link", { name: "Review evidence" })).toHaveClass("bg-(--act)");

    const handoff = within(handoffRow);
    expect(handoff.getByText("Approve external hand-off")).toBeVisible();
    expect(handoff.getByText(/Next: Port Terminal T1/)).toBeVisible();
    expect(handoff.getByText("3,000.000 t")).toBeVisible();
    expect(handoff.getByText("remaining after release")).toBeVisible();
    expect(handoff.getByText("USD 600,000.00")).toBeVisible();
    expect(handoff.getByText("debt remains recorded")).toBeVisible();

    const valuation = within(valuationRow);
    expect(valuation.getByText("Renew valuation")).toBeVisible();
    expect(
      valuation.getByText(
        "Chrome ore, single grade class · Port terminal stockyard, east-coast port",
      ),
    ).toBeVisible();
    expect(valuation.getByText(/Due 30 Nov 2026, 16:00 SAST/)).toBeVisible();
    expect(valuation.getByText("valued lot")).toBeVisible();
    expect(valuation.getByText("eligible value")).toBeVisible();
    for (const link of table.getAllByRole("link", { name: "Open dossier" })) {
      expect(link).toHaveAttribute("href", "/lender-one/lots/CR-0001");
      expect(link).not.toHaveClass("bg-(--act)");
    }
    expect(table.getAllByRole("link", { name: "Open dossier" })).toHaveLength(2);
  });

  it("exposes the URL filters and shows only tasks assigned to the acting organisation", () => {
    showQueue("lender-one", "mine");
    const mine = screen.getByRole("link", { name: "Assigned to me" });
    expect(mine).toHaveAttribute("aria-current", "true");
    expect(mine).toHaveAttribute("href", "/lender-one/queue");
    expect(screen.getByRole("link", { name: "Overdue" })).toHaveAttribute(
      "href",
      "/lender-one/queue?filter=overdue",
    );
    expect(screen.getByRole("button", { name: "All sites" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "All states" })).toBeDisabled();
    expect(screen.getByText("Review payment evidence")).toBeVisible();
    expect(screen.getByText("Renew valuation")).toBeVisible();
    expect(screen.queryByText("Approve external hand-off")).not.toBeInTheDocument();
  });

  it("shows the exporter's item and the empty state when filtered to the exporter", () => {
    const { unmount } = showQueue("khunou");
    expect(screen.getByText("Track release request")).toBeVisible();
    expect(screen.getByRole("link", { name: "Review evidence" })).toHaveAttribute(
      "href",
      "/khunou/releases/rel-0001",
    );
    expect(screen.queryByText("Review payment evidence")).not.toBeInTheDocument();
    unmount();

    showQueue("khunou", "mine");
    expect(screen.getByText("Nothing needs you right now.")).toBeVisible();
    expect(screen.getByRole("link", { name: "View exception queue" })).toHaveAttribute(
      "href",
      "/khunou/exceptions",
    );
  });

  it("shows the overdue empty state when no deadline has passed", () => {
    showQueue("lender-one", "overdue", Date.parse("2026-11-28T17:00:00+02:00"));
    expect(screen.getByRole("link", { name: "Overdue" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByText("No overdue work.")).toBeVisible();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("shows items with deadlines strictly before now", () => {
    showQueue("lender-one", "overdue", Date.parse("2026-11-28T17:00:01+02:00"));
    expect(screen.getByText("Review payment evidence")).toBeVisible();
    expect(screen.getAllByRole("row")).toHaveLength(2);
  });

  it("distinguishes an unavailable queue from an empty one", () => {
    render(<WorkQueueScreen organisationId="lender-one" data={null} now={beforeDeadlines} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load the work queue.");
    expect(screen.queryByText("Nothing needs you right now.")).not.toBeInTheDocument();
  });
});
