import { PageHeader } from "@/components/thetis/page-header";
import type { LiveReader, LiveReleaseView } from "@/data/live/types";
import { formatClockTime, formatDateTime, formatTonnes } from "@/lib/format";
import { LiveReleaseStatus } from "./live-release-status";
import { TermsTable } from "./terms-table";
import { WaterfallTable } from "./waterfall-table";

// The release screen in live mode (live-lending.md §6.9.3, §4.5.4; layout of release.html, no
// CaseSwitch). Every figure is the intent's or the loan's as indexed; nothing here records anything.

export function LiveReleaseReview({
  release,
  scenario,
  context,
  organisationId,
}: {
  release: LiveReleaseView;
  scenario: LiveReader["scenario"];
  context: string;
  organisationId: string | null;
}) {
  const { intent, inputs, preview, previewBlocked } = release;
  return (
    <>
      <PageHeader
        title={`Release ${formatTonnes(intent.quantityKg)} to ${intent.buyer.name}`}
        sub={
          <>
            Lot <span className="font-medium font-mono text-[13px]">{intent.lotId}</span>, seller{" "}
            {intent.seller.name}. Intent expires {formatDateTime(intent.expiresAt)}.
          </>
        }
        aside={
          <div className="font-medium font-mono text-[12px] text-(--ink-2) leading-[1.4]">
            <div>Facility currency {release.currency}</div>
            <div>
              {scenario.settlementMode} · {scenario.network}
            </div>
          </div>
        }
      />
      <div className="work-columns">
        <div className="flex min-w-0 flex-col gap-3">
          {preview !== null && inputs !== null ? (
            <>
              <p className="text-[12px] text-(--ink-2)">
                Preview from the intent's terms and the loan as of {formatClockTime(release.asOf)}.
                Nothing here is recorded until the lender confirms the payment and the chain
                confirms the sale.
              </p>
              <WaterfallTable
                currency={release.currency}
                inputs={inputs}
                preview={preview}
                minorDigits={release.minorDigits}
                source="live"
              />
            </>
          ) : (
            <>
              <p className="text-[13px]">
                {previewBlocked === "buyer"
                  ? "The loan figures are visible to the lender and the seller."
                  : "No valuation on chain for this lot's class, grade and site, so the release can't be previewed."}
              </p>
              <TermsTable intent={intent} />
            </>
          )}
        </div>
        <LiveReleaseStatus release={release} context={context} organisationId={organisationId} />
      </div>
    </>
  );
}
