import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, assert, describe, expect, it } from "vitest";
import { ExceptionsScreen } from "@/components/queue/exceptions-screen";
import { referenceReader } from "@/data/reader";
import fixture from "../../../../fixtures/web/demo-scenario.json";

afterEach(cleanup);

const reader = referenceReader(fixture);

describe("Exceptions", () => {
  it("shows the lender's own case first and the financed cases with dossier links", () => {
    render(
      <ExceptionsScreen organisationId="lender-one" cases={reader.exceptions("lender-one")} />,
    );
    expect(screen.getByRole("heading", { name: "Exceptions" })).toBeVisible();
    expect(
      screen.getByText(
        "Cases you own, and cases on lots you finance. Retry never means resubmitting value.",
      ),
    ).toBeVisible();
    const table = within(screen.getByRole("table"));
    const [, ...rows] = table.getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(table.getAllByText("Not on chain")).toHaveLength(3);

    const expectedCases = [
      {
        kind: "Unmatched payment",
        owner: "Lender One Bank",
        reason:
          "Buyer reports payment; the lender has not attested it and nothing is recorded on chain.",
        action: "Review payment evidence",
      },
      {
        kind: "Duplicate intake",
        owner: "Kopano Stockyard Custody",
        reason:
          "Intake ID already issued to CR-0001. The existing record is shown; no new receipt.",
        action: "View existing record",
      },
      {
        kind: "Rejected handover",
        owner: "Mosela Haulage",
        reason: "Unaccredited haulier is not accredited for this batch. Handover refused.",
        action: "Assign an accredited haulier",
      },
    ];
    expectedCases.forEach(({ kind, owner, reason, action }, index) => {
      const caseRow = rows[index];
      assert(caseRow, `Expected row for ${kind}`);
      const row = within(caseRow);
      expect(row.getByText(kind)).toBeVisible();
      expect(row.getByText("CR-0001")).toBeVisible();
      expect(row.getByText(owner)).toBeVisible();
      expect(row.getByText(reason)).toBeVisible();
      const link = row.getByRole("link", { name: action });
      expect(link).toHaveAttribute("href", "/lender-one/lots/CR-0001");
      if (index === 0) expect(link).toHaveClass("bg-(--act)");
      else expect(link).not.toHaveClass("bg-(--act)");
    });
  });

  it("shows the empty state for the exporter", () => {
    render(<ExceptionsScreen organisationId="khunou" cases={reader.exceptions("khunou")} />);
    expect(screen.getByText("No open exceptions.")).toBeVisible();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("distinguishes an unavailable queue from an empty one", () => {
    render(<ExceptionsScreen organisationId="lender-one" cases={null} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load the exception queue.");
    expect(screen.queryByText("No open exceptions.")).not.toBeInTheDocument();
  });
});
