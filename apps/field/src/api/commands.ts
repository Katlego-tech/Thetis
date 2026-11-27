// The relay's command routes and a strict parser for CommandView (unknown fields refused).
import {
  ADDRESS,
  array,
  DECIMAL,
  HEX64,
  ISO,
  nullable,
  oneOf,
  record,
  ShapeError,
  string,
  UUID,
} from "../lib/shape";
import { type ApiClient, TIMEOUTS } from "./client";

export const COMMAND_KINDS = [
  "open_facility",
  "set_valuation",
  "pledge",
  "record_advance",
  "confirm_payment",
  "correct_payment",
  "repay",
  "create_release_intent",
  "sell_pledged",
  "liquidate",
  "close_loan",
  "deposit",
  "withdraw",
  "borrow",
  "repay_simulated",
  "issue_lot",
  "handover",
  "record_observation",
  "record_loading",
] as const;
export type CommandKind = (typeof COMMAND_KINDS)[number];

export const COMMAND_STATUSES = [
  "awaiting_signatures",
  "submitted",
  "confirmed",
  "failed",
  "outcome_unknown",
  "expired",
] as const;
export type CommandStatus = (typeof COMMAND_STATUSES)[number];

export const SIGNER_ROLES = [
  "borrower",
  "lender",
  "seller",
  "buyer",
  "depositor",
  "payer",
  "custodian",
  "holder",
  "next_holder",
  "observer",
  "owner",
  "terminal",
] as const;
export type SignerRole = (typeof SIGNER_ROLES)[number];

export interface CommandText {
  version: number;
  messageBase64: string;
  messageSha256: string;
  validUntil: string;
  validUntilText: string;
}

export interface CommandSigner {
  role: SignerRole;
  organisationId: string;
  method: "text" | "transaction";
  signed: { wallet: string; signedAt: string } | null;
}

export interface CommandView {
  id: string;
  kind: CommandKind;
  status: CommandStatus;
  network: "devnet";
  programId: string;
  protocol: string;
  initiatorOrganisationId: string;
  parties: string[];
  lot: string | null;
  facility: string | null;
  loan: string | null;
  intent: string | null;
  payment: string | null;
  args: Record<string, string>;
  fields: { label: string; value: string }[];
  text: CommandText | null;
  signers: CommandSigner[];
  transaction: { signature: string; sends: number; explorerUrl: string } | null;
  confirmedSlot: string | null;
  confirmedCommitment: "confirmed" | "finalized" | null;
  outcome: {
    event: string;
    slot: string;
    commitment: "confirmed" | "finalized";
    data: Record<string, unknown>;
  } | null;
  error: { code: string; detail: string | null } | null;
  createdAt: string;
  updatedAt: string;
}

const VIEW_KEYS = [
  "id",
  "kind",
  "status",
  "network",
  "programId",
  "protocol",
  "initiatorOrganisationId",
  "parties",
  "lot",
  "facility",
  "loan",
  "intent",
  "payment",
  "args",
  "fields",
  "text",
  "signers",
  "transaction",
  "confirmedSlot",
  "confirmedCommitment",
  "outcome",
  "error",
  "createdAt",
  "updatedAt",
] as const;

const address = (path: string) => (v: unknown) => string(v, path, ADDRESS);
const COMMITMENTS = ["confirmed", "finalized"] as const;

function count(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ShapeError(path, "not a count");
  }
  return value;
}

function stringMap(value: unknown, path: string): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ShapeError(path, "not an object");
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) out[key] = string(item, `${path}.${key}`);
  return out;
}

function jsonObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ShapeError(path, "not an object");
  }
  return value as Record<string, unknown>;
}

function readText(value: unknown): CommandText {
  const t = record(value, "text", [
    "version",
    "messageBase64",
    "messageSha256",
    "validUntil",
    "validUntilText",
  ]);
  return {
    version: count(t.version, "text.version"),
    messageBase64: string(t.messageBase64, "text.messageBase64", /^[A-Za-z0-9+/]*={0,2}$/),
    messageSha256: string(t.messageSha256, "text.messageSha256", HEX64),
    validUntil: string(t.validUntil, "text.validUntil", DECIMAL),
    validUntilText: string(t.validUntilText, "text.validUntilText"),
  };
}

function readSigner(value: unknown, path: string): CommandSigner {
  const s = record(value, path, ["role", "organisationId", "method", "signed"]);
  return {
    role: oneOf(s.role, `${path}.role`, SIGNER_ROLES),
    organisationId: string(s.organisationId, `${path}.organisationId`, UUID),
    method: oneOf(s.method, `${path}.method`, ["text", "transaction"] as const),
    signed: nullable(s.signed, (v) => {
      const signed = record(v, `${path}.signed`, ["wallet", "signedAt"]);
      return {
        wallet: string(signed.wallet, `${path}.signed.wallet`, ADDRESS),
        signedAt: string(signed.signedAt, `${path}.signed.signedAt`, ISO),
      };
    }),
  };
}

/** The single event each field kind's confirmed transaction must hold, when the relay read it. */
const OUTCOME_EVENT: Partial<Record<CommandKind, string>> = { issue_lot: "LotIssued" };

/**
 * Rules across fields: a confirmed view names its transaction and commitment, a failed view its
 * error, and an outcome is the kind's event. Nothing is shown as done without the chain's facts.
 */
function checkFacts(view: CommandView): CommandView {
  if (view.status === "confirmed") {
    if (view.transaction === null) throw new ShapeError("transaction", "missing on confirmed");
    if (view.confirmedCommitment === null)
      throw new ShapeError("confirmedCommitment", "missing on confirmed");
  }
  if (view.status === "failed" && view.error === null) {
    throw new ShapeError("error", "missing on failed");
  }
  const event = OUTCOME_EVENT[view.kind];
  if (view.outcome !== null && event !== undefined && view.outcome.event !== event) {
    throw new ShapeError("outcome.event", `not ${event}`);
  }
  return view;
}

export function parseCommandView(value: unknown): CommandView {
  return checkFacts(readView(value));
}

function readView(value: unknown): CommandView {
  const v = record(value, "command", VIEW_KEYS);
  return {
    id: string(v.id, "id", UUID),
    kind: oneOf(v.kind, "kind", COMMAND_KINDS),
    status: oneOf(v.status, "status", COMMAND_STATUSES),
    network: oneOf(v.network, "network", ["devnet"] as const),
    programId: string(v.programId, "programId", ADDRESS),
    protocol: string(v.protocol, "protocol", ADDRESS),
    initiatorOrganisationId: string(v.initiatorOrganisationId, "initiatorOrganisationId", UUID),
    parties: array(v.parties, "parties", (p, path) => string(p, path, UUID)),
    lot: nullable(v.lot, address("lot")),
    facility: nullable(v.facility, address("facility")),
    loan: nullable(v.loan, address("loan")),
    intent: nullable(v.intent, address("intent")),
    payment: nullable(v.payment, address("payment")),
    args: stringMap(v.args, "args"),
    fields: array(v.fields, "fields", (f, path) => {
      const field = record(f, path, ["label", "value"]);
      return {
        label: string(field.label, `${path}.label`),
        value: string(field.value, `${path}.value`),
      };
    }),
    text: nullable(v.text, readText),
    signers: array(v.signers, "signers", readSigner),
    transaction: nullable(v.transaction, (t) => {
      const tx = record(t, "transaction", ["signature", "sends", "explorerUrl"]);
      return {
        signature: string(tx.signature, "transaction.signature", /^[1-9A-HJ-NP-Za-km-z]{64,88}$/),
        sends: count(tx.sends, "transaction.sends"),
        explorerUrl: string(
          tx.explorerUrl,
          "transaction.explorerUrl",
          /^https:\/\/explorer\.solana\.com\//,
        ),
      };
    }),
    confirmedSlot: nullable(v.confirmedSlot, (s) => string(s, "confirmedSlot", DECIMAL)),
    confirmedCommitment: nullable(v.confirmedCommitment, (c) =>
      oneOf(c, "confirmedCommitment", COMMITMENTS),
    ),
    outcome: nullable(v.outcome, (o) => {
      const out = record(o, "outcome", ["event", "slot", "commitment", "data"]);
      return {
        event: string(out.event, "outcome.event"),
        slot: string(out.slot, "outcome.slot", DECIMAL),
        commitment: oneOf(out.commitment, "outcome.commitment", COMMITMENTS),
        data: jsonObject(out.data, "outcome.data"),
      };
    }),
    error: nullable(v.error, (e) => {
      const error = record(e, "error", ["code", "detail"]);
      return {
        code: string(error.code, "error.code"),
        detail: nullable(error.detail, (d) => string(d, "error.detail")),
      };
    }),
    createdAt: string(v.createdAt, "createdAt", ISO),
    updatedAt: string(v.updatedAt, "updatedAt", ISO),
  };
}

export interface CreateCommand {
  kind: CommandKind;
  organisationId: string;
  args: Record<string, string>;
}

export interface SignatureBody {
  role: SignerRole;
  wallet: string;
  messageSha256: string;
  signature: string;
}

export function commandsApi(client: ApiClient) {
  const parse = parseCommandView;
  return {
    create: (body: CreateCommand) =>
      client.request("POST", "/v1/commands", { body, timeoutMs: TIMEOUTS.create, parse }),
    get: (id: string) =>
      client.request("GET", `/v1/commands/${id}`, { timeoutMs: TIMEOUTS.get, parse }),
    sign: (id: string, body: SignatureBody) =>
      client.request("POST", `/v1/commands/${id}/signatures`, {
        body,
        timeoutMs: TIMEOUTS.signatures,
        parse,
      }),
    renew: (id: string) =>
      client.request("POST", `/v1/commands/${id}/renew`, {
        body: {},
        timeoutMs: TIMEOUTS.renew,
        parse,
      }),
  };
}

export type CommandsApi = ReturnType<typeof commandsApi>;
