import { CommandForm } from "@/components/commands/command-form";
import { RegistryMark } from "@/components/thetis/registry-mark";
import { ResultTable } from "@/components/thetis/result-table";
import type { LiveFacility } from "@/data/live/types";
import { formatBpsPercent } from "@/lib/format";

// A lender context's facilities, below its work queue (live-lending.md §6.9.2a).

export function FacilitiesPanel({
  facilities,
  context,
  organisationId,
  borrowers,
}: {
  facilities: LiveFacility[];
  context: string;
  /** the context's organisation uuid; null renders no action */
  organisationId: string | null;
  /** Exporter organisations by uuid */
  borrowers: { value: string; label: string }[];
}) {
  return (
    <section aria-labelledby="queue-facilities" className="flex flex-col gap-3">
      <h2 id="queue-facilities">Your facilities</h2>
      {facilities.length === 0 ? (
        <p className="text-(--ink-2)">No facilities on chain.</p>
      ) : (
        <ResultTable
          columns={[
            { key: "borrower", label: "Borrower" },
            { key: "currency", label: "Currency" },
            { key: "rate", label: "Rate", align: "right" },
            { key: "ltv", label: "Max loan to value", align: "right" },
            { key: "loans", label: "Loans", align: "right" },
            { key: "registry", label: "Registry" },
          ]}
          rows={facilities.map((facility) => ({
            borrower: facility.borrower.name,
            currency: facility.currency,
            rate: formatBpsPercent(facility.rateBps),
            ltv: formatBpsPercent(facility.maxLtvBps),
            loans: facility.loanCount.toString(),
            registry: <RegistryMark status={facility.registry.status} />,
          }))}
        />
      )}
      {organisationId !== null && (
        <div className="act-row">
          <CommandForm
            action="Open facility"
            kind="open_facility"
            organisationId={organisationId}
            context={context}
            args={{}}
            fields={[
              { name: "borrower", label: "Borrower", kind: "select", options: borrowers },
              { name: "currency", label: "Currency", kind: "text", initial: "USD", half: true },
              {
                name: "currencyDecimals",
                label: "Minor digits",
                kind: "integer",
                initial: "2",
                half: true,
              },
              {
                name: "rateBps",
                label: "Rate in basis points",
                kind: "integer",
                initial: "1200",
                hint: "Synthetic demo rate",
                half: true,
              },
              {
                name: "maxLtvBps",
                label: "Max loan to value in basis points",
                kind: "integer",
                initial: "6000",
                half: true,
              },
              { name: "termsVersion", label: "Terms version", kind: "integer", initial: "1" },
            ]}
            primary={facilities.length === 0}
          />
        </div>
      )}
    </section>
  );
}
