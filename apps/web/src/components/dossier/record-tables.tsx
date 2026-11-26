import Link from "next/link";
import { RegistryMark } from "@/components/thetis/registry-mark";
import { ResultTable } from "@/components/thetis/result-table";
import type { LiveLotView } from "@/data/live/types";
import type { LotView, PaymentStatus } from "@/data/types";
import { formatBpsPercent, formatDateTime, formatTonnes } from "@/lib/format";

const resultColumns = [
  { key: "result", label: "Result" },
  { key: "value", label: "Value", align: "right" },
  { key: "basis", label: "Basis" },
  { key: "attestor", label: "Attested by" },
  { key: "registry", label: "Registry" },
] as const;

/** A reference lot always has a formatter; a live Phase 1 lot has no loan and no money to format. */
export type FinancialRecord =
  | { lot: LotView; money: (minor: bigint) => string }
  | { lot: LiveLotView & { loan: null }; money: null };

const notAttested = "Not attested yet";

function UnfinancedResults({
  lot,
  includeQuantity,
}: {
  lot: LiveLotView;
  includeQuantity: boolean;
}) {
  const notOnChain = <RegistryMark status="not_submitted" />;
  const rows = [
    ...(includeQuantity
      ? [
          {
            result: "Lot quantity",
            value: formatTonnes(lot.quantityKg),
            basis: "Supply on chain, kg atomic unit",
            attestor: notAttested,
            registry: <RegistryMark status={lot.registry.status} />,
          },
        ]
      : []),
    {
      result: "Recorded debt",
      value: "None recorded",
      basis: "No loan on chain for this lot",
      attestor: notAttested,
      registry: notOnChain,
    },
    {
      result: "Valuation",
      value: "None recorded",
      basis: "No valuation on chain for this lot's class, grade and site",
      attestor: notAttested,
      registry: notOnChain,
    },
    {
      result: "Eligible value",
      value: "Not computed",
      basis: "Needs a valuation",
      attestor: notAttested,
      registry: notOnChain,
    },
    {
      result: "Loan to value",
      value: "Not computed",
      basis: "Needs a loan and a valuation",
      attestor: notAttested,
      registry: notOnChain,
    },
  ];
  return <ResultTable columns={[...resultColumns]} rows={rows} totalRowIndex={rows.length - 1} />;
}

export function FinancialResults({
  includeQuantity = false,
  ...record
}: FinancialRecord & { includeQuantity?: boolean }) {
  if (record.money === null)
    return <UnfinancedResults lot={record.lot} includeQuantity={includeQuantity} />;
  const { lot, money } = record;
  const { loan, valuation } = lot;
  const quantity = formatTonnes(lot.quantityKg);
  const price = `${money(valuation.valuePerKgMinor * 1000n)}/t`;
  const haircut = valuation.haircutBps === 0n ? "0" : formatBpsPercent(valuation.haircutBps);
  const attestor = loan.lender.name;
  const loanRegistry = <RegistryMark status={loan.registry.status} />;
  const rows = [
    ...(includeQuantity
      ? [
          {
            result: "Lot quantity",
            value: quantity,
            basis: "Weighbridge, kg atomic unit",
            attestor: lot.custodian.name,
            registry: <RegistryMark status={lot.registry.status} />,
          },
        ]
      : [
          {
            result: "Principal",
            value: money(loan.principalMinor),
            basis: "Recorded loan",
            attestor,
            registry: loanRegistry,
          },
          {
            result: "Booked interest",
            value: money(loan.bookedInterestMinor),
            basis: "Recorded loan",
            attestor,
            registry: loanRegistry,
          },
          {
            result: "Booked fees",
            value: money(loan.bookedFeesMinor),
            basis: "Recorded loan",
            attestor,
            registry: loanRegistry,
          },
        ]),
    {
      result: "Recorded debt",
      value: money(loan.debtMinor),
      basis:
        loan.bookedInterestMinor === 0n && loan.bookedFeesMinor === 0n
          ? "Principal, no accrual booked"
          : "Principal plus booked interest and fees",
      attestor,
      registry: loanRegistry,
    },
    {
      result: "Valuation",
      value: price,
      basis: `Haircut ${haircut}, until ${formatDateTime(valuation.validUntil)}`,
      attestor,
      registry: <RegistryMark status={valuation.registry.status} />,
    },
    {
      result: "Eligible value",
      value: money(valuation.eligibleValueMinor),
      basis: `${quantity} at ${price}${valuation.haircutBps === 0n ? "" : `, after ${haircut} haircut`}`,
      attestor: "Derived",
      registry: "none",
    },
    {
      result: "Loan to value",
      value: formatBpsPercent(valuation.ltvBps),
      basis: `Limit ${formatBpsPercent(valuation.maxLtvBps)}`,
      attestor: "Derived",
      registry: "none",
    },
  ];

  return <ResultTable columns={[...resultColumns]} rows={rows} totalRowIndex={rows.length - 1} />;
}

export function EvidenceTable({
  evidence,
  source = "reference",
}: {
  evidence: LotView["evidence"];
  source?: "reference" | "live";
}) {
  if (!evidence.length) return <p className="text-(--ink-2)">No evidence for this lot.</p>;

  return (
    <ResultTable
      columns={[
        { key: "document", label: "Document" },
        { key: "issuer", label: "Issuer" },
        { key: "status", label: "Status" },
        { key: "file", label: "File" },
      ]}
      rows={evidence.map(({ kind, issuer, status }) => ({
        document: kind,
        issuer: issuer.name,
        status: <span className="thetis-mark border border-dashed border-(--ink-2)">{status}</span>,
        file: source === "live" ? "Digest on chain" : "No file in the reference scenario",
      }))}
    />
  );
}

const paymentLabels: Record<PaymentStatus, string> = {
  reported_by_buyer: "Reported by buyer",
  attested_by_lender: "Attested by lender",
  rejected: "Rejected",
};

export function ReleaseTable({
  releases,
  context,
}: {
  releases: LotView["releases"];
  context: string;
}) {
  if (!releases.length) return <p className="text-(--ink-2)">No releases for this lot.</p>;

  return (
    <ResultTable
      columns={[
        { key: "buyer", label: "Buyer" },
        { key: "quantity", label: "Quantity", align: "right" },
        { key: "payment", label: "Payment status" },
        { key: "registry", label: "Registry" },
      ]}
      rows={releases.map(({ id, buyer, soldLockedQuantityKg, payment, registry }) => ({
        buyer: (
          <Link className="text-(--act) underline" href={`/${context}/releases/${id}`}>
            {buyer.name}
          </Link>
        ),
        quantity: formatTonnes(soldLockedQuantityKg),
        payment: paymentLabels[payment],
        registry: <RegistryMark status={registry.status} />,
      }))}
    />
  );
}

type CustodyEvent = LotView["custodyTimeline"][number];

const eventLabels: Record<CustodyEvent["kind"], string> = {
  intake: "Intake",
  handover: "Handover",
  observation: "Checkpoint observed, custody unchanged",
};

export function CustodyEvents({
  events,
  activity = false,
}: {
  events: CustodyEvent[];
  activity?: boolean;
}) {
  const ordered = activity
    ? events.toSorted((first, second) => Date.parse(second.at) - Date.parse(first.at))
    : events;

  return (
    <>
      {ordered.length ? (
        <ResultTable
          columns={[
            { key: "when", label: "When" },
            { key: "event", label: "Event" },
            { key: "site", label: "Site" },
            ...(activity ? [] : [{ key: "quantity", label: "Quantity", align: "right" } as const]),
            { key: "parties", label: "Parties" },
            ...(activity ? [] : [{ key: "registry", label: "Registry" }]),
          ]}
          rows={ordered.map(({ at, kind, site, quantityKg, by, registry }) => ({
            when: (
              <time className="tabular-nums" dateTime={at}>
                {formatDateTime(at)}
              </time>
            ),
            event: eventLabels[kind],
            site: site.name,
            quantity: formatTonnes(quantityKg),
            parties: by.map(({ name }) => name).join(", "),
            registry: <RegistryMark status={registry.status} />,
          }))}
        />
      ) : (
        <p className="text-(--ink-2)">No custody events for this lot.</p>
      )}
      {activity && (
        <p className="text-xs text-(--ink-2)">
          Evidence and release events join this list once the API records their times.
        </p>
      )}
    </>
  );
}
