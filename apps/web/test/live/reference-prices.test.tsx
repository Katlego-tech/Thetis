// web.md §10: the dated USGS chromium-products reference beside the lender's valuation. It is shown
// with its source and retrieval date and is never an input to any valuation, coverage or loan to value.

import "@testing-library/jest-dom/vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { LotDossier } from "@/components/dossier/lot-dossier";
import { ReferencePrices } from "@/components/dossier/reference-prices";
import { liveReader } from "@/data/live/map";
import type { LiveSnapshot } from "@/data/live/rows";
import { parseReferencePrices } from "@/data/reference-prices";
import committed from "@/data/reference-prices.json";
import { intent, NOW, payment, pledgedSnapshot, RELEASE_PAYMENT } from "./snapshot";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const clone = (): Record<string, unknown> => structuredClone(committed) as Record<string, unknown>;

function withSource(field: string, value: unknown) {
  const data = clone();
  data.source = { ...(data.source as object), [field]: value };
  return data;
}

function withPrice(index: number, field: string, value: unknown) {
  const data = clone();
  const prices = structuredClone(data.prices) as Record<string, unknown>[];
  prices[index] = { ...prices[index], [field]: value };
  data.prices = prices;
  return data;
}

function withoutSource(field: string) {
  const data = clone();
  const source = { ...(data.source as Record<string, unknown>) };
  delete source[field];
  data.source = source;
  return data;
}

function withoutPrice(index: number, field: string) {
  const data = clone();
  const prices = structuredClone(data.prices) as Record<string, unknown>[];
  delete prices[index]?.[field];
  data.prices = prices;
  return data;
}

function reason(value: unknown) {
  const parsed = parseReferencePrices(value);
  if (parsed.ok) throw new Error("expected the reference prices to be refused");
  return parsed.reason;
}

// The phrase is built, so it is never written out anywhere in the repository.
const BANNED = ["public", "domain"].join(" ");

describe("reference price data", () => {
  test("the committed file parses and carries the USGS figures exactly as printed", () => {
    const parsed = parseReferencePrices(committed);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.data.source).toMatchObject({
      issue: "2026-02",
      url: "https://d9-wret.s3.us-west-2.amazonaws.com/assets/palladium/production/s3fs-public/media/files/mis-202602-chrom.pdf",
      location: "Page 2, text and figure 2",
      priceSource: "Argus Media, Argus Non-Ferrous Markets",
      retrievedOn: "2026-11-28",
    });
    expect(
      parsed.data.prices.map(({ product, amount, unit, period }) => [
        product,
        amount,
        unit,
        period,
      ]),
    ).toEqual([
      ["Chromium metal, 99% chromium", "5.68", "per pound", "2026-02"],
      [
        "High-carbon ferrochromium, minimum 62% chromium",
        "1.76",
        "per pound of contained chromium",
        "2026-02",
      ],
    ]);
  });

  test("the committed file never makes a rights claim for the figures", () => {
    expect(JSON.stringify(committed).toLowerCase()).not.toContain(BANNED);
  });

  test.each([
    ["a missing source field", withoutSource("publisher"), "source.publisher"],
    ["a missing retrieval date", withoutSource("retrievedOn"), "source.retrievedOn"],
    ["a missing amount", withoutPrice(0, "amount"), "prices[0].amount"],
    ["a missing unit", withoutPrice(1, "unit"), "prices[1].unit"],
    ["an empty product", withPrice(0, "product", ""), "prices[0].product"],
    ["a numeric amount", withPrice(0, "amount", 5.68), "prices[0].amount"],
    ["a comma decimal", withPrice(1, "amount", "5,68"), "prices[1].amount"],
    ["a bare fraction", withPrice(0, "amount", ".5"), "prices[0].amount"],
    ["a whole number", withPrice(0, "amount", "5"), "prices[0].amount"],
    ["another currency", withPrice(0, "currency", "ZAR"), "prices[0].currency"],
    ["a bad period", withPrice(0, "period", "2026-13"), "prices[0].period"],
    ["a bad issue", withSource("issue", "February 2026"), "source.issue"],
    [
      "a url for another issue",
      withSource("url", committed.source.url.replace("202602", "202601")),
      "source.url",
    ],
    [
      "a url off the USGS store",
      withSource("url", "https://example.org/mis-202602-chrom.pdf"),
      "source.url",
    ],
    ["an impossible retrieval date", withSource("retrievedOn", "2026-02-30"), "source.retrievedOn"],
    ["a short checksum", withSource("sha256", "065dcfa4"), "source.sha256"],
    ["another kind", { ...clone(), kind: "chrome_ore_price" }, "kind"],
    ["no prices", { ...clone(), prices: [] }, "prices"],
  ])("%s is refused with a reason naming the field", (_name, value, field) => {
    expect(reason(value)).toContain(field);
  });

  test("a missing file's value is refused", () => {
    expect(reason(undefined)).toContain("reference prices");
    expect(reason(null)).toContain("reference prices");
  });
});

describe("reference prices panel", () => {
  test("renders the label, both prices, the period, the source line and the link", () => {
    const { container } = render(<ReferencePrices />);
    const section = screen.getByRole("region", { name: "Reference prices" });
    expect(
      within(section).getByText("Chromium products reference. Not this lot's valuation."),
    ).toBeVisible();
    expect(
      within(section).getByText(
        "US prices for chromium metal and high-carbon ferrochromium, not chrome ore. They change no valuation, eligible value or loan to value on this page.",
      ),
    ).toBeVisible();
    const heads = within(section)
      .getAllByRole("columnheader")
      .map((head) => head.textContent);
    expect(heads).toEqual(["Product", "Measure", "Period", "Price"]);
    const rows = within(section)
      .getAllByRole("row")
      .slice(1)
      .map((row) =>
        within(row)
          .getAllByRole("cell")
          .map((cell) => {
            const copy = cell.cloneNode(true) as HTMLElement;
            for (const label of copy.querySelectorAll(".result-mobile-label")) label.remove();
            return copy.textContent;
          }),
      );
    expect(rows).toEqual([
      [
        "Chromium metal, 99% chromium",
        "Average assessed US price",
        "February 2026",
        "USD 5.68 per pound",
      ],
      [
        "High-carbon ferrochromium, minimum 62% chromium",
        "Average assessed US price",
        "February 2026",
        "USD 1.76 per pound of contained chromium",
      ],
    ]);
    expect(
      within(section).getByText(
        "Source: U.S. Geological Survey, National Minerals Information Center, Mineral Industry Surveys, Chromium in February 2026, Page 2, text and figure 2. Prices from Argus Media, Argus Non-Ferrous Markets, as published by USGS.",
      ),
    ).toBeVisible();
    expect(within(section).getByText("Retrieved 28 Nov 2026.")).toBeVisible();
    expect(
      within(section).getByText(
        "Issues from March 2026 on publish trade tables only, without prices.",
      ),
    ).toBeVisible();
    const link = within(section).getByRole("link", { name: "Open the USGS issue" });
    expect(link).toHaveAttribute("href", committed.source.url);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
    expect(container.textContent?.toLowerCase()).not.toContain(BANNED);
    expect(container.textContent).not.toMatch(/[–—]/);
  });

  test("invalid data renders nothing and logs the reason", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { container } = render(<ReferencePrices data={withPrice(0, "amount", 5.68)} />);
    expect(container).toBeEmptyDOMElement();
    expect(warn).toHaveBeenCalledWith("Reference prices not shown", {
      reason: expect.stringContaining("prices[0].amount"),
    });
  });

  test("missing data renders nothing and logs the reason", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { container } = render(<ReferencePrices data={null} />);
    expect(container).toBeEmptyDOMElement();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

function dossier(snapshot: LiveSnapshot, context: string, role: string) {
  const reader = liveReader(snapshot, NOW);
  const lot = reader.lot("CR-0001", context);
  if (!lot) throw new Error(`CR-0001 is not visible to ${context}`);
  return render(
    <LotDossier
      lot={lot}
      context={context}
      tab="financing"
      workItems={reader.workQueue(context)}
      currency={lot.lending?.facilities[0]?.currency ?? null}
      minorDigits={lot.lending?.facilities[0]?.currencyDecimals ?? null}
      source="live"
      role={role}
    />,
  );
}

describe("on the Financing tab", () => {
  test("the lender sees the reference after Facilities, with the computed results unchanged", () => {
    dossier(pledgedSnapshot(), "lender-one", "lender");
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    const facilities = headings.indexOf("Facilities");
    expect(facilities).toBeGreaterThanOrEqual(0);
    expect(headings[facilities + 1]).toBe("Reference prices");
    expect(screen.getByRole("row", { name: /Eligible value/ })).toBeVisible();
  });

  test("a buyer without a facility view does not see it", () => {
    const snapshot = pledgedSnapshot(["buyer-smelter"]);
    snapshot.facilities = [];
    snapshot.valuations = [];
    snapshot.loans = [];
    snapshot.locks = [];
    snapshot.intents = [intent()];
    snapshot.payments = [payment(RELEASE_PAYMENT)];
    dossier(snapshot, "buyer-smelter", "buyer");
    expect(screen.queryByRole("region", { name: "Reference prices" })).toBeNull();
  });
});

describe("not an input", () => {
  const root = join(__dirname, "../../src");
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? files(join(dir, entry.name))
        : /\.(ts|tsx)$/.test(entry.name)
          ? [join(dir, entry.name)]
          : [],
    );
  const importers = (pattern: RegExp) =>
    files(root)
      .filter((file) =>
        [...readFileSync(file, "utf8").matchAll(/from\s+["']([^"']+)["']/g)].some(([, spec]) =>
          pattern.test(spec ?? ""),
        ),
      )
      .map((file) => relative(root, file))
      .sort();

  const data = /(^|\/)data\/reference-prices(\.json)?$/;
  const panel = /(^@\/components\/dossier\/|^\.\/)reference-prices$/;

  test("only the panel reads the reference data", () => {
    expect(importers(data)).toEqual(["components/dossier/reference-prices.tsx"]);
  });

  test("only the Financing tab mounts the panel", () => {
    expect(importers(panel)).toEqual(["components/dossier/financing-live.tsx"]);
  });

  test("the walk sees the valuation path", () => {
    const walked = files(root).map((file) => relative(root, file));
    for (const file of [
      "data/live/map.ts",
      "data/reader.ts",
      "lib/format.ts",
      "components/dossier/valuation-section.tsx",
      "components/dossier/record-tables.tsx",
    ])
      expect(walked).toContain(file);
  });
});
