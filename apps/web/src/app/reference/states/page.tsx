import { ReferenceBanner } from "@/components/shell/reference-banner";
import { ThemeToggle } from "@/components/shell/theme-toggle";
import { PageHeader } from "@/components/thetis/page-header";
import { QuantityBar } from "@/components/thetis/quantity-bar";
import { RegistryMark, registryMarks } from "@/components/thetis/registry-mark";
import { ResultTable } from "@/components/thetis/result-table";
import { StateMark } from "@/components/thetis/state-mark";
import type { CustodyState, FinanceState, RegistryStatus, RestrictionState } from "@/data/types";

const custody = {
  Stored: true,
  "Awaiting departure": true,
  "In transit": true,
  "Partly arrived": true,
  Arrived: true,
  Loaded: true,
  Collected: true,
} satisfies Record<CustodyState, true>;

const finance = {
  Available: true,
  Pledged: true,
  Recovery: true,
  "External hand-off": true,
  Repaid: true,
} satisfies Record<FinanceState, true>;

const restriction = {
  Normal: true,
  "Review required": true,
  Disputed: true,
  Frozen: true,
} satisfies Record<RestrictionState, true>;

const columns = [
  { key: "state", label: "State" },
  { key: "mark", label: "Mark" },
];

export default function StateSpecimen() {
  return (
    <>
      <ReferenceBanner specimen />
      <main className="workspace-main">
        <div className="page-content">
          <PageHeader title="State marks" aside={<ThemeToggle />} />
          <section aria-labelledby="registry-specimen">
            <h2 id="registry-specimen">Registry</h2>
            <ResultTable
              columns={columns}
              rows={(Object.keys(registryMarks) as RegistryStatus[]).map((status) => ({
                state: status,
                mark: <RegistryMark status={status} />,
              }))}
            />
          </section>
          {(
            [
              ["Custody", custody],
              ["Finance", finance],
              ["Restriction", restriction],
            ] as const
          ).map(([dimension, values]) => (
            <section aria-label={dimension} key={dimension}>
              <h2>{dimension}</h2>
              <ResultTable
                columns={columns}
                rows={Object.keys(values).map((value) => ({
                  state: value,
                  mark: <StateMark dimension={dimension} value={value} />,
                }))}
              />
            </section>
          ))}
          <section aria-labelledby="quantity-specimen">
            <h2 id="quantity-specimen">Quantity bars</h2>
            <dl className="specimen-quantities">
              {[
                { label: "Empty lot", totalKg: 0n, pledgedKg: 0n, pendingKg: 0n },
                {
                  label: "40% pending inside 100% pledged",
                  totalKg: 5000000n,
                  pledgedKg: 5000000n,
                  pendingKg: 2000000n,
                },
                { label: "100% available", totalKg: 5000000n, pledgedKg: 0n, pendingKg: 0n },
              ].map(({ label, ...quantities }) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>
                    <QuantityBar label={label} {...quantities} />
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
      </main>
    </>
  );
}
