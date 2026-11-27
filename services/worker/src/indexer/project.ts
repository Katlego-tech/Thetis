// Projection: from decoded accounts to read-model rows. Two callers use the row builders: the
// per-slot event projection below, and reconcile (which compares them with stored rows).

import type { Address } from "@solana/kit";
import {
  type Account,
  getAddressDecoder,
  isSolanaError,
  type MaybeEncodedAccount,
  type ReadonlyUint8Array,
  SOLANA_ERROR__CODECS__ENUM_DISCRIMINATOR_OUT_OF_RANGE,
  unwrapOption,
} from "@solana/kit";
import {
  type Authority,
  BatchStage,
  type ClassPolicy,
  type CustodianClass,
  type DocumentAttestation,
  DocumentKind,
  decodeAuthority,
  decodeClassPolicy,
  decodeCustodianClass,
  decodeDocumentAttestation,
  decodeFacility,
  decodeHandoffAcceptance,
  decodeHandoverRecord,
  decodeIncident,
  decodeIntakeIdentity,
  decodeLoadingIntent,
  decodeLoan,
  decodeLockAllocation,
  decodeLot,
  decodeManifestBatch,
  decodeOrganisation,
  decodePaymentAttestation,
  decodePoolShare,
  decodePosition,
  decodeProtocol,
  decodeReleaseIntent,
  decodeShipment,
  decodeSimulationPool,
  decodeValuation,
  type Facility,
  findPositionPda,
  type HandoffAcceptance,
  type HandoverRecord,
  HandoverStage,
  type Incident,
  IncidentStatus,
  type IntakeIdentity,
  IntentStatus,
  type LoadingIntent,
  LoadingStatus,
  type Loan,
  LoanStatus,
  type LockAllocation,
  LockControl,
  type Lot,
  LotState,
  type ManifestBatch,
  type Organisation,
  type PaymentAttestation,
  PaymentPurpose,
  PaymentStatus,
  type PoolShare,
  type Position,
  type Protocol,
  QuantityUnit,
  type ReleaseIntent,
  Restriction,
  Role,
  SettlementMode,
  type Shipment,
  ShipmentStatus,
  type SimulationPool,
  ThetisAccountError,
  toI64String,
  toU64String,
  type Valuation,
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
  | "Position"
  | "Facility"
  | "Valuation"
  | "Loan"
  | "LockAllocation"
  | "PaymentAttestation"
  | "ReleaseIntent"
  | "SimulationPool"
  | "PoolShare"
  | "Shipment"
  | "ManifestBatch"
  | "HandoverRecord"
  | "LoadingIntent"
  | "HandoffAcceptance"
  | "Incident";

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
  Facility: "chain_facilities",
  Valuation: "chain_valuations",
  Loan: "chain_loans",
  LockAllocation: "chain_locks",
  PaymentAttestation: "chain_payments",
  ReleaseIntent: "chain_release_intents",
  SimulationPool: "chain_pools",
  PoolShare: "chain_pool_shares",
  Shipment: "chain_shipments",
  ManifestBatch: "chain_batches",
  HandoverRecord: "chain_handovers",
  LoadingIntent: "chain_loading_intents",
  HandoffAcceptance: "chain_handoff_acceptances",
  Incident: "chain_incidents",
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
  | { kind: "Position"; data: Position }
  | { kind: "Facility"; data: Facility }
  | { kind: "Valuation"; data: Valuation }
  | { kind: "Loan"; data: Loan }
  | { kind: "LockAllocation"; data: LockAllocation }
  | { kind: "PaymentAttestation"; data: PaymentAttestation }
  | { kind: "ReleaseIntent"; data: ReleaseIntent }
  | { kind: "SimulationPool"; data: SimulationPool }
  | { kind: "PoolShare"; data: PoolShare }
  | { kind: "Shipment"; data: Shipment }
  | { kind: "ManifestBatch"; data: ManifestBatch }
  | { kind: "HandoverRecord"; data: HandoverRecord }
  | { kind: "LoadingIntent"; data: LoadingIntent }
  | { kind: "HandoffAcceptance"; data: HandoffAcceptance }
  | { kind: "Incident"; data: Incident };

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
  Facility: decodeFacility as unknown as GuardedDecoder,
  Valuation: decodeValuation as unknown as GuardedDecoder,
  Loan: decodeLoan as unknown as GuardedDecoder,
  LockAllocation: decodeLockAllocation as unknown as GuardedDecoder,
  PaymentAttestation: decodePaymentAttestation as unknown as GuardedDecoder,
  ReleaseIntent: decodeReleaseIntent as unknown as GuardedDecoder,
  SimulationPool: decodeSimulationPool as unknown as GuardedDecoder,
  PoolShare: decodePoolShare as unknown as GuardedDecoder,
  Shipment: decodeShipment as unknown as GuardedDecoder,
  ManifestBatch: decodeManifestBatch as unknown as GuardedDecoder,
  HandoverRecord: decodeHandoverRecord as unknown as GuardedDecoder,
  LoadingIntent: decodeLoadingIntent as unknown as GuardedDecoder,
  HandoffAcceptance: decodeHandoffAcceptance as unknown as GuardedDecoder,
  Incident: decodeIncident as unknown as GuardedDecoder,
};

export type DecodeFailure = { address: string; enumError: boolean; message: string };

/**
 * The guarded decode of one account as the expected kind. Never throws for a bad account: the
 * failure comes back so a caller can list every failing address. `protocol` is the instance the
 * account must belong to. The Protocol account and a PoolShare have no such field: a PoolShare
 * belongs to its pool's instance, which its row's dependencies check (live-lending.md §4.1.5).
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
    if (kind !== "Protocol" && kind !== "PoolShare" && data.protocol !== protocol) {
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

/** An account whose currency bytes are not three capital letters (live-lending.md §3.1). */
export class CurrencyError extends Error {
  constructor() {
    super("currency is not three capital letters");
    this.name = "CurrencyError";
  }
}

/**
 * What a row builder needs from other accounts: organisation ids, custodian classes, a
 * facility's lender and currency digits, a loan's facility, and whether a pool is the stream's.
 */
export interface Resolver {
  organisationId(address: string): string;
  custodianOf(classAddress: string): string;
  facility(address: string): { lender: string; currencyDecimals: number };
  loanFacility(address: string): string;
  /** Records that the pool must be the stream's; a pool that is not is a missing dependency. */
  pool(address: string): void;
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

const addressText = getAddressDecoder();
const hex = (bytes: ReadonlyUint8Array) => Buffer.from(bytes as Uint8Array).toString("hex");
const currencyText = (bytes: ReadonlyUint8Array) => {
  const values = [...(bytes as Uint8Array)];
  if (values.length !== 3 || values.some((byte) => byte < 0x41 || byte > 0x5a)) {
    throw new CurrencyError();
  }
  return String.fromCharCode(...values);
};
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
        // A Departure document's subject is its lot's address bytes (live-custody.md §3.1).
        subject_address:
          data.kind === DocumentKind.Departure ? addressText.decode(data.subject) : null,
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
    case "Facility": {
      const { data } = account;
      return {
        lender: data.lender,
        lender_org_id: resolver.organisationId(data.lender),
        borrower: data.borrower,
        borrower_org_id: resolver.organisationId(data.borrower),
        facility_id_hex: hex(data.facilityId),
        currency: currencyText(data.currency),
        currency_decimals: data.currencyDecimals,
        terms_version: data.termsVersion,
        rate_bps: data.rateBps,
        max_ltv_bps: data.maxLtvBps,
        terms_digest_hex: hex(data.termsDigest),
        loan_count: data.loanCount,
      };
    }
    case "Valuation": {
      const { data } = account;
      return {
        facility: data.facility,
        class_policy: data.classPolicy,
        grade: data.grade,
        custodian_class: data.custodianClass,
        value_per_kg: toU64String(data.valuePerKg),
        haircut_bps: data.haircutBps,
        valid_until: toI64String(data.validUntil),
        source_digest_hex: hex(data.sourceDigest),
        version: data.version,
        set_at: toI64String(data.setAt),
      };
    }
    case "Loan": {
      const { data } = account;
      return {
        facility: data.facility,
        lender_org_id: resolver.organisationId(resolver.facility(data.facility).lender),
        borrower: data.borrower,
        borrower_org_id: resolver.organisationId(data.borrower),
        lot: data.lot,
        position: data.position,
        loan_index: data.index,
        status: variant("LoanStatus", LoanStatus, data.status),
        rate_bps: data.rateBps,
        terms_version: data.termsVersion,
        principal: toU64String(data.principal),
        booked_interest: toU64String(data.bookedInterest),
        accrual_remainder: toU64String(data.accrualRemainder),
        accrued_at: toI64String(data.accruedAt),
        open_exceptions: data.openExceptions,
        revision: toU64String(data.revision),
      };
    }
    case "LockAllocation": {
      const { data } = account;
      return {
        loan: data.loan,
        position: data.position,
        quantity_kg: toU64String(data.quantityKg),
        control: variant("LockControl", LockControl, data.control),
      };
    }
    case "PaymentAttestation": {
      const { data } = account;
      return {
        lender: data.lender,
        lender_org_id: resolver.organisationId(data.lender),
        loan: data.loan,
        payment_id_hex: hex(data.paymentId),
        purpose: variant("PaymentPurpose", PaymentPurpose, data.purpose),
        subject: data.subject,
        amount: toU64String(data.amount),
        currency: currencyText(data.currency),
        evidence_digest_hex: hex(data.evidenceDigest),
        observed_at: toI64String(data.observedAt),
        status: variant("PaymentStatus", PaymentStatus, data.status),
        applied: toU64String(data.applied),
        surplus: toU64String(data.surplus),
      };
    }
    case "ReleaseIntent": {
      const { data } = account;
      const facility = resolver.facility(resolver.loanFacility(data.loan));
      return {
        loan: data.loan,
        lot: data.lot,
        position: data.position,
        seller: data.seller,
        seller_org_id: resolver.organisationId(data.seller),
        buyer: data.buyer,
        buyer_org_id: resolver.organisationId(data.buyer),
        lender: facility.lender,
        lender_org_id: resolver.organisationId(facility.lender),
        currency_decimals: facility.currencyDecimals,
        nonce: toU64String(data.nonce),
        quantity_kg: toU64String(data.quantityKg),
        price: toU64String(data.price),
        top_up: toU64String(data.topUp),
        currency: currencyText(data.currency),
        expires_at: toI64String(data.expiresAt),
        position_revision: toU64String(data.positionRevision),
        status: variant("IntentStatus", IntentStatus, data.status),
      };
    }
    case "SimulationPool": {
      const { data } = account;
      return {
        mint: data.mint,
        vault: data.vault,
        currency: currencyText(data.currency),
        currency_decimals: data.currencyDecimals,
        cash_minor: toU64String(data.cashMinor),
        total_shares: toU64String(data.totalShares),
        lent_minor: toU64String(data.lentMinor),
        income_minor: toU64String(data.incomeMinor),
        revision: toU64String(data.revision),
      };
    }
    case "PoolShare": {
      const { data } = account;
      resolver.pool(data.pool);
      return {
        pool: data.pool,
        organisation: data.organisation,
        org_id: resolver.organisationId(data.organisation),
        shares: toU64String(data.shares),
        lent_minor: toU64String(data.lentMinor),
      };
    }
    case "Shipment": {
      const { data } = account;
      return {
        shipment_id_hex: hex(data.shipmentId),
        lot: data.lot,
        position: data.position,
        owner: data.owner,
        owner_org_id: resolver.organisationId(data.owner),
        source: data.source,
        source_custodian: data.sourceCustodian,
        source_custodian_org_id: resolver.organisationId(data.sourceCustodian),
        destination: data.destination,
        destination_custodian: data.destinationCustodian,
        destination_custodian_org_id: resolver.organisationId(data.destinationCustodian),
        committed_kg: toU64String(data.committedKg),
        locked_kg: toU64String(data.lockedKg),
        batch_count: data.batchCount,
        manifest_root_hex: hex(data.manifestRoot),
        departure_document: data.departureDocument,
        registered_count: data.registeredCount,
        registered_kg: toU64String(data.registeredKg),
        departed_count: data.departedCount,
        departed_kg: toU64String(data.departedKg),
        arrived_count: data.arrivedCount,
        arrived_kg: toU64String(data.arrivedKg),
        status: variant("ShipmentStatus", ShipmentStatus, data.status),
        prepared_at: toI64String(data.preparedAt),
        revision: toU64String(data.revision),
      };
    }
    case "ManifestBatch": {
      const { data } = account;
      return {
        shipment: data.shipment,
        lot: data.lot,
        batch_index: data.index,
        batch_count: data.batchCount,
        quantity_kg: toU64String(data.quantityKg),
        carrier: data.carrier,
        load_digest_hex: hex(data.loadDigest),
        manifest_digest_hex: hex(data.manifestDigest),
        holder: data.holder,
        holder_org_id: resolver.organisationId(data.holder),
        stage: variant("BatchStage", BatchStage, data.stage),
        sequence: toU64String(data.sequence),
        observation_count: data.observationCount,
        departed_at: optionalI64(data.departedAt),
        arrived_at: optionalI64(data.arrivedAt),
      };
    }
    case "HandoverRecord": {
      const { data } = account;
      return {
        shipment: data.shipment,
        batch: data.batch,
        sequence: toU64String(data.sequence),
        from_organisation: data.from,
        from_org_id: resolver.organisationId(data.from),
        to_organisation: data.to,
        to_org_id: resolver.organisationId(data.to),
        from_wallet: data.fromWallet,
        to_wallet: data.toWallet,
        stage: variant("HandoverStage", HandoverStage, data.stage),
        quantity_kg: toU64String(data.quantityKg),
        manifest_digest_hex: hex(data.manifestDigest),
        at: toI64String(data.at),
      };
    }
    case "LoadingIntent": {
      const { data } = account;
      return {
        lot: data.lot,
        position: data.position,
        owner: data.owner,
        owner_org_id: resolver.organisationId(data.owner),
        terminal: data.terminal,
        terminal_org_id: resolver.organisationId(data.terminal),
        custodian_class: data.custodianClass,
        nonce: toU64String(data.nonce),
        quantity_kg: toU64String(data.quantityKg),
        locked_kg: toU64String(data.lockedKg),
        document_sha256_hex: hex(data.documentSha256),
        position_revision: toU64String(data.positionRevision),
        expires_at: toI64String(data.expiresAt),
        status: variant("LoadingStatus", LoadingStatus, data.status),
        executed_at: optionalI64(data.executedAt),
      };
    }
    case "HandoffAcceptance": {
      const { data } = account;
      return {
        intent: data.intent,
        loan: data.loan,
        lock: data.lock,
        lender: data.lender,
        lender_org_id: resolver.organisationId(data.lender),
        lock_quantity_kg: toU64String(data.lockQuantityKg),
        loan_revision: toU64String(data.loanRevision),
        principal: toU64String(data.principal),
        booked_interest: toU64String(data.bookedInterest),
        accepted_at: toI64String(data.acceptedAt),
        version: data.version,
      };
    }
    case "Incident": {
      const { data } = account;
      return {
        incident_id_hex: hex(data.incidentId),
        lot: data.lot,
        batch: unwrapOption(data.batch) ?? null,
        inspector: data.inspector,
        inspector_org_id: resolver.organisationId(data.inspector),
        method_code: data.methodCode,
        expected_kg: toU64String(data.expectedKg),
        observed_kg: toU64String(data.observedKg),
        tolerance_bps: data.toleranceBps,
        within_tolerance: data.withinTolerance,
        evidence_digest_hex: hex(data.evidenceDigest),
        observed_at: toI64String(data.observedAt),
        restriction_after: variant("Restriction", Restriction, data.restrictionAfter),
        status: variant("IncidentStatus", IncidentStatus, data.status),
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

/** The Phase 2 keys of an event row (live-lending.md §4.1.3); null where the event has none. */
type LendingKeys = {
  facility: string | null;
  loan: string | null;
  loanRevision: bigint | null;
  pool: string | null;
  poolRevision: bigint | null;
  valuation: string | null;
  valuationVersion: number | null;
  created: string | null;
  /** The Phase 3 keys (live-custody.md §4.1.3). */
  shipment: string | null;
  shipmentRevision: bigint | null;
  batch: string | null;
  batchSequence: bigint | null;
  observationIndex: number | null;
  acceptance: string | null;
  acceptanceVersion: number | null;
};

const NO_KEYS: LendingKeys = {
  facility: null,
  loan: null,
  loanRevision: null,
  pool: null,
  poolRevision: null,
  valuation: null,
  valuationVersion: null,
  created: null,
  shipment: null,
  shipmentRevision: null,
  batch: null,
  batchSequence: null,
  observationIndex: null,
  acceptance: null,
  acceptanceVersion: null,
};

type Plan = {
  transaction: SlotTransaction;
  invocation: Invocation;
  event: DecodedEvent;
  scope:
    | "registry"
    | "organisation"
    | "lot"
    | "facility"
    | "pool"
    | "shipment"
    | "loading"
    | "incident";
  lot: string | null;
  revision: bigint | null;
  keys: LendingKeys;
  /** A voided PaymentCorrected: it names its loan's revision without advancing it. */
  voided: boolean;
  fetch: Planned[];
  creates: Planned[];
  /** Created when absent (init_if_needed): a transfer's or sale's recipient, a deposit's share. */
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
    keys: NO_KEYS,
    voided: false,
    fetch: [] as Planned[],
    creates: [] as Planned[],
    mayCreate: [] as Planned[],
  };
  const facilityKeys = (keys: Partial<LendingKeys>): LendingKeys => ({
    ...NO_KEYS,
    facility: accounts.facility ?? null,
    ...keys,
  });
  // A required account of the instruction: the parse names every one.
  const ixAccount = (name: string) => accounts[name] as string;
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
    case "FacilityOpened": {
      const planned = { address: text("facility"), kind: "Facility" as const };
      return {
        ...base,
        scope: "facility",
        keys: facilityKeys({ created: planned.address }),
        fetch: [planned],
        creates: [planned],
      };
    }
    case "ValuationSet": {
      const planned = { address: text("valuation"), kind: "Valuation" as const };
      const version = value.version as number;
      return {
        ...base,
        scope: "facility",
        keys: facilityKeys({ valuation: planned.address, valuationVersion: version }),
        fetch: [planned],
        creates: version === 1 ? [planned] : [],
      };
    }
    case "Pledged": {
      const loan = { address: text("loan"), kind: "Loan" as const };
      const lock = { address: text("lock"), kind: "LockAllocation" as const };
      return {
        ...base,
        scope: "facility",
        keys: facilityKeys({ loan: loan.address, loanRevision: value.revision as bigint }),
        fetch: [
          loan,
          lock,
          { address: text("position"), kind: "Position" },
          { address: ixAccount("facility"), kind: "Facility" },
        ],
        creates: [loan, lock],
      };
    }
    case "AdvanceRecorded":
      return {
        ...base,
        scope: "facility",
        keys: facilityKeys({ loan: text("loan"), loanRevision: value.revision as bigint }),
        fetch: [{ address: text("loan"), kind: "Loan" }],
      };
    case "PaymentConfirmed": {
      const planned = { address: text("payment"), kind: "PaymentAttestation" as const };
      return {
        ...base,
        scope: "facility",
        keys: facilityKeys({ loan: text("loan"), created: planned.address }),
        fetch: [planned],
        creates: [planned],
      };
    }
    case "PaymentCorrected": {
      const planned = { address: text("payment"), kind: "PaymentAttestation" as const };
      const voided = value.voided as boolean;
      return {
        ...base,
        scope: "facility",
        voided,
        keys: facilityKeys({
          loan: text("loan"),
          loanRevision: voided ? null : (value.loanRevision as bigint),
          created: planned.address,
        }),
        fetch: [
          planned,
          { address: text("target"), kind: "PaymentAttestation" },
          { address: text("loan"), kind: "Loan" },
        ],
        creates: [planned],
      };
    }
    case "Repaid": {
      const payment = value.payment as string | undefined;
      const pool = value.pool as string | undefined;
      const share = invocation.remaining[0];
      return {
        ...base,
        scope: "facility",
        keys: facilityKeys({
          loan: text("loan"),
          loanRevision: value.revision as bigint,
          ...(pool === undefined ? {} : { pool, poolRevision: value.poolRevision as bigint }),
        }),
        fetch: [
          { address: text("loan"), kind: "Loan" },
          ...optional("PaymentAttestation", payment),
          ...(pool === undefined
            ? []
            : [
                { address: pool, kind: "SimulationPool" as const },
                ...optional("PoolShare", share),
              ]),
        ],
      };
    }
    case "ReleaseIntentCreated": {
      const planned = { address: text("intent"), kind: "ReleaseIntent" as const };
      return {
        ...base,
        scope: "facility",
        keys: facilityKeys({ loan: text("loan"), created: planned.address }),
        fetch: [planned],
        creates: [planned],
      };
    }
    case "PledgedSold": {
      const lot = text("lot");
      const buyer = { address: text("buyerPosition"), kind: "Position" as const };
      return {
        ...base,
        scope: "lot",
        lot,
        revision: value.lotRevision as bigint,
        keys: { ...NO_KEYS, loan: text("loan"), loanRevision: value.revision as bigint },
        fetch: [
          { address: lot, kind: "Lot" },
          { address: text("loan"), kind: "Loan" },
          { address: ixAccount("lock"), kind: "LockAllocation" },
          { address: text("intent"), kind: "ReleaseIntent" },
          { address: text("payment"), kind: "PaymentAttestation" },
          { address: text("sellerPosition"), kind: "Position" },
          buyer,
        ],
        mayCreate: [buyer],
      };
    }
    case "Liquidated":
      return {
        ...base,
        scope: "facility",
        keys: facilityKeys({ loan: text("loan"), loanRevision: value.revision as bigint }),
        fetch: [
          { address: text("loan"), kind: "Loan" },
          { address: text("lock"), kind: "LockAllocation" },
        ],
      };
    case "LoanClosed":
      return {
        ...base,
        scope: "facility",
        keys: facilityKeys({ loan: text("loan"), loanRevision: value.revision as bigint }),
        fetch: [
          { address: text("loan"), kind: "Loan" },
          { address: ixAccount("lock"), kind: "LockAllocation" },
          { address: text("position"), kind: "Position" },
        ],
      };
    case "PoolOpened": {
      const planned = { address: text("pool"), kind: "SimulationPool" as const };
      return {
        ...base,
        scope: "pool",
        keys: { ...NO_KEYS, pool: planned.address, created: planned.address },
        fetch: [planned],
        creates: [planned],
      };
    }
    case "Deposited": {
      const share = { address: ixAccount("share"), kind: "PoolShare" as const };
      return {
        ...base,
        scope: "pool",
        keys: { ...NO_KEYS, pool: text("pool"), poolRevision: value.poolRevision as bigint },
        fetch: [{ address: text("pool"), kind: "SimulationPool" }, share],
        mayCreate: [share],
      };
    }
    case "Withdrawn":
      return {
        ...base,
        scope: "pool",
        keys: { ...NO_KEYS, pool: text("pool"), poolRevision: value.poolRevision as bigint },
        fetch: [
          { address: text("pool"), kind: "SimulationPool" },
          { address: ixAccount("share"), kind: "PoolShare" },
        ],
      };
    case "Borrowed":
      return {
        ...base,
        scope: "facility",
        keys: facilityKeys({
          loan: text("loan"),
          loanRevision: value.revision as bigint,
          pool: text("pool"),
          poolRevision: value.poolRevision as bigint,
        }),
        fetch: [
          { address: text("loan"), kind: "Loan" },
          { address: text("pool"), kind: "SimulationPool" },
          { address: ixAccount("lenderShare"), kind: "PoolShare" },
        ],
      };
    case "ShipmentPrepared": {
      const shipment = { address: text("shipment"), kind: "Shipment" as const };
      const lot = text("lot");
      return {
        ...base,
        scope: "lot",
        lot,
        revision: value.lotRevision as bigint,
        // The created Shipment's own revision is 0 (live-custody.md §4.1.3).
        keys: {
          ...NO_KEYS,
          shipment: shipment.address,
          shipmentRevision: 0n,
          created: shipment.address,
        },
        fetch: [
          shipment,
          { address: lot, kind: "Lot" },
          { address: ixAccount("position"), kind: "Position" },
          { address: ixAccount("destinationClass"), kind: "CustodianClass" },
        ],
        creates: [shipment],
      };
    }
    case "BatchRegistered": {
      const batch = { address: text("batch"), kind: "ManifestBatch" as const };
      return {
        ...base,
        scope: "shipment",
        keys: {
          ...NO_KEYS,
          shipment: text("shipment"),
          batch: batch.address,
          created: batch.address,
        },
        fetch: [batch, { address: text("shipment"), kind: "Shipment" }],
        creates: [batch],
      };
    }
    case "ShipmentCancelled": {
      const lot = text("lot");
      return {
        ...base,
        scope: "lot",
        lot,
        revision: value.lotRevision as bigint,
        keys: {
          ...NO_KEYS,
          shipment: text("shipment"),
          shipmentRevision: value.revision as bigint,
        },
        fetch: [
          { address: text("shipment"), kind: "Shipment" },
          { address: lot, kind: "Lot" },
          { address: ixAccount("destinationClass"), kind: "CustodianClass" },
        ],
      };
    }
    case "CustodyHandedOver": {
      // A handover advances the lot exactly at the shipment's first departure and its last
      // arrival (live-custody.md §4.1.4); any other is shipment-scoped and repeats the lot revision.
      const record = { address: text("handover"), kind: "HandoverRecord" as const };
      const lot = text("lot");
      const advancing = advancesLot(value);
      const keys: LendingKeys = {
        ...NO_KEYS,
        shipment: text("shipment"),
        shipmentRevision: value.shipmentRevision as bigint,
        batch: text("batch"),
        batchSequence: value.sequence as bigint,
        created: record.address,
      };
      return {
        ...base,
        scope: advancing ? "lot" : "shipment",
        lot: advancing ? lot : null,
        revision: advancing ? (value.lotRevision as bigint) : null,
        keys,
        fetch: [
          record,
          { address: text("batch"), kind: "ManifestBatch" },
          { address: text("shipment"), kind: "Shipment" },
          { address: lot, kind: "Lot" },
          { address: ixAccount("sourceClass"), kind: "CustodianClass" },
          { address: ixAccount("destinationClass"), kind: "CustodianClass" },
        ],
        creates: [record],
      };
    }
    case "ObservationRecorded":
      // An observation moves only the batch's observation_count; it is keyed by the batch and its
      // index, never by observed_at (live-custody.md §4.1.3, §4.1.4).
      return {
        ...base,
        scope: "shipment",
        keys: {
          ...NO_KEYS,
          shipment: text("shipment"),
          batch: text("batch"),
          observationIndex: value.index as number,
        },
        fetch: [{ address: text("batch"), kind: "ManifestBatch" }],
      };
    case "LoadingIntentCreated": {
      const planned = { address: text("intent"), kind: "LoadingIntent" as const };
      return {
        ...base,
        scope: "loading",
        keys: { ...NO_KEYS, created: planned.address },
        fetch: [planned, { address: ixAccount("position"), kind: "Position" }],
        creates: [planned],
      };
    }
    case "LoadingAccepted": {
      // As a valuation: version 1 creates the acceptance, a later version updates it
      // (live-custody.md §4.1.4); the loan is named without a revision.
      const planned = { address: text("acceptance"), kind: "HandoffAcceptance" as const };
      const version = value.version as number;
      return {
        ...base,
        scope: "facility",
        keys: facilityKeys({
          loan: text("loan"),
          acceptance: planned.address,
          acceptanceVersion: version,
        }),
        fetch: [planned],
        creates: version === 1 ? [planned] : [],
      };
    }
    case "LoadingRecorded": {
      // Keyed by the lot revision it raises (live-custody.md §8 decision 7); the loans are read
      // only through their LoanHandedOff.
      const lot = text("lot");
      return {
        ...base,
        scope: "lot",
        lot,
        revision: value.lotRevision as bigint,
        fetch: [
          { address: lot, kind: "Lot" },
          { address: ixAccount("position"), kind: "Position" },
          { address: text("intent"), kind: "LoadingIntent" },
          { address: ixAccount("custodianClass"), kind: "CustodianClass" },
          { address: ixAccount("intake"), kind: "IntakeIdentity" },
          ...optional("Lot", accounts.root),
        ],
      };
    }
    case "LoanHandedOff": {
      // The i-th hand-off is the invocation's event i + 1; its lock is remaining[3i + 2]. Its
      // facility is the loan's, set when the rows are built (live-custody.md §4.1.5).
      const triple = invocation.events.indexOf(event) - 1;
      return {
        ...base,
        scope: "facility",
        keys: { ...NO_KEYS, loan: text("loan"), loanRevision: value.revision as bigint },
        fetch: [
          { address: text("loan"), kind: "Loan" },
          { address: invocation.remaining[3 * triple + 2] as string, kind: "LockAllocation" },
        ],
      };
    }
    case "ShortfallAttested": {
      // Keyed by the incident only: its lot revision may repeat or advance (live-custody.md §4.1.3,
      // §4.1.4); the lot check reads it from the event's own fields.
      const planned = { address: text("incident"), kind: "Incident" as const };
      const batch = value.batch as string | undefined;
      return {
        ...base,
        scope: "incident",
        keys: { ...NO_KEYS, created: planned.address, batch: batch ?? null },
        fetch: [planned, { address: text("lot"), kind: "Lot" }],
        creates: [planned],
      };
    }
    case "RestrictionSet": {
      const lot = text("lot");
      return {
        ...base,
        scope: "lot",
        lot,
        revision: value.revision as bigint,
        fetch: [{ address: lot, kind: "Lot" }],
      };
    }
  }
}

/**
 * How a ShortfallAttested names its lot's revision (live-custody.md §4.1.4): outside tolerance and
 * ReviewRequired it is a candidate (it advanced a Normal lot or repeated a ReviewRequired one, and
 * the event alone can't tell); otherwise it repeats the lot's revision.
 */
function isShortfallCandidate(value: Record<string, unknown>): boolean {
  return value.withinTolerance === false && value.restriction === Restriction.ReviewRequired;
}

/**
 * Whether a CustodyHandedOver advanced its lot's revision: the shipment's first handover (its
 * first departure) or the arrival that made it Arrived (decode.ts checks the two agree with the
 * stage and the lot state).
 */
function advancesLot(value: Record<string, unknown>): boolean {
  return value.shipmentRevision === 1n || value.shipmentStatus === ShipmentStatus.Arrived;
}

type LotEntry = {
  creators: Plan[];
  revisions: { revision: bigint; plan: Plan }[];
  /** Events that name the lot's revision without advancing it (live-custody.md §4.1.4 repeats). */
  repeats: { revision: bigint; plan: Plan }[];
  /** Shortfalls that advanced the lot or repeated it, resolved by the slot's revisions (§4.1.4). */
  candidates: { revision: bigint; plan: Plan }[];
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
      entry = { creators: [], revisions: [], repeats: [], candidates: [] };
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
      case "PledgedSold":
      case "ShipmentPrepared":
      case "ShipmentCancelled":
      case "LoadingRecorded":
        entryOf(value.lot as string).revisions.push({
          revision: value.lotRevision as bigint,
          plan,
        });
        break;
      case "RestrictionSet":
        entryOf(value.lot as string).revisions.push({ revision: value.revision as bigint, plan });
        break;
      case "ShortfallAttested": {
        const item = { revision: value.lotRevision as bigint, plan };
        if (isShortfallCandidate(value)) entryOf(value.lot as string).candidates.push(item);
        else entryOf(value.lot as string).repeats.push(item);
        break;
      }
      case "CustodyHandedOver": {
        const item = { revision: value.lotRevision as bigint, plan };
        if (plan.scope === "lot") entryOf(value.lot as string).revisions.push(item);
        else entryOf(value.lot as string).repeats.push(item);
        break;
      }
      default:
        break;
    }
  }
  const eventRevision = new Map<string, bigint>();
  for (const lot of [...lots.keys()].sort(sortText)) {
    const entry = lots.get(lot) as LotEntry;
    const signatures = [
      ...new Set(
        [
          ...entry.creators,
          ...entry.revisions.map((item) => item.plan),
          ...entry.repeats.map((item) => item.plan),
          ...entry.candidates.map((item) => item.plan),
        ].map((p) => p.transaction.signature),
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
    // D: the keyed revisions, distinct; U: D and every candidate above the base. U, sorted, must be
    // exactly base + 1 … base + |U|, and every candidate and repeat must lie between the floor and
    // the lot's new event_revision (live-custody.md §4.1.4).
    const floor = base < 0n ? 0n : base;
    const keyed = entry.revisions.map((item) => item.revision).sort(sortBig);
    for (const [index, revision] of keyed.entries()) {
      if (index > 0 && revision === keyed[index - 1]) {
        throw stepHalt(
          "sequence",
          "REVISION_SEQUENCE",
          `${named} carries revision ${revision} twice: [${keyed.join(", ")}]`,
        );
      }
    }
    for (const { revision } of entry.candidates) {
      if (revision < floor) {
        throw stepHalt(
          "sequence",
          "REVISION_SEQUENCE",
          `${named}: a shortfall names revision ${revision}, below ${floor}`,
        );
      }
    }
    const revisions = [
      ...new Set([
        ...keyed,
        ...entry.candidates.map((item) => item.revision).filter((revision) => revision > base),
      ]),
    ].sort(sortBig);
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
    const next = revisions.at(-1) ?? base;
    for (const { revision, plan } of [...entry.repeats, ...entry.candidates]) {
      if (revision < floor || revision > next) {
        const what = plan.event.name === "ShortfallAttested" ? "a shortfall" : "a handover";
        throw stepHalt(
          "sequence",
          "REVISION_SEQUENCE",
          `${named}: ${what} repeats revision ${revision}, outside ${floor} to ${next}`,
        );
      }
    }
    eventRevision.set(lot, next);
  }

  // Loans, pools and valuations (live-lending.md §4.1.4).
  const signaturesOf = (list: Plan[]) =>
    [...new Set(list.map((plan) => plan.transaction.signature))].sort(sortText).join(", ");
  const inSequence = (named: string, base: bigint, revisions: bigint[]) => {
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
  };
  const loanEventRevision = new Map<string, bigint>();
  const loanNames = [
    ...new Set(
      plans
        .filter(
          (plan) => plan.keys.loan !== null && (plan.keys.loanRevision !== null || plan.voided),
        )
        .map((plan) => plan.keys.loan as string),
    ),
  ].sort(sortText);
  for (const loan of loanNames) {
    const naming = plans.filter((plan) => plan.keys.loan === loan);
    const advancing = naming.filter((plan) => plan.keys.loanRevision !== null);
    const voided = naming.filter((plan) => plan.voided);
    const pledges = naming.filter((plan) => plan.event.name === "Pledged");
    const named = `loan ${loan} (signatures ${signaturesOf([...advancing, ...voided])})`;
    const row = storedRow("Loan", loan);
    let base: bigint;
    if (pledges.length > 0) {
      if (pledges.length > 1) {
        throw stepHalt(
          "sequence",
          "REVISION_SEQUENCE",
          `${named} is pledged by ${pledges.length} events of one slot`,
        );
      }
      if (row) {
        throw stepHalt(
          "sequence",
          "REVISION_SEQUENCE",
          `${named} is pledged again while it is stored`,
        );
      }
      base = -1n;
    } else {
      if (!row) {
        throw stepHalt(
          "sequence",
          "EVENT_GAP",
          `${named} has no stored row and no Pledged of this slot creates it`,
        );
      }
      base = BigInt(row.event_revision as string);
    }
    const revisions = advancing.map((plan) => plan.keys.loanRevision as bigint).sort(sortBig);
    inSequence(named, base, revisions);
    const next = revisions.at(-1) ?? base;
    const floor = base < 0n ? 0n : base;
    for (const plan of voided) {
      const repeated = (plan.event.value as Record<string, unknown>).loanRevision as bigint;
      const fits =
        revisions.length === 0 ? repeated === base : repeated >= floor && repeated <= next;
      if (!fits) {
        throw stepHalt(
          "sequence",
          "REVISION_SEQUENCE",
          `${named}: a voided correction repeats revision ${repeated}, outside ${floor} to ${next}`,
        );
      }
    }
    loanEventRevision.set(loan, next);
  }

  const poolEventRevision = new Map<string, bigint>();
  const poolNames = [
    ...new Set(
      plans
        .filter(
          (plan) =>
            plan.keys.pool !== null &&
            (plan.keys.poolRevision !== null || plan.event.name === "PoolOpened"),
        )
        .map((plan) => plan.keys.pool as string),
    ),
  ].sort(sortText);
  for (const pool of poolNames) {
    const naming = plans.filter((plan) => plan.keys.pool === pool);
    const opened = naming.filter((plan) => plan.event.name === "PoolOpened");
    const advancing = naming.filter((plan) => plan.keys.poolRevision !== null);
    const named = `pool ${pool} (signatures ${signaturesOf([...opened, ...advancing])})`;
    const row = storedRow("SimulationPool", pool);
    let base: bigint;
    if (opened.length > 0) {
      if (opened.length > 1 || row) {
        throw stepHalt(
          "sequence",
          "REVISION_SEQUENCE",
          row ? `${named} is opened again while it is stored` : `${named} is opened twice`,
        );
      }
      base = 0n;
    } else {
      if (!row) {
        throw stepHalt(
          "sequence",
          "EVENT_GAP",
          `${named} has no stored row and no PoolOpened of this slot creates it`,
        );
      }
      base = BigInt(row.event_revision as string);
    }
    const revisions = advancing.map((plan) => plan.keys.poolRevision as bigint).sort(sortBig);
    inSequence(named, base, revisions);
    poolEventRevision.set(pool, revisions.at(-1) ?? base);
  }

  const valuationEventVersion = new Map<string, number>();
  const valuationNames = [
    ...new Set(
      plans
        .filter((plan) => plan.keys.valuation !== null)
        .map((plan) => plan.keys.valuation as string),
    ),
  ].sort(sortText);
  for (const valuation of valuationNames) {
    const naming = plans.filter((plan) => plan.keys.valuation === valuation);
    const versions = naming
      .map((plan) => BigInt(plan.keys.valuationVersion as number))
      .sort(sortBig);
    const named = `valuation ${valuation} (signatures ${signaturesOf(naming)})`;
    const row = storedRow("Valuation", valuation);
    if (!row && (versions[0] as bigint) > 1n) {
      throw stepHalt(
        "sequence",
        "EVENT_GAP",
        `${named} has no stored row and its lowest version is ${versions[0]}`,
      );
    }
    if (row && versions.includes(1n)) {
      throw stepHalt(
        "sequence",
        "REVISION_SEQUENCE",
        `${named} is set at version 1 again while it is stored`,
      );
    }
    const base = row ? BigInt(row.event_version as number) : 0n;
    inSequence(named, base, versions);
    valuationEventVersion.set(valuation, Number(versions.at(-1) as bigint));
  }

  // Shipments and registrations (live-custody.md §4.1.4).
  const preparedIn = (shipment: string) =>
    plans.filter(
      (plan) => plan.event.name === "ShipmentPrepared" && plan.keys.shipment === shipment,
    );
  const shipmentEventRevision = new Map<string, bigint>();
  const shipmentNames = [
    ...new Set(
      plans
        .filter((plan) => plan.keys.shipmentRevision !== null)
        .map((plan) => plan.keys.shipment as string),
    ),
  ].sort(sortText);
  for (const shipment of shipmentNames) {
    const advancing = plans.filter(
      (plan) => plan.keys.shipment === shipment && plan.keys.shipmentRevision !== null,
    );
    const prepared = preparedIn(shipment);
    const named = `shipment ${shipment} (signatures ${signaturesOf(advancing)})`;
    const row = storedRow("Shipment", shipment);
    let base: bigint;
    if (prepared.length > 0) {
      if (prepared.length > 1) {
        throw stepHalt(
          "sequence",
          "REVISION_SEQUENCE",
          `${named} is prepared by ${prepared.length} events of one slot`,
        );
      }
      if (row) {
        throw stepHalt(
          "sequence",
          "REVISION_SEQUENCE",
          `${named} is prepared again while it is stored`,
        );
      }
      base = -1n;
    } else {
      if (!row) {
        throw stepHalt(
          "sequence",
          "EVENT_GAP",
          `${named} has no stored row and no ShipmentPrepared of this slot creates it`,
        );
      }
      base = BigInt(row.event_revision as string);
    }
    const revisions = advancing.map((plan) => plan.keys.shipmentRevision as bigint).sort(sortBig);
    inSequence(named, base, revisions);
    shipmentEventRevision.set(shipment, revisions.at(-1) ?? base);
  }

  const shipmentEventRegistered = new Map<string, number>();
  const registeredNames = [
    ...new Set(
      plans
        .filter((plan) => plan.event.name === "BatchRegistered")
        .map((plan) => plan.keys.shipment as string),
    ),
  ].sort(sortText);
  for (const shipment of registeredNames) {
    const naming = plans.filter(
      (plan) => plan.event.name === "BatchRegistered" && plan.keys.shipment === shipment,
    );
    const named = `shipment ${shipment} (signatures ${signaturesOf(naming)})`;
    const row = storedRow("Shipment", shipment);
    let base: bigint;
    if (preparedIn(shipment).length > 0) base = 0n;
    else if (row) base = BigInt(row.event_registered as number);
    else {
      throw stepHalt(
        "sequence",
        "EVENT_GAP",
        `${named} registers a batch but has no stored row and no ShipmentPrepared of this slot`,
      );
    }
    const counts = naming
      .map((plan) =>
        BigInt((plan.event.value as Record<string, unknown>).registeredCount as number),
      )
      .sort(sortBig);
    for (const [index, count] of counts.entries()) {
      const expected = base + 1n + BigInt(index);
      if (count !== expected) {
        throw stepHalt(
          "sequence",
          "REVISION_SEQUENCE",
          `${named} carries registration counts [${counts.join(", ")}] after ${base}, expected ${expected} at position ${index}`,
        );
      }
    }
    shipmentEventRegistered.set(shipment, Number(counts.at(-1) ?? base));
  }

  // Batch sequences (live-custody.md §4.1.4): each handover consumes the batch's next sequence.
  const batchEventSequence = new Map<string, bigint>();
  const handedBatches = [
    ...new Set(
      plans
        .filter((plan) => plan.event.name === "CustodyHandedOver")
        .map((plan) => plan.keys.batch as string),
    ),
  ].sort(sortText);
  for (const batch of handedBatches) {
    const naming = plans.filter(
      (plan) => plan.event.name === "CustodyHandedOver" && plan.keys.batch === batch,
    );
    const named = `batch ${batch} (signatures ${signaturesOf(naming)})`;
    const registered = plans.some(
      (plan) => plan.event.name === "BatchRegistered" && plan.keys.batch === batch,
    );
    const row = storedRow("ManifestBatch", batch);
    let base: bigint;
    if (registered) base = 0n;
    else if (row) base = BigInt(row.event_sequence as string);
    else {
      throw stepHalt(
        "sequence",
        "EVENT_GAP",
        `${named} is handed over but has no stored row and no BatchRegistered of this slot`,
      );
    }
    const sequences = naming.map((plan) => plan.keys.batchSequence as bigint).sort(sortBig);
    for (const [index, sequence] of sequences.entries()) {
      const expected = base + BigInt(index);
      if (sequence !== expected) {
        throw stepHalt(
          "sequence",
          "REVISION_SEQUENCE",
          `${named} consumes handover sequences [${sequences.join(", ")}] from ${base}, expected ${expected} at position ${index}`,
        );
      }
    }
    batchEventSequence.set(batch, base + BigInt(sequences.length));
  }

  // Observations (live-custody.md §4.1.4): each observation takes the batch's next index.
  const batchEventObservations = new Map<string, number>();
  const observedBatches = [
    ...new Set(
      plans
        .filter((plan) => plan.event.name === "ObservationRecorded")
        .map((plan) => plan.keys.batch as string),
    ),
  ].sort(sortText);
  for (const batch of observedBatches) {
    const naming = plans.filter(
      (plan) => plan.event.name === "ObservationRecorded" && plan.keys.batch === batch,
    );
    const named = `batch ${batch} (signatures ${signaturesOf(naming)})`;
    const registered = plans.some(
      (plan) => plan.event.name === "BatchRegistered" && plan.keys.batch === batch,
    );
    const row = storedRow("ManifestBatch", batch);
    let base: number;
    if (registered) base = 0;
    else if (row) base = row.event_observations as number;
    else {
      throw stepHalt(
        "sequence",
        "EVENT_GAP",
        `${named} is observed but has no stored row and no BatchRegistered of this slot`,
      );
    }
    const indexes = naming
      .map((plan) => plan.keys.observationIndex as number)
      .sort((a, b) => a - b);
    for (const [position, index] of indexes.entries()) {
      const expected = base + position;
      if (index !== expected) {
        throw stepHalt(
          "sequence",
          "REVISION_SEQUENCE",
          `${named} takes observation indexes [${indexes.join(", ")}] from ${base}, expected ${expected} at position ${position}`,
        );
      }
    }
    batchEventObservations.set(batch, base + indexes.length);
  }

  // Acceptances (live-custody.md §4.1.4), as valuations: version 1 creates, each later version is
  // the next.
  const acceptanceEventVersion = new Map<string, number>();
  const acceptanceNames = [
    ...new Set(
      plans
        .filter((plan) => plan.keys.acceptance !== null)
        .map((plan) => plan.keys.acceptance as string),
    ),
  ].sort(sortText);
  for (const acceptance of acceptanceNames) {
    const naming = plans.filter((plan) => plan.keys.acceptance === acceptance);
    const versions = naming
      .map((plan) => BigInt(plan.keys.acceptanceVersion as number))
      .sort(sortBig);
    const named = `acceptance ${acceptance} (signatures ${signaturesOf(naming)})`;
    const row = storedRow("HandoffAcceptance", acceptance);
    if (!row && (versions[0] as bigint) > 1n) {
      throw stepHalt(
        "sequence",
        "EVENT_GAP",
        `${named} has no stored row and its lowest version is ${versions[0]}`,
      );
    }
    if (row && versions.includes(1n)) {
      throw stepHalt(
        "sequence",
        "REVISION_SEQUENCE",
        `${named} is accepted at version 1 again while it is stored`,
      );
    }
    const base = row ? BigInt(row.event_version as number) : 0n;
    inSequence(named, base, versions);
    acceptanceEventVersion.set(acceptance, Number(versions.at(-1) as bigint));
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
  const facilities = new Map<string, { lender: string; currencyDecimals: number }>();
  const loans = new Map<string, string>();
  const pools = new Set<string>();
  for (const [address, { account }] of read) {
    if (account.kind === "Organisation")
      organisations.set(address, uuidFromBytes(account.data.orgId));
    if (account.kind === "CustodianClass") classes.set(address, account.data.custodian);
    if (account.kind === "Facility") {
      facilities.set(address, {
        lender: account.data.lender,
        currencyDecimals: account.data.currencyDecimals,
      });
    }
    if (account.kind === "Loan") loans.set(address, account.data.facility);
    if (account.kind === "SimulationPool") pools.add(address);
  }
  const PLACEHOLDER_ORGANISATION = "00000000-0000-0000-0000-000000000000";
  // Contain characters outside the base58 alphabet, so no real address can equal them.
  const PLACEHOLDER_CUSTODIAN = "0-unresolved-custodian";
  const PLACEHOLDER_LENDER = "0-unresolved-lender";
  const PLACEHOLDER_FACILITY = "0-unresolved-facility";
  const placeholders = new Set([PLACEHOLDER_CUSTODIAN, PLACEHOLDER_LENDER]);
  const missing = {
    organisations: new Set<string>(),
    classes: new Set<string>(),
    facilities: new Set<string>(),
    loans: new Set<string>(),
    pools: new Set<string>(),
  };
  const resolver: Resolver = {
    organisationId(address) {
      const known = organisations.get(address);
      if (known !== undefined) return known;
      if (!placeholders.has(address)) missing.organisations.add(address);
      return PLACEHOLDER_ORGANISATION;
    },
    custodianOf(classAddress) {
      const known = classes.get(classAddress);
      if (known !== undefined) return known;
      missing.classes.add(classAddress);
      return PLACEHOLDER_CUSTODIAN;
    },
    facility(address) {
      const known = facilities.get(address);
      if (known !== undefined) return known;
      if (address !== PLACEHOLDER_FACILITY) missing.facilities.add(address);
      return { lender: PLACEHOLDER_LENDER, currencyDecimals: 0 };
    },
    loanFacility(address) {
      const known = loans.get(address);
      if (known !== undefined) return known;
      missing.loans.add(address);
      return PLACEHOLDER_FACILITY;
    },
    pool(address) {
      if (!pools.has(address)) missing.pools.add(address);
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
  // The Organisation whose members alone read the event row (org_id): an organisation-scoped
  // event's, and the depositor of a pool event that names one (T063c fold 12); else none.
  const eventOrgAddress = (plan: Plan): string | null => {
    if (plan.scope === "organisation") return eventOrganisation(plan);
    if (plan.event.name === "Deposited" || plan.event.name === "Withdrawn") {
      return (plan.event.value as Record<string, unknown>).organisation as string;
    }
    return null;
  };
  const creatingOwner = (lot: string): { plan: Plan; owner: string } | undefined => {
    const creator = lots.get(lot)?.creators[0];
    if (!creator) return undefined;
    return {
      plan: creator,
      owner: (creator.event.value as Record<string, unknown>).owner as string,
    };
  };

  const columnsOf = (address: string, account: AccountData): Row => {
    try {
      return accountColumns(account, resolver);
    } catch (error) {
      if (error instanceof UnknownEnumError) {
        throw stepHalt("fetch", "UNKNOWN_ENUM", `${account.kind}: ${error.message}`);
      }
      if (error instanceof CurrencyError) {
        throw stepHalt("fetch", "ACCOUNT_DECODE_FAILED", `${address}: ${error.message}`);
      }
      throw error;
    }
  };
  const build = () => {
    for (const [address, { account }] of read) columnsOf(address, account);
    for (const plan of plans) {
      const owner = eventOrgAddress(plan);
      if (owner !== null) resolver.organisationId(owner);
      if (plan.event.name === "LoanHandedOff") resolver.loanFacility(plan.keys.loan as string);
    }
    for (const [lot, { account }] of read) {
      if (account.kind !== "Lot") continue;
      const created = creatingOwner(lot);
      if (created) resolver.organisationId(created.owner);
    }
  };
  let resolved = false;
  for (let round = 0; round < 6 && !resolved; round += 1) {
    for (const set of Object.values(missing)) set.clear();
    build();
    if (Object.values(missing).every((set) => set.size === 0)) {
      resolved = true;
      break;
    }
    const unresolved: string[] = [];
    if (missing.loans.size > 0) {
      const found = await store.storedRows(stream, "chain_loans", [...missing.loans]);
      for (const address of missing.loans) {
        const row = found.get(address);
        if (row) loans.set(address, row.facility as string);
        else unresolved.push(`Loan ${address}`);
      }
    }
    if (missing.facilities.size > 0) {
      const found = await store.storedRows(stream, "chain_facilities", [...missing.facilities]);
      for (const address of missing.facilities) {
        const row = found.get(address);
        if (row) {
          facilities.set(address, {
            lender: row.lender as string,
            currencyDecimals: row.currency_decimals as number,
          });
        } else unresolved.push(`Facility ${address}`);
      }
    }
    if (missing.pools.size > 0) {
      const found = await store.storedRows(stream, "chain_pools", [...missing.pools]);
      for (const address of missing.pools) {
        if (found.has(address)) pools.add(address);
        else unresolved.push(`SimulationPool ${address}`);
      }
    }
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
      ...columnsOf(address, account),
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
    if (account.kind === "Loan" || account.kind === "SimulationPool") {
      const previous = storedRow(account.kind, address);
      const revision = (account.kind === "Loan" ? loanEventRevision : poolEventRevision).get(
        address,
      );
      row.event_revision =
        revision === undefined ? (previous?.event_revision as string) : toU64String(revision);
    }
    if (account.kind === "Shipment") {
      const previous = storedRow("Shipment", address);
      const revision = shipmentEventRevision.get(address);
      row.event_revision =
        revision === undefined ? (previous?.event_revision as string) : toU64String(revision);
      // A shipment prepared in this slot has had no registration yet unless one is counted.
      row.event_registered =
        shipmentEventRegistered.get(address) ??
        (previous ? (previous.event_registered as number) : 0);
    }
    if (account.kind === "ManifestBatch") {
      // A handover of this slot moves event_sequence, an observation event_observations. A batch
      // registered in this slot starts at 0, a stored one keeps its columns.
      const previous = storedRow("ManifestBatch", address);
      const sequence = batchEventSequence.get(address);
      row.event_sequence =
        sequence !== undefined
          ? toU64String(sequence)
          : previous
            ? (previous.event_sequence as string)
            : "0";
      const observations = batchEventObservations.get(address);
      row.event_observations =
        observations !== undefined
          ? observations
          : previous
            ? (previous.event_observations as number)
            : 0;
    }
    if (account.kind === "ReleaseIntent" || account.kind === "LoadingIntent") {
      // The mark is carried forward; §4.1.7 below may set it.
      row.cancelled_by = (storedRow(account.kind, address)?.cancelled_by ?? null) as JsonValue;
    }
    if (account.kind === "HandoffAcceptance") {
      const version = acceptanceEventVersion.get(address);
      row.event_version =
        version === undefined
          ? (storedRow("HandoffAcceptance", address)?.event_version as number)
          : version;
    }
    if (account.kind === "Valuation") {
      const version = valuationEventVersion.get(address);
      row.event_version =
        version === undefined
          ? (storedRow("Valuation", address)?.event_version as number)
          : version;
    }
    upserts.push({ table, row });
  }

  // Intents cancelled by a shipment (live-custody.md §4.1.7): release and loading intents alike.
  const shipped = plans.filter((plan) => plan.event.name === "ShipmentPrepared");
  if (shipped.length > 0) {
    const positions = [
      ...new Set(shipped.map((plan) => plan.invocation.accounts.position as string)),
    ];
    for (const table of ["chain_release_intents", "chain_loading_intents"] as const) {
      const storedIntents = await store.rowsByColumn(stream, table, "position", positions);
      const fresh = new Map<string, Row>();
      for (const entry of upserts) {
        if (entry.table === table) fresh.set(entry.row.address as string, entry.row);
      }
      const marked = new Map<string, string>();
      for (const plan of shipped) {
        const value = plan.event.value as Record<string, unknown>;
        const shipment = value.shipment as string;
        const position = plan.invocation.accounts.position as string;
        const decoded = read.get(shipment)?.account as { data: Shipment };
        const preparedAt = decoded.data.preparedAt;
        const before = (value.positionRevision as bigint) - 1n;
        const candidates = new Map<string, Row>();
        for (const [address, row] of storedIntents) candidates.set(address, row);
        for (const [address, row] of fresh) candidates.set(address, row);
        for (const address of [...candidates.keys()].sort(sortText)) {
          const row = candidates.get(address) as Row;
          if (row.position !== position || row.cancelled_by !== null || marked.has(address))
            continue;
          if (
            row.status === "Open" &&
            BigInt(row.position_revision as string) === before &&
            BigInt(row.expires_at as string) > preparedAt
          ) {
            marked.set(address, shipment);
          }
        }
      }
      for (const address of [...marked.keys()].sort(sortText)) {
        const shipment = marked.get(address) as string;
        const row = fresh.get(address);
        if (row) row.cancelled_by = shipment;
        else {
          upserts.push({
            table,
            row: { ...(storedIntents.get(address) as Row), cancelled_by: shipment },
          });
        }
      }
    }
  }

  const eventRows: Row[] = [];
  for (const plan of plans) {
    const { transaction, event } = plan;
    const owner = eventOrgAddress(plan);
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
      org_id: owner === null ? null : resolver.organisationId(owner),
      data: event.data,
      // A hand-off's facility is its loan's (live-custody.md §4.1.5).
      facility:
        plan.event.name === "LoanHandedOff"
          ? resolver.loanFacility(plan.keys.loan as string)
          : plan.keys.facility,
      loan: plan.keys.loan,
      loan_revision: plan.keys.loanRevision === null ? null : toU64String(plan.keys.loanRevision),
      pool: plan.keys.pool,
      pool_revision: plan.keys.poolRevision === null ? null : toU64String(plan.keys.poolRevision),
      valuation: plan.keys.valuation,
      valuation_version: plan.keys.valuationVersion,
      created: plan.keys.created,
      shipment: plan.keys.shipment,
      shipment_revision:
        plan.keys.shipmentRevision === null ? null : toU64String(plan.keys.shipmentRevision),
      batch: plan.keys.batch,
      batch_sequence:
        plan.keys.batchSequence === null ? null : toU64String(plan.keys.batchSequence),
      observation_index: plan.keys.observationIndex,
      acceptance: plan.keys.acceptance,
      acceptance_version: plan.keys.acceptanceVersion,
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
