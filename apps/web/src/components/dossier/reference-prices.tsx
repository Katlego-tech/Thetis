import { ResultTable } from "@/components/thetis/result-table";
import { parseReferencePrices } from "@/data/reference-prices";
import committed from "@/data/reference-prices.json";

// web.md §10.4: a dated, sourced reference for chromium products beside the lender's valuation.
// It is printed as published and feeds nothing: no valuation, eligible value or loan to value.

const MONTHS = [
  ["Jan", "January"],
  ["Feb", "February"],
  ["Mar", "March"],
  ["Apr", "April"],
  ["May", "May"],
  ["Jun", "June"],
  ["Jul", "July"],
  ["Aug", "August"],
  ["Sep", "September"],
  ["Oct", "October"],
  ["Nov", "November"],
  ["Dec", "December"],
] as const;

/** "2026-02" → "February 2026" (validated YYYY-MM). */
function monthYear(period: string): string {
  const [year, month] = period.split("-");
  return `${MONTHS[Number(month) - 1]?.[1]} ${year}`;
}

/** "2026-11-28" → "28 Nov 2026" (validated YYYY-MM-DD). */
function day(date: string): string {
  const [year, month, dayOfMonth] = date.split("-");
  return `${Number(dayOfMonth)} ${MONTHS[Number(month) - 1]?.[0]} ${year}`;
}

export function ReferencePrices({ data = committed }: { data?: unknown }) {
  const parsed = parseReferencePrices(data);
  if (!parsed.ok) {
    console.warn("Reference prices not shown", { reason: parsed.reason });
    return null;
  }
  const { source, prices } = parsed.data;
  return (
    <section aria-labelledby="financing-reference-prices" className="flex flex-col gap-4">
      <h2 id="financing-reference-prices">Reference prices</h2>
      <div className="work-panel">
        <div className="flex flex-col gap-1">
          <p className="font-semibold">Chromium products reference. Not this lot's valuation.</p>
          <p className="text-(--ink-2)">
            US prices for chromium metal and high-carbon ferrochromium, not chrome ore. They change
            no valuation, eligible value or loan to value on this page.
          </p>
        </div>
        <ResultTable
          columns={[
            { key: "product", label: "Product" },
            { key: "measure", label: "Measure" },
            { key: "period", label: "Period" },
            { key: "price", label: "Price", align: "right" },
          ]}
          rows={prices.map(({ product, measure, period, amount, currency, unit }) => ({
            product,
            measure,
            period: monthYear(period),
            price: <span className="tabular-nums">{`${currency} ${amount} ${unit}`}</span>,
          }))}
        />
        <div className="flex flex-col gap-1 text-[12px] text-(--ink-2)">
          <p>
            {`Source: ${source.publisher}, ${source.publication}, ${source.location}. Prices from ${source.priceSource}, as published by USGS.`}
          </p>
          <p>{`Retrieved ${day(source.retrievedOn)}.`}</p>
          <p>{source.note}</p>
          <p>
            <a
              className="text-(--act) underline"
              href={source.url}
              target="_blank"
              rel="noreferrer"
            >
              Open the USGS issue
            </a>
          </p>
        </div>
      </div>
    </section>
  );
}
