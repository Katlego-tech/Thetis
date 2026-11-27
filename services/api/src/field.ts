// The field app's two read routes (field-app.md §6.3 "Read routes", and its read-route folds):
//   GET /v1/field/batches?organisationId=          batches this organisation holds, or that are
//                                                  coming to it, on open shipments
//   GET /v1/field/loading-intents?organisationId=  open, unexpired loading intents at this terminal
// Both read the indexed chain read model (live-custody.md §6) with the service client, after the
// caller's membership of organisationId is checked, and only while the indexer stream is live.
// Every value returned is a column of an indexed row; nothing is computed but the batch number,
// the acceptance state and the order.
import { getAddressEncoder } from "@solana/kit";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CommandDependencies } from "./commands/routes.ts";
import { RelayError } from "./commands/views.ts";

export interface FieldScope {
  network: string;
  programId: string;
  protocol: string;
}

export interface OrganisationRow {
  address: string;
  org_id: string;
  display_name: string;
}
export interface ShipmentRow {
  address: string;
  lot: string;
  destination_custodian: string;
  status: string;
}
export interface BatchRow {
  address: string;
  shipment: string;
  lot: string;
  batch_index: number;
  batch_count: number;
  quantity_kg: string;
  carrier: string;
  holder: string;
  stage: "AtSource" | "InTransit" | "Arrived";
  sequence: string;
  observation_count: number;
}
export interface LotRow {
  address: string;
  lot_id: string;
}
export interface IntentRow {
  address: string;
  lot: string;
  position: string;
  owner: string;
  terminal: string;
  nonce: string;
  quantity_kg: string;
  locked_kg: string;
  document_sha256_hex: string;
  expires_at: string;
  status: string;
  cancelled_by: string | null;
}
export interface LockRow {
  address: string;
  loan: string;
  position: string;
  quantity_kg: string;
}
export interface LoanRow {
  address: string;
  facility: string;
  revision: string;
}
export interface FacilityRow {
  address: string;
  lender: string;
}
export interface AcceptanceRow {
  address: string;
  intent: string;
  loan: string;
  lock: string;
  lender: string;
  lock_quantity_kg: string;
  loan_revision: string;
}

/** Thin table readers, each scoped to one network and protocol. The routes do every filter. */
export interface FieldStore {
  isMember(userId: string, organisationId: string): Promise<boolean>;
  checkpointStatus(scope: FieldScope): Promise<"backfilling" | "live" | "halted" | null>;
  organisationByOrgId(scope: FieldScope, orgId: string): Promise<OrganisationRow | null>;
  organisationsAt(scope: FieldScope, addresses: string[]): Promise<OrganisationRow[]>;
  shipmentsTo(scope: FieldScope, custodian: string): Promise<ShipmentRow[]>;
  shipmentsAt(scope: FieldScope, addresses: string[]): Promise<ShipmentRow[]>;
  batchesHeldBy(scope: FieldScope, holder: string): Promise<BatchRow[]>;
  batchesOf(scope: FieldScope, shipments: string[]): Promise<BatchRow[]>;
  lotsAt(scope: FieldScope, addresses: string[]): Promise<LotRow[]>;
  intentsAt(scope: FieldScope, terminal: string): Promise<IntentRow[]>;
  locksOf(scope: FieldScope, positions: string[]): Promise<LockRow[]>;
  loansAt(scope: FieldScope, addresses: string[]): Promise<LoanRow[]>;
  facilitiesAt(scope: FieldScope, addresses: string[]): Promise<FacilityRow[]>;
  acceptancesOf(scope: FieldScope, intents: string[]): Promise<AcceptanceRow[]>;
}

export interface FieldBatch {
  batch: string;
  shipment: string;
  lot: string;
  lotId: string;
  index: number;
  batchCount: number;
  quantityKg: string;
  stage: "AtSource" | "InTransit" | "Arrived";
  holder: string;
  holderName: string;
  carrier: string;
  carrierName: string;
  destinationCustodian: string;
  destinationName: string;
  observationCount: number;
  sequence: string;
}

export interface FieldLoadingIntent {
  intent: string;
  lot: string;
  lotId: string;
  quantityKg: string;
  lockedKg: string;
  owner: string;
  ownerName: string;
  terminalName: string;
  documentSha256: string;
  nonce: string;
  expiresAt: string;
  acceptances: {
    lender: string;
    lenderName: string;
    loan: string;
    lockKg: string;
    state: "accepted" | "missing" | "stale";
  }[];
}

const OPEN_SHIPMENT = new Set(["Prepared", "InTransit"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ROUTES = { batches: "/v1/field/batches", intents: "/v1/field/loading-intents" } as const;

export function isFieldPath(path: string): boolean {
  return path === "/v1/field" || path.startsWith("/v1/field/");
}

/** A read-model row the answer depends on is absent: never fill it in. */
function missing(what: string): never {
  throw new RelayError("INTERNAL", `read model has no ${what}`);
}

function lookup<T>(rows: T[], key: (row: T) => string): Map<string, T> {
  return new Map(rows.map((row) => [key(row), row]));
}

function need<T>(map: Map<string, T>, key: string, what: string): T {
  const value = map.get(key);
  if (value === undefined) missing(`${what} ${key}`);
  return value;
}

const unique = (values: string[]) => [...new Set(values)];

function organisationId(query: string | undefined): string {
  const entries = [...new URLSearchParams(query ?? "").entries()];
  const [entry] = entries;
  if (entries.length !== 1 || !entry || entry[0] !== "organisationId" || !UUID.test(entry[1])) {
    throw new RelayError("VALIDATION", "organisationId");
  }
  return entry[1];
}

export async function listBatches(
  store: FieldStore,
  scope: FieldScope,
  org: OrganisationRow,
): Promise<FieldBatch[]> {
  const [held, incoming] = await Promise.all([
    store.batchesHeldBy(scope, org.address),
    store.shipmentsTo(scope, org.address),
  ]);
  const incomingOpen = incoming.filter((s) => OPEN_SHIPMENT.has(s.status));
  const arriving = incomingOpen.length
    ? await store.batchesOf(
        scope,
        incomingOpen.map((s) => s.address),
      )
    : [];
  const known = lookup(incoming, (s) => s.address);
  const unknown = unique(held.map((b) => b.shipment).filter((s) => !known.has(s)));
  for (const s of unknown.length ? await store.shipmentsAt(scope, unknown) : []) {
    known.set(s.address, s);
  }

  const batches = new Map<string, { batch: BatchRow; shipment: ShipmentRow }>();
  for (const batch of [...held, ...arriving]) {
    const shipment = need(known, batch.shipment, "shipment");
    if (!OPEN_SHIPMENT.has(shipment.status)) continue;
    batches.set(batch.address, { batch, shipment });
  }
  if (batches.size === 0) return [];

  const rows = [...batches.values()];
  const [lots, organisations] = await Promise.all([
    store.lotsAt(scope, unique(rows.map((r) => r.batch.lot))),
    store.organisationsAt(
      scope,
      unique(
        rows.flatMap((r) => [r.batch.holder, r.batch.carrier, r.shipment.destination_custodian]),
      ),
    ),
  ]);
  const lotIds = lookup(lots, (l) => l.address);
  const names = lookup(organisations, (o) => o.address);
  const name = (address: string) => need(names, address, "organisation").display_name;

  return rows
    .map(({ batch, shipment }) => ({
      batch: batch.address,
      shipment: batch.shipment,
      lot: batch.lot,
      lotId: need(lotIds, batch.lot, "lot").lot_id,
      index: batch.batch_index + 1,
      batchCount: batch.batch_count,
      quantityKg: batch.quantity_kg,
      stage: batch.stage,
      holder: batch.holder,
      holderName: name(batch.holder),
      carrier: batch.carrier,
      carrierName: name(batch.carrier),
      destinationCustodian: shipment.destination_custodian,
      destinationName: name(shipment.destination_custodian),
      observationCount: batch.observation_count,
      sequence: batch.sequence,
    }))
    .sort(
      (a, b) =>
        a.lotId.localeCompare(b.lotId) ||
        a.shipment.localeCompare(b.shipment) ||
        a.index - b.index ||
        a.batch.localeCompare(b.batch),
    );
}

export async function listLoadingIntents(
  store: FieldStore,
  scope: FieldScope,
  terminal: OrganisationRow,
  nowSecs: bigint,
): Promise<FieldLoadingIntent[]> {
  const open = (await store.intentsAt(scope, terminal.address)).filter(
    (i) =>
      i.terminal === terminal.address &&
      i.status === "Open" &&
      i.cancelled_by === null &&
      BigInt(i.expires_at) > nowSecs,
  );
  if (open.length === 0) return [];

  const [lots, allLocks, acceptances] = await Promise.all([
    store.lotsAt(scope, unique(open.map((i) => i.lot))),
    store.locksOf(scope, unique(open.map((i) => i.position))),
    store.acceptancesOf(
      scope,
      open.map((i) => i.address),
    ),
  ]);
  const locks = allLocks.filter((l) => BigInt(l.quantity_kg) > 0n);
  const loans = locks.length ? await store.loansAt(scope, unique(locks.map((l) => l.loan))) : [];
  const loanBy = lookup(loans, (l) => l.address);
  const facilities = loans.length
    ? await store.facilitiesAt(scope, unique(loans.map((l) => l.facility)))
    : [];
  const facilityBy = lookup(facilities, (f) => f.address);
  const lenderOf = (loan: string) =>
    need(facilityBy, need(loanBy, loan, "loan").facility, "facility").lender;
  const organisations = await store.organisationsAt(
    scope,
    unique([...open.map((i) => i.owner), ...locks.map((l) => lenderOf(l.loan))]),
  );
  const names = lookup(organisations, (o) => o.address);
  const name = (address: string) => need(names, address, "organisation").display_name;
  const lotIds = lookup(lots, (l) => l.address);
  const encoder = getAddressEncoder();
  const raw = (address: string) => Buffer.from(encoder.encode(address as never));

  return open
    .map((i) => ({
      intent: i.address,
      lot: i.lot,
      lotId: need(lotIds, i.lot, "lot").lot_id,
      quantityKg: i.quantity_kg,
      lockedKg: i.locked_kg,
      owner: i.owner,
      ownerName: name(i.owner),
      terminalName: terminal.display_name,
      documentSha256: i.document_sha256_hex,
      nonce: i.nonce,
      expiresAt: i.expires_at,
      acceptances: locks
        .filter((l) => l.position === i.position)
        .sort((a, b) => Buffer.compare(raw(a.loan), raw(b.loan)))
        .map((lock) => {
          const loan = need(loanBy, lock.loan, "loan");
          const lender = lenderOf(lock.loan);
          // As record_loading reads it: the acceptance must name this intent, loan and lock.
          const accepted = acceptances.find(
            (a) => a.intent === i.address && a.loan === lock.loan && a.lock === lock.address,
          );
          const state = !accepted
            ? ("missing" as const)
            : accepted.loan_revision !== loan.revision ||
                accepted.lock_quantity_kg !== lock.quantity_kg
              ? ("stale" as const)
              : ("accepted" as const);
          return {
            lender,
            lenderName: name(lender),
            loan: lock.loan,
            lockKg: lock.quantity_kg,
            state,
          };
        }),
    }))
    .sort((a, b) => {
      const left = BigInt(a.expiresAt);
      const right = BigInt(b.expiresAt);
      return left < right ? -1 : left > right ? 1 : a.intent.localeCompare(b.intent);
    });
}

/** The routes after the bearer check in ../routes.ts. `requireNoBody` refuses a request body. */
export async function fieldRoute(
  method: string,
  path: string,
  query: string | undefined,
  requireNoBody: () => void,
  userId: string,
  dependencies: () => Promise<CommandDependencies>,
  store: FieldStore,
): Promise<object[]> {
  const which =
    method !== "GET"
      ? null
      : path === ROUTES.batches
        ? "batches"
        : path === ROUTES.intents
          ? "intents"
          : null;
  if (!which) throw new RelayError("NOT_FOUND");
  const orgId = organisationId(query);
  requireNoBody();
  if (!(await store.isMember(userId, orgId))) {
    throw new RelayError("NOT_AUTHORISED", "the caller is not a member of the organisation");
  }
  const relay = await dependencies();
  const scope: FieldScope = {
    network: relay.network,
    programId: relay.programId,
    protocol: relay.protocol,
  };
  if ((await store.checkpointStatus(scope)) !== "live") throw new RelayError("CHAIN_UNAVAILABLE");
  const org = await store.organisationByOrgId(scope, orgId);
  if (!org) return [];
  return which === "batches"
    ? listBatches(store, scope, org)
    : listLoadingIntents(store, scope, org, BigInt(Math.floor(relay.now() / 1000)));
}

// ---------------------------------------------------------------- Supabase

const PAGE = 1000; // Supabase API max_rows
const CHUNK = 100; // addresses per `in` filter, to keep the URL short

type Result<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

async function pages<T>(read: (from: number, to: number) => Result<T>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await read(from, from + PAGE - 1);
    if (error) throw new RelayError("INTERNAL", error.message);
    rows.push(...(data ?? []));
    if ((data ?? []).length < PAGE) return rows;
  }
}

async function chunked<T>(values: string[], read: (chunk: string[]) => Promise<T[]>) {
  const rows: T[] = [];
  for (let i = 0; i < values.length; i += CHUNK)
    rows.push(...(await read(values.slice(i, i + CHUNK))));
  return rows;
}

export function supabaseFieldStore(service: SupabaseClient): FieldStore {
  const table = (scope: FieldScope, name: string, columns: string) =>
    service.from(name).select(columns).eq("network", scope.network).eq("protocol", scope.protocol);
  const where = <T>(
    scope: FieldScope,
    name: string,
    columns: string,
    column: string,
    value: string,
  ) =>
    pages<T>(
      (from, to) =>
        table(scope, name, columns).eq(column, value).order("address").range(from, to) as never,
    );
  const whereIn = <T>(
    scope: FieldScope,
    name: string,
    columns: string,
    column: string,
    values: string[],
  ) =>
    chunked(values, (chunk) =>
      pages<T>(
        (from, to) =>
          table(scope, name, columns).in(column, chunk).order("address").range(from, to) as never,
      ),
    );

  const ORGANISATION = "address, org_id, display_name";
  const SHIPMENT = "address, lot, destination_custodian, status";
  const BATCH =
    "address, shipment, lot, batch_index, batch_count, quantity_kg, carrier, holder, stage, sequence, observation_count";
  const INTENT =
    "address, lot, position, owner, terminal, nonce, quantity_kg, locked_kg, document_sha256_hex, expires_at, status, cancelled_by";
  const ACCEPTANCE = "address, intent, loan, lock, lender, lock_quantity_kg, loan_revision";

  return {
    async isMember(userId, organisationId) {
      const { data, error } = await service
        .from("memberships")
        .select("id")
        .eq("user_id", userId)
        .eq("organisation_id", organisationId)
        .is("revoked_at", null)
        .limit(1);
      if (error) throw new RelayError("INTERNAL", error.message);
      return (data ?? []).length > 0;
    },
    async checkpointStatus(scope) {
      const { data, error } = await service
        .from("indexer_checkpoints")
        .select("status")
        .eq("network", scope.network)
        .eq("program_id", scope.programId)
        .eq("protocol", scope.protocol)
        .maybeSingle();
      if (error) throw new RelayError("INTERNAL", error.message);
      return (data?.status as "backfilling" | "live" | "halted" | undefined) ?? null;
    },
    async organisationByOrgId(scope, orgId) {
      const { data, error } = await table(scope, "chain_organisations", ORGANISATION)
        .eq("org_id", orgId)
        .maybeSingle();
      if (error) throw new RelayError("INTERNAL", error.message);
      return (data as OrganisationRow | null) ?? null;
    },
    organisationsAt: (scope, addresses) =>
      whereIn(scope, "chain_organisations", ORGANISATION, "address", addresses),
    shipmentsTo: (scope, custodian) =>
      where(scope, "chain_shipments", SHIPMENT, "destination_custodian", custodian),
    shipmentsAt: (scope, addresses) =>
      whereIn(scope, "chain_shipments", SHIPMENT, "address", addresses),
    batchesHeldBy: (scope, holder) => where(scope, "chain_batches", BATCH, "holder", holder),
    batchesOf: (scope, shipments) => whereIn(scope, "chain_batches", BATCH, "shipment", shipments),
    lotsAt: (scope, addresses) =>
      whereIn(scope, "chain_lots", "address, lot_id", "address", addresses),
    intentsAt: (scope, terminal) =>
      where(scope, "chain_loading_intents", INTENT, "terminal", terminal),
    locksOf: (scope, positions) =>
      whereIn(scope, "chain_locks", "address, loan, position, quantity_kg", "position", positions),
    loansAt: (scope, addresses) =>
      whereIn(scope, "chain_loans", "address, facility, revision", "address", addresses),
    facilitiesAt: (scope, addresses) =>
      whereIn(scope, "chain_facilities", "address, lender", "address", addresses),
    acceptancesOf: (scope, intents) =>
      whereIn(scope, "chain_handoff_acceptances", ACCEPTANCE, "intent", intents),
  };
}
