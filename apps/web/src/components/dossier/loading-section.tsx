import Link from "next/link";
import type { ReactNode } from "react";
import { CommandForm } from "@/components/commands/command-form";
import { RegistryMark } from "@/components/thetis/registry-mark";
import { ResultTable } from "@/components/thetis/result-table";
import { StateMark } from "@/components/thetis/state-mark";
import type {
  LiveLending,
  LiveLoadingIntent,
  LiveLoadingRow,
  LiveLotView,
} from "@/data/live/types";
import { kindTitles } from "@/lib/commands";
import { formatClockTime, formatDateTime, formatMoney, formatTonnes } from "@/lib/format";
import {
  type LendingActions,
  loadingStateLabels,
  loadingTally,
  outcomeLines,
  rowAcceptance,
  summaryLine,
} from "./lending-copy";

// The Financing tab's Loading section (live-lending.md §6.10, loading.html): the loading intents of
// the shown position (and, fold 10, of the viewer's other positions on the lot), each lender's
// acceptance and the owner's and lenders' actions. Every mark and line comes from chain rows and
// the render clock; a command never marks anything done here.

const UPLOAD_HINT =
  "The bill of lading or loading record. PDF, JPEG or PNG, at most 20 MiB. Its SHA-256 goes into the signed text.";
const signingLink = "Open the signing page";

function failureNames(lending: LiveLending, intent: LiveLoadingIntent) {
  return {
    lenders: Object.fromEntries(
      lending.loans.map((loan) => [
        loan.address,
        { name: loan.facility.lender.name, index: loan.index.toString() },
      ]),
    ),
    owner: intent.owner.name,
  };
}

function Basis({ children }: { children: string }) {
  return <span className="block text-[12px] text-(--ink-2)">{children}</span>;
}

function IntentHeading({ intent }: { intent: LiveLoadingIntent }) {
  return (
    <div className="block-heading">
      <h3>
        Loading intent {intent.nonce.toString()}, {intent.terminal.name}
      </h3>
      <span className="act-row">
        <StateMark dimension="Loading" value={loadingStateLabels[intent.state]} />
        <RegistryMark status={intent.registry.status} />
      </span>
    </div>
  );
}

function InProgress({ intent }: { intent: LiveLoadingIntent }) {
  const command = intent.openCommand;
  if (!command) return null;
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-(--hair) border-t pt-2.5 text-[13px]">
      <span>
        {kindTitles[command.kind]}: {summaryLine(command)}
      </span>
      <Link className="text-(--act) underline" href={command.href}>
        {signingLink}
      </Link>
    </div>
  );
}

function Terms({ intent }: { intent: LiveLoadingIntent }) {
  const columns = [
    { key: "term", label: "Term" },
    { key: "value", label: "Value" },
  ];
  return (
    <div className="pair-table grid items-start gap-4 md:grid-cols-2">
      <ResultTable
        columns={columns}
        rows={[
          {
            term: "Quantity",
            value: (
              <>
                {formatTonnes(intent.quantityKg)}
                <Basis>The whole position</Basis>
              </>
            ),
          },
          { term: "Locked", value: formatTonnes(intent.lockedKg) },
          { term: "Owner", value: intent.owner.name },
          { term: "Terminal", value: intent.terminal.name },
        ]}
      />
      <ResultTable
        columns={columns}
        rows={[
          {
            term: "Loading document",
            value: (
              <>
                <span className="font-mono text-[12px] break-all">{intent.documentSha256Hex}</span>
                <Basis>SHA-256 in the signed text</Basis>
              </>
            ),
          },
          { term: "Expires", value: formatDateTime(intent.expiresAt) },
          { term: "Position revision", value: intent.positionRevision.toString() },
        ]}
      />
    </div>
  );
}

function AcceptAction({
  row,
  intent,
  lot,
  lending,
  context,
  actions,
}: {
  row: LiveLoadingRow;
  intent: LiveLoadingIntent;
  lot: LiveLotView;
  lending: LiveLending;
  context: string;
  actions: LendingActions | null;
}) {
  const loan = lending.loans.find(({ address }) => address === row.loan);
  if (
    row.lender.id !== context ||
    !intent.live ||
    (row.state !== "missing" && row.state !== "stale") ||
    loan?.status !== "Active" ||
    row.lockedKg <= 0n
  )
    return null;
  if (row.openCommand)
    return (
      <Link className="text-(--act) underline" href={row.openCommand.href}>
        {signingLink}
      </Link>
    );
  if (!actions) return null;
  const { facility } = loan;
  const index = row.loanIndex.toString();
  return (
    <CommandForm
      action="Accept loading"
      kind="accept_loading"
      organisationId={actions.organisationId}
      context={context}
      args={{ intent: intent.address, loan: row.loan }}
      confirm={`Accept the loading of ${lot.id} at ${intent.terminal.name} for loan ${index}? When the loading is recorded, your lock of ${formatTonnes(row.lockedKg)} ends and the loan's debt stays recorded as an external hand-off.`}
      facts={[
        { label: "Locked", value: formatTonnes(row.lockedKg) },
        {
          label: "Debt now",
          value: `${formatMoney(loan.debtMinor, facility.currency, facility.currencyDecimals)}, accrued to ${formatClockTime(loan.asOf)}`,
        },
        { label: "Loading document", value: intent.documentSha256Hex.slice(0, 8) },
        { label: "Expires", value: formatDateTime(intent.expiresAt) },
      ]}
      foot="Your wallet signs the transaction on the next page. The Thetis fee sponsor pays the network fee."
      names={failureNames(lending, intent)}
      primary
    />
  );
}

function AcceptanceTable({
  intent,
  lot,
  lending,
  context,
  actions,
}: {
  intent: LiveLoadingIntent;
  lot: LiveLotView;
  lending: LiveLending;
  context: string;
  actions: LendingActions | null;
}) {
  // The intent's own position's hidden locks, not the shown position's (T056x X1).
  const hidden = intent.hiddenLockedKg > 0n;
  if (intent.rows.length === 0 && !hidden) return null;
  const lends = intent.rows.some((row) => row.lender.id === context);
  const rows: Record<string, ReactNode>[] = intent.rows.map((row) => ({
    loan: `Loan ${row.loanIndex.toString()}, ${row.lender.name}`,
    locked: formatTonnes(row.lockedKg),
    acceptance: rowAcceptance(row, row.lender.id === context),
    registry: row.registry ? <RegistryMark status={row.registry.status} /> : "none",
    action: (
      <AcceptAction
        row={row}
        intent={intent}
        lot={lot}
        lending={lending}
        context={context}
        actions={actions}
      />
    ),
  }));
  if (hidden)
    rows.push({
      loan: "Other lenders",
      locked: formatTonnes(intent.hiddenLockedKg),
      acceptance: "Not visible to you",
      registry: "",
      action: null,
    });
  return (
    <ResultTable
      columns={[
        { key: "loan", label: "Loan" },
        { key: "locked", label: "Locked", align: "right" },
        { key: "acceptance", label: "Acceptance" },
        { key: "registry", label: "Registry" },
        ...(lends ? [{ key: "action", label: "Action", align: "right" as const }] : []),
      ]}
      rows={rows}
    />
  );
}

function CreateIntent({
  lot,
  lending,
  context,
  actions,
  replaces,
  primary,
}: {
  lot: LiveLotView;
  lending: LiveLending;
  context: string;
  actions: LendingActions;
  replaces: LiveLoadingIntent | null;
  primary: boolean;
}) {
  const { loading } = lending;
  const terminal = loading.terminal?.name ?? "";
  return (
    <CommandForm
      action="Create loading intent"
      kind="create_loading_intent"
      organisationId={actions.organisationId}
      context={context}
      args={{ lot: lending.lotAddress }}
      confirm={`Loads all ${formatTonnes(loading.positionQuantityKg)} of your position at ${terminal}. Each lender with a lock on it must accept before the loading can be recorded.`}
      {...(replaces
        ? {
            note: `This replaces loading intent ${replaces.nonce.toString()}. Its acceptances stop counting, and each lender accepts the new one.`,
          }
        : {})}
      upload={{
        label: "Loading document",
        ownerOrganisationId: actions.organisationId,
        lotId: lot.id,
        purpose: "loading",
        subjectRef: lending.lotAddress,
        hint: UPLOAD_HINT,
      }}
      fields={[
        {
          name: "expiresInHours",
          label: "Expires in hours",
          kind: "integer",
          initial: "24",
          hint: "1 to 720",
        },
      ]}
      names={{ lenders: {}, owner: lending.shownPosition.owner.name }}
      primary={primary}
    />
  );
}

export function LoadingSection({
  lot,
  context,
  actions,
}: {
  lot: LiveLotView;
  context: string;
  actions: LendingActions | null;
}) {
  const { lending } = lot;
  if (!lending?.loading.terminal) return null;
  const { loading } = lending;
  const terminal = loading.terminal as NonNullable<typeof loading.terminal>;
  const mayCreate =
    actions !== null &&
    lending.shownPosition.owner.id === context &&
    lot.custody === "Stored" &&
    loading.positionQuantityKg > 0n;
  // The newest intent of each position gets a full block (only it can be live); the shown
  // position's come first, then each other position the viewer owns or lends on (T064b.4 pre-check
  // fold 10), in the order of their newest intent (T056x X1).
  const shownAddress = lending.shownPosition.address;
  const groups = new Map<string, LiveLoadingIntent[]>([[shownAddress, []]]);
  for (const intent of loading.intents) {
    groups.set(intent.position, [...(groups.get(intent.position) ?? []), intent]);
  }
  if (loading.intents.length === 0 && !mayCreate) return null;

  return (
    <section aria-labelledby="financing-loading" className="flex flex-col gap-4">
      <h2 id="financing-loading">Loading</h2>
      {[...groups].map(([position, [newest, ...older]]) => {
        const shown = position === shownAddress;
        if (!newest && !(shown && mayCreate)) return null;
        return (
          <div key={position} className="contents">
            {!newest ? (
              <>
                <p className="text-(--ink-2)">
                  No loading intent for this position. The lot is stored at {terminal.name} (
                  {loading.site}), so your position can be loaded there.
                </p>
                {actions && (
                  <div className="act-row">
                    <CreateIntent
                      lot={lot}
                      lending={lending}
                      context={context}
                      actions={actions}
                      replaces={null}
                      primary
                    />
                  </div>
                )}
              </>
            ) : (
              <IntentBlock
                intent={newest}
                lot={lot}
                lending={lending}
                context={context}
                actions={actions}
                mayCreate={shown && mayCreate}
              />
            )}
            {older.map((intent) => (
              <div key={intent.address} className="work-panel gap-2">
                <IntentHeading intent={intent} />
                <p className="text-[13px]">{loadingTally(intent)}</p>
              </div>
            ))}
          </div>
        );
      })}
    </section>
  );
}

function IntentBlock({
  intent,
  lot,
  lending,
  context,
  actions,
  mayCreate,
}: {
  intent: LiveLoadingIntent;
  lot: LiveLotView;
  lending: LiveLending;
  context: string;
  actions: LendingActions | null;
  mayCreate: boolean;
}) {
  const owns = intent.owner.id === context;
  const create = mayCreate && actions && (
    <CreateIntent
      lot={lot}
      lending={lending}
      context={context}
      actions={actions}
      replaces={intent.live ? intent : null}
      primary={!intent.live}
    />
  );
  if (!intent.live) {
    return (
      <div className="work-panel gap-2">
        <IntentHeading intent={intent} />
        <p className="text-[13px]">{loadingTally(intent)}</p>
        {intent.state === "recorded" && (
          <div className="flex flex-col gap-1.5 text-[13px]">
            {outcomeLines(intent).map((line) => (
              <div key={line} className="border-(--ink) border-l-2 py-1 pl-3">
                {line}
              </div>
            ))}
          </div>
        )}
        {create && <div className="act-row">{create}</div>}
      </div>
    );
  }
  const short = intent.rows.some(({ state }) => state !== "accepted");
  const record = owns && actions && !intent.openCommand && (
    <CommandForm
      action="Record loading"
      kind="record_loading"
      organisationId={actions.organisationId}
      context={context}
      args={{ intent: intent.address }}
      confirm={`Record the loading of all ${formatTonnes(intent.quantityKg)} of your position at ${intent.terminal.name}? ${intent.terminal.name} signs the same text on the field app. Nothing is recorded until both of you have signed and devnet confirms it.`}
      names={failureNames(lending, intent)}
      primary={intent.state === "ready"}
    />
  );
  return (
    <div className="work-panel gap-3.5">
      <IntentHeading intent={intent} />
      <AcceptanceTable
        intent={intent}
        lot={lot}
        lending={lending}
        context={context}
        actions={actions}
      />
      <p className="text-[13px]">{loadingTally(intent)}</p>
      {owns && short && (
        <p className="border-(--ink) border-l-2 py-1.5 pl-3 text-[13px]">
          Not every lender has accepted yet. Thetis refuses to record the loading until each lender
          with a lock on this position accepts.
        </p>
      )}
      {owns && <InProgress intent={intent} />}
      {(record || create) && (
        <div className="act-row">
          {record}
          {create}
        </div>
      )}
      <Terms intent={intent} />
    </div>
  );
}
