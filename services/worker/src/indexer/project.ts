// Projection: from decoded accounts to read-model rows. Two callers use the row builders: the
// per-slot event projection below, and reconcile (which compares them with stored rows).

import type { Address } from "@solana/kit";
import {
  type Account,
  isSolanaError,
  type MaybeEncodedAccount,
  type ReadonlyUint8Array,
  SOLANA_ERROR__CODECS__ENUM_DISCRIMINATOR_OUT_OF_RANGE,
  unwrapOption,
} from "@solana/kit";
import {
  type Authority,
  type ClassPolicy,
  type CustodianClass,
  type DocumentAttestation,
  DocumentKind,
  decodeAuthority,
  decodeClassPolicy,
  decodeCustodianClass,
  decodeDocumentAttestation,
  decodeIntakeIdentity,
  decodeLot,
  decodeOrganisation,
  decodePosition,
  decodeProtocol,
  findPositionPda,
  type IntakeIdentity,
  type Lot,
  LotState,
  type Organisation,
  type Position,
  type Protocol,
  QuantityUnit,
  Restriction,
  Role,
  SettlementMode,
  ThetisAccountError,
  toI64String,
  toU64String,
} from "@thetis/contracts";
import type { DecodedEvent, HandledEvent, Invocation } from "./decode.ts";
import { HaltError, type HaltReason } from "./errors.ts";
import type { ChainSource } from "./rpc.ts";
import type { JsonValue, ProjectionTable, ReadModelStore, Row, Stream, Upsert } from "./store.ts";

// ------------------------------------------------------------------------------------------------
// Account kinds
// ------------------------------------------------------------------------------------------------

export type Kind =
  | "Protocol"
  | "ClassPolicy"
  | "Organisation"
  | "Authority"
  | "CustodianClass"
  | "DocumentAttestation"
  | "IntakeIdentity"
  | "Lot"
  | "Position";

export const KIND_TABLE: Record<Kind, ProjectionTable> = {
  Protocol: "chain_protocols",
  ClassPolicy: "chain_class_policies",
  Organisation: "chain_organisations",
  Authority: "chain_authorities",
  CustodianClass: "chain_custodian_classes",
  DocumentAttestation: "chain_documents",
  IntakeIdentity: "chain_intakes",
  Lot: "chain_lots",
  Position: "chain_positions",
};

export const TABLE_KIND = Object.fromEntries(
  Object.entries(KIND_TABLE).map(([kind, table]) => [table, kind]),
) as Record<ProjectionTable, Kind>;

export type AccountData =
  | { kind: "Protocol"; data: Protocol }
  | { kind: "ClassPolicy"; data: ClassPolicy }
  | { kind: "Organisation"; data: Organisation }
  | { kind: "Authority"; data: Authority }
  | { kind: "CustodianClass"; data: CustodianClass }
  | { kind: "DocumentAttestation"; data: DocumentAttestation }
  | { kind: "IntakeIdentity"; data: IntakeIdentity }
  | { kind: "Lot"; data: Lot }
  | { kind: "Position"; data: Position };

type GuardedDecoder = (account: MaybeEncodedAccount) => { exists: boolean; data?: unknown };

const DECODERS: Record<Kind, GuardedDecoder> = {
  Protocol: decodeProtocol as unknown as GuardedDecoder,
  ClassPolicy: decodeClassPolicy as unknown as GuardedDecoder,
  Organisation: decodeOrganisation as unknown as GuardedDecoder,
  Authority: decodeAuthority as unknown as GuardedDecoder,
  CustodianClass: decodeCustodianClass as unknown as GuardedDecoder,
  DocumentAttestation: decodeDocumentAttestation as unknown as GuardedDecoder,
  IntakeIdentity: decodeIntakeIdentity as unknown as GuardedDecoder,
  Lot: decodeLot as unknown as GuardedDecoder,
  Position: decodePosition as unknown as GuardedDecoder,
};

export type DecodeFailure = { address: string; enumError: boolean; message: string };

/**
 * The guarded decode of one account as the expected kind. Never throws for a bad account: the
 * failure comes back so a caller can list every failing address. `protocol` is the instance the
 * account must belong to (the Protocol account has no such field).
 */
export function decodeAccountAs(
  kind: Kind,
  account: MaybeEncodedAccount,
  protocol: string,
): { ok: AccountData } | { failure: DecodeFailure } {
  const address = account.address as string;
  if (!account.exists) {
    return { failure: { address, enumError: false, message: "the account does not exist" } };
  }
  try {
    const decoded = DECODERS[kind](account) as unknown as Account<{ protocol?: string }>;
    const data = decoded.data;
    if (kind !== "Protocol" && data.protocol !== protocol) {
      return {
        failure: {
          address,
          enumError: false,
          message: `${kind} belongs to protocol ${data.protocol}`,
        },
      };
    }
    return { ok: { kind, data } as unknown as AccountData };
  } catch (error) {
    if (isSolanaError(error, SOLANA_ERROR__CODECS__ENUM_DISCRIMINATOR_OUT_OF_RANGE)) {
      return {
        failure: { address, enumError: true, message: `${kind} carries an unknown enum number` },
      };
    }
    const message = error instanceof ThetisAccountError ? error.message : `${kind} does not decode`;
    return { failure: { address, enumError: false, message } };
  }
}

/** The halt for a set of decode failures: an enum failure names UNKNOWN_ENUM and wins. */
export function decodeHalt(step: "fetch" | "reconcile", failures: DecodeFailure[]): HaltError {
  const reason: HaltReason = failures.some((failure) => failure.enumError)
    ? "UNKNOWN_ENUM"
    : "ACCOUNT_DECODE_FAILED";
  const sorted = [...failures].sort((a, b) => (a.address < b.address ? -1 : 1));
  return new HaltError(
    reason,
    `${step}: ${sorted.map((failure) => `${failure.address} (${failure.message})`).join("; ")}`,
    null,
  );
}

// ------------------------------------------------------------------------------------------------
// Row values
// ------------------------------------------------------------------------------------------------

export class MissingDependency extends Error {
  readonly table: ProjectionTable;
  readonly address: string;

  constructor(table: ProjectionTable, address: string) {
    super(`no ${table} row or account for ${address}`);
    this.name = "MissingDependency";
    this.table = table;
    this.address = address;
  }
}

export class UnknownEnumError extends Error {
  readonly enumName: string;

  constructor(enumName: string, value: number) {
    super(`${enumName} has no variant numbered ${value}`);
    this.name = "UnknownEnumError";
    this.enumName = enumName;
  }
}

/** What a row builder needs from other accounts: organisation ids and custodian classes. */
export interface Resolver {
  organisationId(address: string): string;
  custodianOf(classAddress: string): string;
}

function variant(enumName: string, names: unknown, value: number): string {
  const found = (names as Record<number, string | undefined>)[value];
  if (found === undefined) throw new UnknownEnumError(enumName, value);
  return found;
}

export function uuidFromBytes(bytes: ReadonlyUint8Array): string {
  const hex = Buffer.from(bytes as Uint8Array).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

const hex = (bytes: ReadonlyUint8Array) => Buffer.from(bytes as Uint8Array).toString("hex");
const optionalI64 = (value: unknown): JsonValue => {
  const unwrapped = unwrapOption(value as Parameters<typeof unwrapOption>[0]);
  return unwrapped === null ? null : toI64String(unwrapped as bigint);
};

/** The columns read from the account itself (ACCOUNT_COLUMNS of its table). */
export function accountColumns(account: AccountData, resolver: Resolver): Row {
  switch (account.kind) {
    case "Protocol": {
      const { data } = account;
      return {
        instance_id_hex: hex(data.instanceId),
        settlement_mode: variant("SettlementMode", SettlementMode, data.settlementMode),
        admin: data.admin,
        accreditor: data.accreditor,
        pause_flags: data.pauseFlags,
      };
    }
    case "ClassPolicy": {
      const { data } = account;
      return {
        class_code: data.classCode,
        version: data.version,
        unit: variant("QuantityUnit", QuantityUnit, data.unit),
        grades: [...data.grades],
        origin_required: data.originRequired,
        lot_validity_secs: toI64String(data.lotValiditySecs),
        split_inherits_expiry: data.splitInheritsExpiry,
      };
    }
    case "Organisation": {
      const { data } = account;
      return {
        org_id: uuidFromBytes(data.orgId),
        role: variant("Role", Role, data.role),
        display_name: data.displayName,
        admin: data.admin,
        related: [...data.related],
      };
    }
    case "Authority": {
      const { data } = account;
      return {
        organisation: data.organisation,
        org_id: resolver.organisationId(data.organisation),
        wallet: data.wallet,
        scopes: data.scopes,
        expires_at: toI64String(data.expiresAt),
        revoked_at: optionalI64(data.revokedAt),
      };
    }
    case "CustodianClass": {
      const { data } = account;
      return {
        custodian: data.custodian,
        custodian_org_id: resolver.organisationId(data.custodian),
        class_policy: data.classPolicy,
        site_code: data.siteCode,
        approved_capacity_kg: toU64String(data.approvedCapacityKg),
        occupied_kg: toU64String(data.occupiedKg),
        reserved_inbound_kg: toU64String(data.reservedInboundKg),
      };
    }
    case "DocumentAttestation": {
      const { data } = account;
      return {
        kind: variant("DocumentKind", DocumentKind, data.kind),
        subject_hex: hex(data.subject),
        version: data.version,
        issuer: data.issuer,
        issuer_org_id: resolver.organisationId(data.issuer),
        sha256_hex: hex(data.sha256),
        valid_until: toI64String(data.validUntil),
        revoked_at: optionalI64(data.revokedAt),
      };
    }
    case "IntakeIdentity": {
      const { data } = account;
      return {
        custodian: data.custodian,
        custodian_org_id: resolver.organisationId(data.custodian),
        intake_digest_hex: hex(data.intakeDigest),
        lot: data.lot,
        retired: data.retired,
      };
    }
    case "Lot": {
      const { data } = account;
      const custodian = resolver.custodianOf(data.custodianClass);
      return {
        lot_id: data.lotId,
        class_policy: data.classPolicy,
        class_version: data.classVersion,
        grade: data.grade,
        custodian_class: data.custodianClass,
        custodian,
        custodian_org_id: resolver.organisationId(custodian),
        intake: data.intake,
        parent: unwrapOption(data.parent) ?? null,
        root: data.root,
        mint: data.mint,
        supply_kg: toU64String(data.supplyKg),
        state: variant("LotState", LotState, data.state),
        restriction: variant("Restriction", Restriction, data.restriction),
        expires_at: toI64String(data.expiresAt),
        revision: toU64String(data.revision),
        live_children: data.liveChildren,
      };
    }
    case "Position": {
      const { data } = account;
      return {
        lot: data.lot,
        owner: data.owner,
        owner_org_id: resolver.organisationId(data.owner),
        quantity_kg: toU64String(data.quantityKg),
        locked_kg: toU64String(data.lockedKg),
        reserved_kg: toU64String(data.reservedKg),
        revision: toU64String(data.revision),
      };
    }
  }
}

// ------------------------------------------------------------------------------------------------
// Per-slot projection
// ------------------------------------------------------------------------------------------------

export type SlotTransaction = {
  signature: string;
  slot: number;
  blockTime: string;
  succeeded: boolean;
  /** Null for a failed transaction or one with no Thetis execution. */
  decoded: { invocations: Invocation[]; protocol: string | null; otherInstance: boolean } | null;
};

export type ProjectionContext = {
  chain: ChainSource;
  store: ReadModelStore;
  stream: Stream;
  signal: () => AbortSignal;
};

export type SlotRows = { transactions: Row[]; events: Row[]; upserts: Upsert[] };

type Planned = { address: string; kind: Kind };

type Plan = {
  transaction: SlotTransaction;
  invocation: Invocation;
  event: DecodedEvent;
  scope: "registry" | "organisation" | "lot";
  lot: string | null;
  revision: bigint | null;
  fetch: Planned[];
  creates: Planned[];
  /** The transfer recipient's Position: created when absent (init_if_needed). */
  mayCreate: Planned[];
};

const sortText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sortBig = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);

function stepHalt(step: string, reason: HaltReason, message: string): HaltError {
  return new HaltError(reason, `${step}: ${message}`, null);
}

async function positionOf(lot: string, owner: string): Promise<string> {
  const [address] = await findPositionPda({ lot: lot as Address, owner: owner as Address });
  return address as string;
}

async function planEvent(
  transaction: SlotTransaction,
  invocation: Invocation,
  event: DecodedEvent,
): Promise<Plan> {
  const value = event.value as Record<string, unknown>;
  const text = (field: string) => value[field] as string;
  const base = {
    transaction,
    invocation,
    event,
    lot: null,
    revision: null,
    fetch: [] as Planned[],
    creates: [] as Planned[],
    mayCreate: [] as Planned[],
  };
  const name: HandledEvent = event.name;
  const accounts = invocation.accounts;
  const optional = (kind: Kind, address: string | undefined): Planned[] =>
    address === undefined ? [] : [{ address, kind }];
  switch (name) {
    case "ProtocolInitialized": {
      const planned = { address: text("protocol"), kind: "Protocol" as const };
      return { ...base, scope: "registry", fetch: [planned], creates: [planned] };
    }
    case "ClassRegistered": {
      const planned = { address: text("classPolicy"), kind: "ClassPolicy" as const };
      return { ...base, scope: "registry", fetch: [planned], creates: [planned] };
    }
    case "OrganisationAccredited": {
      const planned = { address: text("organisation"), kind: "Organisation" as const };
      return { ...base, scope: "organisation", fetch: [planned], creates: [planned] };
    }
    case "RelationshipDeclared":
      return {
        ...base,
        scope: "registry",
        fetch: [
          { address: text("a"), kind: "Organisation" },
          { address: text("b"), kind: "Organisation" },
        ],
      };
    case "AuthorityDelegated": {
      const planned = { address: text("authority"), kind: "Authority" as const };
      return { ...base, scope: "organisation", fetch: [planned], creates: [planned] };
    }
    case "AuthorityRevoked":
      return {
        ...base,
        scope: "organisation",
        fetch: [{ address: text("authority"), kind: "Authority" }],
      };
    case "CustodianClassAccredited": {
      const planned = { address: text("custodianClass"), kind: "CustodianClass" as const };
      return { ...base, scope: "registry", fetch: [planned], creates: [planned] };
    }
    case "PauseChanged":
      return {
        ...base,
        scope: "registry",
        fetch: optional("Protocol", accounts.protocol),
      };
    case "DocumentAttested": {
      const planned = { address: text("document"), kind: "DocumentAttestation" as const };
      return { ...base, scope: "organisation", fetch: [planned], creates: [planned] };
    }
    case "DocumentRevoked":
      return {
        ...base,
        scope: "organisation",
        fetch: [{ address: text("document"), kind: "DocumentAttestation" }],
      };
    case "LotIssued": {
      const lot = text("lot");
      const position = { address: await positionOf(lot, text("owner")), kind: "Position" as const };
      const creates: Planned[] = [
        { address: lot, kind: "Lot" },
        { address: text("intake"), kind: "IntakeIdentity" },
        position,
      ];
      return {
        ...base,
        scope: "lot",
        lot,
        revision: value.revision as bigint,
        fetch: [...creates, ...optional("CustodianClass", accounts.custodianClass)],
        creates,
      };
    }
    case "UnitsTransferred": {
      const lot = text("lot");
      const from = { address: await positionOf(lot, text("from")), kind: "Position" as const };
      const to = { address: await positionOf(lot, text("to")), kind: "Position" as const };
      return {
        ...base,
        scope: "lot",
        lot,
        revision: value.revision as bigint,
        fetch: [{ address: lot, kind: "Lot" }, from, to],
        mayCreate: [to],
      };
    }
    case "LotSplit": {
      const parent = text("parent");
      const child = text("child");
      const owner = text("owner");
      const childLot = { address: child, kind: "Lot" as const };
      const childPosition = { address: await positionOf(child, owner), kind: "Position" as const };
      return {
        ...base,
        scope: "lot",
        lot: parent,
        revision: value.parentRevision as bigint,
        fetch: [
          { address: parent, kind: "Lot" },
          childLot,
          { address: await positionOf(parent, owner), kind: "Position" },
          childPosition,
          ...optional("Lot", accounts.root),
        ],
        creates: [childLot, childPosition],
      };
    }
    case "UnitsRedeemed": {
      const lot = text("lot");
      return {
        ...base,
        scope: "lot",
        lot,
        revision: value.revision as bigint,
        fetch: [
          { address: lot, kind: "Lot" },
          { address: await positionOf(lot, text("owner")), kind: "Position" },
          ...optional("IntakeIdentity", accounts.intake),
          ...optional("CustodianClass", accounts.custodianClass),
          ...optional("Lot", accounts.root),
        ],
      };
    }
  }
}

type LotEntry = {
  creators: Plan[];
  revisions: { revision: bigint; plan: Plan }[];
};

/**
 * Projects the new transactions of one slot into rows: plans each event, checks revision
 * sequences and creations against the store, reads the accounts the events name, resolves what
 * the rows depend on, and builds the rows. Throws HaltError (steps sequence and fetch).
 */
export async function projectSlot(
  context: ProjectionContext,
  slot: number,
  transactions: SlotTransaction[],
): Promise<SlotRows> {
  const { chain, store, stream } = context;
  const ordered = [...transactions].sort((a, b) => sortText(a.signature, b.signature));

  // Plans, in transaction then event order.
  const plans: Plan[] = [];
  for (const transaction of ordered) {
    for (const invocation of transaction.decoded?.invocations ?? []) {
      for (const event of invocation.events) {
        plans.push(await planEvent(transaction, invocation, event));
      }
    }
  }

  // Who plans what.
  const kinds = new Map<string, Kind>();
  const conflicts = new Set<string>();
  const namedBy = new Map<string, string[]>();
  const note = (planned: Planned, signature: string) => {
    const known = kinds.get(planned.address);
    if (known !== undefined && known !== planned.kind) conflicts.add(planned.address);
    kinds.set(planned.address, known ?? planned.kind);
    const list = namedBy.get(planned.address) ?? [];
    list.push(signature);
    namedBy.set(planned.address, list);
  };
  for (const plan of plans) {
    for (const planned of [...plan.fetch, ...plan.creates, ...plan.mayCreate]) {
      note(planned, plan.transaction.signature);
    }
  }

  // Stored rows for everything the slot names.
  const stored = new Map<ProjectionTable, Map<string, Row>>();
  for (const table of Object.values(KIND_TABLE)) {
    const addresses = [...kinds].filter(([, kind]) => KIND_TABLE[kind] === table).map(([a]) => a);
    stored.set(
      table,
      addresses.length === 0 ? new Map() : await store.storedRows(stream, table, addresses),
    );
  }
  const storedRow = (kind: Kind, address: string) =>
    (stored.get(KIND_TABLE[kind]) as Map<string, Row>).get(address);

  // Sequence check, lot by lot.
  const lots = new Map<string, LotEntry>();
  const entryOf = (lot: string) => {
    let entry = lots.get(lot);
    if (!entry) {
      entry = { creators: [], revisions: [] };
      lots.set(lot, entry);
    }
    return entry;
  };
  for (const plan of plans) {
    const value = plan.event.value as Record<string, unknown>;
    switch (plan.event.name) {
      case "LotIssued":
        entryOf(value.lot as string).creators.push(plan);
        entryOf(value.lot as string).revisions.push({ revision: value.revision as bigint, plan });
        break;
      case "UnitsTransferred":
      case "UnitsRedeemed":
        entryOf(value.lot as string).revisions.push({ revision: value.revision as bigint, plan });
        break;
      case "LotSplit":
        entryOf(value.parent as string).revisions.push({
          revision: value.parentRevision as bigint,
          plan,
        });
        entryOf(value.child as string).creators.push(plan);
        break;
      default:
        break;
    }
  }
  const eventRevision = new Map<string, bigint>();
  for (const lot of [...lots.keys()].sort(sortText)) {
    const entry = lots.get(lot) as LotEntry;
    const signatures = [
      ...new Set(
        [...entry.creators, ...entry.revisions.map((item) => item.plan)].map(
          (p) => p.transaction.signature,
        ),
      ),
    ].sort(sortText);
    const named = `lot ${lot} (signatures ${signatures.join(", ")})`;
    if (entry.creators.length > 1) {
      throw stepHalt(
        "sequence",
        "REVISION_SEQUENCE",
        `${named} is created by ${entry.creators.length} events of one slot`,
      );
    }
    const row = storedRow("Lot", lot);
    let base: bigint;
    const creator = entry.creators[0];
    if (creator) {
      if (row) {
        throw stepHalt(
          "sequence",
          "REVISION_SEQUENCE",
          `${named} is created again while it is already stored`,
        );
      }
      base = creator.event.name === "LotIssued" ? -1n : 0n;
    } else {
      if (!row) {
        throw stepHalt(
          "sequence",
          "EVENT_GAP",
          `${named} has no stored row and no event of this slot creates it`,
        );
      }
      base = BigInt(row.event_revision as string);
    }
    const revisions = entry.revisions.map((item) => item.revision).sort(sortBig);
    for (const [index, revision] of revisions.entries()) {
      const expected = base + 1n + BigInt(index);
      if (revision !== expected) {
        throw stepHalt(
          "sequence",
          "REVISION_SEQUENCE",
          `${named} carries revisions [${revisions.join(", ")}] after ${base}, expected ${expected} at position ${index}`,
        );
      }
    }
    eventRevision.set(lot, revisions.at(-1) ?? base);
  }

  // Creation check, account by account.
  const creators = new Map<string, Plan[]>();
  const recipients = new Set<string>();
  for (const plan of plans) {
    for (const planned of plan.creates)
      creators.set(planned.address, [...(creators.get(planned.address) ?? []), plan]);
    for (const planned of plan.mayCreate) recipients.add(planned.address);
  }
  for (const address of [...kinds.keys()].sort(sortText)) {
    const kind = kinds.get(address) as Kind;
    const made = creators.get(address) ?? [];
    const signatures = [...new Set(namedBy.get(address))].sort(sortText).join(", ");
    if (made.length > 1) {
      throw stepHalt(
        "sequence",
        "REVISION_SEQUENCE",
        `${kind} ${address} is created by ${made.length} events of one slot (signatures ${signatures})`,
      );
    }
    const isStored = storedRow(kind, address) !== undefined;
    if (made.length === 1 && isStored) {
      throw stepHalt(
        "sequence",
        "REVISION_SEQUENCE",
        `${kind} ${address} is created again while it is already stored (signatures ${signatures})`,
      );
    }
    if (made.length === 0 && !isStored && !recipients.has(address)) {
      throw stepHalt(
        "sequence",
        "EVENT_GAP",
        `${kind} ${address} is neither stored nor created by an event of this slot (signatures ${signatures})`,
      );
    }
  }

  // Fetch and guarded decode.
  const addresses = [...kinds.keys()].sort(sortText);
  const failures: DecodeFailure[] =
    conflicts.size === 0
      ? []
      : [...conflicts].map((address) => ({
          address,
          enumError: false,
          message: "the slot plans this address as two account kinds",
        }));
  const read = new Map<string, { slot: number; account: AccountData }>();
  for (let start = 0; start < addresses.length; start += 100) {
    const batch = addresses.slice(start, start + 100);
    const result = await chain.getMultipleAccounts(batch, "confirmed", slot, context.signal());
    if (result.accounts.length !== batch.length || result.slot < slot) {
      throw new Error(
        `getMultipleAccounts answered slot ${result.slot} with ${result.accounts.length} accounts for ${batch.length} requested at ${slot}`,
      );
    }
    for (const [index, fetched] of result.accounts.entries()) {
      const address = batch[index] as string;
      if (fetched.address !== address)
        throw new Error(`getMultipleAccounts answered ${fetched.address} for ${address}`);
      if (conflicts.has(address)) continue;
      const decoded = decodeAccountAs(kinds.get(address) as Kind, fetched, stream.protocol);
      if ("failure" in decoded) failures.push(decoded.failure);
      else read.set(address, { slot: result.slot, account: decoded.ok });
    }
  }
  if (failures.length > 0) throw decodeHalt("fetch", failures);

  // Dependencies: this slot's accounts first, then stored rows, until nothing is missing.
  const organisations = new Map<string, string>();
  const classes = new Map<string, string>();
  for (const [address, { account }] of read) {
    if (account.kind === "Organisation")
      organisations.set(address, uuidFromBytes(account.data.orgId));
    if (account.kind === "CustodianClass") classes.set(address, account.data.custodian);
  }
  const PLACEHOLDER_ORGANISATION = "00000000-0000-0000-0000-000000000000";
  // Contains characters outside the base58 alphabet, so no real address can equal it.
  const PLACEHOLDER_CUSTODIAN = "0-unresolved-custodian";
  const missing = { organisations: new Set<string>(), classes: new Set<string>() };
  const resolver: Resolver = {
    organisationId(address) {
      const known = organisations.get(address);
      if (known !== undefined) return known;
      if (address !== PLACEHOLDER_CUSTODIAN) missing.organisations.add(address);
      return PLACEHOLDER_ORGANISATION;
    },
    custodianOf(classAddress) {
      const known = classes.get(classAddress);
      if (known !== undefined) return known;
      missing.classes.add(classAddress);
      return PLACEHOLDER_CUSTODIAN;
    },
  };

  // Which Organisation each organisation-scoped event belongs to.
  const eventOrganisation = (plan: Plan): string => {
    const value = plan.event.value as Record<string, unknown>;
    switch (plan.event.name) {
      case "OrganisationAccredited":
      case "AuthorityDelegated":
        return value.organisation as string;
      case "AuthorityRevoked": {
        const authority = read.get(value.authority as string)?.account;
        return (authority as { data: Authority }).data.organisation;
      }
      default: {
        const document = read.get(value.document as string)?.account;
        return (document as { data: DocumentAttestation }).data.issuer;
      }
    }
  };
  const creatingOwner = (lot: string): { plan: Plan; owner: string } | undefined => {
    const creator = lots.get(lot)?.creators[0];
    if (!creator) return undefined;
    return {
      plan: creator,
      owner: (creator.event.value as Record<string, unknown>).owner as string,
    };
  };

  const columnsOf = (account: AccountData): Row => {
    try {
      return accountColumns(account, resolver);
    } catch (error) {
      if (error instanceof UnknownEnumError) {
        throw stepHalt("fetch", "UNKNOWN_ENUM", `${account.kind}: ${error.message}`);
      }
      throw error;
    }
  };
  const build = () => {
    for (const [, { account }] of read) columnsOf(account);
    for (const plan of plans) {
      if (plan.scope === "organisation") resolver.organisationId(eventOrganisation(plan));
    }
    for (const [lot, { account }] of read) {
      if (account.kind !== "Lot") continue;
      const created = creatingOwner(lot);
      if (created) resolver.organisationId(created.owner);
    }
  };
  let resolved = false;
  for (let round = 0; round < 4 && !resolved; round += 1) {
    missing.organisations.clear();
    missing.classes.clear();
    build();
    if (missing.organisations.size === 0 && missing.classes.size === 0) {
      resolved = true;
      break;
    }
    const unresolved: string[] = [];
    if (missing.classes.size > 0) {
      const found = await store.storedRows(stream, "chain_custodian_classes", [...missing.classes]);
      for (const address of missing.classes) {
        const row = found.get(address);
        if (row) classes.set(address, row.custodian as string);
        else unresolved.push(`CustodianClass ${address}`);
      }
    }
    if (missing.organisations.size > 0) {
      const found = await store.storedRows(stream, "chain_organisations", [
        ...missing.organisations,
      ]);
      for (const address of missing.organisations) {
        const row = found.get(address);
        if (row) organisations.set(address, row.org_id as string);
        else unresolved.push(`Organisation ${address}`);
      }
    }
    if (unresolved.length > 0) {
      throw stepHalt(
        "fetch",
        "EVENT_GAP",
        `no stored row for ${unresolved.sort(sortText).join(", ")}`,
      );
    }
  }
  if (!resolved) {
    throw stepHalt("fetch", "EVENT_GAP", "the dependencies of this slot's rows do not resolve");
  }

  // Rows.
  const lastSignature = new Map<string, string>();
  for (const [address, signatures] of namedBy) {
    lastSignature.set(address, [...signatures].sort(sortText).at(-1) as string);
  }
  const slugs = await store.organisationSlugs([...organisations.values()]);
  const creationTime = (lot: string) => creatingOwner(lot)?.plan.transaction.blockTime;
  const upserts: Upsert[] = [];
  for (const address of addresses) {
    const { slot: readSlot, account } = read.get(address) as { slot: number; account: AccountData };
    const table = KIND_TABLE[account.kind];
    const row: Row = {
      network: stream.network,
      address,
      protocol: stream.protocol,
      slot: readSlot,
      commitment: "confirmed",
      last_signature: lastSignature.get(address) ?? null,
      ...columnsOf(account),
    };
    if (account.kind === "Organisation") {
      const slug = slugs.get(row.org_id as string);
      row.slug = slug?.slug ?? null;
      row.synthetic = slug?.synthetic ?? null;
    }
    if (account.kind === "Lot") {
      const previous = storedRow("Lot", address);
      const created = creatingOwner(address);
      const revision = eventRevision.get(address);
      row.event_revision =
        revision === undefined ? (previous?.event_revision as string) : toU64String(revision);
      if (created) {
        row.issued_owner = created.owner;
        row.issued_owner_org_id = resolver.organisationId(created.owner);
        row.issued_at = creationTime(address) as string;
      } else {
        row.issued_owner = previous?.issued_owner as string;
        row.issued_owner_org_id = previous?.issued_owner_org_id as string;
        row.issued_at = previous?.issued_at as string;
      }
    }
    upserts.push({ table, row });
  }

  const eventRows: Row[] = [];
  for (const plan of plans) {
    const { transaction, event } = plan;
    eventRows.push({
      network: stream.network,
      program_id: stream.programId,
      signature: transaction.signature,
      event_index: event.index,
      slot: transaction.slot,
      block_time: transaction.blockTime,
      protocol: stream.protocol,
      instruction: plan.invocation.instruction,
      event: event.name,
      scope: plan.scope,
      lot: plan.lot,
      lot_revision: plan.revision === null ? null : toU64String(plan.revision),
      org_id:
        plan.scope === "organisation" ? resolver.organisationId(eventOrganisation(plan)) : null,
      data: event.data,
    });
  }
  const counts = new Map<string, number>();
  for (const row of eventRows)
    counts.set(row.signature as string, (counts.get(row.signature as string) ?? 0) + 1);
  const transactionRows: Row[] = ordered.map((transaction) => ({
    network: stream.network,
    program_id: stream.programId,
    signature: transaction.signature,
    slot: transaction.slot,
    block_time: transaction.blockTime,
    succeeded: transaction.succeeded,
    protocol: transaction.decoded?.protocol ?? null,
    event_count: counts.get(transaction.signature) ?? 0,
    other_instance: transaction.decoded?.otherInstance ?? false,
  }));
  return { transactions: transactionRows, events: eventRows, upserts };
}
