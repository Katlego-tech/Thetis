import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import ReleasePage from "@/app/[context]/releases/[releaseId]/page";
import { releaseCases } from "@/components/release/case-switch";
import { ReleaseReview } from "@/components/release/release-review";
import { referenceReader } from "@/data/reader";
import type { ReleaseCase } from "@/data/types";
import fixture from "../../../../fixtures/web/demo-scenario.json";

afterEach(cleanup);

const releaseId = "rel-0001";
const params = Promise.resolve({ context: "lender-one", releaseId });

function renderReview(selectedCase?: ReleaseCase, raw: unknown = fixture) {
  const reader = referenceReader(raw);
  const release = reader.release(releaseId, selectedCase);
  if (!release) throw new Error("Expected a fixture release");
  const cases = releaseCases.map((name) => {
    const option = reader.release(releaseId, name);
    if (!option) throw new Error(`Expected a fixture release for ${name}`);
    return option;
  });
  render(<ReleaseReview release={release} cases={cases} scenario={reader.scenario} />);
}

function row(label: string) {
  return within(screen.getByRole("row", { name: new RegExp(label) }));
}

it("renders the requested release, all waterfall lines, and separate payment and registry states", () => {
  renderReview();

  expect(
    screen.getByRole("heading", { name: "Release 2,000.000 t to Buyer Smelter Co" }),
  ).toBeInTheDocument();
  expect(
    screen.getByText(/seller Khunou Ore Exports. Expires 28 Nov 2026, 17:00 SAST./),
  ).toBeInTheDocument();
  expect(screen.getByText("Facility currency USD")).toBeInTheDocument();
  expect(screen.getByText("FIAT_ATTESTATION_TEST · devnet")).toBeInTheDocument();
  expect(
    within(screen.getByRole("table"))
      .getAllByRole("columnheader")
      .map((cell) => cell.textContent),
  ).toEqual(["Line", "Amount", "Basis"]);

  const lines = [
    ["Debt before", "USD 600,000.00", "Principal plus booked interest and fees"],
    ["Confirmed payment", "USD 400,000.00", "Buyer amount plus seller top-up"],
    ["Applied to debt", "USD 400,000.00", "The lesser of debt and payment"],
    ["Debt after", "USD 200,000.00", "Remains recorded against the lot"],
    ["Quantity after", "3,000.000 t", "5,000.000 t locked less 2,000.000 t sold"],
    ["Eligible value after", "USD 600,000.00", "At USD 200.00/t, haircut 0"],
    ["Limit after", "USD 360,000.00", "60.00% of eligible value"],
    ["Residual loan to value", "33.33%", "Within the 60.00% limit"],
    ["Seller surplus", "USD 0.00", "Nothing is released to the seller"],
  ] as const;
  lines.forEach(([label, amount, basis], index) => {
    const tableRow = within(screen.getByRole("table")).getAllByRole("row")[index + 1];
    expect(tableRow).toHaveTextContent(label);
    expect(tableRow).toHaveTextContent(amount);
    expect(tableRow).toHaveTextContent(basis);
  });
  expect(screen.getByRole("row", { name: /Debt after/ })).toHaveAttribute("data-total", "true");
  expect(screen.getByRole("row", { name: /Residual loan to value/ })).toHaveAttribute(
    "data-total",
    "true",
  );

  const status = within(screen.getByRole("complementary", { name: "Status" }));
  expect(status.getByText("Payment").parentElement).toHaveTextContent("Payment Reported by buyer");
  expect(status.getByText("Not yet attested by Lender One Bank.")).toBeInTheDocument();
  expect(status.getByText("Release")).toBeInTheDocument();
  expect(status.getByText("Not on chain")).toBeInTheDocument();
  expect(
    status.getByText("Recording needs the seller, the buyer and your attestation."),
  ).toBeInTheDocument();
  const attest = status.getByRole("button", { name: "Attest payment" });
  expect(attest).toBeDisabled();
  expect(attest).toHaveAccessibleDescription(
    "Signing is not available in the design reference. It arrives with wallet and login support.",
  );
});

it("shows an inline refusal and the above-limit residual LTV", () => {
  renderReview("sale-2000t-210k-refused");

  expect(screen.getByRole("alert")).toHaveTextContent(
    "Refused: debt after USD 390,000.00 exceeds the USD 360,000.00 limit. Additional top-up required: USD 30,000.00.",
  );
  expect(row("Debt after").getByText("USD 390,000.00")).toBeInTheDocument();
  const residual = row("Residual loan to value");
  expect(residual.getByText("65.00%")).toHaveClass("text-(--refuse)");
  expect(residual.getByText("Above the 60.00% limit")).toBeInTheDocument();
});

it("shows debt at the limit after the seller top-up", () => {
  renderReview("sale-2000t-210k-topup-30k");

  expect(row("Debt after").getByText("USD 360,000.00")).toBeInTheDocument();
  expect(row("Residual loan to value").getByText("Within the 60.00% limit")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("renders the domain error inline with its code and message", () => {
  const raw = structuredClone(fixture);
  const [request] = raw.releaseRequests;
  if (!request) throw new Error("Expected a fixture release request");
  request.soldLockedQuantityKg = "5000001";
  renderReview(undefined, raw);

  expect(screen.getByRole("alert")).toHaveTextContent(
    "Cannot preview: Sold quantity exceeds locked quantity (SOLD_EXCEEDS_LOCKED)",
  );
  expect(screen.queryByRole("table")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Attest payment" })).toBeDisabled();
});

it("links to each named case and selects the one from the URL", async () => {
  render(
    await ReleasePage({
      params,
      searchParams: Promise.resolve({ case: "sale-2000t-210k-refused" }),
    }),
  );

  expect(screen.getByRole("link", { name: "As requested: USD 400,000.00" })).toHaveAttribute(
    "href",
    "?case=sale-2000t-400k",
  );
  expect(screen.getByRole("link", { name: "USD 210,000.00, refused" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  expect(
    screen.getByRole("link", { name: "USD 210,000.00 plus USD 30,000.00 top-up" }),
  ).toHaveAttribute("href", "?case=sale-2000t-210k-topup-30k");
  expect(screen.getByRole("alert")).toHaveTextContent("USD 390,000.00");
});

it.each([
  { releaseId, selectedCase: "unknown" },
  { releaseId, selectedCase: ["sale-2000t-400k", "unknown"] },
  { releaseId: "missing", selectedCase: undefined },
])("calls notFound for an invalid release or case (%j)", async ({ releaseId, selectedCase }) => {
  await expect(
    ReleasePage({
      params: Promise.resolve({ context: "lender-one", releaseId }),
      searchParams: Promise.resolve(selectedCase === undefined ? {} : { case: selectedCase }),
    }),
  ).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
});
