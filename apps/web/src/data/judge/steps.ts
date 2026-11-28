import { explorerTxUrl, formatBpsPercent, formatDateTime, formatMoney } from "@/lib/format";
import type {
  ConfiguredJudgeView,
  JudgeBeat,
  JudgeEvent,
  JudgeTransaction,
  JudgeView,
} from "./read";

export type PageState = "loaded" | "indexing" | "halted" | "not_configured";

export type StepFact = { label: string; value: string; mono?: boolean };
export type Step = {
  kind: "setup" | "run" | "refusal";
  slot: number;
  signature: string;
  /** The first event's instruction (setup and run), or the refusal's beat. */
  instruction: string;
  title: string;
  signedBy: string[];
  facts: StepFact[];
  mark: "confirmed" | "finalized" | "failed";
  explorerUrl: string;
};

/** The page state of judge-page.md §5.1, in its order: the first match wins. */
export function pageState(view: JudgeView): PageState {
  if (!view.configured || !view.streamMatches) return "not_configured";
  const { checkpoint } = view;
  if (checkpoint?.status === "halted") return "halted";
  if (
    checkpoint === null ||
    checkpoint.status === "backfilling" ||
    view.transactions.length < view.expectedTransactions
  )
    return "indexing";
  return "loaded";
}

export const BEAT_TITLES: Record<JudgeBeat, string> = {
  second_lender: "a second lender pledges the same units",
  refused_driver: "a driver with no authority signs the handover",
  duplicate_intake: "the same intake is issued again",
};

/** `G9GN…soo3`: the first and last four characters. */
export function shorten(value: string): string {
  return value.length <= 9 ? value : `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export function explorerAddressUrl(address: string): string {
  return `https://explorer.solana.com/address/${address}?cluster=devnet`;
}

const grouped = new Intl.NumberFormat("en-US");

/** u64 kilograms as "5,000 t (5,000,000 kg)", exact. */
export function formatKg(kg: bigint): string {
  const whole = grouped.format(kg / 1000n);
  const rest = (kg % 1000n).toString().padStart(3, "0").replace(/0+$/, "");
  return `${whole}${rest ? `.${rest}` : ""} t (${grouped.format(kg)} kg)`;
}

const SETUP = new Set([
  "InitializeProtocol",
  "RegisterClass",
  "AccreditOrganisation",
  "AccreditCustodianClass",
  "DelegateAuthority",
  "OpenFacility",
  "SetValuation",
]);

type Money = { currency: string; decimals: number };

/** A currency as the indexer stores event bytes (lowercase hex) or as three capitals. */
function currencyCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (/^[A-Z]{3}$/.test(value)) return value;
  if (!/^[0-9a-f]{6}$/.test(value)) return null;
  const code = String.fromCharCode(
    ...[0, 2, 4].map((i) => Number.parseInt(value.slice(i, i + 2), 16)),
  );
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

/**
 * The run's currency from its FacilityOpened events: used only when every facility of the run
 * agrees on currency and decimals, so no amount is ever shown in a currency it might not be in.
 */
function runMoney(view: ConfiguredJudgeView): Money | null {
  const seen = new Map<string, Money>();
  for (const tx of view.transactions)
    for (const e of tx.events) {
      if (e.event !== "FacilityOpened") continue;
      const currency = currencyCode(e.data.currency);
      const decimals = e.data.currencyDecimals;
      if (currency === null || typeof decimals !== "number" || !Number.isInteger(decimals))
        return null;
      seen.set(`${currency}/${decimals}`, { currency, decimals });
    }
  return seen.size === 1 ? ([...seen.values()][0] ?? null) : null;
}

function u64(value: unknown): bigint | null {
  return typeof value === "string" && /^[0-9]{1,20}$/.test(value) ? BigInt(value) : null;
}

type Context = {
  name: (address: unknown) => string | null;
  money: Money | null;
};

function factsAndSigners(
  instruction: string,
  events: JudgeEvent[],
  ctx: Context,
): { title: string; signedBy: string[]; facts: StepFact[] } {
  const facts: StepFact[] = [];
  const signedBy: string[] = [];
  const add = (label: string, value: string | null, mono = false) => {
    if (value !== null) facts.push(mono ? { label, value, mono } : { label, value });
  };
  const kg = (value: unknown) => {
    const v = u64(value);
    return v === null ? null : formatKg(v);
  };
  const amount = (value: unknown, currency?: unknown) => {
    const v = u64(value);
    if (v === null) return null;
    const code = currency === undefined ? ctx.money?.currency : currencyCode(currency);
    if (!ctx.money || !code || code !== ctx.money.currency)
      return `${grouped.format(v)} minor units`;
    return formatMoney(v, code, ctx.money.decimals);
  };
  const short = (value: unknown) => (typeof value === "string" ? shorten(value) : null);
  const plain = (value: unknown) =>
    typeof value === "string" || typeof value === "number" ? String(value) : null;
  const sign = (field: unknown, role?: string) => {
    const who = ctx.name(field);
    if (who) signedBy.push(role ? `${who} (${role})` : who);
  };
  const of = (name: string) => events.find((e) => e.event === name)?.data ?? {};

  let title = instruction;
  switch (instruction) {
    case "InitializeProtocol":
      title = "Protocol initialised";
      signedBy.push("the registry admin");
      break;
    case "RegisterClass":
      title = "Class registered";
      signedBy.push("the registry admin");
      add("Version", plain(of("ClassRegistered").version));
      break;
    case "AccreditOrganisation": {
      const d = of("OrganisationAccredited");
      title = "Organisation accredited";
      signedBy.push("the registry accreditor");
      add("Organisation", ctx.name(d.organisation));
      add("Role", plain(d.role));
      break;
    }
    case "AccreditCustodianClass":
      title = "Custodian site accredited";
      signedBy.push("the registry accreditor");
      add("Approved capacity", kg(of("CustodianClassAccredited").approvedCapacityKg));
      break;
    case "DelegateAuthority": {
      const d = of("AuthorityDelegated");
      title = "Authority delegated";
      sign(d.organisation, "its admin");
      add("Organisation", ctx.name(d.organisation));
      break;
    }
    case "OpenFacility": {
      const d = of("FacilityOpened");
      title = "Facility opened";
      sign(d.lender);
      add("Lender", ctx.name(d.lender));
      add("Borrower", ctx.name(d.borrower));
      const rate = u64(String(d.rateBps ?? ""));
      const ltv = u64(String(d.maxLtvBps ?? ""));
      add("Rate", rate === null ? null : formatBpsPercent(rate));
      add("Max LTV", ltv === null ? null : formatBpsPercent(ltv));
      break;
    }
    case "SetValuation": {
      const d = of("ValuationSet");
      title = "Valuation set";
      signedBy.push("the lender");
      add("Value per kg", amount(d.valuePerKg));
      const until = typeof d.validUntil === "string" ? Number(d.validUntil) : Number.NaN;
      add(
        "Valid until",
        Number.isSafeInteger(until) ? formatDateTime(new Date(until * 1000).toISOString()) : null,
      );
      break;
    }
    case "IssueLot": {
      const d = of("LotIssued");
      title = "Lot issued";
      signedBy.push("the custodian's authority");
      add("Quantity", kg(d.quantityKg));
      add("Owner", ctx.name(d.owner));
      add("Intake", short(d.intake), true);
      break;
    }
    case "Pledge": {
      const d = of("Pledged");
      title = "Units locked";
      signedBy.push("the owner and the lender");
      add("Locked", kg(d.quantityKg));
      add("Loan", short(d.loan), true);
      add("Lock", short(d.lock), true);
      break;
    }
    case "RecordAdvance": {
      const d = of("AdvanceRecorded");
      title = "Advance recorded";
      signedBy.push("the lender, over terms the borrower accepted");
      add("Advance", amount(d.amount));
      add("Debt", amount(d.principal));
      break;
    }
    case "PrepareShipment": {
      const d = of("ShipmentPrepared");
      title = "Shipment prepared";
      sign(d.owner, "controlling owner");
      add("Committed", kg(d.committedKg));
      add("Batches", plain(d.batchCount));
      add("From", ctx.name(d.source));
      add("To", ctx.name(d.destination));
      break;
    }
    case "RegisterBatch": {
      const d = of("BatchRegistered");
      title = "Batch registered";
      add("Quantity", kg(d.quantityKg));
      add("Carrier", ctx.name(d.carrier));
      break;
    }
    case "Handover": {
      const d = of("CustodyHandedOver");
      title =
        d.stage === "Departure"
          ? "Handover at departure"
          : d.stage === "Arrival"
            ? "Handover at arrival"
            : "Handover";
      sign(d.from);
      sign(d.to);
      add("From", ctx.name(d.from));
      add("To", ctx.name(d.to));
      add("Quantity", kg(d.quantityKg));
      add("Stage", plain(d.stage));
      add("Lot state", plain(d.lotState));
      break;
    }
    case "RecordObservation": {
      const d = of("ObservationRecorded");
      title = typeof d.kind === "string" ? `${d.kind} observation` : "Observation recorded";
      sign(d.observer);
      add("Observer", ctx.name(d.observer));
      add("Kind", plain(d.kind));
      add("Location", plain(d.locationCode), true);
      add("Holder unchanged", ctx.name(d.holder));
      break;
    }
    case "CreateReleaseIntent": {
      const d = of("ReleaseIntentCreated");
      title = "Release intent created";
      sign(d.seller, "seller");
      add("Quantity", kg(d.quantityKg));
      add("Price", amount(d.price));
      break;
    }
    case "ConfirmPayment": {
      const d = of("PaymentConfirmed");
      title = "Payment confirmed";
      signedBy.push("the lender");
      add("Amount", amount(d.amount, d.currency));
      break;
    }
    case "SellPledged": {
      const d = of("PledgedSold");
      title = "Pledged units sold";
      signedBy.push("the buyer");
      add("Quantity", kg(d.quantityKg));
      add("Debt after", amount(d.principal));
      break;
    }
    case "AcceptLoading": {
      const d = of("LoadingAccepted");
      title = "Loading accepted";
      sign(d.lender);
      add("Locked", kg(d.lockQuantityKg));
      break;
    }
    case "CreateLoadingIntent": {
      const d = of("LoadingIntentCreated");
      title = "Loading intent created";
      sign(d.owner);
      add("Quantity", kg(d.quantityKg));
      add("Terminal", ctx.name(d.terminal));
      break;
    }
    case "RecordLoading": {
      const d = of("LoadingRecorded");
      title = "Loading recorded";
      sign(d.owner);
      sign(d.terminal);
      add("Quantity", kg(d.quantityKg));
      add("Terminal", ctx.name(d.terminal));
      add("Lot loaded", typeof d.lotLoaded === "boolean" ? (d.lotLoaded ? "Yes" : "No") : null);
      for (const e of events.filter((x) => x.event === "LoanHandedOff")) {
        if (e.data.externalHandoff === true) add("Loan", "ExternalHandoff");
        add("Debt recorded", amount(e.data.principal));
      }
      break;
    }
  }
  return { title, signedBy, facts };
}

function txStep(tx: JudgeTransaction, ctx: Context): Step {
  const events = [...tx.events].sort((a, b) => a.index - b.index);
  // The parse refuses a transaction with no events.
  const instruction = events[0]?.instruction ?? "";
  const { title, signedBy, facts } = factsAndSigners(instruction, events, ctx);
  return {
    kind: SETUP.has(instruction) ? "setup" : "run",
    slot: tx.slot,
    signature: tx.signature,
    instruction,
    title,
    signedBy,
    facts,
    mark: tx.commitment,
    explorerUrl: explorerTxUrl(tx.signature),
  };
}

const bySlotThenSignature = (a: Step, b: Step) =>
  a.slot - b.slot || (a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0);

/** One step per confirmed transaction and per refusal, merged in (slot, signature) order (§7). */
export function toSteps(view: ConfiguredJudgeView): Step[] {
  const names = new Map(view.organisations.map((o) => [o.address, o.displayName]));
  const ctx: Context = {
    name: (address) =>
      typeof address === "string" ? (names.get(address) ?? shorten(address)) : null,
    money: runMoney(view),
  };
  const steps = view.transactions.map((tx) => txStep(tx, ctx));
  for (const r of view.refusals)
    steps.push({
      kind: "refusal",
      slot: r.slot,
      signature: r.signature,
      instruction: r.beat,
      title: `Refused: ${BEAT_TITLES[r.beat]}`,
      signedBy: [],
      facts: [
        { label: "Error", value: r.errorName, mono: true },
        { label: "Result", value: "Failed on chain. Nothing changed." },
      ],
      mark: "failed",
      explorerUrl: explorerTxUrl(r.signature),
    });
  return steps.sort(bySlotThenSignature);
}
