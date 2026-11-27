import type { ReleaseInput, ReleasePreview } from "@thetis/domain";
import type { CommandKind, CommandStatus, SignerRole } from "@/lib/commands";
import type { ThetisReader } from "../reader";
import type {
  Context,
  ExceptionView,
  LotView,
  Organisation,
  PaymentStatus,
  Registry,
  ReleaseCase,
  ReleaseView,
  WorkItemView,
} from "../types";

export type LivePaymentState = "none" | "confirmed" | "mismatch" | "consumed" | "voided";
/** A reference LotView, or a live lot whose loan, valuation and release payments come from chain. */
export type LiveLotView = Omit<LotView, "loan" | "valuation" | "releases"> & {
  loan: LotView["loan"] | null;
  valuation: (Omit<LotView["valuation"], "ltvBps"> & { ltvBps: bigint | null }) | null; // null ltvBps: eligible value 0
  releases: (Omit<LotView["releases"][number], "payment"> & {
    payment: PaymentStatus | LivePaymentState;
  })[];
  lending?: LiveLending; // set by liveReader; never by the reference reader
};
export interface LiveFacility {
  address: string;
  facilityIdHex: string;
  lender: Organisation;
  borrower: Organisation;
  currency: string;
  currencyDecimals: number;
  termsVersion: bigint;
  rateBps: bigint;
  maxLtvBps: bigint;
  loanCount: bigint;
  registry: Registry;
}
export interface LiveValuation {
  address: string;
  facility: string;
  valuePerKgMinor: bigint;
  haircutBps: bigint;
  validUntil: string;
  setAt: string;
  version: bigint;
  stale: boolean; // valid_until*1000 < now
  registry: Registry;
}
export interface LivePayment {
  address: string;
  purpose: "Repayment" | "Release" | "Correction";
  subject: string;
  amountMinor: bigint;
  status: "Unconsumed" | "Consumed" | "Voided";
  appliedMinor: bigint;
  surplusMinor: bigint;
  observedAt: string;
  registry: Registry;
}
export interface LiveLoan {
  address: string;
  facility: LiveFacility;
  index: bigint;
  status: "Active" | "Recovery" | "ExternalHandoff" | "Closed";
  principalMinor: bigint;
  bookedInterestMinor: bigint;
  accruedInterestMinor: bigint;
  debtMinor: bigint;
  accruedAt: string;
  asOf: string;
  openExceptions: bigint;
  revision: bigint;
  position: string; // the loan row's position (live-lending.md §6.10.8)
  lock: { address: string; quantityKg: bigint; control: "Pledged" | "Recovery" };
  valuation: LiveValuation | null;
  payments: LivePayment[];
  registry: Registry;
}
export interface LiveIntent {
  address: string;
  loan: string;
  lotId: string;
  seller: Organisation;
  buyer: Organisation;
  lender: Organisation;
  nonce: bigint;
  quantityKg: bigint;
  priceMinor: bigint;
  topUpMinor: bigint;
  currency: string;
  currencyDecimals: number; // from the intent row (§3.1), so a buyer needs no facility
  expiresAt: string;
  expired: boolean;
  status: "Open" | "Executed";
  payment: LivePaymentState;
  registry: Registry;
}
export interface LiveCommandSummary {
  id: string;
  kind: CommandKind;
  status: CommandStatus;
  awaiting: { role: SignerRole; organisation: Organisation }[];
  validUntil: string | null;
  href: string;
}
export interface LiveLending {
  lotAddress: string; // the lot's chain address (LotView.id is lot_id)
  primaryLoan: string | null; // the address of §4.5.2's primary loan, an entry of `loans`
  valuations: LiveValuation[]; // visible valuations for the lot's class_policy, grade and custodian_class, by facility address
  facilities: LiveFacility[]; // visible facilities whose borrower is the shown position's owner, by address
  loans: LiveLoan[]; // visible loans on the lot, by facility address then index
  intents: LiveIntent[]; // visible intents on the lot, by expires_at then address
  hiddenLockedKg: bigint; // shown position's locked_kg minus its visible open locks
  openCommands: LiveCommandSummary[]; // open commands whose lot is this lot, by created_at then id
  shownPosition: { address: string; owner: Organisation; revision: bigint };
  classPolicy: string;
  grade: string;
  custodianClass: string;
  loading: LiveLoading;
}
// live-lending.md §6.10.8: a loading intent as the web shows it.
export type LoadingState = "open" | "ready" | "recorded" | "expired" | "cancelled" | "outdated";
export interface LiveLoadingRow {
  loan: string;
  loanIndex: bigint;
  lender: Organisation;
  lockedKg: bigint;
  state: "accepted" | "stale" | "missing" | "recovery";
  acceptedAt: string | null; // ISO of accepted_at, when a row exists
  registry: Registry | null; // the acceptance row's commitment
  openCommand: LiveCommandSummary | null; // an open accept_loading for (intent, loan)
}
export interface LiveHandOff {
  loan: string;
  loanIndex: bigint;
  lender: Organisation;
  status: LiveLoan["status"];
  debtMinor: bigint;
  currency: string;
  currencyDecimals: number;
}
export interface LiveLoadingIntent {
  address: string;
  nonce: bigint;
  owner: Organisation;
  terminal: Organisation;
  position: string;
  quantityKg: bigint;
  lockedKg: bigint;
  documentSha256Hex: string;
  positionRevision: bigint;
  expiresAt: string;
  executedAt: string | null;
  cancelledBy: string | null;
  state: LoadingState;
  live: boolean;
  rows: LiveLoadingRow[]; // by loan index, then address
  accepted: number;
  required: number | null; // null when the viewer can't see every lock
  handOffs: LiveHandOff[]; // state "recorded" only; else []
  lotLoaded: boolean; // state "recorded" only; else false
  openCommand: LiveCommandSummary | null; // an open record_loading for this intent
  registry: Registry;
}
export interface LiveLoading {
  terminal: Organisation | null; // the lot's custodian when its chain role is Terminal
  site: string; // the lot's custodian class site_code
  positionQuantityKg: bigint; // the shown position's quantity_kg
  intents: LiveLoadingIntent[]; // newest first (T064b.4 pre-check fold 10 for which)
}
export interface LiveReleaseView {
  intent: LiveIntent;
  lot: LiveLotView;
  lender: Organisation;
  currency: string;
  minorDigits: number;
  loan: LiveLoan | null; // null when the caller reads the intent only as its buyer
  inputs: ReleaseInput | null;
  preview: ReleasePreview | { error: { code: string; message: string } } | null;
  previewBlocked: "buyer" | "no_valuation" | null;
  asOf: string;
  paymentAddress: string | null; // the payment §4.5.4 picked, when one exists
  sale: { registry: Registry; command: LiveCommandSummary | null };
}
export type HaltReason =
  | "UNKNOWN_INSTRUCTION"
  | "UNKNOWN_EVENT"
  | "UNKNOWN_ENUM"
  | "EVENT_DECODE_FAILED"
  | "EVENT_MISMATCH"
  | "TRANSACTION_UNREADABLE"
  | "REVISION_SEQUENCE"
  | "EVENT_GAP"
  | "ACCOUNT_DECODE_FAILED"
  | "ACCOUNT_VANISHED"
  | "CONFIRMED_DROPPED"
  | "HISTORY_INCOMPLETE"
  | "MIXED_INSTANCE";
export type FreshnessState = "current" | "behind" | "stalled" | "halted";
export interface Freshness {
  state: FreshnessState;
  indexedThroughSlot: bigint | null;
  lastSuccessAt: string | null; // ISO
  haltReason: HaltReason | null;
  haltedAt: string | null; // ISO
  checkedAt: string; // ISO, the `now` passed in
}
export interface LiveScenario {
  label: "synthetic";
  scenarioVersion: string;
  settlementMode: string;
  network: "devnet";
  facilityCurrency: null;
  currencyMinorDigits: null;
}
export interface LiveReader {
  readonly mode: "live";
  readonly scenario: LiveScenario;
  readonly freshness: Freshness;
  contexts(): Context[];
  context(organisationId: string): Context | null;
  workQueue(organisationId: string): WorkItemView[]; // live-lending.md §4.5.3
  exceptions(organisationId: string): ExceptionView[]; // always []
  release(releaseId: string, releaseCase?: ReleaseCase): ReleaseView | null; // always null
  lots(organisationId: string): LiveLotView[];
  lot(lotId: string, organisationId: string): LiveLotView | null;
  lotStale(lotId: string): "halted" | "skew" | null;
  liveRelease(intent: string, organisationId: string): LiveReleaseView | null;
  releases(organisationId: string): LiveIntent[]; // intents on lots(org), by expires_at then address
  facilityCurrency(
    organisationId: string,
  ): { currency: string; minorDigits: number } | "none" | "mixed";
  organisationsByRole(role: "Buyer" | "Exporter"): Organisation[]; // chain_organisations of that role, by name
  facilities(organisationId: string): LiveFacility[]; // selected facilities the org is a party to, by address
  orgIdOf(organisationId: string): string | null; // an Organisation.id (slug) to its uuid
  organisationByOrgId(orgId: string): Organisation | null; // the reverse, for CommandView uuids
  workItemMoney(
    organisationId: string,
    itemId: string,
  ): { currency: string; minorDigits: number } | null;
}
export type ScreenReader = ThetisReader | LiveReader;
export type LiveDataErrorCode =
  | "CONFIG"
  | "NO_SESSION"
  | "READ_FAILED"
  | "NOT_SYNTHETIC"
  | "BAD_ROW"
  | "TOO_MANY_ROWS";

export class LiveDataError extends Error {
  readonly code: LiveDataErrorCode;
  readonly path: string;

  constructor(code: LiveDataErrorCode, path: string, message?: string, cause?: string) {
    super(
      message === undefined ? `${code} at ${path}` : `${code} at ${path}: ${message}`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "LiveDataError";
    this.code = code;
    this.path = path;
  }
}
