// Errors the indexer raises on purpose. A HaltError is a stop condition: the stream stops and says
// why. A StoreCodeError is a named code a database function raised. A ConfigError names the
// environment variable that was refused.

export const HALT_REASONS = [
  "UNKNOWN_INSTRUCTION",
  "UNKNOWN_EVENT",
  "UNKNOWN_ENUM",
  "EVENT_DECODE_FAILED",
  "EVENT_MISMATCH",
  "TRANSACTION_UNREADABLE",
  "REVISION_SEQUENCE",
  "EVENT_GAP",
  "ACCOUNT_DECODE_FAILED",
  "ACCOUNT_VANISHED",
  "CONFIRMED_DROPPED",
  "HISTORY_INCOMPLETE",
] as const;

export type HaltReason = (typeof HALT_REASONS)[number];

export const HALT_STEPS = [
  "listing",
  "decode",
  "sequence",
  "fetch",
  "finalize",
  "reconcile",
] as const;

export type HaltStep = (typeof HALT_STEPS)[number];

export const STORE_CODES = [
  "CURSOR_MOVED",
  "INDEXER_HALTED",
  "REVISION_SEQUENCE",
  "EVENT_GAP",
  "ROW_INVALID",
  "STREAM_INVALID",
  "TABLE_INVALID",
  "INDEXER_TRANSITION",
] as const;

export type StoreCode = (typeof STORE_CODES)[number];

export class HaltError extends Error {
  readonly reason: HaltReason;
  readonly detail: string;
  readonly signature: string | null;

  constructor(reason: HaltReason, detail: string, signature: string | null = null) {
    super(`${reason}: ${detail}`);
    this.name = "HaltError";
    this.reason = reason;
    this.detail = detail;
    this.signature = signature;
  }
}

export class StoreCodeError extends Error {
  readonly code: StoreCode;
  readonly detail: string | null;

  constructor(code: StoreCode, detail: string | null = null) {
    super(detail === null ? code : `${code}: ${detail}`);
    this.name = "StoreCodeError";
    this.code = code;
    this.detail = detail;
  }
}

export class ConfigError extends Error {
  readonly variable: string;

  constructor(variable: string, message = `${variable} is missing or not accepted`) {
    super(message);
    this.name = "ConfigError";
    this.variable = variable;
  }
}

export function isStoreCode(value: string): value is StoreCode {
  return (STORE_CODES as readonly string[]).includes(value);
}
