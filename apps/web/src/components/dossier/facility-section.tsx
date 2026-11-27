import { CommandForm } from "@/components/commands/command-form";
import { RegistryMark } from "@/components/thetis/registry-mark";
import { ResultTable } from "@/components/thetis/result-table";
import type { LiveLending } from "@/data/live/types";
import { formatBpsPercent } from "@/lib/format";
import { type LendingActions, RATE_BASIS } from "./lending-copy";
import { ValuationSection } from "./valuation-section";

// The facilities to the shown position's owner (live-lending.md §6.9.2 FacilitySection). It lists
// facilities and never opens one: a lender reads a borrower's lots only once a facility exists.

export function FacilitySection({
  lending,
  context,
  actions,
}: {
  lending: LiveLending;
  context: string;
  actions: LendingActions | null;
}) {
  const owner = lending.shownPosition.owner;
  return (
    <section aria-labelledby="financing-facilities" className="flex flex-col gap-4">
      <h2 id="financing-facilities">Facilities</h2>
      {lending.facilities.length === 0 ? (
        <p className="text-(--ink-2)">No facility with {owner.name} on chain.</p>
      ) : (
        lending.facilities.map((facility) => {
          const valuation =
            lending.valuations.find((entry) => entry.facility === facility.address) ?? null;
          const canPledge = owner.id === context || facility.lender.id === context;
          return (
            <div key={facility.address} className="work-panel">
              <div className="block-heading">
                <h3>
                  Facility {facility.facilityIdHex.slice(0, 8)} · {facility.lender.name} to{" "}
                  {facility.borrower.name}
                </h3>
                <RegistryMark status={facility.registry.status} />
              </div>
              <div className="pair-table grid items-start gap-4 md:grid-cols-2">
                <ResultTable
                  columns={[
                    { key: "term", label: "Term" },
                    { key: "value", label: "Value" },
                  ]}
                  rows={[
                    { term: "Currency", value: facility.currency },
                    {
                      term: "Rate",
                      value: (
                        <>
                          {formatBpsPercent(facility.rateBps)}
                          <span className="block text-[12px] text-(--ink-2)">{RATE_BASIS}</span>
                        </>
                      ),
                    },
                    { term: "Max loan to value", value: formatBpsPercent(facility.maxLtvBps) },
                    { term: "Terms", value: `v${facility.termsVersion}` },
                    { term: "Loans", value: facility.loanCount.toString() },
                  ]}
                />
                <ValuationSection
                  facility={facility}
                  valuation={valuation}
                  lending={lending}
                  context={context}
                  actions={actions}
                />
              </div>
              {canPledge && actions && (
                <div className="act-row">
                  <CommandForm
                    action="Request pledge"
                    kind="pledge"
                    organisationId={actions.organisationId}
                    context={context}
                    args={{ facility: facility.address, lot: lending.lotAddress }}
                    fields={[{ name: "quantityKg", label: "Quantity in tonnes", kind: "tonnes" }]}
                  />
                </div>
              )}
            </div>
          );
        })
      )}
    </section>
  );
}
