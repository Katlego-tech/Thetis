import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { loadLiveSnapshot } from "@/data/live/load";
import { LiveDataError } from "@/data/live/types";
import { checkpoint, ENV, fakeSupabase, issuedSnapshot, PROGRAM_ID, PROTOCOL } from "./snapshot";

const server = vi.hoisted(() => ({ client: null as unknown, calls: 0 }));
vi.mock("@/lib/supabase-server", () => ({
  supabaseServer: async () => {
    server.calls += 1;
    if (server.client instanceof Error) throw server.client;
    return server.client;
  },
}));

const { loadReader, requireReader } = await import("@/data/load-reader");

const chainTables = [
  "chain_organisations",
  "chain_protocols",
  "chain_class_policies",
  "chain_custodian_classes",
  "chain_lots",
  "chain_positions",
  "chain_intakes",
  "chain_documents",
  "chain_facilities",
  "chain_valuations",
  "chain_loans",
  "chain_locks",
  "chain_payments",
  "chain_release_intents",
  "chain_loading_intents",
  "chain_handoff_acceptances",
];

function liveEnvironment() {
  vi.stubEnv("THETIS_DATA_SOURCE", "live");
  vi.stubEnv("THETIS_NETWORK", "devnet");
  vi.stubEnv("THETIS_PROGRAM_ID", PROGRAM_ID);
  vi.stubEnv("THETIS_PROTOCOL", PROTOCOL);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "synthetic-anon-key");
}

beforeEach(() => {
  server.client = null;
  server.calls = 0;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("loadLiveSnapshot", () => {
  test("a missing checkpoint, or one that has not reported, empties every chain field", async () => {
    const empty = {
      organisations: [],
      protocol: null,
      classPolicies: [],
      custodianClasses: [],
      lots: [],
      positions: [],
      intakes: [],
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
      intakeEvents: [],
    };

    const missing = fakeSupabase(issuedSnapshot());
    missing.tables.indexer_checkpoints = [];
    const withoutCheckpoint = await loadLiveSnapshot(missing.client, ENV);
    expect(withoutCheckpoint).toEqual({
      env: ENV,
      memberships: issuedSnapshot().memberships,
      ...empty,
      checkpoint: null,
    });
    expect(missing.calls.map(({ table }) => table)).toEqual([
      "organisations",
      "indexer_checkpoints",
      "commands",
    ]);

    const unreported = fakeSupabase(issuedSnapshot());
    const firstStart = checkpoint({
      status: "backfilling",
      last_success_at: null,
      indexed_through_slot: 11_000,
    });
    unreported.tables.indexer_checkpoints = [{ ...firstStart }];
    const notReported = await loadLiveSnapshot(unreported.client, ENV);
    expect(notReported).toMatchObject({ ...empty, checkpoint: firstStart });
    expect(unreported.calls.map(({ table }) => table)).toEqual([
      "organisations",
      "indexer_checkpoints",
      "commands",
    ]);

    // A reset that begins while the rows are read: the checkpoint is read again last.
    const reset = fakeSupabase(issuedSnapshot());
    const afterReset = checkpoint({
      status: "backfilling",
      last_success_at: null,
      indexed_through_slot: null,
    });
    reset.respond = (call, index) =>
      call.table === "indexer_checkpoints" && index > 2
        ? { data: [{ ...afterReset }], error: null, count: 1 }
        : undefined;
    const duringReset = await loadLiveSnapshot(reset.client, ENV);
    expect(duringReset).toMatchObject({ ...empty, checkpoint: afterReset });
    expect(duringReset.memberships).toHaveLength(1);
    expect(reset.calls.at(-1)?.table).toBe("indexer_checkpoints");

    const gone = fakeSupabase(issuedSnapshot());
    gone.respond = (call, index) =>
      call.table === "indexer_checkpoints" && index > 2
        ? { data: [], error: null, count: 0 }
        : undefined;
    expect(await loadLiveSnapshot(gone.client, ENV)).toMatchObject({ ...empty, checkpoint: null });

    const malformed = fakeSupabase(issuedSnapshot());
    malformed.tables.indexer_checkpoints = [{ ...checkpoint(), last_success_at: "not a time" }];
    await expect(loadLiveSnapshot(malformed.client, ENV)).rejects.toMatchObject({
      code: "BAD_ROW",
      path: "checkpoint.last_success_at",
    });
    expect(malformed.calls).toHaveLength(3);
  });

  test("loadLiveSnapshot throws TOO_MANY_ROWS when count exceeds the rows, READ_FAILED when it is below or missing, and filters by network and protocol", async () => {
    const fake = fakeSupabase(issuedSnapshot());
    const snapshot = await loadLiveSnapshot(fake.client, ENV);
    expect(snapshot).toEqual(issuedSnapshot());

    const tables = fake.calls.map(({ table }) => table);
    expect(tables.slice(0, 3)).toEqual(["organisations", "indexer_checkpoints", "commands"]);
    expect(tables.at(-1)).toBe("indexer_checkpoints");
    expect(tables.slice(3, -1).toSorted()).toEqual([...chainTables, "chain_events"].toSorted());
    for (const call of fake.calls) {
      expect(call.options).toEqual({ count: "exact" });
      expect(call.range).toEqual([0, 999]);
    }
    const byTable = (table: string) => fake.calls.find((call) => call.table === table);
    expect(byTable("organisations")).toMatchObject({
      columns: ["id", "slug", "name", "kind", "synthetic"],
      filters: [],
      orders: [{ column: "id" }],
    });
    for (const table of chainTables) {
      const call = byTable(table);
      expect(call?.filters).toEqual([
        ["network", "devnet"],
        ["protocol", PROTOCOL],
      ]);
      expect(call?.orders.map(({ column }) => column)).toEqual(["network", "address"]);
      expect(call?.columns).not.toContain("created_at");
      expect(call?.columns).not.toContain("updated_at");
      expect(call?.columns).not.toContain("last_signature");
    }
    expect(byTable("chain_lots")?.columns).toContain("issued_at");
    expect(byTable("chain_events")).toMatchObject({
      columns: [
        "network",
        "program_id",
        "signature",
        "event_index",
        "slot",
        "block_time",
        "protocol",
        "lot",
        "lot_revision",
        "data",
        "commitment",
      ],
      filters: [
        ["event", "LotIssued"],
        ["network", "devnet"],
        ["program_id", PROGRAM_ID],
        ["protocol", PROTOCOL],
      ],
    });
    expect(byTable("chain_events")?.orders.map(({ column }) => column)).toEqual([
      "network",
      "program_id",
      "signature",
      "event_index",
    ]);
    expect(byTable("indexer_checkpoints")).toMatchObject({
      columns: [
        "network",
        "program_id",
        "protocol",
        "status",
        "indexed_through_slot",
        "last_success_at",
        "halt_reason",
        "halted_at",
      ],
      filters: [
        ["network", "devnet"],
        ["program_id", PROGRAM_ID],
        ["protocol", PROTOCOL],
      ],
    });
    expect(byTable("indexer_checkpoints")?.orders.map(({ column }) => column)).toEqual([
      "network",
      "program_id",
      "protocol",
    ]);
    expect(byTable("commands")).toMatchObject({
      columns: [
        "id",
        "kind",
        "status",
        "initiator_org",
        "parties",
        "lot",
        "facility",
        "loan",
        "intent",
        "payment",
        "args",
        "fields",
        "valid_until",
        "signers",
        "signatures",
        "transaction_signature",
        "error_code",
        "created_at",
        "updated_at",
      ],
      filters: [
        ["network", "devnet"],
        ["program_id", PROGRAM_ID],
        ["protocol", PROTOCOL],
        ["status", ["awaiting_signatures", "submitted", "outcome_unknown"], "in"],
        [
          "kind",
          [
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
            "create_loading_intent",
            "record_loading",
            "accept_loading",
          ],
          "in",
        ],
      ],
    });
    expect(byTable("commands")?.orders.map(({ column }) => column)).toEqual(["created_at", "id"]);

    async function refusal(
      table: string,
      response: { data: unknown; error: unknown; count: unknown },
    ) {
      const failing = fakeSupabase(issuedSnapshot());
      failing.respond = (call) => (call.table === table ? (response as never) : undefined);
      return loadLiveSnapshot(failing.client, ENV).then(
        () => null,
        (error: unknown) => error,
      );
    }
    const oneLot = issuedSnapshot().lots;
    expect(await refusal("chain_lots", { data: oneLot, error: null, count: 1_001 })).toMatchObject({
      code: "TOO_MANY_ROWS",
      path: "lots",
    });
    expect(await refusal("chain_lots", { data: oneLot, error: null, count: 0 })).toMatchObject({
      code: "READ_FAILED",
      path: "lots",
    });
    expect(await refusal("chain_lots", { data: oneLot, error: null, count: null })).toMatchObject({
      code: "READ_FAILED",
      path: "lots",
    });
    expect(await refusal("chain_lots", { data: oneLot, error: null, count: 1.5 })).toMatchObject({
      code: "READ_FAILED",
      path: "lots",
    });
    expect(
      await refusal("chain_events", { data: null, error: { message: "boom" }, count: null }),
    ).toMatchObject({
      code: "READ_FAILED",
      path: "intakeEvents",
    });
    expect(await refusal("organisations", { data: [], error: null, count: 3 })).toMatchObject({
      code: "TOO_MANY_ROWS",
      path: "memberships",
    });
    const twoProtocols = [issuedSnapshot().protocol, issuedSnapshot().protocol];
    expect(
      await refusal("chain_protocols", { data: twoProtocols, error: null, count: 2 }),
    ).toMatchObject({
      code: "BAD_ROW",
      path: "protocol",
    });

    const rejected = fakeSupabase(issuedSnapshot());
    rejected.respond = (call) =>
      call.table === "chain_positions" ? Promise.reject(new Error("offline")) : undefined;
    await expect(loadLiveSnapshot(rejected.client, ENV)).rejects.toMatchObject({
      code: "READ_FAILED",
      path: "positions",
    });
  });
});

describe("loadReader", () => {
  test("getUser errors other than a missing session are READ_FAILED", async () => {
    liveEnvironment();
    const fake = fakeSupabase(issuedSnapshot());
    server.client = fake.client;

    fake.getUser = async () => ({
      data: { user: null },
      error: { name: "AuthUnknownError", status: 500 },
    });
    await expect(loadReader()).rejects.toMatchObject({ code: "READ_FAILED", path: "auth.getUser" });

    fake.getUser = async () => ({
      data: { user: null },
      error: { name: "AuthRetryableFetchError", status: 0 },
    });
    await expect(loadReader()).rejects.toMatchObject({ code: "READ_FAILED", path: "auth.getUser" });

    fake.getUser = () => Promise.reject(new TypeError("fetch failed"));
    await expect(loadReader()).rejects.toMatchObject({ code: "READ_FAILED", path: "auth.getUser" });
    expect(fake.calls).toHaveLength(0);

    fake.getUser = async () => ({
      data: { user: null },
      error: { name: "AuthSessionMissingError", status: 400 },
    });
    await expect(loadReader()).rejects.toMatchObject({ code: "NO_SESSION", path: "auth.getUser" });
    fake.getUser = async () => ({ data: { user: null }, error: null });
    await expect(loadReader()).rejects.toMatchObject({ code: "NO_SESSION", path: "auth.getUser" });
    for (const status of [401, 403]) {
      fake.getUser = async () => ({
        data: { user: null },
        error: { name: "AuthApiError", status },
      });
      await expect(loadReader()).rejects.toMatchObject({
        code: "NO_SESSION",
        path: "auth.getUser:rejected",
      });
    }

    fake.getUser = async () => ({ data: { user: null }, error: null });
    await expect(requireReader("/khunou/queue?filter=mine")).rejects.toMatchObject({
      digest: expect.stringContaining(`;${"/login?next=%2Fkhunou%2Fqueue%3Ffilter%3Dmine"};`),
    });
    fake.getUser = async () => ({
      data: { user: null },
      error: { name: "AuthApiError", status: 401 },
    });
    await expect(requireReader("/khunou/lots/CR-0001")).rejects.toMatchObject({
      digest: expect.stringContaining(";/login?next=%2Fkhunou%2Flots%2FCR-0001&reason=expired;"),
    });
    fake.getUser = async () => ({
      data: { user: null },
      error: { name: "AuthUnknownError", status: 500 },
    });
    await expect(requireReader("/khunou/queue")).rejects.toBeInstanceOf(LiveDataError);

    fake.getUser = async () => ({
      data: { user: { id: "21000000-0000-4000-8000-000000000001" } },
      error: null,
    });
    const reader = await loadReader();
    expect(reader.mode).toBe("live");
    if (reader.mode !== "live") throw new Error("expected the live reader");
    expect(reader.lots("khunou").map(({ id }) => id)).toEqual(["CR-0001"]);
  });

  test("an unexpected live error is READ_FAILED at loadReader, and reference mode reads the fixture", async () => {
    liveEnvironment();
    server.client = new Error("cookies are not available");
    await expect(loadReader()).rejects.toMatchObject({ code: "READ_FAILED", path: "loadReader" });

    vi.unstubAllEnvs();
    vi.stubEnv("THETIS_DATA_SOURCE", "");
    const reference = await loadReader();
    expect(reference.mode).toBe("reference");
    expect(server.calls).toBe(1);
  });
});
