import type { ThetisReader } from "../reader";
import type {
  Context,
  ExceptionView,
  LotView,
  ReleaseCase,
  ReleaseView,
  WorkItemView,
} from "../types";

/** A reference LotView, or a Phase 1 live lot with neither loan nor valuation. */
export type LiveLotView =
  | LotView
  | (Omit<LotView, "loan" | "valuation"> & { loan: null; valuation: null });
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
  workQueue(organisationId: string): WorkItemView[]; // always []
  exceptions(organisationId: string): ExceptionView[]; // always []
  release(releaseId: string, releaseCase?: ReleaseCase): ReleaseView | null; // always null
  lots(organisationId: string): LiveLotView[];
  lot(lotId: string, organisationId: string): LiveLotView | null;
  lotStale(lotId: string): "halted" | "skew" | null;
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
