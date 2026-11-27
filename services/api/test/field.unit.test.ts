// The field app's two read routes (field-app.md §6.3 "Read routes", and its read-route folds):
// GET /v1/field/batches and GET /v1/field/loading-intents, against a stubbed read-model store.
// Every organisation, lot, quantity and address here is synthetic test data.
import { type Address, getAddressDecoder } from "@solana/kit";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { describe, expect, it, vi } from "vitest";
import { ChainUnavailableError } from "../src/commands/chain.ts";
import type { CommandDependencies } from "../src/commands/routes.ts";
import type {
  AcceptanceRow,
  BatchRow,
  FacilityRow,
  FieldScope,
  FieldStore,
  IntentRow,
  LoanRow,
  LockRow,
  LotRow,
  OrganisationRow,
  ShipmentRow,
} from "../src/field.ts";
import { route } from "../src/routes.ts";
import type { AccessClients } from "../src/supabase.ts";

const decoder = getAddressDecoder();
/** A 32-byte address from a whole number, big-endian. */
function addressOf(value: bigint): string {
  const bytes = new Uint8Array(32);
  let rest = value;
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return decoder.decode(bytes);
}
const at = (n: number) => addressOf(BigInt(n) * 1_000_003n + 7n);

const PROGRAM_ID = at(1) as Address;
const PROTOCOL = at(2) as Address;
const SCOPE: FieldScope = { network: "devnet", programId: PROGRAM_ID, protocol: PROTOCOL };
const NOW_MS = 1_800_000_000_000;
const NOW_SECS = NOW_MS / 1000;

const USER = "4b3c0c1e-6f5a-4d36-9a63-1b0f8f0c2a01";
const CUSTODIAN_ORG = "b1930ef0-7812-46cf-9fdc-663acc67daa1";
const TERMINAL_ORG = "c2a41f01-8923-47d0-8aed-774bdd78ebb2";
const OTHER_ORG = "d3b52a12-9a34-48e1-9bfe-885cee89fcc3";

const ORG = {
  custodian: { address: at(10), org_id: CUSTODIAN_ORG, display_name: "Kopano Stockpile" },
  carrier: { address: at(11), org_id: OTHER_ORG, display_name: "Mosela Haulage" },
  terminal: { address: at(12), org_id: TERMINAL_ORG, display_name: "Port Terminal T1" },
  owner: {
    address: at(13),
    org_id: "e4c63b23-ab45-49f2-8c0f-996df09a0dd4",
    display_name: "Bushveld Chrome Exports",
  },
  lenderA: {
    address: at(14),
    org_id: "f5d74c34-bc56-4a03-9d10-aa7e01ab1ee5",
    display_name: "Highveld Trade Finance",
  },
  lenderB: {
    address: at(15),
    org_id: "a6e85d45-cd67-4b14-8e21-bb8f12bc2ff6",
    display_name: "Limpopo Commodity Bank",
  },
} satisfies Record<string, OrganisationRow>;

const LOT = { address: at(20), lot_id: "CR-0001" } satisfies LotRow;
const LOT_2 = { address: at(21), lot_id: "CR-0002" } satisfies LotRow;

function shipment(n: number, patch: Partial<ShipmentRow> = {}): ShipmentRow {
  return {
    address: at(30 + n),
    lot: LOT.address,
    destination_custodian: ORG.terminal.address,
    status: "InTransit",
    ...patch,
  };
}

function batch(n: number, patch: Partial<BatchRow> = {}): BatchRow {
  return {
    address: at(40 + n),
    shipment: at(31),
    lot: LOT.address,
    batch_index: 0,
    batch_count: 2,
    quantity_kg: "34000",
    carrier: ORG.carrier.address,
    holder: ORG.custodian.address,
    stage: "AtSource",
    sequence: "0",
    observation_count: 0,
    ...patch,
  };
}

interface Tables {
  members: { userId: string; organisationId: string }[];
  checkpoint: "backfilling" | "live" | "halted" | null;
  organisations: OrganisationRow[];
  shipments: ShipmentRow[];
  batches: BatchRow[];
  lots: LotRow[];
  intents: IntentRow[];
  locks: LockRow[];
  loans: LoanRow[];
  facilities: FacilityRow[];
  acceptances: AcceptanceRow[];
}

function tables(patch: Partial<Tables> = {}): Tables {
  return {
    members: [
      { userId: USER, organisationId: CUSTODIAN_ORG },
      { userId: USER, organisationId: TERMINAL_ORG },
    ],
    checkpoint: "live",
    organisations: Object.values(ORG),
    shipments: [],
    batches: [],
    lots: [LOT, LOT_2],
    intents: [],
    locks: [],
    loans: [],
    facilities: [],
    acceptances: [],
    ...patch,
  };
}

/** The store as thin table readers; every filter the route applies is in the route, not here. */
function stubStore(t: Tables) {
  const scopes: FieldScope[] = [];
  const seen = (scope: FieldScope) => {
    scopes.push(scope);
  };
  const store: FieldStore = {
    isMember: vi.fn(async (userId: string, organisationId: string) =>
      t.members.some((m) => m.userId === userId && m.organisationId === organisationId),
    ),
    checkpointStatus: vi.fn(async (scope: FieldScope) => {
      seen(scope);
      return t.checkpoint;
    }),
    organisationByOrgId: vi.fn(async (scope: FieldScope, orgId: string) => {
      seen(scope);
      return t.organisations.find((o) => o.org_id === orgId) ?? null;
    }),
    organisationsAt: vi.fn(async (scope: FieldScope, addresses: string[]) => {
      seen(scope);
      return t.organisations.filter((o) => addresses.includes(o.address));
    }),
    shipmentsTo: vi.fn(async (scope: FieldScope, custodian: string) => {
      seen(scope);
      return t.shipments.filter((s) => s.destination_custodian === custodian);
    }),
    shipmentsAt: vi.fn(async (scope: FieldScope, addresses: string[]) => {
      seen(scope);
      return t.shipments.filter((s) => addresses.includes(s.address));
    }),
    batchesHeldBy: vi.fn(async (scope: FieldScope, holder: string) => {
      seen(scope);
      return t.batches.filter((b) => b.holder === holder);
    }),
    batchesOf: vi.fn(async (scope: FieldScope, shipments: string[]) => {
      seen(scope);
      return t.batches.filter((b) => shipments.includes(b.shipment));
    }),
    lotsAt: vi.fn(async (scope: FieldScope, addresses: string[]) => {
      seen(scope);
      return t.lots.filter((l) => addresses.includes(l.address));
    }),
    intentsAt: vi.fn(async (scope: FieldScope, terminal: string) => {
      seen(scope);
      return t.intents.filter((i) => i.terminal === terminal);
    }),
    locksOf: vi.fn(async (scope: FieldScope, positions: string[]) => {
      seen(scope);
      return t.locks.filter((l) => positions.includes(l.position));
    }),
    loansAt: vi.fn(async (scope: FieldScope, addresses: string[]) => {
      seen(scope);
      return t.loans.filter((l) => addresses.includes(l.address));
    }),
    facilitiesAt: vi.fn(async (scope: FieldScope, addresses: string[]) => {
      seen(scope);
      return t.facilities.filter((f) => addresses.includes(f.address));
    }),
    acceptancesOf: vi.fn(async (scope: FieldScope, intents: string[]) => {
      seen(scope);
      return t.acceptances.filter((a) => intents.includes(a.intent));
    }),
  };
  return { store, scopes };
}

const relay = {
  network: "devnet",
  programId: PROGRAM_ID,
  protocol: PROTOCOL,
  now: () => NOW_MS,
} as unknown as CommandDependencies;

function clients(userId: string | null = USER) {
  return {
    siteUrl: "http://localhost:3100",
    corsOrigin: "http://localhost:3100",
    service: {
      auth: {
        getUser: vi.fn(async () =>
          userId
            ? { data: { user: { id: userId } }, error: null }
            : { data: { user: null }, error: { status: 401 } },
        ),
      },
    },
    caller: () => ({}),
  } as unknown as AccessClients;
}

function event(
  path: string,
  query: string,
  options: { method?: string; token?: string | null; body?: string } = {},
): APIGatewayProxyEventV2 {
  const token = options.token === undefined ? "field-token" : options.token;
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: path,
    rawQueryString: query,
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
    ...(options.body !== undefined && { body: options.body }),
    isBase64Encoded: false,
    requestContext: { requestId: "field-unit", http: { method: options.method ?? "GET", path } },
  } as unknown as APIGatewayProxyEventV2;
}

async function call(
  t: Tables,
  path: string,
  query: string,
  options: Parameters<typeof event>[2] & {
    deps?: () => Promise<CommandDependencies>;
    userId?: string | null;
  } = {},
) {
  const { store, scopes } = stubStore(t);
  const result = await route(
    event(path, query, options),
    clients(options.userId === undefined ? USER : options.userId),
    options.deps ?? (async () => relay),
    () => store,
  );
  return { status: result.statusCode, body: JSON.parse(result.body ?? "null"), store, scopes };
}

const BATCHES = "/v1/field/batches";
const INTENTS = "/v1/field/loading-intents";
const q = (organisationId: string) => `organisationId=${organisationId}`;

const BATCH_KEYS = [
  "batch",
  "shipment",
  "lot",
  "lotId",
  "index",
  "batchCount",
  "quantityKg",
  "stage",
  "holder",
  "holderName",
  "carrier",
  "carrierName",
  "destinationCustodian",
  "destinationName",
  "observationCount",
  "sequence",
].sort();
const INTENT_KEYS = [
  "intent",
  "lot",
  "lotId",
  "quantityKg",
  "lockedKg",
  "owner",
  "ownerName",
  "terminalName",
  "documentSha256",
  "nonce",
  "expiresAt",
  "acceptances",
].sort();
const ACCEPTANCE_KEYS = ["lender", "lenderName", "loan", "lockKg", "state"].sort();

describe("field read routes: request parsing", () => {
  it.each([
    ["no query", ""],
    ["an empty organisationId", "organisationId="],
    ["an organisationId that is not a uuid", "organisationId=kopano"],
    ["an upper-case uuid", `organisationId=${CUSTODIAN_ORG.toUpperCase()}`],
    ["a repeated organisationId", `${q(CUSTODIAN_ORG)}&${q(CUSTODIAN_ORG)}`],
    ["an extra parameter", `${q(CUSTODIAN_ORG)}&limit=5`],
    ["a misspelt key", `organisationid=${CUSTODIAN_ORG}`],
  ])("refuses %s with VALIDATION", async (_, query) => {
    for (const path of [BATCHES, INTENTS]) {
      const { status, body, store } = await call(tables(), path, query);
      expect(status).toBe(400);
      expect(body).toMatchObject({ error: { code: "VALIDATION", detail: "organisationId" } });
      expect(store.isMember).not.toHaveBeenCalled();
    }
  });

  it("refuses a request body with VALIDATION", async () => {
    const { status, body } = await call(tables(), BATCHES, q(CUSTODIAN_ORG), {
      body: JSON.stringify({ organisationId: CUSTODIAN_ORG }),
    });
    expect(status).toBe(400);
    expect(body).toMatchObject({ error: { code: "VALIDATION" } });
  });

  it.each([
    ["POST", BATCHES],
    ["POST", INTENTS],
    ["GET", "/v1/field"],
    ["GET", "/v1/field/"],
    ["GET", "/v1/field/shipments"],
    ["GET", `${BATCHES}/extra`],
    ["GET", `${INTENTS}/`],
  ])("answers %s %s with NOT_FOUND", async (method, path) => {
    const { status, body } = await call(tables(), path, q(CUSTODIAN_ORG), { method });
    expect(status).toBe(404);
    expect(body).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("decodes a percent-encoded organisationId", async () => {
    const { status } = await call(
      tables(),
      BATCHES,
      `organisationId=${encodeURIComponent(CUSTODIAN_ORG)}`,
    );
    expect(status).toBe(200);
  });
});

describe("field read routes: who may read", () => {
  it("needs a bearer token", async () => {
    for (const path of [BATCHES, INTENTS]) {
      const { status, body } = await call(tables(), path, q(CUSTODIAN_ORG), { token: null });
      expect(status).toBe(401);
      expect(body).toMatchObject({ error: { code: "NOT_AUTHENTICATED" } });
    }
  });

  it("refuses an invalid session", async () => {
    const { status } = await call(tables(), BATCHES, q(CUSTODIAN_ORG), { userId: null });
    expect(status).toBe(401);
  });

  it("refuses a caller who is not a member, before reading any chain row", async () => {
    for (const path of [BATCHES, INTENTS]) {
      const { status, body, store } = await call(tables(), path, q(OTHER_ORG));
      expect(status).toBe(403);
      expect(body).toMatchObject({ error: { code: "NOT_AUTHORISED" } });
      expect(store.isMember).toHaveBeenCalledWith(USER, OTHER_ORG);
      expect(store.checkpointStatus).not.toHaveBeenCalled();
      expect(store.organisationByOrgId).not.toHaveBeenCalled();
    }
  });

  it("refuses a revoked member (the store answers false)", async () => {
    const { status } = await call(tables({ members: [] }), BATCHES, q(CUSTODIAN_ORG));
    expect(status).toBe(403);
  });
});

describe("field read routes: the read model must stand for the chain", () => {
  it.each([
    ["halted", "halted"],
    ["backfilling", "backfilling"],
    ["missing", null],
  ] as const)("answers CHAIN_UNAVAILABLE when the stream is %s", async (_, checkpoint) => {
    for (const path of [BATCHES, INTENTS]) {
      const { status, body, store } = await call(tables({ checkpoint }), path, q(CUSTODIAN_ORG));
      expect(status).toBe(503);
      expect(body).toMatchObject({ error: { code: "CHAIN_UNAVAILABLE" } });
      expect(store.organisationByOrgId).not.toHaveBeenCalled();
    }
  });

  it("answers CHAIN_UNAVAILABLE when the relay can't reach devnet", async () => {
    const { status, body } = await call(tables(), BATCHES, q(CUSTODIAN_ORG), {
      deps: async () => {
        throw new ChainUnavailableError(new Error("offline"));
      },
    });
    expect(status).toBe(503);
    expect(body).toMatchObject({ error: { code: "CHAIN_UNAVAILABLE" } });
  });

  it("reads only this instance's network, program and protocol", async () => {
    const { scopes } = await call(
      tables({ shipments: [shipment(1)], batches: [batch(1, { shipment: at(31) })] }),
      BATCHES,
      q(CUSTODIAN_ORG),
    );
    expect(scopes.length).toBeGreaterThan(0);
    for (const scope of scopes) expect(scope).toEqual(SCOPE);
  });

  it("logs a store failure and answers INTERNAL without its detail", async () => {
    const t = tables();
    const { store } = stubStore(t);
    store.checkpointStatus = async () => {
      throw new Error("connection refused");
    };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await route(
      event(BATCHES, q(CUSTODIAN_ORG)),
      clients(),
      async () => relay,
      () => store,
    );
    log.mockRestore();
    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body ?? "")).toEqual({
      error: { code: "INTERNAL", message: "An internal error occurred." },
    });
  });
});

describe("GET /v1/field/batches", () => {
  it("answers an empty list when the organisation is not on chain", async () => {
    const { status, body } = await call(
      tables({ organisations: [ORG.carrier, ORG.terminal], batches: [batch(1)] }),
      BATCHES,
      q(CUSTODIAN_ORG),
    );
    expect(status).toBe(200);
    expect(body).toEqual({ data: [] });
  });

  it("returns a held batch in the contract's shape, every value from its rows", async () => {
    const { status, body } = await call(
      tables({
        shipments: [shipment(1)],
        batches: [
          batch(1, {
            batch_index: 1,
            batch_count: 3,
            quantity_kg: "33500",
            sequence: "2",
            observation_count: 4,
            stage: "InTransit",
          }),
        ],
      }),
      BATCHES,
      q(CUSTODIAN_ORG),
    );
    expect(status).toBe(200);
    expect(body.data).toHaveLength(1);
    const [row] = body.data;
    expect(Object.keys(row).sort()).toEqual(BATCH_KEYS);
    expect(row).toEqual({
      batch: at(41),
      shipment: at(31),
      lot: LOT.address,
      lotId: "CR-0001",
      index: 2,
      batchCount: 3,
      quantityKg: "33500",
      stage: "InTransit",
      holder: ORG.custodian.address,
      holderName: "Kopano Stockpile",
      carrier: ORG.carrier.address,
      carrierName: "Mosela Haulage",
      destinationCustodian: ORG.terminal.address,
      destinationName: "Port Terminal T1",
      observationCount: 4,
      sequence: "2",
    });
  });

  it("numbers the batch from one: the chain's index 0 is batch 1 of n", async () => {
    const { body } = await call(
      tables({ shipments: [shipment(1)], batches: [batch(1, { batch_index: 0, batch_count: 1 })] }),
      BATCHES,
      q(CUSTODIAN_ORG),
    );
    expect(body.data[0]).toMatchObject({ index: 1, batchCount: 1 });
  });

  it("includes batches of open shipments arriving at the organisation (a terminal)", async () => {
    const { body } = await call(
      tables({
        shipments: [shipment(1), shipment(2, { status: "Prepared" })],
        batches: [
          batch(1, { holder: ORG.carrier.address, stage: "InTransit" }),
          batch(2, { shipment: at(32), holder: ORG.custodian.address }),
        ],
      }),
      BATCHES,
      q(TERMINAL_ORG),
    );
    expect(body.data.map((b: { batch: string }) => b.batch).sort()).toEqual(
      [at(41), at(42)].sort(),
    );
    expect(body.data.find((b: { batch: string }) => b.batch === at(41))).toMatchObject({
      holder: ORG.carrier.address,
      holderName: "Mosela Haulage",
      destinationName: "Port Terminal T1",
    });
  });

  it("leaves out batches of shipments that are Arrived or Cancelled", async () => {
    const { body } = await call(
      tables({
        shipments: [
          shipment(1, { status: "Arrived" }),
          shipment(2, { status: "Cancelled" }),
          shipment(3, { status: "Prepared" }),
          shipment(4, { status: "InTransit" }),
        ],
        batches: [
          batch(1, { shipment: at(31) }),
          batch(2, { shipment: at(32) }),
          batch(3, { shipment: at(33) }),
          batch(4, { shipment: at(34), stage: "InTransit" }),
        ],
      }),
      BATCHES,
      q(CUSTODIAN_ORG),
    );
    expect(body.data.map((b: { batch: string }) => b.batch).sort()).toEqual(
      [at(43), at(44)].sort(),
    );
  });

  it("keeps an Arrived batch while its shipment is still open", async () => {
    const { body } = await call(
      tables({
        shipments: [shipment(1)],
        batches: [batch(1, { holder: ORG.terminal.address, stage: "Arrived", sequence: "3" })],
      }),
      BATCHES,
      q(TERMINAL_ORG),
    );
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ stage: "Arrived", holderName: "Port Terminal T1" });
  });

  it("leaves out batches another organisation holds on a shipment to elsewhere", async () => {
    const elsewhere = shipment(1, { destination_custodian: ORG.owner.address });
    const { body } = await call(
      tables({
        shipments: [elsewhere],
        batches: [batch(1, { holder: ORG.carrier.address })],
      }),
      BATCHES,
      q(CUSTODIAN_ORG),
    );
    expect(body).toEqual({ data: [] });
  });

  it("lists a batch once when it is both held by and arriving at the organisation", async () => {
    const { body } = await call(
      tables({
        shipments: [shipment(1)],
        batches: [batch(1, { holder: ORG.terminal.address, stage: "Arrived" })],
      }),
      BATCHES,
      q(TERMINAL_ORG),
    );
    expect(body.data).toHaveLength(1);
  });

  it("orders by lot id, then shipment, then batch number", async () => {
    const { body } = await call(
      tables({
        shipments: [shipment(1), shipment(2, { lot: LOT_2.address })],
        batches: [
          batch(1, { shipment: at(32), lot: LOT_2.address, batch_index: 0 }),
          batch(2, { batch_index: 1 }),
          batch(3, { batch_index: 0 }),
        ],
      }),
      BATCHES,
      q(CUSTODIAN_ORG),
    );
    expect(body.data.map((b: { lotId: string; index: number }) => `${b.lotId}:${b.index}`)).toEqual(
      ["CR-0001:1", "CR-0001:2", "CR-0002:1"],
    );
  });

  it("answers INTERNAL rather than invent a lot id or a name it can't read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const noLot = await call(
      tables({ lots: [], shipments: [shipment(1)], batches: [batch(1)] }),
      BATCHES,
      q(CUSTODIAN_ORG),
    );
    expect(noLot.status).toBe(500);
    const noCarrier = await call(
      tables({
        organisations: [ORG.custodian, ORG.terminal],
        shipments: [shipment(1)],
        batches: [batch(1)],
      }),
      BATCHES,
      q(CUSTODIAN_ORG),
    );
    expect(noCarrier.status).toBe(500);
    vi.restoreAllMocks();
  });

  it("answers INTERNAL when a batch names a shipment the read model lacks", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { status } = await call(tables({ batches: [batch(1)] }), BATCHES, q(CUSTODIAN_ORG));
    expect(status).toBe(500);
    vi.restoreAllMocks();
  });
});

// ------------------------------------------------------------------ loading intents

const POSITION = at(60);
const INTENT = at(61);
const DOC = "ab".repeat(32);

function intent(patch: Partial<IntentRow> = {}): IntentRow {
  return {
    address: INTENT,
    lot: LOT.address,
    position: POSITION,
    owner: ORG.owner.address,
    terminal: ORG.terminal.address,
    nonce: "7",
    quantity_kg: "68000",
    locked_kg: "50000",
    document_sha256_hex: DOC,
    expires_at: String(NOW_SECS + 3600),
    status: "Open",
    cancelled_by: null,
    ...patch,
  };
}

// Two loans whose base58 order is the reverse of their raw byte order: 58^43 − 1 encodes as 43
// 'z' characters, 58^43 as "2" followed by 43 '1's, so a string sort would put the second first.
const LOAN_LOW = addressOf(58n ** 43n - 1n);
const LOAN_HIGH = addressOf(58n ** 43n);
const LOAN_ZERO = at(70);
const FACILITY_A = at(71);
const FACILITY_B = at(72);
const LOCK_LOW = at(73);
const LOCK_HIGH = at(74);
const LOCK_ZERO = at(75);

function loadingWorld(patch: Partial<Tables> = {}): Tables {
  return tables({
    intents: [intent()],
    locks: [
      { address: LOCK_HIGH, loan: LOAN_HIGH, position: POSITION, quantity_kg: "20000" },
      { address: LOCK_LOW, loan: LOAN_LOW, position: POSITION, quantity_kg: "30000" },
      { address: LOCK_ZERO, loan: LOAN_ZERO, position: POSITION, quantity_kg: "0" },
    ],
    loans: [
      { address: LOAN_LOW, facility: FACILITY_A, revision: "5" },
      { address: LOAN_HIGH, facility: FACILITY_B, revision: "9" },
      { address: LOAN_ZERO, facility: FACILITY_A, revision: "1" },
    ],
    facilities: [
      { address: FACILITY_A, lender: ORG.lenderA.address },
      { address: FACILITY_B, lender: ORG.lenderB.address },
    ],
    acceptances: [
      {
        address: at(80),
        intent: INTENT,
        loan: LOAN_LOW,
        lock: LOCK_LOW,
        lender: ORG.lenderA.address,
        lock_quantity_kg: "30000",
        loan_revision: "5",
      },
    ],
    ...patch,
  });
}

describe("GET /v1/field/loading-intents", () => {
  it("returns an open intent at this terminal in the contract's shape", async () => {
    const { status, body } = await call(loadingWorld(), INTENTS, q(TERMINAL_ORG));
    expect(status).toBe(200);
    expect(body.data).toHaveLength(1);
    const [row] = body.data;
    expect(Object.keys(row).sort()).toEqual(INTENT_KEYS);
    for (const a of row.acceptances) expect(Object.keys(a).sort()).toEqual(ACCEPTANCE_KEYS);
    expect(row).toEqual({
      intent: INTENT,
      lot: LOT.address,
      lotId: "CR-0001",
      quantityKg: "68000",
      lockedKg: "50000",
      owner: ORG.owner.address,
      ownerName: "Bushveld Chrome Exports",
      terminalName: "Port Terminal T1",
      documentSha256: DOC,
      nonce: "7",
      expiresAt: String(NOW_SECS + 3600),
      acceptances: [
        {
          lender: ORG.lenderA.address,
          lenderName: "Highveld Trade Finance",
          loan: LOAN_LOW,
          lockKg: "30000",
          state: "accepted",
        },
        {
          lender: ORG.lenderB.address,
          lenderName: "Limpopo Commodity Bank",
          loan: LOAN_HIGH,
          lockKg: "20000",
          state: "missing",
        },
      ],
    });
  });

  it("orders acceptances by the raw loan key, as the loading's triples are", async () => {
    expect(LOAN_HIGH < LOAN_LOW).toBe(true); // the string order disagrees
    const { body } = await call(loadingWorld(), INTENTS, q(TERMINAL_ORG));
    expect(body.data[0].acceptances.map((a: { loan: string }) => a.loan)).toEqual([
      LOAN_LOW,
      LOAN_HIGH,
    ]);
  });

  it("leaves out a lock of zero", async () => {
    const { body } = await call(loadingWorld(), INTENTS, q(TERMINAL_ORG));
    expect(body.data[0].acceptances.map((a: { loan: string }) => a.loan)).not.toContain(LOAN_ZERO);
  });

  it("lists no acceptances when nothing is locked", async () => {
    const { body } = await call(
      loadingWorld({ locks: [], acceptances: [] }),
      INTENTS,
      q(TERMINAL_ORG),
    );
    expect(body.data[0].acceptances).toEqual([]);
  });

  it("marks an acceptance stale when the loan revision has moved", async () => {
    const t = loadingWorld();
    t.loans = t.loans.map((l) => (l.address === LOAN_LOW ? { ...l, revision: "6" } : l));
    const { body } = await call(t, INTENTS, q(TERMINAL_ORG));
    expect(body.data[0].acceptances[0]).toMatchObject({ loan: LOAN_LOW, state: "stale" });
  });

  it("marks an acceptance stale when the lock quantity has changed, and shows the lock now", async () => {
    const t = loadingWorld();
    t.locks = t.locks.map((l) => (l.address === LOCK_LOW ? { ...l, quantity_kg: "25000" } : l));
    const { body } = await call(t, INTENTS, q(TERMINAL_ORG));
    expect(body.data[0].acceptances[0]).toMatchObject({
      loan: LOAN_LOW,
      lockKg: "25000",
      state: "stale",
    });
  });

  it("counts an acceptance that names another lock as missing", async () => {
    const t = loadingWorld();
    t.acceptances = t.acceptances.map((a) => ({ ...a, lock: LOCK_ZERO }));
    const { body } = await call(t, INTENTS, q(TERMINAL_ORG));
    expect(body.data[0].acceptances[0]).toMatchObject({ loan: LOAN_LOW, state: "missing" });
  });

  it("ignores an acceptance of another intent", async () => {
    const t = loadingWorld();
    t.acceptances = t.acceptances.map((a) => ({ ...a, intent: at(62) }));
    const { body } = await call(t, INTENTS, q(TERMINAL_ORG));
    expect(body.data[0].acceptances[0]).toMatchObject({ loan: LOAN_LOW, state: "missing" });
  });

  it.each([
    ["executed", { status: "Executed" }],
    ["cancelled", { cancelled_by: ORG.owner.address }],
    ["expired now", { expires_at: String(NOW_SECS) }],
    ["expired earlier", { expires_at: String(NOW_SECS - 1) }],
    ["at another terminal", { terminal: ORG.custodian.address }],
  ] as const)("leaves out an intent that is %s", async (_, patch) => {
    const { status, body } = await call(
      loadingWorld({ intents: [intent(patch as Partial<IntentRow>)] }),
      INTENTS,
      q(TERMINAL_ORG),
    );
    expect(status).toBe(200);
    expect(body).toEqual({ data: [] });
  });

  it("keeps an intent one second before it expires", async () => {
    const { body } = await call(
      loadingWorld({ intents: [intent({ expires_at: String(NOW_SECS + 1) })] }),
      INTENTS,
      q(TERMINAL_ORG),
    );
    expect(body.data).toHaveLength(1);
  });

  it("answers an empty list when the terminal organisation is not on chain", async () => {
    const { body } = await call(
      loadingWorld({ organisations: [ORG.owner, ORG.lenderA, ORG.lenderB] }),
      INTENTS,
      q(TERMINAL_ORG),
    );
    expect(body).toEqual({ data: [] });
  });

  it("orders intents by expiry, then address", async () => {
    const second = at(63);
    const first = at(64);
    const { body } = await call(
      loadingWorld({
        intents: [
          intent({ address: second, expires_at: String(NOW_SECS + 900) }),
          intent({ address: first, expires_at: String(NOW_SECS + 600) }),
        ],
      }),
      INTENTS,
      q(TERMINAL_ORG),
    );
    expect(body.data.map((i: { intent: string }) => i.intent)).toEqual([first, second]);
  });

  it("answers INTERNAL rather than invent a lender it can't read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const noFacility = await call(loadingWorld({ facilities: [] }), INTENTS, q(TERMINAL_ORG));
    expect(noFacility.status).toBe(500);
    const noLoan = await call(loadingWorld({ loans: [] }), INTENTS, q(TERMINAL_ORG));
    expect(noLoan.status).toBe(500);
    const noOwnerName = await call(
      loadingWorld({ organisations: [ORG.terminal, ORG.lenderA, ORG.lenderB] }),
      INTENTS,
      q(TERMINAL_ORG),
    );
    expect(noOwnerName.status).toBe(500);
    vi.restoreAllMocks();
  });
});
