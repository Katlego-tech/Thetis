// The field read routes against the local Supabase stack: real memberships, real RLS-free service
// reads of the chain read model, rows written straight into the projection tables. Every
// organisation, lot, quantity and address is synthetic test data; no RPC is called.
//
// The database holds one indexer stream (indexer_checkpoints_one_stream), so this file sets its
// own for the run and puts back whatever was there afterwards. Its chain rows carry a protocol
// of their own and are deleted at the end.
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { type Address, getAddressDecoder } from "@solana/kit";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CommandDependencies } from "../src/commands/routes.ts";
import { localSupabaseEnv } from "../src/local.ts";
import { route } from "../src/routes.ts";
import { type AccessClients, createAccessClients } from "../src/supabase.ts";

const origin = "http://localhost:3100";
const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
const namespace = randomUUID();
const password = "Thetis-local-integration-password";
const clientOptions = { auth: { autoRefreshToken: false, persistSession: false } };
const decoder = getAddressDecoder();
const addr = () => decoder.decode(randomBytes(32));
const hex = (bytes: number) => randomBytes(bytes).toString("hex");

const PROGRAM_ID = addr() as Address;
const PROTOCOL = addr() as Address;
const OTHER_PROTOCOL = addr();
const NOW_SECS = Math.floor(Date.now() / 1000);

const relay = {
  network: "devnet",
  programId: PROGRAM_ID,
  protocol: PROTOCOL,
  now: () => NOW_SECS * 1000,
} as unknown as CommandDependencies;

const TABLES = [
  "chain_handoff_acceptances",
  "chain_locks",
  "chain_loans",
  "chain_facilities",
  "chain_loading_intents",
  "chain_batches",
  "chain_shipments",
  "chain_lots",
  "chain_organisations",
];

type OrgKey = "custodian" | "carrier" | "terminal" | "owner" | "lender" | "outsider";
const ORGS: Record<OrgKey, { name: string; kind: string; role: string }> = {
  custodian: { name: "Kopano Stockpile", kind: "custodian", role: "Custodian" },
  carrier: { name: "Mosela Haulage", kind: "transporter", role: "Transporter" },
  terminal: { name: "Port Terminal T1", kind: "terminal", role: "Terminal" },
  owner: { name: "Bushveld Chrome Exports", kind: "exporter", role: "Exporter" },
  lender: { name: "Highveld Trade Finance", kind: "lender", role: "Lender" },
  outsider: { name: "Unrelated Buyer", kind: "buyer", role: "Buyer" },
};
const orgIds = {} as Record<OrgKey, string>;
const orgAddress = {} as Record<OrgKey, string>;
const tokens = {} as Record<OrgKey, string>;

let service: SupabaseClient;
let clients: AccessClients;
let savedCheckpoint: Record<string, unknown> | null = null;

function sql(statement: string) {
  execFileSync("supabase", ["db", "query", "--local", statement], {
    cwd: projectRoot,
    timeout: 15_000,
  });
}

const quote = (value: string | number | null) =>
  value === null ? "null" : typeof value === "number" ? String(value) : `'${value}'`;

function insert(table: string, row: Record<string, string | number | null>) {
  const full = {
    network: "devnet",
    address: addr(),
    protocol: PROTOCOL,
    slot: 1,
    commitment: "confirmed",
    ...row,
  };
  const columns = Object.keys(full);
  sql(
    `insert into public.${table} (${columns.join(", ")}) values (${columns
      .map((c) => quote(full[c as keyof typeof full]))
      .join(", ")})`,
  );
  return full.address as string;
}

const LOT_ID = `F${namespace.replaceAll("-", "").slice(0, 7).toUpperCase()}`;
const world = {} as {
  lot: string;
  position: string;
  shipment: string;
  batch: string;
  otherProtocolBatch: string;
  intent: string;
  executedIntent: string;
  acceptedLoan: string;
  missingLoan: string;
};

beforeAll(async () => {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = localSupabaseEnv();
  const hostname = new URL(API_URL).hostname;
  if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "[::1]") {
    throw new Error("API integration tests require a local Supabase API_URL");
  }
  vi.stubEnv("SUPABASE_URL", API_URL);
  vi.stubEnv("SUPABASE_ANON_KEY", ANON_KEY);
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);
  vi.stubEnv("SITE_URL", origin);
  vi.stubEnv("CORS_ORIGIN", origin);
  clients = createAccessClients();
  service = createClient(API_URL, SERVICE_ROLE_KEY, clientOptions);

  const users = {} as Record<OrgKey, string>;
  for (const key of Object.keys(ORGS) as OrgKey[]) {
    const email = `field-${key}-${namespace}@example.com`;
    const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error) throw created.error;
    users[key] = created.data.user.id;
    const client = createClient(API_URL, ANON_KEY, clientOptions);
    const signedIn = await client.auth.signInWithPassword({ email, password });
    if (signedIn.error) throw signedIn.error;
    tokens[key] = signedIn.data.session.access_token;
    orgIds[key] = randomUUID();
    orgAddress[key] = addr();
  }
  const keys = Object.keys(ORGS) as OrgKey[];
  // Production grants forbid membership inserts, so the local database is written directly.
  sql(
    `insert into public.organisations (id, slug, name, kind, synthetic) values ${keys
      .map(
        (k) =>
          `('${orgIds[k]}', 'field-${k}-${namespace}', '${ORGS[k].name}', '${ORGS[k].kind}', true)`,
      )
      .join(", ")}`,
  );
  sql(
    `insert into public.memberships (organisation_id, user_id, member_role) values ${keys
      .map((k) => `('${orgIds[k]}', '${users[k]}', 'member')`)
      .join(", ")}`,
  );

  // This run's stream: keep whatever stream the database had, then stand in for it.
  const existing = await service.from("indexer_checkpoints").select("*").maybeSingle();
  if (existing.error) throw new Error(existing.error.message);
  savedCheckpoint = existing.data;
  sql("delete from public.indexer_checkpoints");
  sql(
    `insert into public.indexer_checkpoints (network, program_id, protocol, status, indexed_through_slot)
     values ('devnet', '${PROGRAM_ID}', '${PROTOCOL}', 'live', 1)`,
  );

  for (const key of keys.filter((k) => k !== "outsider")) {
    insert("chain_organisations", {
      address: orgAddress[key],
      org_id: orgIds[key],
      role: ORGS[key].role,
      display_name: ORGS[key].name,
      admin: addr(),
    });
  }

  world.position = addr();
  world.lot = insert("chain_lots", {
    lot_id: LOT_ID,
    class_policy: addr(),
    class_version: 1,
    grade: "LG6",
    custodian_class: addr(),
    custodian: orgAddress.custodian,
    custodian_org_id: orgIds.custodian,
    intake: addr(),
    root: addr(),
    mint: addr(),
    supply_kg: "68000",
    state: "Stored",
    restriction: "Normal",
    expires_at: String(NOW_SECS + 86_400 * 90),
    revision: "3",
    live_children: 0,
    event_revision: "3",
    issued_owner: orgAddress.owner,
    issued_owner_org_id: orgIds.owner,
    issued_at: new Date(NOW_SECS * 1000).toISOString(),
  });
  const shipment = (protocol: string) => ({
    protocol,
    shipment_id_hex: hex(16),
    lot: world.lot,
    position: world.position,
    owner: orgAddress.owner,
    owner_org_id: orgIds.owner,
    source: addr(),
    source_custodian: orgAddress.custodian,
    source_custodian_org_id: orgIds.custodian,
    destination: addr(),
    destination_custodian: orgAddress.terminal,
    destination_custodian_org_id: orgIds.terminal,
    committed_kg: "34000",
    locked_kg: "0",
    batch_count: 1,
    manifest_root_hex: hex(32),
    departure_document: addr(),
    registered_count: 1,
    registered_kg: "34000",
    departed_count: 0,
    departed_kg: "0",
    arrived_count: 0,
    arrived_kg: "0",
    status: "Prepared",
    prepared_at: String(NOW_SECS - 600),
    revision: "1",
    event_revision: "1",
    event_registered: 1,
  });
  world.shipment = insert("chain_shipments", shipment(PROTOCOL));
  const otherShipment = insert("chain_shipments", shipment(OTHER_PROTOCOL));
  const batch = (protocol: string, shipmentAddress: string) => ({
    protocol,
    shipment: shipmentAddress,
    lot: world.lot,
    batch_index: 0,
    batch_count: 1,
    quantity_kg: "34000",
    carrier: orgAddress.carrier,
    load_digest_hex: hex(32),
    manifest_digest_hex: hex(32),
    holder: orgAddress.custodian,
    holder_org_id: orgIds.custodian,
    stage: "AtSource",
    sequence: "0",
    observation_count: 0,
    event_sequence: "0",
    event_observations: 0,
  });
  world.batch = insert("chain_batches", batch(PROTOCOL, world.shipment));
  world.otherProtocolBatch = insert("chain_batches", batch(OTHER_PROTOCOL, otherShipment));

  const intent = (status: string, executedAt: string | null) => ({
    lot: world.lot,
    position: world.position,
    owner: orgAddress.owner,
    owner_org_id: orgIds.owner,
    terminal: orgAddress.terminal,
    terminal_org_id: orgIds.terminal,
    custodian_class: addr(),
    nonce: "1",
    quantity_kg: "68000",
    locked_kg: "50000",
    document_sha256_hex: hex(32),
    position_revision: "4",
    expires_at: String(NOW_SECS + 3600),
    status,
    executed_at: executedAt,
  });
  world.intent = insert("chain_loading_intents", intent("Open", null));
  world.executedIntent = insert("chain_loading_intents", intent("Executed", String(NOW_SECS)));

  const facility = insert("chain_facilities", {
    lender: orgAddress.lender,
    lender_org_id: orgIds.lender,
    borrower: orgAddress.owner,
    borrower_org_id: orgIds.owner,
    facility_id_hex: hex(16),
    currency: "ZAR",
    currency_decimals: 2,
    terms_version: 1,
    rate_bps: 1150,
    max_ltv_bps: 7000,
    terms_digest_hex: hex(32),
    loan_count: 2,
  });
  const loan = (index: number) =>
    insert("chain_loans", {
      facility,
      lender_org_id: orgIds.lender,
      borrower: orgAddress.owner,
      borrower_org_id: orgIds.owner,
      lot: world.lot,
      position: world.position,
      loan_index: index,
      status: "Active",
      rate_bps: 1150,
      terms_version: 1,
      principal: "100000000",
      booked_interest: "0",
      accrual_remainder: "0",
      accrued_at: String(NOW_SECS - 60),
      open_exceptions: 0,
      revision: "2",
      event_revision: "2",
    });
  world.acceptedLoan = loan(0);
  world.missingLoan = loan(1);
  const lock = (loanAddress: string, quantity: string) =>
    insert("chain_locks", {
      loan: loanAddress,
      position: world.position,
      quantity_kg: quantity,
      control: "Pledged",
    });
  const acceptedLock = lock(world.acceptedLoan, "30000");
  lock(world.missingLoan, "20000");
  insert("chain_handoff_acceptances", {
    intent: world.intent,
    loan: world.acceptedLoan,
    lock: acceptedLock,
    lender: orgAddress.lender,
    lender_org_id: orgIds.lender,
    lock_quantity_kg: "30000",
    loan_revision: "2",
    principal: "100000000",
    booked_interest: "0",
    accepted_at: String(NOW_SECS - 30),
    version: 1,
    event_version: 1,
  });
}, 60_000);

afterAll(() => {
  for (const table of TABLES) {
    sql(`delete from public.${table} where protocol in ('${PROTOCOL}', '${OTHER_PROTOCOL}')`);
  }
  sql("delete from public.indexer_checkpoints");
  if (savedCheckpoint) {
    const json = JSON.stringify(savedCheckpoint).replaceAll("'", "''");
    sql(
      `insert into public.indexer_checkpoints select * from jsonb_populate_record(null::public.indexer_checkpoints, '${json}'::jsonb)`,
    );
  }
  vi.unstubAllEnvs();
  // One supabase CLI call per table: a cold CLI takes seconds each, past the 10 s default.
}, 60_000);

async function get(path: string, org: OrgKey, as: OrgKey = org) {
  const response = await route(
    {
      version: "2.0",
      routeKey: "$default",
      rawPath: path,
      rawQueryString: `organisationId=${orgIds[org]}`,
      headers: { origin, authorization: `Bearer ${tokens[as]}` },
      isBase64Encoded: false,
      requestContext: { requestId: randomUUID(), http: { method: "GET", path } },
    } as unknown as APIGatewayProxyEventV2,
    clients,
    async () => relay,
  );
  return { status: response.statusCode, body: JSON.parse(response.body ?? "null") };
}

describe("GET /v1/field/batches (local Supabase)", () => {
  it("lists the batch the custodian holds, from its indexed rows", async () => {
    const { status, body } = await get("/v1/field/batches", "custodian");
    expect(status).toBe(200);
    expect(body.data).toEqual([
      {
        batch: world.batch,
        shipment: world.shipment,
        lot: world.lot,
        lotId: LOT_ID,
        index: 1,
        batchCount: 1,
        quantityKg: "34000",
        stage: "AtSource",
        holder: orgAddress.custodian,
        holderName: "Kopano Stockpile",
        carrier: orgAddress.carrier,
        carrierName: "Mosela Haulage",
        destinationCustodian: orgAddress.terminal,
        destinationName: "Port Terminal T1",
        observationCount: 0,
        sequence: "0",
      },
    ]);
  });

  it("lists the same batch for the terminal it is coming to", async () => {
    const { body } = await get("/v1/field/batches", "terminal");
    expect(body.data.map((b: { batch: string }) => b.batch)).toEqual([world.batch]);
  });

  it("lists nothing for the carrier, which neither holds it nor receives it", async () => {
    const { body } = await get("/v1/field/batches", "carrier");
    expect(body).toEqual({ data: [] });
  });

  it("lists nothing for an organisation not on chain", async () => {
    const { body } = await get("/v1/field/batches", "outsider");
    expect(body).toEqual({ data: [] });
  });

  it("refuses a caller who is not a member of the organisation", async () => {
    const { status, body } = await get("/v1/field/batches", "custodian", "outsider");
    expect(status).toBe(403);
    expect(body.error.code).toBe("NOT_AUTHORISED");
  });
});

describe("GET /v1/field/loading-intents (local Supabase)", () => {
  it("lists the open intent at the terminal with one accepted and one missing acceptance", async () => {
    const { status, body } = await get("/v1/field/loading-intents", "terminal");
    expect(status).toBe(200);
    expect(body.data).toHaveLength(1);
    const [row] = body.data;
    expect(row).toMatchObject({
      intent: world.intent,
      lot: world.lot,
      lotId: LOT_ID,
      quantityKg: "68000",
      lockedKg: "50000",
      owner: orgAddress.owner,
      ownerName: "Bushveld Chrome Exports",
      terminalName: "Port Terminal T1",
      nonce: "1",
      expiresAt: String(NOW_SECS + 3600),
    });
    expect(row.documentSha256).toMatch(/^[0-9a-f]{64}$/);
    const byLoan = Object.fromEntries(
      row.acceptances.map((a: { loan: string; state: string; lockKg: string }) => [a.loan, a]),
    );
    expect(byLoan[world.acceptedLoan]).toEqual({
      lender: orgAddress.lender,
      lenderName: "Highveld Trade Finance",
      loan: world.acceptedLoan,
      lockKg: "30000",
      state: "accepted",
    });
    expect(byLoan[world.missingLoan]).toMatchObject({ lockKg: "20000", state: "missing" });
  });

  it("lists nothing for an organisation that is not the terminal", async () => {
    const { body } = await get("/v1/field/loading-intents", "owner");
    expect(body).toEqual({ data: [] });
  });

  it("refuses a caller who is not a member of the terminal", async () => {
    const { status } = await get("/v1/field/loading-intents", "terminal", "custodian");
    expect(status).toBe(403);
  });
});

describe("field read routes while the stream is not live (local Supabase)", () => {
  it("answers CHAIN_UNAVAILABLE during a backfill", async () => {
    sql(
      `update public.indexer_checkpoints set status = 'backfilling' where protocol = '${PROTOCOL}'`,
    );
    try {
      for (const path of ["/v1/field/batches", "/v1/field/loading-intents"]) {
        const { status, body } = await get(path, "terminal");
        expect(status).toBe(503);
        expect(body.error.code).toBe("CHAIN_UNAVAILABLE");
      }
    } finally {
      sql(`update public.indexer_checkpoints set status = 'live' where protocol = '${PROTOCOL}'`);
    }
  });
});
