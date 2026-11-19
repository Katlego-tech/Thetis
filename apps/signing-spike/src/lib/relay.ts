import { decodeBase58, decodeBase64 } from "./encoding";

export const roles = ["sender", "receiver"] as const;
export const outcomeStates = ["waiting", "submitted", "confirmed", "failed", "unknown"] as const;
export type Role = (typeof roles)[number];

export interface Intent {
  role: Role;
  expectedAddress: string;
  messageText: string;
  messageBase64: string;
  messageSha256: string;
  validUntil: string;
  validUntilText: string;
  expectedSequence: string;
  network: "devnet";
}

const recordedRefusals = ["WRONG_ADDRESS", "BAD_SIGNATURE"] as const;
const signatureRefusals = [
  ...recordedRefusals,
  "UNKNOWN_ROLE",
  "ALREADY_SUBMITTED",
  "STALE_INTENT",
] as const;
type IntentReason = "UNKNOWN_ROLE" | "BATCH_COMPLETE" | "CHAIN_UNAVAILABLE";
type SignatureReason = (typeof signatureRefusals)[number] | "CHAIN_UNAVAILABLE";
export type RefusalReason = IntentReason | SignatureReason;

type Refusal<Reason extends RefusalReason> = { verified: false; reason: Reason };
export type Check = { verified: true } | Refusal<SignatureReason>;
type RecordedCheck = { verified: true } | Refusal<(typeof recordedRefusals)[number]>;

export interface Outcome {
  state: (typeof outcomeStates)[number];
  signature?: string;
  error?: string;
  sizeBytes?: number;
  activeMessageSha256: string;
  submittedMessageSha256?: string;
  checks: Partial<Record<Role, RecordedCheck>>;
}

type Rule = (value: unknown) => boolean;
type Fields = Record<string, Rule>;
const isString = (value: unknown): value is string => typeof value === "string";
const isSha256 = (value: unknown): boolean => isString(value) && /^[a-f0-9]{64}$/.test(value);
const isDecimal = (value: unknown): boolean => isString(value) && /^(0|[1-9][0-9]*)$/.test(value);
const isNatural = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function matches(value: unknown, required: Fields, optional: Fields = {}): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const object = value as Record<string, unknown>;
  return (
    Object.entries(required).every(
      ([key, rule]) => Object.hasOwn(object, key) && rule(object[key]),
    ) &&
    Object.entries(object).every(
      ([key, field]) =>
        Object.hasOwn(required, key) || (Object.hasOwn(optional, key) && optional[key](field)),
    )
  );
}

function isAddress(value: unknown): boolean {
  if (!isString(value) || value.length < 32 || value.length > 44) return false;
  try {
    return decodeBase58(value).length === 32;
  } catch {
    return false;
  }
}

export function checkMessageText(text: string, encoded: string) {
  const bytes = decodeBase64(encoded);
  if (
    bytes.length === 0 ||
    bytes.length !== text.length ||
    !bytes.every(
      (byte, index) =>
        (byte === 10 || (byte >= 32 && byte <= 126)) && byte === text.charCodeAt(index),
    )
  ) {
    throw new Error("Intent text differs from the bytes to sign");
  }
  return bytes;
}

function isRefusal(value: unknown, reasons: readonly RefusalReason[]): boolean {
  return matches(value, {
    verified: (verified) => verified === false,
    reason: (reason) => reasons.some((known) => known === reason),
  });
}

export function parseIntent(value: unknown, status = 200): Intent | Refusal<IntentReason> {
  if (
    status === 200 &&
    matches(value, {
      role: (role) => role === "sender" || role === "receiver",
      expectedAddress: isAddress,
      messageText: isString,
      messageBase64: isString,
      messageSha256: isSha256,
      validUntil: isDecimal,
      validUntilText: isString,
      expectedSequence: isDecimal,
      network: (network) => network === "devnet",
    })
  ) {
    const intent = value as Intent;
    try {
      checkMessageText(intent.messageText, intent.messageBase64);
      return intent;
    } catch {
      throw new Error("Invalid /intent response");
    }
  }
  if (
    (status === 400 && isRefusal(value, ["UNKNOWN_ROLE"])) ||
    (status === 409 && isRefusal(value, ["BATCH_COMPLETE"])) ||
    (status === 503 && isRefusal(value, ["CHAIN_UNAVAILABLE"]))
  ) {
    return value as Refusal<IntentReason>;
  }
  throw new Error("Invalid /intent response");
}

function isVerified(value: unknown): boolean {
  return matches(value, { verified: (verified) => verified === true });
}

function isRecordedCheck(value: unknown): boolean {
  return isVerified(value) || isRefusal(value, recordedRefusals);
}

export function parseOutcome(value: unknown): Outcome {
  // No digest exists until the first intent is issued.
  if (
    matches(value, {
      state: (state) => state === "waiting",
      activeMessageSha256: (digest) => digest === "",
      checks: (checks) => matches(checks, {}),
    })
  )
    return value as Outcome;

  if (
    !matches(
      value,
      {
        state: (state) => outcomeStates.some((known) => known === state),
        activeMessageSha256: isSha256,
        checks: (checks) =>
          matches(checks, {}, { sender: isRecordedCheck, receiver: isRecordedCheck }),
      },
      {
        signature: isString,
        error: isString,
        sizeBytes: isNatural,
        submittedMessageSha256: isSha256,
      },
    )
  ) {
    throw new Error("Invalid /outcome response");
  }
  return value as Outcome;
}

export function parseCheck(value: unknown, status = 200): Check {
  if (
    (status === 200 && (isVerified(value) || isRefusal(value, signatureRefusals))) ||
    (status === 400 && isRefusal(value, ["BAD_SIGNATURE"])) ||
    (status === 503 && isRefusal(value, ["CHAIN_UNAVAILABLE"]))
  ) {
    return value as Check;
  }
  throw new Error("Invalid /signature response");
}

export function checkIntentRole(intent: Intent, role: Role): void {
  if (intent.role !== role) throw new Error("Relay intent does not match the selected role");
}

export function sameIntent(loaded: Intent, latest: Intent): boolean {
  return (
    loaded.role === latest.role &&
    loaded.expectedAddress === latest.expectedAddress &&
    loaded.messageBase64 === latest.messageBase64 &&
    loaded.messageSha256 === latest.messageSha256
  );
}
