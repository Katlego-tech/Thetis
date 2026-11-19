import { PageHeader } from "@/components/thetis/page-header";
import type { ThetisReader } from "@/data/reader";
import type { ReleaseView } from "@/data/types";
import { formatDateTime, formatTonnes } from "@/lib/format";
import { CaseSwitch } from "./case-switch";
import { StatusPanel } from "./status-panel";
import { WaterfallTable } from "./waterfall-table";

export function ReleaseReview({
  release,
  cases,
  scenario,
}: {
  release: ReleaseView;
  cases: ReleaseView[];
  scenario: ThetisReader["scenario"];
}) {
  const { buyer, seller, expiresAt, inputs, lot, payment, lender, registry, currency, preview } =
    release;
  return (
    <>
      <PageHeader
        title={`Release ${formatTonnes(inputs.soldLockedQuantity)} to ${buyer.name}`}
        sub={
          <>
            Lot <span className="font-medium font-mono text-[13px]">{lot.id}</span>, seller{" "}
            {seller.name}. Expires {formatDateTime(expiresAt)}.
          </>
        }
        aside={
          <div className="font-medium font-mono text-[12px] text-(--ink-2) leading-[1.4]">
            <div>Facility currency {currency}</div>
            <div>
              {scenario.settlementMode} · {scenario.network}
            </div>
          </div>
        }
      />
      <CaseSwitch
        cases={cases}
        activeCase={release.case}
        minorDigits={scenario.currencyMinorDigits}
      />
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <WaterfallTable
          currency={currency}
          inputs={inputs}
          preview={preview}
          minorDigits={scenario.currencyMinorDigits}
        />
        <StatusPanel lender={lender} payment={payment} registry={registry} />
      </div>
    </>
  );
}
