import { PageHeader } from "@/components/thetis/page-header";
import { RegistryMark } from "@/components/thetis/registry-mark";
import type { ExceptionView } from "@/data/types";
import { lotIdClass, QueueAction, QueueTable } from "./queue-table";

export const exceptionsTitle = "Exceptions";
export const exceptionsSubtitle =
  "Cases you own, and cases on lots you finance. Retry never means resubmitting value.";
export const exceptionsColumns = [
  { key: "kind", label: "Case" },
  { key: "lot", label: "Lot" },
  { key: "owner", label: "Owner" },
  { key: "reason", label: "Reason" },
  { key: "registry", label: "Registry" },
  { key: "action", label: "Action" },
];

export function ExceptionsScreen({
  organisationId,
  cases,
}: {
  organisationId: string;
  cases: ExceptionView[] | null;
}) {
  const orderedCases = cases?.toSorted(
    (first, second) =>
      Number(second.owner.id === organisationId) - Number(first.owner.id === organisationId),
  );

  return (
    <>
      <PageHeader title={exceptionsTitle} sub={exceptionsSubtitle} />
      {orderedCases === undefined ? (
        <p role="alert" className="text-(--refuse)">
          Could not load the exception queue.
        </p>
      ) : orderedCases.length === 0 ? (
        <p>No open exceptions.</p>
      ) : (
        <QueueTable
          columns={exceptionsColumns}
          rows={orderedCases.map(({ kind, lot, owner, reason, nextAction, registry }) => ({
            kind: (
              <strong className="font-semibold">
                {kind.charAt(0).toUpperCase() + kind.slice(1)}
              </strong>
            ),
            lot: <span className={`${lotIdClass} whitespace-nowrap`}>{lot.id}</span>,
            owner: owner.name,
            reason,
            registry: <RegistryMark status={registry.status} />,
            action: (
              <QueueAction
                href={`/${organisationId}/lots/${encodeURIComponent(lot.id)}`}
                primary={owner.id === organisationId}
              >
                {nextAction}
              </QueueAction>
            ),
          }))}
        />
      )}
    </>
  );
}
