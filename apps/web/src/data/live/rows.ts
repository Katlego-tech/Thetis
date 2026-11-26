// Rows of the indexed read model as the web reads them (supabase/migrations, chain_read_model and
// chain_other_instance): snake_case columns, u64 and i64 as text, u8 to u32 and slots as numbers.

import { DomainError, parseU64 } from "@thetis/domain";
import { type HaltReason, LiveDataError } from "./types";

export type Commitment = "confirmed" | "finalized";

/** A row of public.organisations the caller may read (their own organisations). */
export interface OrganisationRow {
  id: string;
  slug: string;
  name: string;
  kind: string;
  synthetic: boolean;
}

interface ProjectionColumns {
  network: "devnet";
  address: string;
  protocol: string;
  slot: number;
  commitment: Commitment;
}

export interface ChainProtocolRow extends ProjectionColumns {
  instance_id_hex: string;
  settlement_mode: "FiatAttestationTest" | "DevnetTokenSimulation";
  admin: string;
  accreditor: string;
  pause_flags: number;
}
export interface ChainClassPolicyRow extends ProjectionColumns {
  class_code: string;
  version: number;
  unit: "Kilogram";
  grades: string[];
  origin_required: boolean;
  lot_validity_secs: string;
  split_inherits_expiry: boolean;
}
export interface ChainOrganisationRow extends ProjectionColumns {
  org_id: string;
  slug: string | null;
  synthetic: boolean | null;
  role: string;
  display_name: string;
  admin: string;
  related: string[];
}
export interface ChainCustodianClassRow extends ProjectionColumns {
  custodian: string;
  custodian_org_id: string;
  class_policy: string;
  site_code: string;
  approved_capacity_kg: string;
  occupied_kg: string;
  reserved_inbound_kg: string;
}
export interface ChainDocumentRow extends ProjectionColumns {
  kind: "Origin";
  subject_hex: string;
  version: number;
  issuer: string;
  issuer_org_id: string;
  sha256_hex: string;
  valid_until: string;
  revoked_at: string | null;
}
export interface ChainIntakeRow extends ProjectionColumns {
  custodian: string;
  custodian_org_id: string;
  intake_digest_hex: string;
  lot: string;
  retired: boolean;
}
export interface ChainLotRow extends ProjectionColumns {
  lot_id: string;
  class_policy: string;
  class_version: number;
  grade: string;
  custodian_class: string;
  custodian: string;
  custodian_org_id: string;
  intake: string;
  parent: string | null;
  root: string;
  mint: string;
  supply_kg: string;
  state: "Stored" | "Redeemed";
  restriction: "Normal";
  expires_at: string;
  revision: string;
  live_children: number;
  event_revision: string;
  issued_owner: string;
  issued_owner_org_id: string;
  issued_at: string;
}
export interface ChainPositionRow extends ProjectionColumns {
  lot: string;
  owner: string;
  owner_org_id: string;
  quantity_kg: string;
  locked_kg: string;
  reserved_kg: string;
  revision: string;
}
/** A chain_events row whose event is LotIssued. */
export interface ChainEventRow {
  network: "devnet";
  program_id: string;
  signature: string;
  event_index: number;
  slot: number;
  block_time: string;
  protocol: string;
  lot: string;
  lot_revision: string;
  data: { lot: string; owner: string; quantityKg: string; intake: string; revision: string };
  commitment: Commitment;
}
/** The indexer_checkpoints columns granted to members. */
export interface CheckpointRow {
  network: "devnet";
  program_id: string;
  protocol: string;
  status: "backfilling" | "live" | "halted";
  indexed_through_slot: number | null;
  last_success_at: string | null;
  halt_reason: HaltReason | null;
  halted_at: string | null;
}

export interface LiveSnapshot {
  env: { network: "devnet"; programId: string; protocol: string };
  memberships: OrganisationRow[]; // public.organisations visible to the caller (RLS: own orgs)
  organisations: ChainOrganisationRow[];
  protocol: ChainProtocolRow | null;
  classPolicies: ChainClassPolicyRow[];
  custodianClasses: ChainCustodianClassRow[];
  lots: ChainLotRow[];
  positions: ChainPositionRow[];
  intakes: ChainIntakeRow[];
  documents: ChainDocumentRow[];
  intakeEvents: ChainEventRow[]; // chain_events where event = 'LotIssued'
  checkpoint: CheckpointRow | null;
}

const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;

/** Canonical signed decimal text within i64, else BAD_ROW at `path`. */
export function parseI64(text: string, path: string): bigint {
  if (typeof text !== "string" || !/^(0|-?[1-9][0-9]{0,18})$/.test(text)) {
    throw new LiveDataError("BAD_ROW", path, "expected a canonical i64 decimal string");
  }
  const value = BigInt(text);
  if (value < I64_MIN || value > I64_MAX) {
    throw new LiveDataError("BAD_ROW", path, "outside i64");
  }
  return value;
}

/** Canonical unsigned decimal text within u64, else BAD_ROW at `path`. */
export function parseU64At(text: string, path: string): bigint {
  try {
    return parseU64(text);
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    throw new LiveDataError("BAD_ROW", path, error.message);
  }
}

// Column rules. Each snapshot field names its table, primary key, how it is filtered, and every
// column it selects, in the order the rows above declare them (which is the order rows are checked).

export const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const RESERVED_SLUGS: readonly string[] = ["reference", "login", "invite", "account"];
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;

const COMMITMENTS = ["confirmed", "finalized"] as const;
const ORG_KINDS = [
  "exporter",
  "custodian",
  "transporter",
  "terminal",
  "lender",
  "buyer",
  "accreditor",
] as const;
const ROLES = [
  "Exporter",
  "Buyer",
  "Custodian",
  "Transporter",
  "Terminal",
  "Lender",
  "Inspector",
  "DocumentIssuer",
] as const;
export const HALT_REASONS: readonly HaltReason[] = [
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
  "MIXED_INSTANCE",
];

type Kind =
  | "network"
  | "program"
  | "protocol"
  | "address"
  | "signature"
  | "uuid"
  | "hex64"
  | "hex32"
  | "u64"
  | "i64"
  | "number"
  | "boolean"
  | "text"
  | "timestamp"
  | "addresses"
  | "texts"
  | "object"
  | { oneOf: readonly string[] };
type Row = Record<string, unknown>;
interface Column {
  kind: Kind;
  nullable?: true;
  /** A further rule for this column, given the row read so far (earlier columns already checked). */
  rule?: (value: unknown, row: Row, path: string) => void;
}

const projection = {
  network: { kind: "network" },
  address: { kind: "address" },
  protocol: { kind: "protocol" },
  slot: { kind: "number" },
  commitment: { kind: { oneOf: COMMITMENTS } },
} satisfies Record<keyof ProjectionColumns, Column>;

function bad(path: string, message: string): never {
  throw new LiveDataError("BAD_ROW", path, message);
}

const slugRule = (value: unknown, _row: Row, path: string) => {
  if (typeof value !== "string" || !SLUG.test(value) || RESERVED_SLUGS.includes(value)) {
    bad(path, "expected a lowercase slug that is not a reserved route");
  }
};

const EVENT_DATA_KEYS = ["lot", "owner", "quantityKg", "intake", "revision"];
const eventDataRule = (value: unknown, row: Row, path: string) => {
  const data = value as Record<string, unknown>;
  const keys = Object.keys(data).toSorted();
  if (keys.join(",") !== EVENT_DATA_KEYS.toSorted().join(","))
    bad(path, "expected exactly lot, owner, quantityKg, intake and revision");
  for (const key of ["lot", "owner", "intake"]) {
    if (typeof data[key] !== "string" || !ADDRESS.test(data[key] as string))
      bad(path, `${key} is not an address`);
  }
  parseU64At(data.quantityKg as string, path);
  parseU64At(data.revision as string, path);
  if (data.lot !== row.lot) bad(path, "names another lot than the event row");
  if (data.revision !== "0") bad(path, "a LotIssued event is revision 0");
};

const haltRule =
  (field: "halt_reason" | "halted_at") => (value: unknown, row: Row, path: string) => {
    if (row.status === "halted" && value === null) bad(path, `a halted checkpoint has ${field}`);
  };

export const SNAPSHOT_TABLES = {
  memberships: {
    table: "organisations",
    key: ["id"],
    filter: "none",
    columns: {
      id: { kind: "uuid" },
      slug: { kind: "text", rule: slugRule },
      name: { kind: "text" },
      kind: { kind: { oneOf: ORG_KINDS } },
      synthetic: { kind: "boolean" },
    } satisfies Record<keyof OrganisationRow, Column>,
  },
  organisations: {
    table: "chain_organisations",
    key: ["network", "address"],
    filter: "chain",
    columns: {
      ...projection,
      org_id: { kind: "uuid" },
      slug: { kind: "text", nullable: true },
      synthetic: { kind: "boolean", nullable: true },
      role: { kind: { oneOf: ROLES } },
      display_name: { kind: "text" },
      admin: { kind: "address" },
      related: { kind: "addresses" },
    } satisfies Record<keyof ChainOrganisationRow, Column>,
  },
  protocol: {
    table: "chain_protocols",
    key: ["network", "address"],
    filter: "chain",
    columns: {
      ...projection,
      instance_id_hex: { kind: "hex32" },
      settlement_mode: { kind: { oneOf: ["FiatAttestationTest", "DevnetTokenSimulation"] } },
      admin: { kind: "address" },
      accreditor: { kind: "address" },
      pause_flags: { kind: "number" },
    } satisfies Record<keyof ChainProtocolRow, Column>,
  },
  classPolicies: {
    table: "chain_class_policies",
    key: ["network", "address"],
    filter: "chain",
    columns: {
      ...projection,
      class_code: { kind: "text" },
      version: { kind: "number" },
      unit: { kind: { oneOf: ["Kilogram"] } },
      grades: { kind: "texts" },
      origin_required: { kind: "boolean" },
      lot_validity_secs: { kind: "i64" },
      split_inherits_expiry: { kind: "boolean" },
    } satisfies Record<keyof ChainClassPolicyRow, Column>,
  },
  custodianClasses: {
    table: "chain_custodian_classes",
    key: ["network", "address"],
    filter: "chain",
    columns: {
      ...projection,
      custodian: { kind: "address" },
      custodian_org_id: { kind: "uuid" },
      class_policy: { kind: "address" },
      site_code: { kind: "text" },
      approved_capacity_kg: { kind: "u64" },
      occupied_kg: { kind: "u64" },
      reserved_inbound_kg: { kind: "u64" },
    } satisfies Record<keyof ChainCustodianClassRow, Column>,
  },
  lots: {
    table: "chain_lots",
    key: ["network", "address"],
    filter: "chain",
    columns: {
      ...projection,
      lot_id: { kind: "text" },
      class_policy: { kind: "address" },
      class_version: { kind: "number" },
      grade: { kind: "text" },
      custodian_class: { kind: "address" },
      custodian: { kind: "address" },
      custodian_org_id: { kind: "uuid" },
      intake: { kind: "address" },
      parent: { kind: "address", nullable: true },
      root: { kind: "address" },
      mint: { kind: "address" },
      supply_kg: { kind: "u64" },
      state: { kind: { oneOf: ["Stored", "Redeemed"] } },
      restriction: { kind: { oneOf: ["Normal"] } },
      expires_at: { kind: "i64" },
      revision: { kind: "u64" },
      live_children: { kind: "number" },
      event_revision: { kind: "u64" },
      issued_owner: { kind: "address" },
      issued_owner_org_id: { kind: "uuid" },
      issued_at: { kind: "timestamp" },
    } satisfies Record<keyof ChainLotRow, Column>,
  },
  positions: {
    table: "chain_positions",
    key: ["network", "address"],
    filter: "chain",
    columns: {
      ...projection,
      lot: { kind: "address" },
      owner: { kind: "address" },
      owner_org_id: { kind: "uuid" },
      quantity_kg: { kind: "u64" },
      locked_kg: { kind: "u64" },
      reserved_kg: { kind: "u64" },
      revision: { kind: "u64" },
    } satisfies Record<keyof ChainPositionRow, Column>,
  },
  intakes: {
    table: "chain_intakes",
    key: ["network", "address"],
    filter: "chain",
    columns: {
      ...projection,
      custodian: { kind: "address" },
      custodian_org_id: { kind: "uuid" },
      intake_digest_hex: { kind: "hex64" },
      lot: { kind: "address" },
      retired: { kind: "boolean" },
    } satisfies Record<keyof ChainIntakeRow, Column>,
  },
  documents: {
    table: "chain_documents",
    key: ["network", "address"],
    filter: "chain",
    columns: {
      ...projection,
      kind: { kind: { oneOf: ["Origin"] } },
      subject_hex: { kind: "hex64" },
      version: { kind: "number" },
      issuer: { kind: "address" },
      issuer_org_id: { kind: "uuid" },
      sha256_hex: { kind: "hex64" },
      valid_until: { kind: "i64" },
      revoked_at: { kind: "i64", nullable: true },
    } satisfies Record<keyof ChainDocumentRow, Column>,
  },
  intakeEvents: {
    table: "chain_events",
    key: ["network", "program_id", "signature", "event_index"],
    filter: "events",
    columns: {
      network: { kind: "network" },
      program_id: { kind: "program" },
      signature: { kind: "signature" },
      event_index: { kind: "number" },
      slot: { kind: "number" },
      block_time: { kind: "timestamp" },
      protocol: { kind: "protocol" },
      lot: { kind: "address" },
      lot_revision: {
        kind: "u64",
        rule: (value, _row, path) => {
          if (value !== "0") bad(path, "a LotIssued event is revision 0");
        },
      },
      data: { kind: "object", rule: eventDataRule },
      commitment: { kind: { oneOf: COMMITMENTS } },
    } satisfies Record<keyof ChainEventRow, Column>,
  },
  checkpoint: {
    table: "indexer_checkpoints",
    key: ["network", "program_id", "protocol"],
    filter: "checkpoint",
    columns: {
      network: { kind: "network" },
      program_id: { kind: "program" },
      protocol: { kind: "protocol" },
      status: { kind: { oneOf: ["backfilling", "live", "halted"] } },
      indexed_through_slot: { kind: "number", nullable: true },
      last_success_at: { kind: "timestamp", nullable: true },
      halt_reason: { kind: { oneOf: HALT_REASONS }, nullable: true, rule: haltRule("halt_reason") },
      halted_at: { kind: "timestamp", nullable: true, rule: haltRule("halted_at") },
    } satisfies Record<keyof CheckpointRow, Column>,
  },
} as const;

export type RowField = keyof typeof SNAPSHOT_TABLES;
export interface RowsOf {
  memberships: OrganisationRow;
  organisations: ChainOrganisationRow;
  protocol: ChainProtocolRow;
  classPolicies: ChainClassPolicyRow;
  custodianClasses: ChainCustodianClassRow;
  lots: ChainLotRow;
  positions: ChainPositionRow;
  intakes: ChainIntakeRow;
  documents: ChainDocumentRow;
  intakeEvents: ChainEventRow;
  checkpoint: CheckpointRow;
}

function checkValue(kind: Kind, value: unknown, path: string, env: LiveSnapshot["env"]): unknown {
  const text = () => {
    if (typeof value !== "string") bad(path, "expected text");
    return value;
  };
  const pattern = (regex: RegExp, what: string) => {
    if (!regex.test(text())) bad(path, `expected ${what}`);
    return value;
  };
  if (typeof kind === "object") {
    if (!kind.oneOf.includes(text())) bad(path, `expected one of ${kind.oneOf.join(", ")}`);
    return value;
  }
  switch (kind) {
    case "network":
      if (value !== env.network) bad(path, `expected ${env.network}`);
      return value;
    case "program":
      if (value !== env.programId) bad(path, "another program");
      return value;
    case "protocol":
      if (value !== env.protocol) bad(path, "another protocol instance");
      return value;
    case "address":
      return pattern(ADDRESS, "a base58 address");
    case "signature":
      return pattern(SIGNATURE, "a base58 signature");
    case "uuid":
      return pattern(UUID, "a canonical lowercase uuid");
    case "hex64":
      return pattern(HEX64, "64 lowercase hex digits");
    case "hex32":
      return pattern(HEX32, "32 lowercase hex digits");
    case "u64":
      parseU64At(text(), path);
      return value;
    case "i64":
      parseI64(text(), path);
      return value;
    case "number":
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        bad(path, "expected a non-negative safe integer");
      }
      return value;
    case "boolean":
      if (typeof value !== "boolean") bad(path, "expected a boolean");
      return value;
    case "text":
      return text();
    case "timestamp": {
      const time = new Date(text());
      if (Number.isNaN(time.getTime())) bad(path, "expected a timestamp");
      return time.toISOString();
    }
    case "addresses":
    case "texts": {
      if (!Array.isArray(value)) bad(path, "expected an array");
      value.forEach((item, index) => {
        checkValue(kind === "addresses" ? "address" : "text", item, `${path}[${index}]`, env);
      });
      return [...value];
    }
    case "object":
      if (typeof value !== "object" || value === null || Array.isArray(value))
        bad(path, "expected an object");
      return { ...(value as Row) };
  }
}

/**
 * Checks one row of `field` column by column, in declaration order, and returns it with only the
 * declared columns and timestamps normalised to ISO. `at` is the path prefix (`lots[2]`, `checkpoint`).
 */
export function checkRow<F extends RowField>(
  field: F,
  raw: unknown,
  at: string,
  env: LiveSnapshot["env"],
): RowsOf[F] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) bad(at, "expected a row");
  const input = raw as Row;
  const row: Row = {};
  for (const [name, column] of Object.entries(SNAPSHOT_TABLES[field].columns) as [
    string,
    Column,
  ][]) {
    const path = `${at}.${name}`;
    const value = input[name];
    if (value === null && column.nullable) {
      row[name] = null;
    } else {
      if (value === undefined || value === null) bad(path, "missing");
      row[name] = checkValue(column.kind, value, path, env);
    }
    column.rule?.(row[name], row, path);
  }
  return row as unknown as RowsOf[F];
}
