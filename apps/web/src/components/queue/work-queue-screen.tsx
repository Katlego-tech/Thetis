import Link from "next/link";
import { PageHeader } from "@/components/thetis/page-header";
import { RegistryMark } from "@/components/thetis/registry-mark";
import type { ScreenReader } from "@/data/live/types";
import type { ThetisReader } from "@/data/reader";
import { formatBpsPercent, formatDateTime, formatMoney, formatTonnes } from "@/lib/format";
import { lotIdClass, QueueAction, QueueTable } from "./queue-table";

export const workQueueTitle = "Work requiring attention";
export const workQueueColumns = [
  { key: "lot", label: "Lot" },
  { key: "task", label: "Task and blocker" },
  { key: "quantity", label: "Quantity", align: "right" },
  { key: "amount", label: "Amount", align: "right" },
  { key: "registry", label: "Registry" },
  { key: "action", label: "Action" },
] as const;

function referenceItems(reader: ThetisReader, organisationId: string) {
  const { currencyMinorDigits, facilityCurrency } = reader.scenario;
  const money = (value: bigint) => formatMoney(value, facilityCurrency, currencyMinorDigits);
  const items = reader.workQueue(organisationId).map((item) => {
    const releasePrefix = `/${organisationId}/releases/`;
    const opensRelease = item.href.startsWith(releasePrefix);
    const release = opensRelease ? reader.release(item.href.slice(releasePrefix.length)) : null;
    const deadline = item.deadline === null ? null : Date.parse(item.deadline);
    let quantityBasis: string | undefined;
    let amountBasis: string | undefined;
    let valuationTerms: string | undefined;

    if (release) {
      quantityBasis = `of ${formatTonnes(release.inputs.lockedQuantity)} pledged`;
      if (!("error" in release.preview))
        amountBasis = `debt after ${money(release.preview.debtAfter)}`;
    } else if (item.action === "Approve external hand-off") {
      quantityBasis = "remaining after release";
      amountBasis = "debt remains recorded";
    } else if (item.action === "Renew valuation") {
      quantityBasis = "valued lot";
      amountBasis = "eligible value";
      const valuation = reader.lot(item.lot.id)?.valuation;
      if (valuation) {
        valuationTerms = `${money(valuation.valuePerKgMinor * 1000n)}/t, haircut ${formatBpsPercent(valuation.haircutBps)}, limit ${formatBpsPercent(valuation.maxLtvBps)}.`;
      }
    }

    return {
      ...item,
      deadline,
      opensRelease,
      quantity: item.quantityKg === null ? "none" : formatTonnes(item.quantityKg),
      amount: item.amountMinor === null ? "none" : money(item.amountMinor),
      quantityBasis: item.quantityKg === null ? undefined : quantityBasis,
      amountBasis: item.amountMinor === null ? undefined : amountBasis,
      taskDetails: [
        valuationTerms,
        item.blocker,
        item.nextActor.id !== organisationId && !opensRelease
          ? `Next: ${item.nextActor.name}.`
          : null,
        item.deadline !== null && Number.isFinite(deadline)
          ? `Due ${formatDateTime(item.deadline)}.`
          : null,
      ]
        .filter(Boolean)
        .join(" "),
    };
  });

  return items;
}

export function getQueueData(
  reader: ScreenReader,
  organisationId: string,
): { scenario: ScreenReader["scenario"]; items: ReturnType<typeof referenceItems> } {
  // Phase 1 chain state creates no work, so a live queue has nothing to format.
  if (reader.mode === "live") return { scenario: reader.scenario, items: [] };
  return { scenario: reader.scenario, items: referenceItems(reader, organisationId) };
}

const chipClass = "rounded-sm border border-(--rule) bg-(--sheet) px-2.5 py-[5px] text-[13px]";

export function WorkQueueScreen({
  organisationId,
  data,
  filter,
  now,
}: {
  organisationId: string;
  data: ReturnType<typeof getQueueData> | null;
  filter?: string | undefined;
  now: number;
}) {
  const queueHref = `/${organisationId}/queue`;
  const items = data?.items.filter((item) => {
    if (filter === "mine") return item.nextActor.id === organisationId;
    if (filter === "overdue") return item.deadline !== null && item.deadline < now;
    return true;
  });

  return (
    <>
      <PageHeader
        title={workQueueTitle}
        aside={
          data && (
            <div className="text-xs leading-[1.4] text-(--ink-2)">
              <div className="font-mono font-medium">
                {data.scenario.settlementMode} · {data.scenario.network}
              </div>
              <div>
                {data.scenario.facilityCurrency === null
                  ? "No facility on chain"
                  : `Facility currency ${data.scenario.facilityCurrency}`}
              </div>
            </div>
          )
        }
      />
      <nav aria-label="Work queue filters" className="flex flex-wrap gap-2">
        {[
          { value: "mine", label: "Assigned to me" },
          { value: "overdue", label: "Overdue" },
        ].map(({ value, label }) => (
          <Link
            key={value}
            className={`${chipClass} hover:border-(--ink) aria-[current=true]:border-(--ink) aria-[current=true]:font-semibold`}
            href={filter === value ? queueHref : `${queueHref}?filter=${value}`}
            aria-current={filter === value ? "true" : undefined}
          >
            {label}
          </Link>
        ))}
        <button type="button" disabled className={`${chipClass} text-(--ink-2)`}>
          All sites
        </button>
        <button type="button" disabled className={`${chipClass} text-(--ink-2)`}>
          All states
        </button>
      </nav>

      {items === undefined ? (
        <p role="alert" className="text-(--refuse)">
          Could not load the work queue.
        </p>
      ) : items.length === 0 ? (
        <div>
          <p>{filter === "overdue" ? "No overdue work." : "Nothing needs you right now."}</p>
          {filter !== "overdue" && (
            <Link className="page-link" href={`/${organisationId}/exceptions`}>
              View exception queue
            </Link>
          )}
        </div>
      ) : (
        <QueueTable
          workQueue
          columns={[...workQueueColumns]}
          rows={items.map((item, index) => ({
            lot: (
              <>
                <span className={lotIdClass}>{item.lot.id}</span>
                <span className="block text-xs text-(--ink-2)">
                  {item.lot.gradeClass} · {item.lot.site.name}
                </span>
              </>
            ),
            task: (
              <>
                <strong className="font-semibold">{item.action}</strong>
                <span className="block text-[13px] text-(--ink-2)">{item.taskDetails}</span>
              </>
            ),
            quantity: <QueueFigure value={item.quantity} basis={item.quantityBasis} />,
            amount: <QueueFigure value={item.amount} basis={item.amountBasis} />,
            registry: <RegistryMark status={item.registry.status} />,
            action: (
              <QueueAction href={item.href} primary={index === 0}>
                {item.opensRelease ? "Review evidence" : "Open dossier"}
              </QueueAction>
            ),
          }))}
        />
      )}
    </>
  );
}

function QueueFigure({ value, basis }: { value: string; basis: string | undefined }) {
  return (
    <>
      <strong className="text-[15px] font-semibold tabular-nums">{value}</strong>
      {basis && <span className="block text-xs text-(--ink-2)">{basis}</span>}
    </>
  );
}
