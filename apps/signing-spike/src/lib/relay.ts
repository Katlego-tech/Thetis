import { decodeBase58, decodeBase64 } from "./encoding";
import { signatureIndex } from "./wire";

export const expectedAddresses = {
  sender: "Vjh6dMxXifovfpqRwhhzp6gVsQUxFv5ZwffNu6QugcY",
  receiver: "8dRTJ7KTmCiaziBmZf8skeBtPmwWLHyfEZQpPfu5a5px",
} as const;

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

export interface Check {
  verified: boolean;
  reason?: string;
}

interface IntentRefusal {
  verified: false;
  reason: "BATCH_COMPLETE" | "INTENT_EXPIRED" | "UNKNOWN_ROLE";
  message?: string;
}

export interface Outcome {
  state: (typeof outcomeStates)[number];
  signature?: string;
  error?: string;
  sizeBytes?: number;
  checks: Record<Role, Partial<Record<Route, Check>>>;
}

type Rule = (value: unknown) => boolean;
type Fields = Record<string, Rule>;
const isString = (value: unknown): value is string => typeof value === "string";
const isBoolean = (value: unknown) => typeof value === "boolean";
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

export function parseIntent(value: unknown): Intent | IntentRefusal {
  if (
    matches(value, {
      role: (role) => role === "sender" || role === "receiver",
      expectedAddress: isAddress,
      authorizationBase64: isBase64,
      authorizationSha256: (hash) => isString(hash) && /^[a-f0-9]{64}$/i.test(hash),
      intent: isDecodedIntent,
      network: (network) => network === "devnet",
    })
  ) {
    return value as Intent;
  }
  if (
    matches(
      value,
      {
        verified: (verified) => verified === false,
        reason: (reason) =>
          reason === "BATCH_COMPLETE" || reason === "INTENT_EXPIRED" || reason === "UNKNOWN_ROLE",
      },
      { message: isString },
    )
  ) {
    return value as IntentRefusal;
  }
  throw new Error("Invalid /intent response");
}

function isCheck(value: unknown): boolean {
  return matches(value, { verified: isBoolean }, { reason: isString });
}

function isRoleChecks(value: unknown): boolean {
  return matches(value, {}, { message: isCheck, transaction: isCheck });
}

export function parseOutcome(value: unknown): Outcome {
  if (
    !matches(
      value,
      {
        state: (state) => outcomeStates.some((known) => known === state),
        checks: (checks) => matches(checks, { sender: isRoleChecks, receiver: isRoleChecks }),
      },
      { signature: isString, error: isString, sizeBytes: isNatural },
    )
  ) {
    throw new Error("Invalid /outcome response");
  }
  return value as Outcome;
}

export function parseCheck(value: unknown): Check {
  if (!isCheck(value)) throw new Error("Invalid /signature response");
  return value as Check;
}

export function checkIntentRole(intent: Intent, role: Role): void {
  if (
    intent.role !== role ||
    intent.expectedAddress !== expectedAddresses[role] ||
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
