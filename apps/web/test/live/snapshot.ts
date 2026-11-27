// Synthetic read-model rows for the live adapter tests. Nothing here was read from a chain.
//
// Organisation ids, slugs, names and kinds are supabase/seed.sql's; chain roles are the ones
// scripts/seed-demo.ts accredits for each kind. The program id and the fiat-attestation protocol are
// the README's devnet addresses. Every other address is the base58 of 32 bytes filled with n, and
// every signature the base58 of 64 bytes filled with k: organisation row i's account is n = 10 + i,
// its admin n = 40 + i, and the lot's accounts n = 33 to 39. The CR-0001 issue is transaction k = 12
// in slot 12,000 at 2026-11-26T00:00:01Z; quantities follow the worker's lotHistory() fixture.

import type { SupabaseClient } from "@supabase/supabase-js";
import bs58 from "bs58";
import type {
  ChainDocumentRow,
  ChainHandoffAcceptanceRow,
  ChainLoadingIntentRow,
  ChainEventRow,
  ChainFacilityRow,
  ChainLoanRow,
  ChainLockRow,
  ChainLotRow,
  ChainOrganisationRow,
  ChainPaymentRow,
  ChainPositionRow,
  ChainReleaseIntentRow,
  ChainValuationRow,
  CheckpointRow,
  CommandRow,
  LiveSnapshot,
  OrganisationRow,
} from "@/data/live/rows";

export const PROGRAM_ID = "jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3";
export const PROTOCOL = "G9GNDdbYKQY14xv1xgNw1D6EY8SFnZxgHrDBdEbHsoo3";
export const ENV: LiveSnapshot["env"] = {
  network: "devnet",
  programId: PROGRAM_ID,
  protocol: PROTOCOL,
};

export function address(n: number): string {
  return bs58.encode(new Uint8Array(32).fill(n));
}

export function signature(k: number): string {
  return bs58.encode(new Uint8Array(64).fill(k));
}

export const SEED_ORGANISATIONS = [
  {
    id: "11000000-0000-4000-8000-000000000001",
    slug: "khunou",
    name: "Khunou Ore Exports",
    kind: "exporter",
    role: "Exporter",
  },
  {
    id: "11000000-0000-4000-8000-000000000002",
    slug: "kopano",
    name: "Kopano Stockyard Custody",
    kind: "custodian",
    role: "Custodian",
  },
  {
    id: "11000000-0000-4000-8000-000000000003",
    slug: "mosela",
    name: "Mosela Haulage",
    kind: "transporter",
    role: "Transporter",
  },
  {
    id: "11000000-0000-4000-8000-000000000004",
    slug: "port-t1",
    name: "Port Terminal T1",
    kind: "terminal",
    role: "Terminal",
  },
  {
    id: "11000000-0000-4000-8000-000000000005",
    slug: "lender-one",
    name: "Lender One Bank",
    kind: "lender",
    role: "Lender",
  },
  {
    id: "11000000-0000-4000-8000-000000000006",
    slug: "lender-two",
    name: "Lender Two Bank",
    kind: "lender",
    role: "Lender",
  },
  {
    id: "11000000-0000-4000-8000-000000000007",
    slug: "buyer-smelter",
    name: "Buyer Smelter Co",
    kind: "buyer",
    role: "Buyer",
  },
] as const;

export type Slug = (typeof SEED_ORGANISATIONS)[number]["slug"];

function seedIndex(slug: Slug): number {
  return SEED_ORGANISATIONS.findIndex((row) => row.slug === slug);
}

export function orgId(slug: Slug): string {
  return SEED_ORGANISATIONS[seedIndex(slug)]?.id ?? "";
}

/** The Organisation account of a seed organisation. */
export function orgAccount(slug: Slug): string {
  return address(10 + seedIndex(slug));
}

export const CLASS_POLICY = address(33);
export const CUSTODIAN_CLASS = address(34);
export const INTAKE = address(35);
export const LOT = address(36);
export const MINT = address(37);
export const KHUNOU_POSITION = address(38);
export const BUYER_POSITION = address(39);
export const INTAKE_DIGEST = "5a".repeat(32);
export const ISSUE_SIGNATURE = signature(12);
export const ISSUED_AT = "2026-11-26T00:00:01.000Z";
const LOT_VALIDITY_SECS = 7_776_000;

export function membership(slug: Slug): OrganisationRow {
  const row = SEED_ORGANISATIONS[seedIndex(slug)];
  if (!row) throw new Error(`No seed organisation ${slug}`);
  return { id: row.id, slug: row.slug, name: row.name, kind: row.kind, synthetic: true };
}

function chainOrganisation(index: number): ChainOrganisationRow {
  const row = SEED_ORGANISATIONS[index];
  if (!row) throw new Error(`No seed organisation ${index}`);
  return {
    network: "devnet",
    address: address(10 + index),
    protocol: PROTOCOL,
    slot: 4_000 + 1_000 * index,
    commitment: "finalized",
    org_id: row.id,
    slug: row.slug,
    synthetic: true,
    role: row.role,
    display_name: row.name,
    admin: address(40 + index),
    related: [],
  };
}

export function position(
  at: string,
  owner: Slug,
  quantityKg: string,
  overrides: Partial<ChainPositionRow> = {},
): ChainPositionRow {
  return {
    network: "devnet",
    address: at,
    protocol: PROTOCOL,
    slot: 12_000,
    commitment: "confirmed",
    lot: LOT,
    owner: orgAccount(owner),
    owner_org_id: orgId(owner),
    quantity_kg: quantityKg,
    locked_kg: "0",
    reserved_kg: "0",
    revision: "0",
    ...overrides,
  };
}

export function lotRow(overrides: Partial<ChainLotRow> = {}): ChainLotRow {
  return {
    network: "devnet",
    address: LOT,
    protocol: PROTOCOL,
    slot: 12_000,
    commitment: "confirmed",
    lot_id: "CR-0001",
    class_policy: CLASS_POLICY,
    class_version: 1,
    grade: "G1",
    custodian_class: CUSTODIAN_CLASS,
    custodian: orgAccount("kopano"),
    custodian_org_id: orgId("kopano"),
    intake: INTAKE,
    parent: null,
    root: LOT,
    mint: MINT,
    supply_kg: "5000000",
    state: "Stored",
    restriction: "Normal",
    expires_at: String(Date.parse(ISSUED_AT) / 1000 + LOT_VALIDITY_SECS),
    revision: "0",
    live_children: 0,
    event_revision: "0",
    issued_owner: orgAccount("khunou"),
    issued_owner_org_id: orgId("khunou"),
    issued_at: ISSUED_AT,
    ...overrides,
  };
}

export function issueEvent(): ChainEventRow {
  return {
    network: "devnet",
    program_id: PROGRAM_ID,
    signature: ISSUE_SIGNATURE,
    event_index: 0,
    slot: 12_000,
    block_time: ISSUED_AT,
    protocol: PROTOCOL,
    lot: LOT,
    lot_revision: "0",
    data: {
      lot: LOT,
      owner: orgAccount("khunou"),
      quantityKg: "5000000",
      intake: INTAKE,
      revision: "0",
    },
    commitment: "confirmed",
  };
}

export function document(
  at: string,
  version: number,
  overrides: Partial<ChainDocumentRow> = {},
): ChainDocumentRow {
  return {
    network: "devnet",
    address: at,
    protocol: PROTOCOL,
    slot: 12_500,
    commitment: "confirmed",
    kind: "Origin",
    subject_hex: INTAKE_DIGEST,
    version,
    issuer: orgAccount("port-t1"),
    issuer_org_id: orgId("port-t1"),
    sha256_hex: "6b".repeat(32),
    valid_until: String(Date.parse(ISSUED_AT) / 1000 + 3_600),
    revoked_at: null,
    ...overrides,
  };
}

export function checkpoint(overrides: Partial<CheckpointRow> = {}): CheckpointRow {
  return {
    network: "devnet",
    program_id: PROGRAM_ID,
    protocol: PROTOCOL,
    status: "live",
    indexed_through_slot: 12_000,
    last_success_at: "2026-11-26T00:00:06.000Z",
    halt_reason: null,
    halted_at: null,
    ...overrides,
  };
}

/** The seed plus the CR-0001 issue: 5,000,000 kg to Khunou at Kopano's site, confirmed. */
export function issuedSnapshot(members: Slug[] = ["khunou"]): LiveSnapshot {
  return {
    env: { ...ENV },
    memberships: members.map(membership),
    organisations: SEED_ORGANISATIONS.map((_, index) => chainOrganisation(index)),
    protocol: {
      network: "devnet",
      address: PROTOCOL,
      protocol: PROTOCOL,
      slot: 2_000,
      commitment: "finalized",
      // "fiat-attestation" as 16 ASCII bytes
      instance_id_hex: "666961742d6174746573746174696f6e",
      settlement_mode: "FiatAttestationTest",
      admin: address(2),
      accreditor: address(3),
      pause_flags: 0,
    },
    classPolicies: [
      {
        network: "devnet",
        address: CLASS_POLICY,
        protocol: PROTOCOL,
        slot: 3_000,
        commitment: "finalized",
        class_code: "CHROME",
        version: 1,
        unit: "Kilogram",
        grades: ["G1"],
        origin_required: false,
        lot_validity_secs: String(LOT_VALIDITY_SECS),
        split_inherits_expiry: true,
      },
    ],
    custodianClasses: [
      {
        network: "devnet",
        address: CUSTODIAN_CLASS,
        protocol: PROTOCOL,
        slot: 12_000,
        commitment: "confirmed",
        custodian: orgAccount("kopano"),
        custodian_org_id: orgId("kopano"),
        class_policy: CLASS_POLICY,
        site_code: "PORT-STOCKYARD",
        approved_capacity_kg: "10000000",
        occupied_kg: "5000000",
        reserved_inbound_kg: "0",
      },
    ],
    lots: [lotRow()],
    positions: [position(KHUNOU_POSITION, "khunou", "5000000")],
    intakes: [
      {
        network: "devnet",
        address: INTAKE,
        protocol: PROTOCOL,
        slot: 12_000,
        commitment: "confirmed",
        custodian: orgAccount("kopano"),
        custodian_org_id: orgId("kopano"),
        intake_digest_hex: INTAKE_DIGEST,
        lot: LOT,
        retired: false,
      },
    ],
    documents: [],
    facilities: [],
    valuations: [],
    loans: [],
    locks: [],
    payments: [],
    intents: [],
    commands: [],
    loadingIntents: [],
    acceptances: [],
    intakeEvents: [issueEvent()],
    checkpoint: checkpoint(),
  };
}

/** After the transfer of 2,000,000 kg of CR-0001 from Khunou to Buyer Smelter Co. */
export function transferredSnapshot(members: Slug[] = ["khunou"]): LiveSnapshot {
  const snapshot = issuedSnapshot(members);
  snapshot.lots = [lotRow({ slot: 13_000, revision: "1", event_revision: "1" })];
  snapshot.positions = [
    position(KHUNOU_POSITION, "khunou", "3000000", { slot: 13_000, revision: "1" }),
    position(BUYER_POSITION, "buyer-smelter", "2000000", { slot: 13_000 }),
  ];
  snapshot.checkpoint = checkpoint({ indexed_through_slot: 13_000 });
  return snapshot;
}

// A fake Supabase client: each table holds rows, `.select` returns only the named columns, every
// call is recorded, and `respond` can replace one call's response.

type Filter = [column: string, value: unknown] | [column: string, value: unknown[], kind: "in"];
export interface QueryCall {
  table: string;
  columns: string[];
  options: unknown;
  filters: Filter[];
  orders: { column: string; options: unknown }[];
  range: [number, number] | null;
}
export interface QueryResponse {
  data: unknown;
  error: unknown;
  count: number | null | undefined;
}
export interface FakeUser {
  data: { user: { id: string } | null };
  error: { name: string; status?: number; message?: string } | null;
}
export interface FakeSupabase {
  client: SupabaseClient;
  calls: QueryCall[];
  tables: Record<string, Record<string, unknown>[]>;
  getUser: () => Promise<FakeUser>;
  respond:
    | ((call: QueryCall, index: number) => QueryResponse | Promise<QueryResponse> | undefined)
    | null;
}

export function tablesOf(snapshot: LiveSnapshot): Record<string, Record<string, unknown>[]> {
  const rows = <T extends object>(list: T[]) =>
    list.map((row) => ({ ...row }) as Record<string, unknown>);
  return {
    organisations: rows(snapshot.memberships),
    chain_organisations: rows(snapshot.organisations),
    chain_protocols: rows(snapshot.protocol ? [snapshot.protocol] : []),
    chain_class_policies: rows(snapshot.classPolicies),
    chain_custodian_classes: rows(snapshot.custodianClasses),
    chain_lots: rows(snapshot.lots),
    chain_positions: rows(snapshot.positions),
    chain_intakes: rows(snapshot.intakes),
    chain_documents: rows(snapshot.documents),
    chain_facilities: rows(snapshot.facilities),
    chain_valuations: rows(snapshot.valuations),
    chain_loans: rows(snapshot.loans),
    chain_locks: rows(snapshot.locks),
    chain_payments: rows(snapshot.payments),
    chain_release_intents: rows(snapshot.intents),
    commands: snapshot.commands.map((row) => ({
      ...row,
      network: "devnet",
      program_id: PROGRAM_ID,
      protocol: PROTOCOL,
    })),
    chain_loading_intents: rows(snapshot.loadingIntents),
    chain_handoff_acceptances: rows(snapshot.acceptances),
    chain_events: snapshot.intakeEvents.map((row) => ({
      ...row,
      instruction: "IssueLot",
      event: "LotIssued",
      scope: "lot",
      org_id: null,
    })),
    indexer_checkpoints: rows(snapshot.checkpoint ? [snapshot.checkpoint] : []),
  };
}

export function fakeSupabase(snapshot: LiveSnapshot = issuedSnapshot()): FakeSupabase {
  const fake: FakeSupabase = {
    client: undefined as unknown as SupabaseClient,
    calls: [],
    tables: tablesOf(snapshot),
    getUser: async () => ({
      data: { user: { id: "21000000-0000-4000-8000-000000000001" } },
      error: null,
    }),
    respond: null,
  };

  function query(table: string) {
    const call: QueryCall = {
      table,
      columns: [],
      options: undefined,
      filters: [],
      orders: [],
      range: null,
    };
    const builder = {
      select(columns: string, options?: unknown) {
        call.columns = columns.split(",").map((column) => column.trim());
        call.options = options;
        return builder;
      },
      eq(column: string, value: unknown) {
        call.filters.push([column, value]);
        return builder;
      },
      in(column: string, values: unknown[]) {
        call.filters.push([column, [...values], "in"]);
        return builder;
      },
      order(column: string, options?: unknown) {
        call.orders.push({ column, options });
        return builder;
      },
      range(from: number, to: number) {
        call.range = [from, to];
        return builder;
      },
      // biome-ignore lint/suspicious/noThenProperty: the Supabase query builder is awaited as a thenable
      then(resolve: (value: QueryResponse) => unknown, reject: (reason: unknown) => unknown) {
        const index = fake.calls.push(call) - 1;
        return Promise.resolve()
          .then(() => fake.respond?.(call, index))
          .then((override) => {
            if (override) return override;
            const all = (fake.tables[table] ?? []).filter((row) =>
              call.filters.every(([column, value, kind]) =>
                kind === "in" ? (value as unknown[]).includes(row[column]) : row[column] === value,
              ),
            );
            const data = all.map((row) =>
              Object.fromEntries(
                call.columns.map((column) => [column, structuredClone(row[column])]),
              ),
            );
            return { data, error: null, count: data.length };
          })
          .then(resolve, reject);
      },
    };
    return builder;
  }

  fake.client = {
    from: query,
    auth: { getUser: () => fake.getUser() },
  } as unknown as SupabaseClient;
  return fake;
}

export const NOW = new Date("2026-11-26T00:00:10.000Z");
const NOW_SECONDS = Date.parse("2026-11-26T00:00:10.000Z") / 1000;

// Phase 2 rows (live-lending.md §3.1). Lender One Bank's facility to Khunou (facility id 16 x 0x11,
// the pledge vector's), USD with 2 minor digits at the 1,200 bps demo rate and a 6,000 bps limit, a
// valuation of USD 0.20/kg (USD 200.00/t) and Khunou's 5,000 t pledge as loan 0 with USD 600,000.00
// advanced an hour before NOW. Lender Two Bank's facility (16 x 0x22) has no valuation. Accounts are
// n = 50 to 69; payment and evidence digests follow the worker fixtures (32 x 0x31.., 32 x 0x41..).

export const FACILITY_ONE = address(50);
export const VALUATION_ONE = address(51);
export const LOAN_ONE = address(52);
export const LOCK_ONE = address(53);
export const INTENT = address(54);
export const RELEASE_PAYMENT = address(55);
export const REPAYMENT = address(56);
export const FACILITY_TWO = address(60);
export const LOAN_TWO = address(62);
export const LOCK_TWO = address(63);
export const ACCRUED_AT = String(NOW_SECONDS - 3_600);
export const INTENT_EXPIRES_AT = String(NOW_SECONDS + 86_400);

const lending = (slot: number) =>
  ({ network: "devnet", protocol: PROTOCOL, slot, commitment: "confirmed" }) as const;

export function facility(
  at: string,
  lender: Slug,
  overrides: Partial<ChainFacilityRow> = {},
): ChainFacilityRow {
  return {
    ...lending(12_100),
    address: at,
    lender: orgAccount(lender),
    lender_org_id: orgId(lender),
    borrower: orgAccount("khunou"),
    borrower_org_id: orgId("khunou"),
    facility_id_hex: (lender === "lender-one" ? "11" : "22").repeat(16),
    currency: "USD",
    currency_decimals: 2,
    terms_version: 1,
    rate_bps: 1200,
    max_ltv_bps: 6000,
    terms_digest_hex: "21".repeat(32),
    loan_count: 0,
    ...overrides,
  };
}

export function valuation(overrides: Partial<ChainValuationRow> = {}): ChainValuationRow {
  return {
    ...lending(12_200),
    address: VALUATION_ONE,
    facility: FACILITY_ONE,
    class_policy: CLASS_POLICY,
    grade: "G1",
    custodian_class: CUSTODIAN_CLASS,
    value_per_kg: "20",
    haircut_bps: 0,
    valid_until: String(NOW_SECONDS + 30 * 86_400),
    source_digest_hex: "22".repeat(32),
    version: 1,
    set_at: String(NOW_SECONDS - 7_200),
    event_version: 1,
    ...overrides,
  };
}

export function loan(
  at: string,
  facilityAt: string,
  lender: Slug,
  overrides: Partial<ChainLoanRow> = {},
): ChainLoanRow {
  return {
    ...lending(12_300),
    address: at,
    facility: facilityAt,
    lender_org_id: orgId(lender),
    borrower: orgAccount("khunou"),
    borrower_org_id: orgId("khunou"),
    lot: LOT,
    position: KHUNOU_POSITION,
    loan_index: 0,
    status: "Active",
    rate_bps: 1200,
    terms_version: 1,
    principal: "60000000",
    booked_interest: "0",
    accrual_remainder: "0",
    accrued_at: ACCRUED_AT,
    open_exceptions: 0,
    revision: "1",
    event_revision: "1",
    ...overrides,
  };
}

export function lock(
  at: string,
  loanAt: string,
  quantityKg: string,
  overrides: Partial<ChainLockRow> = {},
): ChainLockRow {
  return {
    ...lending(12_300),
    address: at,
    loan: loanAt,
    position: KHUNOU_POSITION,
    quantity_kg: quantityKg,
    control: "Pledged",
    ...overrides,
  };
}

export function intent(overrides: Partial<ChainReleaseIntentRow> = {}): ChainReleaseIntentRow {
  return {
    ...lending(12_400),
    address: INTENT,
    loan: LOAN_ONE,
    lot: LOT,
    position: KHUNOU_POSITION,
    seller: orgAccount("khunou"),
    seller_org_id: orgId("khunou"),
    buyer: orgAccount("buyer-smelter"),
    buyer_org_id: orgId("buyer-smelter"),
    lender: orgAccount("lender-one"),
    lender_org_id: orgId("lender-one"),
    currency_decimals: 2,
    nonce: "1",
    quantity_kg: "2000000",
    price: "40000000",
    top_up: "0",
    currency: "USD",
    expires_at: INTENT_EXPIRES_AT,
    position_revision: "1",
    status: "Open",
    ...overrides,
  };
}

export function payment(at: string, overrides: Partial<ChainPaymentRow> = {}): ChainPaymentRow {
  return {
    ...lending(12_500),
    address: at,
    lender: orgAccount("lender-one"),
    lender_org_id: orgId("lender-one"),
    loan: LOAN_ONE,
    payment_id_hex: "31".repeat(32),
    purpose: "Release",
    subject: INTENT,
    amount: "40000000",
    currency: "USD",
    evidence_digest_hex: "41".repeat(32),
    observed_at: String(NOW_SECONDS - 600),
    status: "Unconsumed",
    applied: "0",
    surplus: "0",
    ...overrides,
  };
}

/** A command row (public.commands columns of live-lending.md §4.5.1); ids are synthetic uuids. */
export function command(overrides: Partial<CommandRow> = {}): CommandRow {
  return {
    id: "2cc199ec-0000-4000-8000-000000000001",
    kind: "pledge",
    status: "awaiting_signatures",
    initiator_org: orgId("khunou"),
    parties: [orgId("khunou"), orgId("lender-one")].toSorted(),
    lot: LOT,
    facility: FACILITY_ONE,
    loan: null,
    intent: null,
    payment: null,
    args: { facility: FACILITY_ONE, lot: LOT, quantityKg: "5000000" },
    fields: [
      { label: "Lot", value: "CR-0001" },
      { label: "Quantity", value: "5,000.000 t" },
    ],
    valid_until: String(NOW_SECONDS + 240),
    signers: [
      { role: "borrower", organisationId: orgId("khunou"), method: "text", scope: "PLEDGE" },
      { role: "lender", organisationId: orgId("lender-one"), method: "text", scope: "LEND" },
    ],
    signatures: [
      {
        role: "borrower",
        wallet: address(70),
        signature: signature(30),
        signedAt: "2026-11-26T00:00:05.000Z",
      },
    ],
    transaction_signature: null,
    error_code: null,
    created_at: "2026-11-26T00:00:02.000Z",
    updated_at: "2026-11-26T00:00:05.000Z",
    ...overrides,
  };
}

/**
 * Khunou's 5,000 t pledge to Lender One Bank, USD 600,000.00 advanced: the position's 5,000,000 kg
 * are locked. The rows are the ones Lender One Bank or Khunou reads (RLS, live-lending.md §6.2).
 */
export function pledgedSnapshot(members: Slug[] = ["lender-one"]): LiveSnapshot {
  const snapshot = issuedSnapshot(members);
  snapshot.positions = [
    position(KHUNOU_POSITION, "khunou", "5000000", { locked_kg: "5000000", revision: "1" }),
  ];
  snapshot.facilities = [facility(FACILITY_ONE, "lender-one", { loan_count: 1 })];
  snapshot.valuations = [valuation()];
  snapshot.loans = [loan(LOAN_ONE, FACILITY_ONE, "lender-one")];
  snapshot.locks = [lock(LOCK_ONE, LOAN_ONE, "5000000")];
  return snapshot;
}

// Loading rows (live-lending.md §6.10). CR-0001 after the 2,000 t sale, stored at Port Terminal T1's
// PORT-T1: Khunou's 3,000 t locked to Lender One Bank's loan 0, USD 200,000.00 accrued to NOW, and
// loading intent 1 with program-custody.md §6.2's document (64 x "a") at position revision 3.
// Accounts are n = 80 to 83.

export const LOADING_INTENT = address(80);
export const ACCEPTANCE_ONE = address(81);
export const LOADING_INTENT_OLD = address(82);
export const LOADING_DOCUMENT = "a".repeat(64);
export const LOADING_EXPIRES_AT = String(NOW_SECONDS + 86_400);

export function loadingIntent(
  overrides: Partial<ChainLoadingIntentRow> = {},
): ChainLoadingIntentRow {
  return {
    ...lending(13_400),
    address: LOADING_INTENT,
    lot: LOT,
    position: KHUNOU_POSITION,
    owner: orgAccount("khunou"),
    owner_org_id: orgId("khunou"),
    terminal: orgAccount("port-t1"),
    terminal_org_id: orgId("port-t1"),
    custodian_class: CUSTODIAN_CLASS,
    nonce: "1",
    quantity_kg: "3000000",
    locked_kg: "3000000",
    document_sha256_hex: LOADING_DOCUMENT,
    position_revision: "3",
    expires_at: LOADING_EXPIRES_AT,
    status: "Open",
    executed_at: null,
    cancelled_by: null,
    ...overrides,
  };
}

export function acceptance(
  overrides: Partial<ChainHandoffAcceptanceRow> = {},
): ChainHandoffAcceptanceRow {
  return {
    ...lending(13_500),
    address: ACCEPTANCE_ONE,
    intent: LOADING_INTENT,
    loan: LOAN_ONE,
    lock: LOCK_ONE,
    lender: orgAccount("lender-one"),
    lender_org_id: orgId("lender-one"),
    lock_quantity_kg: "3000000",
    loan_revision: "2",
    principal: "20000000",
    booked_interest: "0",
    accepted_at: String(NOW_SECONDS - 600),
    version: 1,
    event_version: 1,
    ...overrides,
  };
}

/** CR-0001 at Port Terminal T1 with Khunou's position locked to loan 0, and the given loading rows. */
export function loadingSnapshot(
  members: Slug[] = ["khunou"],
  intents: ChainLoadingIntentRow[] = [loadingIntent()],
  acceptances: ChainHandoffAcceptanceRow[] = [],
): LiveSnapshot {
  const snapshot = pledgedSnapshot(members);
  snapshot.custodianClasses = snapshot.custodianClasses.map((row) => ({
    ...row,
    custodian: orgAccount("port-t1"),
    custodian_org_id: orgId("port-t1"),
    site_code: "PORT-T1",
  }));
  snapshot.lots = [
    lotRow({
      custodian: orgAccount("port-t1"),
      custodian_org_id: orgId("port-t1"),
      revision: "1",
      event_revision: "1",
    }),
  ];
  snapshot.positions = [
    position(KHUNOU_POSITION, "khunou", "3000000", { locked_kg: "3000000", revision: "3" }),
    position(BUYER_POSITION, "buyer-smelter", "2000000"),
  ];
  snapshot.loans = [
    loan(LOAN_ONE, FACILITY_ONE, "lender-one", {
      principal: "20000000",
      accrued_at: String(NOW_SECONDS),
      revision: "2",
      event_revision: "2",
    }),
  ];
  snapshot.locks = [lock(LOCK_ONE, LOAN_ONE, "3000000")];
  snapshot.loadingIntents = intents;
  snapshot.acceptances = acceptances;
  return snapshot;
}
