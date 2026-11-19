import { decodeBase58, decodeBase64 } from "./encoding";
import { signatureIndex } from "./wire";

export const roles = ["sender", "receiver"] as const;
export const routes = ["message", "transaction"] as const;
export const outcomeStates = ["waiting", "submitted", "confirmed", "failed", "unknown"] as const;
export type Role = (typeof roles)[number];
export type Route = (typeof routes)[number];

export interface Intent {
  role: Role;
  expectedAddress: string;
  authorizationBase64: string;
  authorizationSha256: string;
  intent: {
    text: string;
    batchId: string;
    quantityKg: "2000000";
    from: string;
    to: string;
    expirySlot: number;
    expectedSequence: number;
  };
  network: "devnet";
}

const routeRefusals = ["WRONG_ADDRESS", "BAD_SIGNATURE"] as const;
const intentRefusals = ["UNKNOWN_ROLE", "INTENT_EXPIRED", "BATCH_COMPLETE"] as const;
const signatureRefusals = [
  ...routeRefusals,
  "UNKNOWN_ROLE",
  "INTENT_EXPIRED",
  "ALREADY_SUBMITTED",
  "STALE_INTENT",
] as const;
type RouteRefusal = (typeof routeRefusals)[number];
type IntentReason = (typeof intentRefusals)[number] | "CHAIN_UNAVAILABLE";
type SignatureReason = (typeof signatureRefusals)[number] | "CHAIN_UNAVAILABLE";
export type RefusalReason = IntentReason | SignatureReason;

type Refusal<Reason extends RefusalReason> = {
  [Code in Reason]: { verified: false; reason: Code };
}[Reason];

export type Check = { verified: true } | Refusal<RouteRefusal>;
type SignatureCheck = { verified: true } | Refusal<SignatureReason>;
type IntentRefusal = Refusal<IntentReason> & { message?: string };

export interface Outcome {
  state: (typeof outcomeStates)[number];
  signature?: string;
  error?: string;
  sizeBytes?: number;
  activeAuthorizationSha256: string;
  authorizationSha256?: string;
  checks: Record<Role, Partial<Record<Route, Check>>>;
}

type Rule = (value: unknown) => boolean;
type Fields = Record<string, Rule>;
const isString = (value: unknown): value is string => typeof value === "string";
const isSha256 = (value: unknown): boolean => isString(value) && /^[a-f0-9]{64}$/i.test(value);
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

function isBase64(value: unknown): boolean {
  if (!isString(value)) return false;
  try {
    return decodeBase64(value).length > 0;
  } catch {
    return false;
  }
}

function isDecodedIntent(value: unknown): boolean {
  return matches(value, {
    text: isString,
    batchId: isString,
    quantityKg: (quantity) => quantity === "2000000",
    from: isString,
    to: isString,
    expirySlot: isNatural,
    expectedSequence: isNatural,
  });
}

function isRefusal(value: unknown, reasons: readonly RefusalReason[], optional?: Fields): boolean {
  return matches(
    value,
    {
      verified: (verified) => verified === false,
      reason: (reason) => reasons.some((known) => known === reason),
    },
    optional,
  );
}

export function parseIntent(value: unknown, status = 200): Intent | IntentRefusal {
  if (
    status === 200 &&
    matches(value, {
      role: (role) => role === "sender" || role === "receiver",
      expectedAddress: isAddress,
      authorizationBase64: isBase64,
      authorizationSha256: isSha256,
      intent: isDecodedIntent,
      network: (network) => network === "devnet",
    })
  ) {
    return value as Intent;
  }
  if (
    (status === 200 &&
      (isRefusal(value, intentRefusals) ||
        isRefusal(value, ["BATCH_COMPLETE"], { message: isString }))) ||
    (status === 503 && isRefusal(value, ["CHAIN_UNAVAILABLE"]))
  ) {
    return value as IntentRefusal;
  }
  throw new Error("Invalid /intent response");
}

function isVerified(value: unknown): boolean {
  return matches(value, { verified: (verified) => verified === true });
}

function isRouteCheck(value: unknown): boolean {
  return isVerified(value) || isRefusal(value, routeRefusals);
}

function isRoleChecks(value: unknown): boolean {
  return matches(value, {}, { message: isRouteCheck, transaction: isRouteCheck });
}

export function parseOutcome(value: unknown): Outcome {
  if (
    !matches(
      value,
      {
        state: (state) => outcomeStates.some((known) => known === state),
        activeAuthorizationSha256: isSha256,
        checks: (checks) => matches(checks, { sender: isRoleChecks, receiver: isRoleChecks }),
      },
      {
        signature: isString,
        error: isString,
        sizeBytes: isNatural,
        authorizationSha256: isSha256,
      },
    )
  ) {
    throw new Error("Invalid /outcome response");
  }
  return value as Outcome;
}

export function parseCheck(value: unknown, status = 200): SignatureCheck {
  if (
    (status === 200 && (isVerified(value) || isRefusal(value, signatureRefusals))) ||
    (status === 400 && isRefusal(value, ["BAD_SIGNATURE"])) ||
    (status === 503 && isRefusal(value, ["CHAIN_UNAVAILABLE"]))
  ) {
    return value as SignatureCheck;
  }
  throw new Error("Invalid /signature response");
}

export function checkIntentRole(intent: Intent, role: Role): void {
  if (
    intent.role !== role ||
    signatureIndex(decodeBase64(intent.authorizationBase64), intent.expectedAddress) === undefined
  ) {
    throw new Error("Relay intent does not match the selected role");
  }
}

export function sameAuthorization(loaded: Intent, latest: Intent): boolean {
  return (
    loaded.authorizationBase64 === latest.authorizationBase64 &&
    loaded.authorizationSha256 === latest.authorizationSha256
  );
}

export function authorizationStatus(
  loaded: Intent,
  latest: Intent | IntentRefusal,
  submittedDigest?: string,
): "current" | "stale" | "batchComplete" | "UNKNOWN_ROLE" | "CHAIN_UNAVAILABLE" {
  if ("intent" in latest) {
    return sameAuthorization(loaded, latest) && loaded.expectedAddress === latest.expectedAddress
      ? "current"
      : "stale";
  }
  if (latest.reason === "BATCH_COMPLETE") {
    return loaded.authorizationSha256 === submittedDigest ? "current" : "batchComplete";
  }
  return latest.reason === "INTENT_EXPIRED" ? "stale" : latest.reason;
}
