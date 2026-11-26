import Link from "next/link";
import { PageHeader } from "@/components/thetis/page-header";
import { RegistryMark } from "@/components/thetis/registry-mark";
import { StateMark } from "@/components/thetis/state-mark";
import type { LiveLotView } from "@/data/live/types";
import type { WorkItemView } from "@/data/types";
import { formatMoney, formatTonnes } from "@/lib/format";
import { LotStaleNote } from "./lot-stale-note";
import { NextPanel, overviewColumns, QuantityPanel } from "./overview-panels";
import {
  CustodyEvents,
  EvidenceTable,
  type FinancialRecord,
  FinancialResults,
  ReleaseTable,
} from "./record-tables";

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
  source = "reference",
  stale = null,
}: {
  lot: LiveLotView;
  context: string;
  tab: string | undefined;
  workItems: WorkItemView[];
  currency: string | null;
  minorDigits: number | null;
  source?: "reference" | "live";
  stale?: "halted" | "skew" | null;
}) {
  const activeTab = tabs.find(({ id }) => id === tab)?.id ?? "overview";
  let financial: FinancialRecord;
  if (lot.loan === null) {
    financial = { lot, money: null };
  } else if (currency !== null && minorDigits !== null) {
    financial = { lot, money: (minor: bigint) => formatMoney(minor, currency, minorDigits) };
  } else {
    throw new Error(`Lot ${lot.id} has a loan but no facility currency to show it in`);
  }
  // On chain, a lot whose positions are all empty has no current holder.
  const unheld = source === "live" && lot.position.positionQuantityKg === 0n;

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
              {lot.site.name}. {unheld ? "No current holder." : `Owner ${lot.owner.name}.`}{" "}
              Custodian {lot.custodian.name}.
            </>
          }
          aside={
            <div className="flex max-w-full flex-wrap gap-2">
              <StateMark dimension="Custody" value={lot.custody} />
              {!unheld && <StateMark dimension="Finance" value={lot.finance} />}
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
      {stale !== null && <LotStaleNote stale={stale} />}
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
            <QuantityPanel lot={lot} source={source} />
            <FinancialResults {...financial} includeQuantity />
          </div>
          <NextPanel items={workItems} context={context} />
        </div>
      )}
      {activeTab === "evidence" && <EvidenceTable evidence={lot.evidence} source={source} />}
      {activeTab === "financing" && (
        <>
          <FinancialResults {...financial} />
          <ReleaseTable releases={lot.releases} context={context} />
        </>
      )}
      {activeTab === "custody" && <CustodyEvents events={lot.custodyTimeline} />}
      {activeTab === "activity" && <CustodyEvents events={lot.custodyTimeline} activity />}
    </>
  );
}
