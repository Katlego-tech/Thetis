import { CommandForm } from "@/components/commands/command-form";
import { RegistryMark } from "@/components/thetis/registry-mark";
import { ResultTable } from "@/components/thetis/result-table";
import type { LiveFacility, LiveLending, LiveValuation } from "@/data/live/types";
import { formatBpsPercent, formatDateTime, formatMoney } from "@/lib/format";
import type { LendingActions } from "./lending-copy";

// A facility's valuation for this lot's class, grade and site (live-lending.md §6.9.2, fold 4: per tonne).

export function ValuationSection({
  facility,
  valuation,
  lending,
  context,
  actions,
}: {
  facility: LiveFacility;
  valuation: LiveValuation | null;
  lending: LiveLending;
  context: string;
  actions: LendingActions | null;
}) {
  const money = (minor: bigint) => formatMoney(minor, facility.currency, facility.currencyDecimals);
  const isLender = facility.lender.id === context;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {valuation ? (
        <ResultTable
          columns={[
            { key: "term", label: "Valuation" },
            { key: "value", label: "Value" },
          ]}
          rows={[
            { term: "Value per tonne", value: `${money(valuation.valuePerKgMinor * 1000n)}/t` },
            {
              term: "Haircut",
              value: valuation.haircutBps === 0n ? "0" : formatBpsPercent(valuation.haircutBps),
            },
            {
              term: "Valid until",
              value: (
                <>
                  {formatDateTime(valuation.validUntil)}
                  {valuation.stale && (
                    <span className="block text-[12px] text-(--refuse)">
                      Expired {formatDateTime(valuation.validUntil)}.
                    </span>
                  )}
                </>
              ),
            },
            { term: "Version", value: valuation.version.toString() },
            {
              term: "Set",
              value: (
                <span className="inline-flex flex-wrap items-center gap-2">
                  {formatDateTime(valuation.setAt)}
                  <RegistryMark status={valuation.registry.status} />
                </span>
              ),
            },
          ]}
        />
      ) : (
        <p className="text-(--ink-2)">
          No valuation on chain for this lot's class, grade and site under this facility.
        </p>
      )}
      {isLender && actions && (
        <div className="act-row">
          <CommandForm
            action={valuation ? "Update valuation" : "Set valuation"}
            kind="set_valuation"
            organisationId={actions.organisationId}
            context={context}
            args={{
              facility: facility.address,
              custodianClass: lending.custodianClass,
              grade: lending.grade,
            }}
            fields={[
              {
                name: "valuePerKgMinor",
                label: "Value per kg",
                kind: "money",
                currency: facility.currency,
                digits: facility.currencyDecimals,
              },
              {
                name: "haircutBps",
                label: "Haircut in basis points",
                kind: "integer",
                initial: "0",
                half: true,
              },
              {
                name: "validForDays",
                label: "Valid for days",
                kind: "integer",
                initial: "30",
                half: true,
              },
              { name: "sourceNote", label: "Source note", kind: "text" },
            ]}
          />
        </div>
      )}
    </div>
  );
}
