import Link from "next/link";
import { PageHeader } from "@/components/thetis/page-header";
import { RegistryMark } from "@/components/thetis/registry-mark";
import { StateMark } from "@/components/thetis/state-mark";
import type { LotView, WorkItemView } from "@/data/types";
import { formatMoney, formatTonnes } from "@/lib/format";
import { NextPanel, overviewColumns, QuantityPanel } from "./overview-panels";
import { CustodyEvents, EvidenceTable, FinancialResults, ReleaseTable } from "./record-tables";

const tabs = [
  { id: "overview", label: "Overview" },
  { id: "evidence", label: "Evidence" },
  { id: "financing", label: "Financing" },
  { id: "custody", label: "Custody" },
  { id: "activity", label: "Activity" },
] as const;

export function LotDossier({
  lot,
  context,
  tab,
  workItems,
  currency,
  minorDigits,
}: {
  lot: LotView;
  context: string;
  tab: string | undefined;
  workItems: WorkItemView[];
  currency: string;
  minorDigits: number;
}) {
  const activeTab = tabs.find(({ id }) => id === tab)?.id ?? "overview";
  const money = (minor: bigint) => formatMoney(minor, currency, minorDigits);

  return (
    <>
      <div className="min-w-0 [&_.page-header>div:first-child]:flex-1 [&_.page-header>div:first-child]:basis-87.5">
        <PageHeader
          title={
            <>
              <span className="font-mono text-[24px] font-medium">{lot.id}</span> {lot.gradeClass}
            </>
          }
          sub={
            <>
              <span className="tabular-nums">{formatTonnes(lot.quantityKg)}</span> at{" "}
              {lot.site.name}. Owner {lot.owner.name}. Custodian {lot.custodian.name}.
            </>
          }
          aside={
            <div className="flex max-w-full flex-wrap gap-2">
              <StateMark dimension="Custody" value={lot.custody} />
              <StateMark dimension="Finance" value={lot.finance} />
              <StateMark dimension="Restriction" value={lot.restriction} />
              <span className="relative inline-flex items-center [&>.thetis-mark]:ps-14">
                <span className="pointer-events-none absolute start-[9px] text-xs text-(--ink-2)">
                  Registry
                </span>
                <RegistryMark status={lot.registry.status} />
              </span>
            </div>
          }
        />
      </div>
      <nav aria-label="Lot dossier" className="flex flex-wrap gap-1 border-b border-(--rule)">
        {tabs.map(({ id, label }) => (
          <Link
            key={id}
            href={`?tab=${id}`}
            aria-current={id === activeTab ? "page" : undefined}
            className="-mb-px border-b-2 border-transparent px-3 py-2 text-(--ink-2) hover:text-(--ink) aria-[current=page]:border-(--ink) aria-[current=page]:font-semibold aria-[current=page]:text-(--ink)"
          >
            {label}
          </Link>
        ))}
      </nav>
      {activeTab === "overview" && (
        <div className={overviewColumns}>
          <div className="grid min-w-0 gap-5">
            <QuantityPanel lot={lot} />
            <FinancialResults lot={lot} money={money} includeQuantity />
          </div>
          <NextPanel items={workItems} context={context} />
        </div>
      )}
      {activeTab === "evidence" && <EvidenceTable evidence={lot.evidence} />}
      {activeTab === "financing" && (
        <>
          <FinancialResults lot={lot} money={money} />
          <ReleaseTable releases={lot.releases} context={context} />
        </>
      )}
      {activeTab === "custody" && <CustodyEvents events={lot.custodyTimeline} />}
      {activeTab === "activity" && <CustodyEvents events={lot.custodyTimeline} activity />}
    </>
  );
}
