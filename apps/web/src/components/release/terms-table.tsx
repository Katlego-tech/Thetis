import { ResultTable } from "@/components/thetis/result-table";
import type { LiveIntent } from "@/data/live/types";
import { formatDateTime, formatMoney, formatTonnes } from "@/lib/format";

// An intent's own terms, for a reader who gets no preview (live-lending.md §6.9.3).

export function TermsTable({ intent }: { intent: LiveIntent }) {
  const money = (minor: bigint) => formatMoney(minor, intent.currency, intent.currencyDecimals);
  return (
    <ResultTable
      columns={[
        { key: "quantity", label: "Quantity", align: "right" },
        { key: "price", label: "Price", align: "right" },
        { key: "topUp", label: "Top-up", align: "right" },
        { key: "total", label: "Total payment", align: "right" },
        { key: "expires", label: "Intent expires" },
      ]}
      rows={[
        {
          quantity: formatTonnes(intent.quantityKg),
          price: money(intent.priceMinor),
          topUp: money(intent.topUpMinor),
          total: money(intent.priceMinor + intent.topUpMinor),
          expires: formatDateTime(intent.expiresAt),
        },
      ]}
    />
  );
}
