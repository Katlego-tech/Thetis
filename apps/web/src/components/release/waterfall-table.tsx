import { ResultTable } from "@/components/thetis/result-table";
import type { ReleaseView } from "@/data/types";
import { formatBpsPercent, formatMoney, formatTonnes } from "@/lib/format";

export const waterfallColumns = [
  { key: "line", label: "Line" },
  { key: "amount", label: "Amount", align: "right" },
  { key: "basis", label: "Basis" },
] satisfies Parameters<typeof ResultTable>[0]["columns"];

type WaterfallProps = Pick<ReleaseView, "currency" | "inputs" | "preview"> & {
  minorDigits: number;
  /** live: no caption of its own (LiveReleaseReview renders §6.9.3's), and a confirmed payment */
  source?: "reference" | "live";
};

export function WaterfallTable({
  currency,
  inputs,
  preview,
  minorDigits,
  source = "reference",
}: WaterfallProps) {
  const money = (minor: bigint) => formatMoney(minor, currency, minorDigits);

  if ("error" in preview) {
    return (
      <p role="alert" className="border border-(--refuse) bg-(--sheet) p-3 text-(--refuse)">
        Cannot preview: {preview.error.message} ({preview.error.code})
      </p>
    );
  }

  const { eligibleValueAfter, debtAfter, allowed } = preview;
  const limitPercent = formatBpsPercent(inputs.maxLtvBps);
  let residualLtv = "Undefined";
  if (eligibleValueAfter > 0n) {
    residualLtv = formatBpsPercent((debtAfter * 10000n) / eligibleValueAfter);
  } else if (debtAfter === 0n) {
    residualLtv = formatBpsPercent(0n);
  }

  const haircut = inputs.haircutBps === 0n ? "0" : formatBpsPercent(inputs.haircutBps);
  const rows = [
    ["Debt before", money(preview.debtBefore), "Principal plus booked interest and fees"],
    [
      source === "live" ? "Payment, once confirmed" : "Payment, once attested",
      money(preview.confirmedPayment),
      "Buyer amount plus seller top-up",
    ],
    ["Applied to debt", money(preview.applied), "The lesser of debt and payment"],
    ["Debt after", money(debtAfter), "Remains recorded against the lot"],
    [
      "Quantity after",
      formatTonnes(preview.quantityAfter),
      `${formatTonnes(inputs.lockedQuantity)} locked less ${formatTonnes(inputs.soldLockedQuantity)} sold`,
    ],
    [
      "Eligible value after",
      money(eligibleValueAfter),
      `At ${money(inputs.valuePerUnit * 1000n)}/t, haircut ${haircut}`,
    ],
    ["Limit after", money(preview.limitAfter), `${limitPercent} of eligible value`],
    [
      "Residual loan to value",
      <span key="residual" className={allowed ? undefined : "text-(--refuse)"}>
        {residualLtv}
      </span>,
      `${allowed ? "Within" : "Above"} the ${limitPercent} limit`,
    ],
    [
      "Seller surplus",
      money(preview.sellerSurplus),
      preview.sellerSurplus === 0n
        ? "Nothing is released to the seller"
        : "Payment remaining after debt is covered",
    ],
  ].map(([line, amount, basis]) => ({
    line,
    amount,
    basis: <span className="block text-[12px] text-(--ink-2)">{basis}</span>,
  }));

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {source === "reference" && (
        <p className="text-[12px] text-(--ink-2)">
          Preview from the reported terms. Nothing here is recorded until the lender attests the
          payment and the chain confirms the release.
        </p>
      )}
      {!allowed && (
        <p role="alert" className="border border-(--refuse) bg-(--sheet) p-3 text-(--refuse)">
          Refused: debt after {money(debtAfter)} exceeds the {money(preview.limitAfter)} limit.
          Additional top-up required: {money(preview.requiredAdditionalTopUp)}.
        </p>
      )}
      <ResultTable columns={waterfallColumns} rows={rows} totalRowIndexes={[3, 7]} />
    </div>
  );
}
