import type { ReactNode } from "react";
import { PageHeader } from "@/components/thetis/page-header";
import { RegistryMark } from "@/components/thetis/registry-mark";
import { ResultTable } from "@/components/thetis/result-table";
import { type CommandView, kindTitles } from "@/lib/commands";
import { commandRegistry, recordedHeading } from "./status";

// The command page's layout (live-lending.md §6.9.4, command.html): header, the fields and the exact
// text on the left, the signers and the outcome on the right (first on a phone).

const facilityKinds: readonly CommandView["kind"][] = ["open_facility", "set_valuation"];
const poolKinds: readonly CommandView["kind"][] = [
  "deposit",
  "withdraw",
  "borrow",
  "repay_simulated",
];

function fieldValue(view: CommandView, label: string): string | null {
  return view.fields.find((field) => field.label === label)?.value ?? null;
}

function Subtitle({ view, lotId }: { view: CommandView; lotId: string | null }) {
  const named = (noun: string, value: string) => (
    <>
      {noun} <span className="font-mono text-[13px] font-medium">{value}</span>.
    </>
  );
  if (facilityKinds.includes(view.kind)) {
    const facility = fieldValue(view, "Facility");
    return facility ? named("Facility", facility.slice(0, 8)) : null;
  }
  if (poolKinds.includes(view.kind)) {
    const pool = fieldValue(view, "Pool");
    return pool ? named("Pool", pool.slice(0, 8)) : null;
  }
  return lotId ? named("Lot", lotId) : null;
}

/** A value that is one long token (an address or a hex id) reads in the monospace face. */
function FieldValue({ value }: { value: string }) {
  return /^[0-9A-Za-z]{32,}$/.test(value) ? (
    <span className="font-mono text-[12.5px] [overflow-wrap:anywhere]">{value}</span>
  ) : (
    value
  );
}

export function decodeText(messageBase64: string): Uint8Array {
  const binary = atob(messageBase64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function CommandScreen({
  view,
  lotId,
  signers,
  outcome,
}: {
  view: CommandView;
  lotId: string | null;
  signers: ReactNode;
  outcome: ReactNode;
}) {
  const text = view.text ? new TextDecoder().decode(decodeText(view.text.messageBase64)) : null;
  const sub = <Subtitle view={view} lotId={lotId} />;
  return (
    <>
      <PageHeader
        title={kindTitles[view.kind]}
        sub={sub}
        aside={
          <div className="flex flex-col items-end gap-1.5 max-md:items-start">
            <RegistryMark status={commandRegistry(view)} />
            <span className="font-mono text-[12px] font-medium text-(--ink-2)">
              Command {view.id.slice(0, 8)}
            </span>
          </div>
        }
      />
      <div className="work-columns">
        <div className="work-stack">
          <section aria-labelledby="command-fields" className="pair-table">
            <h2 id="command-fields">{recordedHeading(view.status)}</h2>
            <ResultTable
              columns={[
                { key: "field", label: "Field" },
                { key: "value", label: "Value" },
              ]}
              rows={view.fields.map(({ label, value }) => ({
                field: <span className="text-(--ink-2)">{label}</span>,
                value: <FieldValue value={value} />,
              }))}
            />
          </section>
          {text !== null && view.text && (
            <section aria-labelledby="command-text">
              <h2 id="command-text">Text to sign</h2>
              <pre className="signed-text">{text}</pre>
              <div className="text-facts">
                <span>SHA-256 {view.text.messageSha256.slice(0, 8)}</span>
                <span>Valid until {view.text.validUntilText}</span>
              </div>
            </section>
          )}
        </div>
        <div className="work-stack work-first-on-phone">
          {signers}
          {outcome}
        </div>
      </div>
    </>
  );
}
