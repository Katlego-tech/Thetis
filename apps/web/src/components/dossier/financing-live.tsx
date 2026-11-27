import Link from "next/link";
import { RegistryMark } from "@/components/thetis/registry-mark";
import { ResultTable } from "@/components/thetis/result-table";
import { StateMark } from "@/components/thetis/state-mark";
import type { LiveLotView } from "@/data/live/types";
import { kindTitles } from "@/lib/commands";
import { formatTonnes } from "@/lib/format";
import { FacilitySection } from "./facility-section";
import { type LendingActions, livePaymentLabels, summaryLine } from "./lending-copy";
import { LoanBlock } from "./loan-block";
import { type FinancialRecord, FinancialResults } from "./record-tables";

// The Financing tab in live mode (live-lending.md §6.9.2): the lot's results, then the facilities,
// loans, releases and open commands the chain and the relay hold for it.

export function FinancingLive({
  lot,
  financial,
  context,
  role,
  actions,
}: {
  lot: LiveLotView;
  financial: FinancialRecord;
  context: string;
  /** the context's membership kind */
  role: string | null;
  actions: LendingActions | null;
}) {
  const { lending } = lot;
  if (!lending) return <FinancialResults {...financial} />;
  const showFacilities = role === "lender" || lending.shownPosition.owner.id === context;

  return (
    <>
      <FinancialResults {...financial} />
      {lending.hiddenLockedKg > 0n && (
        <p className="text-[13px]">
          {formatTonnes(lending.hiddenLockedKg)} of this position is pledged to lenders whose loans
          you can't see.
        </p>
      )}
      {showFacilities && <FacilitySection lending={lending} context={context} actions={actions} />}
      {lending.loans.length > 0 && (
        <section aria-labelledby="financing-loans" className="flex flex-col gap-4">
          <h2 id="financing-loans">Loans</h2>
          {lending.loans.map((loan) => (
            <LoanBlock
              key={loan.address}
              loan={loan}
              lotId={lot.id}
              context={context}
              actions={actions}
            />
          ))}
        </section>
      )}
      <section aria-labelledby="financing-releases">
        <h2 id="financing-releases">Releases</h2>
        {lot.releases.length === 0 ? (
          <p className="text-(--ink-2)">No releases for this lot.</p>
        ) : (
          <ResultTable
            columns={[
              { key: "buyer", label: "Buyer" },
              { key: "quantity", label: "Quantity", align: "right" },
              { key: "payment", label: "Payment" },
              { key: "registry", label: "Registry" },
              { key: "open", label: "Open" },
            ]}
            rows={lot.releases.map(({ id, buyer, soldLockedQuantityKg, payment, registry }) => ({
              buyer: buyer.name,
              quantity: formatTonnes(soldLockedQuantityKg),
              payment: (
                <StateMark
                  dimension="Payment"
                  value={
                    payment in livePaymentLabels
                      ? livePaymentLabels[payment as keyof typeof livePaymentLabels]
                      : payment
                  }
                />
              ),
              registry: <RegistryMark status={registry.status} />,
              open: (
                <Link className="text-(--act) underline" href={`/${context}/releases/${id}`}>
                  Open
                </Link>
              ),
            }))}
          />
        )}
      </section>
      {lending.openCommands.length > 0 && (
        <section aria-labelledby="financing-progress">
          <h2 id="financing-progress">In progress</h2>
          <ul className="work-panel">
            {lending.openCommands.map((command) => (
              <li
                key={command.id}
                className="flex flex-wrap items-baseline justify-between gap-2 text-[13px]"
              >
                <span>
                  {kindTitles[command.kind]}: {summaryLine(command)}
                </span>
                <Link className="text-(--act) underline" href={command.href}>
                  Open
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
