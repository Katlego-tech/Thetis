// live-lending.md §6.10.11: loading in the web. Every party, quantity and amount is the synthetic
// demo's (snapshot.ts, loadingSnapshot); wallets are throwaway keys; nothing is sent to devnet.

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { getWallets } from "@wallet-standard/app";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { LendingActions } from "@/components/dossier/lending-copy";
import { loadLiveSnapshot } from "@/data/live/load";
import { liveReader } from "@/data/live/map";
import { COMMAND_KINDS, type LiveSnapshot } from "@/data/live/rows";
import type { LiveLotView } from "@/data/live/types";
import { type CommandView, failureExplanation } from "@/lib/commands";
import { fakeWallet } from "../access/fake-wallet";
import {
  acceptance,
  address,
  BUYER_POSITION,
  checkpoint,
  command,
  ENV,
  FACILITY_ONE,
  FACILITY_TWO,
  facility,
  fakeSupabase,
  KHUNOU_POSITION,
  LOADING_DOCUMENT,
  LOADING_EXPIRES_AT,
  LOADING_INTENT,
  LOADING_INTENT_OLD,
  LOAN_ONE,
  LOAN_TWO,
  LOCK_ONE,
  LOCK_TWO,
  LOT,
  loadingIntent,
  loadingSnapshot,
  loan,
  lock,
  lotRow,
  NOW,
  orgAccount,
  orgId,
  PROGRAM_ID,
  PROTOCOL,
  position,
  type Slug,
} from "./snapshot";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  session: {
    access_token: "synthetic-token",
    user: { id: "21000000-0000-4000-8000-000000000001" },
  },
  links: [] as { wallet: string; organisation_id: string }[],
  inserts: [] as { table: string; row: Record<string, unknown> }[],
  failStep: null as string | null,
  log: [] as string[],
}));

vi.mock("next/navigation", async (original) => ({
  ...(await original<typeof import("next/navigation")>()),
  useRouter: () => ({ push: mocks.push, refresh: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@/lib/supabase-browser", () => ({
  supabaseBrowser: () => ({
    auth: { getSession: async () => ({ data: { session: mocks.session }, error: null }) },
    from(table: string) {
      if (table === "signer_links") {
        const result = { data: mocks.links, error: null };
        const builder = {
          select: () => builder,
          eq: () => builder,
          is: () => builder,
          // biome-ignore lint/suspicious/noThenProperty: the Supabase query builder is awaited
          then: (resolve: (value: typeof result) => unknown) =>
            Promise.resolve(result).then(resolve),
        };
        return builder;
      }
      return {
        insert(row: Record<string, unknown>) {
          mocks.log.push(`insert ${table}`);
          mocks.inserts.push({ table, row });
          const id =
            table === "evidence_objects"
              ? "31000000-0000-4000-8000-000000000001"
              : "32000000-0000-4000-8000-000000000001";
          const reply =
            mocks.failStep === `insert ${table}`
              ? { data: null, error: { message: "denied" } }
              : { data: { id }, error: null };
          return { select: () => ({ single: async () => reply }) };
        },
      };
    },
    storage: {
      from: () => ({
        upload: async (path: string) => {
          mocks.log.push("upload");
          return mocks.failStep === "upload"
            ? { data: null, error: { message: "denied" } }
            : { data: { path }, error: null };
        },
      }),
    },
  }),
}));

const server = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase-server", () => ({ supabaseServer: async () => server.client }));

const { LoadingSection } = await import("@/components/dossier/loading-section");
const { CommandLive } = await import("@/components/commands/command-live");
const { commandFailureMessage, failureMessage } = await import("@/components/commands/messages");
const { statusLine } = await import("@/components/commands/status");
const { getQueueData } = await import("@/components/queue/work-queue-screen");
const { default: CommandPage } = await import("@/app/[context]/commands/[commandId]/page");

const API = "http://api.test";
const COMMAND_ID = "2cc199ec-0000-4000-8000-000000000009";
const NOW_SECONDS = NOW.getTime() / 1000;
const lenderOne = { id: "lender-one", name: "Lender One Bank", role: "lender" };

function lotOf(snapshot: LiveSnapshot, context: Slug): LiveLotView {
  const lot = liveReader(snapshot, NOW).lot("CR-0001", context);
  if (!lot) throw new Error(`CR-0001 is not visible to ${context}`);
  return lot;
}

function loadingOf(snapshot: LiveSnapshot, context: Slug) {
  const loading = lotOf(snapshot, context).lending?.loading;
  if (!loading) throw new Error("no loading view");
  return loading;
}

const actionsOf = (context: Slug): LendingActions => ({
  organisationId: orgId(context),
  buyers: [],
});

function renderSection(snapshot: LiveSnapshot, context: Slug) {
  return render(
    <LoadingSection
      lot={lotOf(snapshot, context)}
      context={context}
      actions={actionsOf(context)}
    />,
  );
}

type Call = { url: string; method: string; body: unknown };
const calls: Call[] = [];
let replies: ((call: Call) => Response | undefined)[] = [];
const unregister: (() => void)[] = [];

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function view(overrides: Partial<CommandView> = {}): CommandView {
  return {
    id: COMMAND_ID,
    kind: "record_loading",
    status: "awaiting_signatures",
    network: "devnet",
    programId: PROGRAM_ID,
    protocol: PROTOCOL,
    initiatorOrganisationId: orgId("khunou"),
    parties: [orgId("khunou"), orgId("port-t1")],
    lot: LOT,
    facility: null,
    loan: null,
    intent: LOADING_INTENT,
    payment: null,
    args: { intent: LOADING_INTENT },
    fields: [
      { label: "Lot", value: "CR-0001" },
      { label: "Quantity", value: "3,000.000 t" },
      { label: "Owner", value: "Khunou Ore Exports" },
      { label: "Terminal", value: "Port Terminal T1" },
      { label: "Loading document", value: LOADING_DOCUMENT },
      { label: "Intent", value: "1" },
      { label: "Locked", value: "3,000.000 t" },
      { label: "Loan acceptances", value: "1" },
      { label: "Revision", value: "3" },
    ],
    text: {
      version: 1,
      messageBase64: Buffer.from("Thetis authorisation v1\nAction: Record loading").toString(
        "base64",
      ),
      messageSha256: "0".repeat(64),
      validUntil: new Date((NOW_SECONDS + 240) * 1000).toISOString(),
      validUntilText: "2026-11-26 02:04:10 SAST",
    },
    signers: [
      { role: "owner", organisationId: orgId("khunou"), method: "text", signed: null },
      { role: "terminal", organisationId: orgId("port-t1"), method: "text", signed: null },
    ],
    transaction: null,
    confirmedSlot: null,
    confirmedCommitment: null,
    outcome: null,
    error: null,
    createdAt: "2026-11-26T00:00:02.000Z",
    updatedAt: "2026-11-26T00:00:02.000Z",
    ...overrides,
  };
}

const organisations = {
  [orgId("khunou")]: "Khunou Ore Exports",
  [orgId("port-t1")]: "Port Terminal T1",
  [orgId("lender-one")]: "Lender One Bank",
};

beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
});
beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_API_URL", API);
  calls.length = 0;
  replies = [];
  mocks.links = [];
  mocks.inserts = [];
  mocks.log = [];
  mocks.failStep = null;
  mocks.push.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const call = {
        url,
        method: init.method ?? "GET",
        body: init.body ? JSON.parse(String(init.body)) : null,
      };
      calls.push(call);
      if (call.method !== "GET") mocks.log.push(`${call.method} ${url.replace(API, "")}`);
      for (const reply of replies) {
        const response = reply(call);
        if (response) return response;
      }
      return json(200, { data: view() });
    }),
  );
});
afterEach(() => {
  cleanup();
  for (const off of unregister.splice(0)) off();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** The relay creates the command: 201 with its view, after the evidence finalize when there is one. */
function created(kind: CommandView["kind"]) {
  replies.push((call) =>
    call.url.endsWith("/finalize") ? json(200, { data: { versionId: "v" } }) : undefined,
  );
  replies.push((call) =>
    call.url.endsWith("/v1/commands") ? json(201, { data: view({ kind }) }) : undefined,
  );
}

function refusedWith(code: string, detail?: string) {
  replies.push((call) =>
    call.url.endsWith("/v1/commands")
      ? json(409, { error: { code, message: "refused", ...(detail ? { detail } : {}) } })
      : undefined,
  );
}

const INTENT_COLUMNS = [
  "network",
  "address",
  "protocol",
  "slot",
  "commitment",
  "lot",
  "position",
  "owner",
  "owner_org_id",
  "terminal",
  "terminal_org_id",
  "custodian_class",
  "nonce",
  "quantity_kg",
  "locked_kg",
  "document_sha256_hex",
  "position_revision",
  "expires_at",
  "status",
  "executed_at",
  "cancelled_by",
];
const ACCEPTANCE_COLUMNS = [
  "network",
  "address",
  "protocol",
  "slot",
  "commitment",
  "intent",
  "loan",
  "lock",
  "lender",
  "lender_org_id",
  "lock_quantity_kg",
  "loan_revision",
  "principal",
  "booked_interest",
  "accepted_at",
  "version",
  "event_version",
];

describe("loading reads", () => {
  test("the snapshot reads chain_loading_intents and chain_handoff_acceptances with exactly their columns, and the never-reported rule empties them", async () => {
    const source = loadingSnapshot(["khunou"], [loadingIntent()], [acceptance()]);
    const fake = fakeSupabase(source);
    const snapshot = await loadLiveSnapshot(fake.client, ENV);
    expect(snapshot.loadingIntents).toEqual([loadingIntent()]);
    expect(snapshot.acceptances).toEqual([acceptance()]);
    expect(Object.keys(snapshot).slice(-5)).toEqual([
      "commands",
      "loadingIntents",
      "acceptances",
      "intakeEvents",
      "checkpoint",
    ]);
    for (const [table, columns] of [
      ["chain_loading_intents", INTENT_COLUMNS],
      ["chain_handoff_acceptances", ACCEPTANCE_COLUMNS],
    ] as const) {
      const call = fake.calls.find((entry) => entry.table === table);
      expect(call?.columns).toEqual(columns);
      expect(call?.options).toEqual({ count: "exact" });
      expect(call?.filters).toEqual([
        ["network", "devnet"],
        ["protocol", PROTOCOL],
      ]);
      expect(call?.orders.map(({ column }) => column)).toEqual(["network", "address"]);
      expect(call?.range).toEqual([0, 999]);
    }

    const unreported = fakeSupabase(source);
    unreported.tables.indexer_checkpoints = [{ ...checkpoint(), last_success_at: null }];
    const empty = await loadLiveSnapshot(unreported.client, ENV);
    expect(empty.loadingIntents).toEqual([]);
    expect(empty.acceptances).toEqual([]);
    expect(unreported.calls.map(({ table }) => table)).not.toContain("chain_loading_intents");
    expect(unreported.calls.map(({ table }) => table)).not.toContain("chain_handoff_acceptances");
  });

  test("the commands read and the command page take the lending and loading kinds, and an issue_lot, handover or record_observation command stays out and is notFound", async () => {
    const kinds = [
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
    ];
    expect([...COMMAND_KINDS]).toEqual(kinds);
    const snapshot = loadingSnapshot(["khunou"]);
    snapshot.commands = [
      command({
        kind: "record_loading",
        facility: null,
        intent: LOADING_INTENT,
        args: { intent: LOADING_INTENT },
        signers: [
          { role: "owner", organisationId: orgId("khunou"), method: "text", scope: "SHIP" },
          { role: "terminal", organisationId: orgId("port-t1"), method: "text", scope: "LOAD" },
        ],
        signatures: [],
      }),
    ];
    const fake = fakeSupabase(snapshot);
    const read = await loadLiveSnapshot(fake.client, ENV);
    const commandsCall = fake.calls.find(({ table }) => table === "commands");
    expect(commandsCall?.filters).toContainEqual(["kind", kinds, "in"]);
    expect(read.commands.map(({ kind }) => kind)).toEqual(["record_loading"]);

    // The command page, live, as Khunou.
    vi.stubEnv("THETIS_DATA_SOURCE", "live");
    vi.stubEnv("THETIS_NETWORK", "devnet");
    vi.stubEnv("THETIS_PROGRAM_ID", PROGRAM_ID);
    vi.stubEnv("THETIS_PROTOCOL", PROTOCOL);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "synthetic-anon-key");
    snapshot.checkpoint = checkpoint({ last_success_at: new Date().toISOString() });
    const page = fakeSupabase(snapshot);
    const auth = (page.client as unknown as { auth: Record<string, unknown> }).auth;
    auth.getSession = async () => ({ data: { session: mocks.session }, error: null });
    server.client = page.client;
    const open = () =>
      CommandPage({ params: Promise.resolve({ context: "khunou", commandId: COMMAND_ID }) });

    for (const kind of ["issue_lot", "handover", "record_observation"]) {
      replies.splice(0, replies.length, () => json(200, { data: view({ kind } as never) }));
      await expect(open()).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
    }
    replies.splice(0, replies.length, () => json(200, { data: view() }));
    render(await open());
    expect(screen.getByRole("heading", { level: 1, name: "Record loading" })).toBeInTheDocument();
  });

  test("liveReader maps the shown position's loading intents newest first, with a row per loan holding a positive lock", () => {
    const snapshot = loadingSnapshot(
      ["khunou"],
      [
        loadingIntent({ address: LOADING_INTENT_OLD, nonce: "7", position_revision: "2" }),
        loadingIntent(),
        // An intent of another position is not shown.
        loadingIntent({ address: orgAccount("mosela"), position: BUYER_POSITION, nonce: "9" }),
      ],
    );
    snapshot.positions = [
      position(KHUNOU_POSITION, "khunou", "3000000", { locked_kg: "3000000", revision: "3" }),
      position(BUYER_POSITION, "buyer-smelter", "2000000"),
    ];
    snapshot.facilities = [
      facility(FACILITY_ONE, "lender-one", { loan_count: 1 }),
      facility(FACILITY_TWO, "lender-two", { loan_count: 2 }),
    ];
    snapshot.loans = [
      loan(LOAN_ONE, FACILITY_ONE, "lender-one", { revision: "2" }),
      loan(LOAN_TWO, FACILITY_TWO, "lender-two", { loan_index: 1, revision: "4" }),
      // A closed loan and one whose lock is zero need no acceptance.
      loan(orgAccount("kopano"), FACILITY_TWO, "lender-two", { loan_index: 0, status: "Closed" }),
    ];
    snapshot.locks = [
      lock(LOCK_ONE, LOAN_ONE, "2000000"),
      lock(LOCK_TWO, LOAN_TWO, "1000000"),
      lock(orgAccount("port-t1"), orgAccount("kopano"), "0"),
    ];
    const loading = loadingOf(snapshot, "khunou");
    expect(loading.terminal).toEqual({
      id: "port-t1",
      name: "Port Terminal T1",
      role: "terminal",
    });
    expect(loading.site).toBe("PORT-T1");
    expect(loading.positionQuantityKg).toBe(3_000_000n);
    expect(loading.intents.map(({ address }) => address)).toEqual([
      LOADING_INTENT,
      LOADING_INTENT_OLD,
    ]);
    const [newest] = loading.intents;
    expect(newest).toMatchObject({
      nonce: 1n,
      owner: { id: "khunou" },
      terminal: { id: "port-t1" },
      quantityKg: 3_000_000n,
      lockedKg: 3_000_000n,
      documentSha256Hex: LOADING_DOCUMENT,
      positionRevision: 3n,
      expiresAt: new Date(Number(LOADING_EXPIRES_AT) * 1000).toISOString(),
      live: true,
      state: "open",
      required: 2,
      accepted: 0,
      registry: { status: "confirmed" },
      openCommand: null,
    });
    expect(newest?.rows).toEqual([
      expect.objectContaining({
        loan: LOAN_ONE,
        loanIndex: 0n,
        lockedKg: 2_000_000n,
        state: "missing",
      }),
      expect.objectContaining({
        loan: LOAN_TWO,
        loanIndex: 1n,
        lender: { id: "lender-two", name: "Lender Two Bank", role: "lender" },
        lockedKg: 1_000_000n,
        state: "missing",
        acceptedAt: null,
        registry: null,
      }),
    ]);
    // A lot at a custodian that is not a terminal has no terminal to load at.
    const stockyard = loadingSnapshot(["khunou"]);
    stockyard.lots = [lotRow({ revision: "1", event_revision: "1" })];
    stockyard.custodianClasses = loadingSnapshot().custodianClasses.map((row) => ({
      ...row,
      custodian: orgAccount("kopano"),
      custodian_org_id: orgId("kopano"),
    }));
    expect(loadingOf(stockyard, "khunou").terminal).toBeNull();
  });

  test("an intent is recorded, cancelled, out of date, expired, ready or open, in that precedence, from chain rows and the clock only", () => {
    const past = String(NOW_SECONDS - 60);
    const stateOf = (overrides: Parameters<typeof loadingIntent>[0], accepted = false) =>
      loadingOf(
        loadingSnapshot(["khunou"], [loadingIntent(overrides)], accepted ? [acceptance()] : []),
        "khunou",
      ).intents[0];
    const all = {
      status: "Executed" as const,
      executed_at: String(NOW_SECONDS - 120),
      cancelled_by: orgAccount("mosela"),
      position_revision: "2",
      expires_at: past,
    };
    expect(stateOf(all)).toMatchObject({ state: "recorded", live: false });
    expect(stateOf({ ...all, status: "Open", executed_at: null })).toMatchObject({
      state: "cancelled",
      live: false,
    });
    expect(stateOf({ position_revision: "2", expires_at: past })).toMatchObject({
      state: "outdated",
      live: false,
    });
    expect(stateOf({ expires_at: past })).toMatchObject({ state: "expired", live: false });
    expect(stateOf({ expires_at: String(NOW_SECONDS) })).toMatchObject({ state: "expired" });
    expect(stateOf({}, true)).toMatchObject({ state: "ready", live: true, accepted: 1 });
    expect(stateOf({})).toMatchObject({ state: "open", live: true, accepted: 0 });

    // An open record_loading command, even submitted, changes no state.
    const pending = loadingSnapshot(["khunou"], [loadingIntent()], [acceptance()]);
    pending.commands = [
      command({
        kind: "record_loading",
        status: "submitted",
        facility: null,
        intent: LOADING_INTENT,
        args: { intent: LOADING_INTENT },
        signers: [],
        signatures: [],
      }),
    ];
    expect(loadingOf(pending, "khunou").intents[0]).toMatchObject({
      state: "ready",
      openCommand: { kind: "record_loading", status: "submitted" },
    });
  });

  test("an acceptance is accepted only while its loan revision and lock quantity match the chain, stale after either changes, and recovery for a loan in Recovery", () => {
    const rowOf = (snapshot: LiveSnapshot) => loadingOf(snapshot, "khunou").intents[0]?.rows[0];
    const accepted = loadingSnapshot(["khunou"], [loadingIntent()], [acceptance()]);
    expect(rowOf(accepted)).toMatchObject({
      state: "accepted",
      acceptedAt: new Date((NOW_SECONDS - 600) * 1000).toISOString(),
      registry: { status: "confirmed" },
    });
    expect(
      rowOf(loadingSnapshot(["khunou"], [loadingIntent()], [acceptance({ loan_revision: "1" })])),
    ).toMatchObject({ state: "stale", registry: { status: "confirmed" } });
    expect(
      rowOf(
        loadingSnapshot(
          ["khunou"],
          [loadingIntent()],
          [acceptance({ lock_quantity_kg: "2000000" })],
        ),
      ),
    ).toMatchObject({ state: "stale" });
    const recovery = loadingSnapshot(["khunou"], [loadingIntent()], [acceptance()]);
    recovery.loans = [
      loan(LOAN_ONE, FACILITY_ONE, "lender-one", { status: "Recovery", revision: "2" }),
    ];
    recovery.locks = [lock(LOCK_ONE, LOAN_ONE, "3000000", { control: "Recovery" })];
    expect(rowOf(recovery)).toMatchObject({ state: "recovery" });
    expect(loadingOf(recovery, "khunou").intents[0]).toMatchObject({ state: "open", accepted: 0 });

    // The owner's view of a stale row and a row in recovery.
    renderSection(
      loadingSnapshot(["khunou"], [loadingIntent()], [acceptance({ loan_revision: "1" })]),
      "khunou",
    );
    expect(
      screen.getByText("Accepted before the loan changed. Lender One Bank needs to accept again."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Not every lender has accepted yet. Thetis refuses to record the loading until each lender with a lock on this position accepts.",
      ),
    ).toBeInTheDocument();
    cleanup();
    renderSection(recovery, "khunou");
    expect(
      screen.getByText(
        "In recovery. The lot can't be loaded until Lender One Bank's recovery clears its lock.",
      ),
    ).toBeInTheDocument();
    cleanup();
    // The lender's own.
    const lenderRecovery = structuredClone(recovery);
    lenderRecovery.memberships = loadingSnapshot(["lender-one"]).memberships;
    renderSection(lenderRecovery, "lender-one");
    expect(
      screen.getByText(
        "In recovery. The lot can't be loaded until your recovery clears this lock.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept loading" })).not.toBeInTheDocument();
    cleanup();
    renderSection(
      loadingSnapshot(["lender-one"], [loadingIntent()], [acceptance({ loan_revision: "1" })]),
      "lender-one",
    );
    expect(screen.getByText("Accepted before loan 0 changed. Accept again.")).toBeInTheDocument();
  });

  test("a lender who can't see every lock gets its own row, an Other lenders row and no k of n count", () => {
    const snapshot = loadingSnapshot(["lender-one"]);
    snapshot.locks = [lock(LOCK_ONE, LOAN_ONE, "2000000")];
    const [intentView] = loadingOf(snapshot, "lender-one").intents;
    expect(intentView).toMatchObject({ required: null, accepted: 0, state: "open" });
    expect(intentView?.rows).toHaveLength(1);
    renderSection(snapshot, "lender-one");
    const table = screen.getAllByRole("table")[0] as HTMLElement;
    const rows = within(table).getAllByRole("row");
    expect(rows.at(-1)).toHaveTextContent("Other lenders");
    expect(rows.at(-1)).toHaveTextContent("1,000.000 t");
    expect(rows.at(-1)).toHaveTextContent("Not visible to you");
    expect(
      screen.getByText(
        "Your loan's acceptance is below. Acceptances of other lenders' loans are not visible to you.",
      ),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Accepted for \d+ of/);
  });
});

describe("loading per position", () => {
  // Lender One Bank lends to Khunou (3,000 t, all locked to loan 0) and to Buyer Smelter Co
  // (2,000 t, 1,000 t locked to its loan 0 and 1,000 t to a lock it can't see). Each position has
  // a live loading intent; the buyer's was created later, at a higher position revision.
  const BUYER_FACILITY = address(90);
  const BUYER_LOAN = address(91);
  const BUYER_LOCK = address(92);
  const BUYER_INTENT = address(93);

  function twoPositions(): LiveSnapshot {
    const snapshot = loadingSnapshot(
      ["lender-one"],
      [
        loadingIntent(),
        loadingIntent({
          address: BUYER_INTENT,
          position: BUYER_POSITION,
          owner: orgAccount("buyer-smelter"),
          owner_org_id: orgId("buyer-smelter"),
          nonce: "4",
          quantity_kg: "2000000",
          locked_kg: "2000000",
          position_revision: "5",
        }),
      ],
    );
    snapshot.positions = [
      position(KHUNOU_POSITION, "khunou", "3000000", { locked_kg: "3000000", revision: "3" }),
      position(BUYER_POSITION, "buyer-smelter", "2000000", { locked_kg: "2000000", revision: "5" }),
    ];
    snapshot.facilities = [
      facility(FACILITY_ONE, "lender-one", { loan_count: 1 }),
      facility(BUYER_FACILITY, "lender-one", {
        borrower: orgAccount("buyer-smelter"),
        borrower_org_id: orgId("buyer-smelter"),
        facility_id_hex: "33".repeat(16),
        loan_count: 1,
      }),
    ];
    snapshot.loans = [
      loan(LOAN_ONE, FACILITY_ONE, "lender-one", {
        principal: "20000000",
        accrued_at: String(NOW_SECONDS),
        revision: "2",
        event_revision: "2",
      }),
      loan(BUYER_LOAN, BUYER_FACILITY, "lender-one", {
        borrower: orgAccount("buyer-smelter"),
        borrower_org_id: orgId("buyer-smelter"),
        position: BUYER_POSITION,
        principal: "10000000",
        accrued_at: String(NOW_SECONDS),
      }),
    ];
    snapshot.locks = [
      lock(LOCK_ONE, LOAN_ONE, "3000000"),
      lock(BUYER_LOCK, BUYER_LOAN, "1000000", { position: BUYER_POSITION }),
    ];
    return snapshot;
  }

  const blockOf = (heading: string) =>
    screen.getByRole("heading", { level: 3, name: heading }).closest(".work-panel") as HTMLElement;

  test("a lender with loans on two positions of one lot sees Accept loading for the live intent on the shown position", () => {
    const snapshot = twoPositions();
    const lot = lotOf(snapshot, "lender-one");
    expect(lot.lending?.shownPosition.address).toBe(KHUNOU_POSITION);
    const intents = lot.lending?.loading.intents ?? [];
    const shown = intents.find(({ address }) => address === LOADING_INTENT);
    const other = intents.find(({ address }) => address === BUYER_INTENT);
    // Each intent counts the locks of its own position: the shown one sees every lock, the
    // buyer's does not.
    expect(shown).toMatchObject({ live: true, state: "open", required: 1, hiddenLockedKg: 0n });
    expect(other).toMatchObject({
      live: true,
      state: "open",
      required: null,
      hiddenLockedKg: 1_000_000n,
    });

    renderSection(snapshot, "lender-one");
    // The shown position's live intent leads, with its acceptance table and Accept loading.
    const [first] = screen.getAllByRole("heading", { level: 3 });
    expect(first).toHaveTextContent("Loading intent 1, Port Terminal T1");
    const khunou = blockOf("Loading intent 1, Port Terminal T1");
    expect(within(khunou).getByText("Loan 0, Lender One Bank")).toBeInTheDocument();
    expect(within(khunou).getByRole("button", { name: "Accept loading" })).toBeInTheDocument();
    expect(within(khunou).queryByText("Other lenders")).not.toBeInTheDocument();
    expect(
      within(khunou).getByText(
        "Accepted for 0 of 1 loans on chain. The loading can be recorded once every loan with a lock on this position is accepted.",
      ),
    ).toBeInTheDocument();
    // The other position's live intent keeps its own block, its own hidden locks and its button.
    const buyer = blockOf("Loading intent 4, Port Terminal T1");
    expect(within(buyer).getByRole("button", { name: "Accept loading" })).toBeInTheDocument();
    const rows = within(within(buyer).getAllByRole("table")[0] as HTMLElement).getAllByRole("row");
    expect(rows.at(-1)).toHaveTextContent("Other lenders");
    expect(rows.at(-1)).toHaveTextContent("1,000.000 t");
    expect(
      within(buyer).getByText(
        "Your loan's acceptance is below. Acceptances of other lenders' loans are not visible to you.",
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Accept loading" })).toHaveLength(2);
  });

  test("an older intent of the shown position is compact, and a newer one on another position never takes its place", () => {
    const snapshot = twoPositions();
    snapshot.loadingIntents = [
      ...snapshot.loadingIntents,
      loadingIntent({ address: LOADING_INTENT_OLD, nonce: "7", position_revision: "2" }),
    ];
    renderSection(snapshot, "lender-one");
    const old = blockOf("Loading intent 7, Port Terminal T1");
    expect(within(old).queryByRole("table")).not.toBeInTheDocument();
    expect(within(old).getByText(/can't be recorded\.$/)).toBeInTheDocument();
    const headings = screen.getAllByRole("heading", { level: 3 }).map((node) => node.textContent);
    expect(headings).toEqual([
      "Loading intent 1, Port Terminal T1",
      "Loading intent 7, Port Terminal T1",
      "Loading intent 4, Port Terminal T1",
    ]);
  });

  test("an intent that names a position of another lot is left out, and the dossier still reads", () => {
    const OTHER_LOT = address(94);
    const OTHER_POSITION = address(95);
    const STRAY_INTENT = address(96);
    const snapshot = loadingSnapshot(["lender-one"]);
    snapshot.lots = [
      ...snapshot.lots,
      lotRow({ address: OTHER_LOT, lot_id: "CR-0002", root: OTHER_LOT, supply_kg: "1000000" }),
    ];
    snapshot.positions = [
      ...snapshot.positions,
      position(OTHER_POSITION, "khunou", "1000000", { lot: OTHER_LOT }),
    ];
    // A loan row of CR-0001 that names the other lot's position (a bad row) lets the stray intent
    // into this lot's view.
    snapshot.loans = [
      ...snapshot.loans,
      loan(address(97), FACILITY_ONE, "lender-one", { position: OTHER_POSITION, loan_index: 1 }),
    ];
    snapshot.locks = [
      ...snapshot.locks,
      lock(address(98), address(97), "0", { position: OTHER_POSITION }),
    ];
    snapshot.loadingIntents = [
      loadingIntent(),
      loadingIntent({ address: STRAY_INTENT, position: OTHER_POSITION, nonce: "8" }),
    ];
    const loading = loadingOf(snapshot, "lender-one");
    expect(loading.intents.map(({ address: at }) => at)).toEqual([LOADING_INTENT]);
    renderSection(snapshot, "lender-one");
    expect(screen.getByRole("button", { name: "Accept loading" })).toBeInTheDocument();
    expect(screen.queryByText(/Loading intent 8/)).not.toBeInTheDocument();
  });

  test("an intent with no lock to accept is ready, and its tally and queue item read fold 12's line", () => {
    const snapshot = loadingSnapshot(["khunou"], [loadingIntent({ locked_kg: "0" })]);
    snapshot.positions = [
      position(KHUNOU_POSITION, "khunou", "3000000", { revision: "3" }),
      position(BUYER_POSITION, "buyer-smelter", "2000000"),
    ];
    snapshot.facilities = [];
    snapshot.valuations = [];
    snapshot.loans = [];
    snapshot.locks = [];
    const [intentView] = loadingOf(snapshot, "khunou").intents;
    expect(intentView).toMatchObject({ state: "ready", required: 0, accepted: 0 });
    const line = "No loan holds a lock on this position, so no lender needs to accept.";
    renderSection(snapshot, "khunou");
    expect(screen.getByText(line)).toBeInTheDocument();
    expect(liveReader(snapshot, NOW).workQueue("khunou")).toEqual([
      expect.objectContaining({
        id: `record-loading:${LOADING_INTENT}`,
        action: "Record loading",
        blocker: `${line} Record the loading with Port Terminal T1.`,
      }),
    ]);
  });
});

describe("loading actions", () => {
  test("Create loading intent shows only to the owner of a stored position at a terminal, and uploads the loading document under the lot's address before the command", async () => {
    // Not at a terminal: no section at all.
    const stockyard = loadingSnapshot(["khunou"], []);
    stockyard.lots = [lotRow({ revision: "1", event_revision: "1" })];
    stockyard.custodianClasses = stockyard.custodianClasses.map((row) => ({
      ...row,
      custodian: orgAccount("kopano"),
      custodian_org_id: orgId("kopano"),
    }));
    renderSection(stockyard, "khunou");
    expect(screen.queryByRole("heading", { name: "Loading" })).not.toBeInTheDocument();
    cleanup();
    // A lender, with no intent: nothing to show.
    renderSection(loadingSnapshot(["lender-one"], []), "lender-one");
    expect(screen.queryByRole("heading", { name: "Loading" })).not.toBeInTheDocument();
    cleanup();
    // The owner, lot no longer stored: no create.
    const prepared = loadingSnapshot(
      ["khunou"],
      [loadingIntent({ expires_at: String(NOW_SECONDS - 1) })],
    );
    prepared.lots = [
      lotRow({
        custodian: orgAccount("port-t1"),
        custodian_org_id: orgId("port-t1"),
        state: "Prepared",
        revision: "1",
        event_revision: "1",
      }),
    ];
    renderSection(prepared, "khunou");
    expect(screen.queryByRole("button", { name: "Create loading intent" })).not.toBeInTheDocument();
    cleanup();

    renderSection(loadingSnapshot(["khunou"], []), "khunou");
    expect(screen.getByRole("heading", { level: 2, name: "Loading" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "No loading intent for this position. The lot is stored at Port Terminal T1 (PORT-T1), so your position can be loaded there.",
      ),
    ).toBeInTheDocument();
    created("create_loading_intent");
    fireEvent.click(screen.getByRole("button", { name: "Create loading intent" }));
    const dialog = screen.getByRole("dialog", { name: "Create loading intent" });
    expect(dialog).toHaveTextContent(
      "Loads all 3,000.000 t of your position at Port Terminal T1. Each lender with a lock on it must accept before the loading can be recorded.",
    );
    expect(dialog).not.toHaveTextContent("This replaces loading intent");
    expect(
      within(dialog).getByText(
        "The bill of lading or loading record. PDF, JPEG or PNG, at most 20 MiB. Its SHA-256 goes into the signed text.",
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Expires in hours")).toHaveValue("24");
    expect(within(dialog).getByText("1 to 720")).toBeInTheDocument();
    const file = new File(["%PDF-1.4 synthetic"], "synthetic-bill-of-lading.pdf", {
      type: "application/pdf",
    });
    fireEvent.change(within(dialog).getByLabelText("Loading document"), {
      target: { files: [file] },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create loading intent" }));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith(`/khunou/commands/${COMMAND_ID}`));
    expect(mocks.log).toEqual([
      "insert evidence_objects",
      "insert evidence_versions",
      "upload",
      "POST /v1/evidence/32000000-0000-4000-8000-000000000001/finalize",
      "POST /v1/commands",
    ]);
    expect(mocks.inserts[0]).toEqual({
      table: "evidence_objects",
      row: {
        owner_organisation_id: orgId("khunou"),
        subject_kind: "lot",
        subject_ref: LOT,
        purpose: "loading",
        created_by: mocks.session.user.id,
      },
    });
    expect(calls.find(({ url }) => url.endsWith("/v1/commands"))?.body).toEqual({
      kind: "create_loading_intent",
      organisationId: orgId("khunou"),
      args: {
        lot: LOT,
        expiresInHours: "24",
        evidenceVersionId: "32000000-0000-4000-8000-000000000001",
      },
    });
    cleanup();

    // With a live intent the owner may replace it, and the dialog says so.
    renderSection(loadingSnapshot(["khunou"]), "khunou");
    fireEvent.click(screen.getByRole("button", { name: "Create loading intent" }));
    expect(screen.getByRole("dialog", { name: "Create loading intent" })).toHaveTextContent(
      "This replaces loading intent 1. Its acceptances stop counting, and each lender accepts the new one.",
    );
  });

  test("a failed loading document upload creates no command and says nothing was recorded", async () => {
    for (const step of ["insert evidence_objects", "insert evidence_versions", "upload"]) {
      mocks.failStep = step;
      calls.length = 0;
      created("create_loading_intent");
      renderSection(loadingSnapshot(["khunou"], []), "khunou");
      fireEvent.click(screen.getByRole("button", { name: "Create loading intent" }));
      const dialog = screen.getByRole("dialog", { name: "Create loading intent" });
      fireEvent.change(within(dialog).getByLabelText("Loading document"), {
        target: {
          files: [new File(["%PDF"], "bill.pdf", { type: "application/pdf" })],
        },
      });
      fireEvent.click(within(dialog).getByRole("button", { name: "Create loading intent" }));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent(
        "Thetis could not store the loading document. Nothing was recorded.",
      );
      expect(calls.some(({ url }) => url.endsWith("/v1/commands"))).toBe(false);
      cleanup();
    }
  });

  test("Accept loading shows only to the lender of an Active loan with a positive lock on a live intent it has not accepted at the current revision", () => {
    const accept = () => screen.queryByRole("button", { name: "Accept loading" });
    renderSection(loadingSnapshot(["lender-one"]), "lender-one");
    expect(accept()).toBeInTheDocument();
    expect(screen.getByText("Not accepted")).toBeInTheDocument();
    cleanup();
    renderSection(loadingSnapshot(["khunou"]), "khunou");
    expect(accept()).not.toBeInTheDocument();
    cleanup();
    renderSection(loadingSnapshot(["lender-one"], [loadingIntent()], [acceptance()]), "lender-one");
    expect(accept()).not.toBeInTheDocument();
    expect(screen.getByText(/^Accepted \d/)).toBeInTheDocument();
    cleanup();
    renderSection(
      loadingSnapshot(["lender-one"], [loadingIntent()], [acceptance({ loan_revision: "1" })]),
      "lender-one",
    );
    expect(accept()).toBeInTheDocument();
    cleanup();
    renderSection(
      loadingSnapshot(["lender-one"], [loadingIntent({ expires_at: String(NOW_SECONDS - 1) })]),
      "lender-one",
    );
    expect(accept()).not.toBeInTheDocument();
    expect(screen.getByText(/^Expired .* It can no longer be recorded\.$/)).toBeInTheDocument();
    cleanup();
    // Another lender of the position sees no button on loan 0's row.
    const two = loadingSnapshot(["lender-two"]);
    two.facilities = [
      facility(FACILITY_ONE, "lender-one", { loan_count: 1 }),
      facility(FACILITY_TWO, "lender-two", { loan_count: 1 }),
    ];
    two.loans = [
      loan(LOAN_ONE, FACILITY_ONE, "lender-one", { revision: "2" }),
      loan(LOAN_TWO, FACILITY_TWO, "lender-two", { revision: "1" }),
    ];
    two.locks = [lock(LOCK_ONE, LOAN_ONE, "2000000"), lock(LOCK_TWO, LOAN_TWO, "1000000")];
    renderSection(two, "lender-two");
    expect(screen.getAllByRole("button", { name: "Accept loading" })).toHaveLength(1);
    const row = screen.getByText("Loan 0, Lender One Bank").closest("tr") as HTMLElement;
    expect(within(row).queryByRole("button")).not.toBeInTheDocument();
    cleanup();
    // An open accept_loading for (intent, loan): the row links to it.
    const signing = loadingSnapshot(["lender-one"]);
    signing.commands = [
      command({
        kind: "accept_loading",
        initiator_org: orgId("lender-one"),
        loan: LOAN_ONE,
        intent: LOADING_INTENT,
        args: { intent: LOADING_INTENT, loan: LOAN_ONE },
        valid_until: null,
        signers: [
          {
            role: "lender",
            organisationId: orgId("lender-one"),
            method: "transaction",
            scope: "LEND",
          },
        ],
        signatures: [],
      }),
    ];
    renderSection(signing, "lender-one");
    expect(accept()).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open the signing page" })).toHaveAttribute(
      "href",
      "/lender-one/commands/2cc199ec-0000-4000-8000-000000000001",
    );
  });

  test("Accept loading creates accept_loading with the intent and loan, and its command page offers the lender's transaction signature", async () => {
    renderSection(loadingSnapshot(["lender-one"]), "lender-one");
    created("accept_loading");
    fireEvent.click(screen.getByRole("button", { name: "Accept loading" }));
    const dialog = screen.getByRole("dialog", { name: "Accept loading" });
    expect(dialog).toHaveTextContent(
      "Accept the loading of CR-0001 at Port Terminal T1 for loan 0? When the loading is recorded, your lock of 3,000.000 t ends and the loan's debt stays recorded as an external hand-off.",
    );
    expect(dialog).toHaveTextContent("Debt now");
    expect(dialog).toHaveTextContent("USD 200,000.00");
    expect(dialog).toHaveTextContent("aaaaaaaa");
    expect(dialog).toHaveTextContent(
      "Your wallet signs the transaction on the next page. The Thetis fee sponsor pays the network fee.",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Accept loading" }));
    await waitFor(() =>
      expect(mocks.push).toHaveBeenCalledWith(`/lender-one/commands/${COMMAND_ID}`),
    );
    expect(calls.find(({ url }) => url.endsWith("/v1/commands"))?.body).toEqual({
      kind: "accept_loading",
      organisationId: orgId("lender-one"),
      args: { intent: LOADING_INTENT, loan: LOAN_ONE },
    });
    cleanup();

    const solflare = fakeWallet("Solflare");
    (solflare.wallet.features as Record<string, unknown>)["solana:signTransaction"] = {
      version: "1.0.0",
      supportedTransactionVersions: ["legacy", 0],
      signTransaction: vi.fn(),
    };
    unregister.push(getWallets().register(solflare.wallet));
    mocks.links = [{ wallet: solflare.account.address, organisation_id: orgId("lender-one") }];
    const acceptView = view({
      kind: "accept_loading",
      initiatorOrganisationId: orgId("lender-one"),
      parties: [orgId("lender-one")],
      loan: LOAN_ONE,
      facility: FACILITY_ONE,
      args: { intent: LOADING_INTENT, loan: LOAN_ONE },
      text: null,
      fields: [
        { label: "Lender", value: "Lender One Bank" },
        { label: "Lot", value: "CR-0001" },
        { label: "Loan", value: `${LOAN_ONE} loan 0` },
        { label: "Locked", value: "3,000.000 t" },
        { label: "Terminal", value: "Port Terminal T1" },
        { label: "Intent", value: "1" },
        { label: "Expires", value: "2026-11-27 02:00:10 SAST" },
        { label: "Revision", value: "2" },
      ],
      signers: [
        {
          role: "lender",
          organisationId: orgId("lender-one"),
          method: "transaction",
          signed: null,
        },
      ],
    });
    replies.push(() => json(200, { data: acceptView }));
    render(
      <CommandLive
        initial={acceptView}
        context="lender-one"
        memberships={[orgId("lender-one")]}
        organisations={organisations}
        lotId="CR-0001"
      />,
    );
    expect(screen.getByRole("heading", { level: 1, name: "Accept loading" })).toBeInTheDocument();
    expect(screen.getByText("CR-0001", { selector: ".font-mono" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Waiting for Lender One Bank to sign the transaction.",
    );
    fireEvent.click(await screen.findByRole("button", { name: "Connect Solflare" }));
    expect(
      await screen.findByRole("button", { name: "Sign the transaction with Solflare" }),
    ).toBeEnabled();
  });

  test("Record loading shows to the owner of a live intent without an open record_loading command, and links to the open one otherwise", async () => {
    renderSection(loadingSnapshot(["lender-one"], [loadingIntent()], [acceptance()]), "lender-one");
    expect(screen.queryByRole("button", { name: "Record loading" })).not.toBeInTheDocument();
    cleanup();
    renderSection(
      loadingSnapshot(["khunou"], [loadingIntent({ position_revision: "2" })]),
      "khunou",
    );
    expect(screen.queryByRole("button", { name: "Record loading" })).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "The position changed after this intent was prepared, so it can't be recorded.",
      ),
    ).toBeInTheDocument();
    cleanup();

    renderSection(loadingSnapshot(["khunou"], [loadingIntent()], [acceptance()]), "khunou");
    expect(
      screen.getByText(
        "Accepted for 1 of 1 loans on chain. Port Terminal T1 and Khunou Ore Exports can now record the loading.",
      ),
    ).toBeInTheDocument();
    created("record_loading");
    fireEvent.click(screen.getByRole("button", { name: "Record loading" }));
    const dialog = screen.getByRole("dialog", { name: "Record loading" });
    expect(dialog).toHaveTextContent(
      "Record the loading of all 3,000.000 t of your position at Port Terminal T1? Port Terminal T1 signs the same text on the field app. Nothing is recorded until both of you have signed and devnet confirms it.",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Record loading" }));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith(`/khunou/commands/${COMMAND_ID}`));
    expect(calls.find(({ url }) => url.endsWith("/v1/commands"))?.body).toEqual({
      kind: "record_loading",
      organisationId: orgId("khunou"),
      args: { intent: LOADING_INTENT },
    });
    cleanup();

    // The terminal prepared one on the phone: its line and link replace the button.
    const started = loadingSnapshot(["khunou"], [loadingIntent()], [acceptance()]);
    started.commands = [
      command({
        kind: "record_loading",
        initiator_org: orgId("port-t1"),
        parties: [orgId("khunou"), orgId("port-t1")],
        facility: null,
        intent: LOADING_INTENT,
        args: { intent: LOADING_INTENT },
        signers: [
          { role: "owner", organisationId: orgId("khunou"), method: "text", scope: "SHIP" },
          { role: "terminal", organisationId: orgId("port-t1"), method: "text", scope: "LOAD" },
        ],
        signatures: [],
      }),
    ];
    renderSection(started, "khunou");
    expect(screen.queryByRole("button", { name: "Record loading" })).not.toBeInTheDocument();
    expect(
      screen.getByText(/^Record loading: Waiting for 2 of 2 signatures\. The text expires at /),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open the signing page" })).toHaveAttribute(
      "href",
      "/khunou/commands/2cc199ec-0000-4000-8000-000000000001",
    );
  });

  test("the record_loading command page offers the owner's wallets and says the terminal signs on the field app", async () => {
    const solflare = fakeWallet("Solflare");
    unregister.push(getWallets().register(solflare.wallet));
    mocks.links = [
      { wallet: solflare.account.address, organisation_id: orgId("khunou") },
      { wallet: solflare.account.address, organisation_id: orgId("port-t1") },
    ];
    render(
      <CommandLive
        initial={view()}
        context="khunou"
        memberships={[orgId("khunou"), orgId("port-t1")]}
        organisations={organisations}
        lotId="CR-0001"
      />,
    );
    expect(screen.getByRole("heading", { level: 1, name: "Record loading" })).toBeInTheDocument();
    const signers = screen.getByRole("region", { name: "Signers" });
    expect(within(signers).getByText("Owner")).toBeInTheDocument();
    expect(within(signers).getByText("Terminal")).toBeInTheDocument();
    expect(
      within(signers).getByText("Port Terminal T1 signs this on the Thetis field app."),
    ).toBeInTheDocument();
    const connect = await within(signers).findAllByRole("button", { name: "Connect Solflare" });
    expect(connect).toHaveLength(1);
    fireEvent.click(connect[0] as HTMLElement);
    expect(
      await within(signers).findAllByRole("button", { name: "Sign with Solflare" }),
    ).toHaveLength(1);
    const terminalRow = within(signers)
      .getByText("Port Terminal T1 signs this on the Thetis field app.")
      .closest(".signer-row") as HTMLElement;
    expect(within(terminalRow).queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/^Waiting for 2 of 2 signatures\./);
  });

  test("the relay's loading refusals read their verbatim lines, naming the lender of the detail's loan", async () => {
    const names = {
      lenders: { [LOAN_ONE]: { name: "Lender One Bank", index: "0" } },
      owner: "Khunou Ore Exports",
    };
    const line = (
      kind: CommandView["kind"],
      code: string,
      detail?: string,
      args?: Record<string, string>,
    ) =>
      commandFailureMessage(
        kind,
        { code: code as never, ...(detail === undefined ? {} : { detail }) },
        names,
        args,
      );
    expect(line("record_loading", "ACCEPTANCE_MISSING", `loan: ${LOAN_ONE}`)).toBe(
      "Not every lender with a lock on this lot has accepted this loading. Ask Lender One Bank to accept the loading in Thetis. Nothing was sent.",
    );
    expect(line("record_loading", "ACCEPTANCE_MISSING", `loan: ${LOAN_TWO}`)).toBe(
      "Not every lender with a lock on this lot has accepted this loading. Ask each lender with a lock on this lot to accept the loading in Thetis. Nothing was sent.",
    );
    expect(line("record_loading", "LOAN_NOT_ACTIVE", `loan: ${LOAN_ONE}`)).toBe(
      "Lender One Bank's loan on this lot is in recovery, so the lot can't be loaded until the recovery is settled. Nothing was sent.",
    );
    expect(line("record_loading", "LOAN_NOT_ACTIVE", `loan: ${LOAN_TWO}`)).toBe(
      "A loan on this lot is in recovery, so the lot can't be loaded until the recovery is settled. Nothing was sent.",
    );
    expect(line("record_loading", "TOO_MANY_LOANS", "5 locked loans")).toBe(
      "More than four loans hold locks on this lot, and one loading takes at most four. Repay and close a loan first. Nothing was sent.",
    );
    const accepting = { intent: LOADING_INTENT, loan: LOAN_ONE };
    expect(line("accept_loading", "LOAN_NOT_ACTIVE", `loan: ${LOAN_ONE}`, accepting)).toBe(
      "Loan 0 is not active, so it can't accept a loading. Nothing was sent.",
    );
    expect(line("accept_loading", "LOADING_NOT_OPEN", `intent: ${LOADING_INTENT}`, accepting)).toBe(
      "This loading intent is no longer open, so there is nothing to accept. Nothing was sent.",
    );
    expect(line("accept_loading", "LOADING_EXPIRED", `intent: ${LOADING_INTENT}`, accepting)).toBe(
      "This loading intent has expired. Ask Khunou Ore Exports to create a new one. Nothing was sent.",
    );
    expect(line("accept_loading", "VALIDATION", "args.loan", accepting)).toBe(
      "Loan 0 has no lock on the position this intent loads, so it has nothing to accept. Nothing was sent.",
    );
    expect(line("create_loading_intent", "EVIDENCE_INVALID", "loading document of this lot")).toBe(
      "The loading document is not stored for this lot. Upload it again. Nothing was sent.",
    );
    expect(
      line("record_loading", "NOT_AUTHORISED", "the organisation is not this action's initiator"),
    ).toBe(
      "The caller is not authorised for this action. the organisation is not this action's initiator",
    );
    // Other kinds keep §6.5.2's message.
    expect(line("pledge", "EVIDENCE_INVALID")).toBe(
      "The evidence file is not a finalized bank record of this lender.",
    );

    // Through the dialog: the refusal shows under it and nothing is pushed.
    renderSection(loadingSnapshot(["khunou"]), "khunou");
    refusedWith("ACCEPTANCE_MISSING", `loan: ${LOAN_ONE}`);
    fireEvent.click(screen.getByRole("button", { name: "Record loading" }));
    const dialog = screen.getByRole("dialog", { name: "Record loading" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Record loading" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Not every lender with a lock on this lot has accepted this loading. Ask Lender One Bank to accept the loading in Thetis. Nothing was sent.",
    );
    expect(mocks.push).not.toHaveBeenCalled();
    cleanup();
    replies = [];
    renderSection(loadingSnapshot(["lender-one"]), "lender-one");
    refusedWith("VALIDATION", "args.loan");
    fireEvent.click(screen.getByRole("button", { name: "Accept loading" }));
    const accept = screen.getByRole("dialog", { name: "Accept loading" });
    fireEvent.click(within(accept).getByRole("button", { name: "Accept loading" }));
    expect(await within(accept).findByRole("alert")).toHaveTextContent(
      "Loan 0 has no lock on the position this intent loads, so it has nothing to accept. Nothing was sent.",
    );
  });

  test("the relay's create-time refusals of a superseded intent and a loan under exception read their loading lines on the Accept loading dialog", async () => {
    const names = {
      lenders: { [LOAN_ONE]: { name: "Lender One Bank", index: "0" } },
      owner: "Khunou Ore Exports",
    };
    const accepting = { intent: LOADING_INTENT, loan: LOAN_ONE };
    expect(
      commandFailureMessage(
        "accept_loading",
        { code: "LOADING_SUPERSEDED", detail: `intent: ${LOADING_INTENT}` },
        names,
        accepting,
      ),
    ).toBe(
      "The position changed after this loading intent was created, so it can't be accepted. Ask Khunou Ore Exports to create a new one. Nothing was sent.",
    );
    expect(
      commandFailureMessage(
        "accept_loading",
        { code: "LOAN_UNDER_EXCEPTION", detail: `loan: ${LOAN_ONE}` },
        names,
        accepting,
      ),
    ).toBe(
      "A payment correction is open on loan 0, so it can't accept a loading until the correction is settled. Nothing was sent.",
    );
    // Any other kind reads the relay's own message for each code.
    expect(failureMessage({ code: "LOADING_SUPERSEDED" })).toBe(
      "The position changed after this loading intent was created. Create a new loading intent.",
    );
    expect(failureMessage({ code: "LOAN_UNDER_EXCEPTION" })).toBe(
      "A payment correction is open on this loan, so it can't accept a loading.",
    );

    for (const [code, detail, text] of [
      [
        "LOADING_SUPERSEDED",
        `intent: ${LOADING_INTENT}`,
        "The position changed after this loading intent was created, so it can't be accepted. Ask Khunou Ore Exports to create a new one. Nothing was sent.",
      ],
      [
        "LOAN_UNDER_EXCEPTION",
        `loan: ${LOAN_ONE}`,
        "A payment correction is open on loan 0, so it can't accept a loading until the correction is settled. Nothing was sent.",
      ],
    ] as const) {
      replies = [];
      renderSection(loadingSnapshot(["lender-one"]), "lender-one");
      refusedWith(code, detail);
      fireEvent.click(screen.getByRole("button", { name: "Accept loading" }));
      const dialog = screen.getByRole("dialog", { name: "Accept loading" });
      fireEvent.click(within(dialog).getByRole("button", { name: "Accept loading" }));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent(text);
      expect(mocks.push).not.toHaveBeenCalled();
      cleanup();
    }
  });

  test("the chain's loading refusals read their loading explanations, and every other kind keeps its own", () => {
    const loadingLines: Record<string, string> = {
      AcceptanceMissing:
        "Not every lender with a lock on this lot had accepted when the transaction reached devnet. Ask each lender to accept, then record the loading again.",
      AcceptanceStale:
        "A loan changed after its lender accepted. Ask that lender to accept again, then record the loading again.",
      LoanNotActive:
        "A loan on this lot is in recovery, so the lot can't be loaded until the recovery is settled.",
      LoadingExpired: "The loading intent expired. Create a new loading intent.",
      LoadingNotOpen: "The loading intent is no longer open.",
      LotNotStored: "The lot is not stored at the terminal, so it can't be loaded.",
      Restricted: "The lot is restricted, so it can't be loaded until the restriction is lifted.",
      StaleRevision:
        "The position or loan changed after this was prepared. Create a new loading intent, or accept again.",
    };
    for (const kind of ["create_loading_intent", "record_loading", "accept_loading"] as const) {
      for (const [code, text] of Object.entries(loadingLines)) {
        expect(failureExplanation(code, kind)).toBe(text);
      }
    }
    expect(failureExplanation("WrongRole", "create_loading_intent")).toBe(
      "The lot's custodian is not a terminal, so the lot can't be loaded there.",
    );
    expect(failureExplanation("WrongRole", "record_loading")).toBe(
      "A signer's authority does not allow this action.",
    );
    expect(failureExplanation("Paused", "record_loading")).toBe(
      "This action is paused on the instance.",
    );
    expect(failureExplanation("LoanNotActive", "pledge")).toBe("The loan is not active.");
    expect(failureExplanation("StaleRevision")).toBe(
      "The lot or loan changed after this was prepared. Start the action again.",
    );
    expect(
      statusLine(
        view({ status: "failed", error: { code: "AcceptanceStale", detail: null } }),
        () => "",
      ),
    ).toBe(
      "Devnet refused this transaction: AcceptanceStale. A loan changed after its lender accepted. Ask that lender to accept again, then record the loading again. The program made no change.",
    );
  });

  test("the work queue lists Accept loading for the lender, Record loading for a ready owner, and Sign: Record loading for an owner whose terminal started it", () => {
    const due = new Date(Number(LOADING_EXPIRES_AT) * 1000).toISOString();
    const lender = liveReader(loadingSnapshot(["lender-one"]), NOW);
    expect(lender.workQueue("lender-one")).toEqual([
      expect.objectContaining({
        id: `accept-loading:${LOADING_INTENT}:${LOAN_ONE}`,
        action: "Accept loading",
        blocker:
          "Khunou Ore Exports is loading CR-0001 at Port Terminal T1. Accept so the loading can be recorded.",
        deadline: due,
        href: "/lender-one/lots/CR-0001?tab=financing",
        amountMinor: null,
        quantityKg: 3_000_000n,
        registry: { status: "not_submitted" },
        nextActor: lenderOne,
      }),
    ]);
    expect(lender.workItemMoney("lender-one", `accept-loading:${LOADING_INTENT}:${LOAN_ONE}`)).toBe(
      null,
    );
    const lenderItems = getQueueData(lender, "lender-one").items;
    expect(lenderItems[0]).toMatchObject({
      quantity: "3,000.000 t",
      quantityBasis: "locked to your loan",
      actionLabel: "Open dossier",
    });
    // Accepted at the current revision: no item.
    expect(
      liveReader(loadingSnapshot(["lender-one"], [loadingIntent()], [acceptance()]), NOW).workQueue(
        "lender-one",
      ),
    ).toEqual([]);

    const owner = liveReader(loadingSnapshot(["khunou"], [loadingIntent()], [acceptance()]), NOW);
    expect(owner.workQueue("khunou")).toEqual([
      expect.objectContaining({
        id: `record-loading:${LOADING_INTENT}`,
        action: "Record loading",
        blocker: "Every lender has accepted. Record the loading with Port Terminal T1.",
        deadline: due,
        href: "/khunou/lots/CR-0001?tab=financing",
        amountMinor: null,
        quantityKg: 3_000_000n,
        registry: { status: "not_submitted" },
      }),
    ]);
    expect(getQueueData(owner, "khunou").items[0]).toMatchObject({
      quantityBasis: "of the position",
    });
    // Not ready: no Record loading item.
    expect(liveReader(loadingSnapshot(["khunou"]), NOW).workQueue("khunou")).toEqual([]);

    const started = loadingSnapshot(["khunou", "port-t1"], [loadingIntent()], [acceptance()]);
    started.commands = [
      command({
        kind: "record_loading",
        initiator_org: orgId("port-t1"),
        parties: [orgId("khunou"), orgId("port-t1")],
        facility: null,
        intent: LOADING_INTENT,
        args: { intent: LOADING_INTENT },
        signers: [
          { role: "owner", organisationId: orgId("khunou"), method: "text", scope: "SHIP" },
          { role: "terminal", organisationId: orgId("port-t1"), method: "text", scope: "LOAD" },
        ],
        signatures: [],
      }),
    ];
    const reader = liveReader(started, NOW);
    expect(reader.workQueue("khunou")).toEqual([
      expect.objectContaining({
        id: "2cc199ec-0000-4000-8000-000000000001",
        action: "Sign: Record loading",
        href: "/khunou/commands/2cc199ec-0000-4000-8000-000000000001",
        registry: { status: "awaiting_signatures" },
      }),
    ]);
    expect(reader.workQueue("khunou")[0]?.blocker).toMatch(/^0 of 2 signatures collected\./);
    // The terminal signs on the field app: no web item for it.
    expect(reader.workQueue("port-t1")).toEqual([]);
  });

  test("a recorded loading shows each loan's outcome from the loan and lot rows, never from the command", () => {
    const executedAt = String(NOW_SECONDS - 300);
    const recorded = (status: "ExternalHandoff" | "Active" | "Closed", principal: string) => {
      const snapshot = loadingSnapshot(
        ["khunou"],
        [loadingIntent({ status: "Executed", executed_at: executedAt })],
        [acceptance()],
      );
      snapshot.positions = [
        position(KHUNOU_POSITION, "khunou", "0", { revision: "4" }),
        position(BUYER_POSITION, "buyer-smelter", "2000000"),
      ];
      snapshot.lots = [
        lotRow({
          custodian: orgAccount("port-t1"),
          custodian_org_id: orgId("port-t1"),
          supply_kg: "2000000",
          revision: "2",
          event_revision: "2",
        }),
      ];
      snapshot.loans = [
        loan(LOAN_ONE, FACILITY_ONE, "lender-one", {
          status,
          principal,
          accrued_at: String(NOW_SECONDS),
          revision: "3",
        }),
      ];
      snapshot.locks = [lock(LOCK_ONE, LOAN_ONE, "0")];
      return snapshot;
    };
    const handedOff = recorded("ExternalHandoff", "20000000");
    const [intentView] = loadingOf(handedOff, "khunou").intents;
    expect(intentView).toMatchObject({
      state: "recorded",
      lotLoaded: false,
      handOffs: [
        {
          loan: LOAN_ONE,
          loanIndex: 0n,
          lender: lenderOne,
          status: "ExternalHandoff",
          debtMinor: 20_000_000n,
          currency: "USD",
          currencyDecimals: 2,
        },
      ],
    });
    renderSection(handedOff, "khunou");
    expect(screen.getByText(/^Recorded on devnet /)).toBeInTheDocument();
    expect(
      screen.getByText(
        "Loan 0, Lender One Bank: Position loaded; debt remains recorded; external hand-off accepted by lender",
      ),
    ).toBeInTheDocument();
    cleanup();

    const retired = recorded("ExternalHandoff", "20000000");
    retired.positions = [position(KHUNOU_POSITION, "khunou", "0", { revision: "4" })];
    retired.lots = [
      lotRow({
        custodian: orgAccount("port-t1"),
        custodian_org_id: orgId("port-t1"),
        supply_kg: "0",
        state: "Loaded",
        revision: "2",
        event_revision: "2",
      }),
    ];
    renderSection(retired, "khunou");
    expect(
      screen.getByText(
        "Loan 0, Lender One Bank: Registry retired; debt remains recorded; external hand-off accepted by lender",
      ),
    ).toBeInTheDocument();
    cleanup();

    renderSection(recorded("Active", "0"), "khunou");
    expect(
      screen.getByText(
        "Loan 0, Lender One Bank: Position loaded. The loan has no debt and is ready to close.",
      ),
    ).toBeInTheDocument();
    cleanup();
    renderSection(recorded("Closed", "0"), "khunou");
    expect(screen.getByText("Loan 0, Lender One Bank: Position loaded.")).toBeInTheDocument();
    cleanup();

    // A confirmed record_loading command alone shows nothing as recorded.
    const pending = loadingSnapshot(["khunou"], [loadingIntent()], [acceptance()]);
    pending.commands = [
      command({
        kind: "record_loading",
        status: "outcome_unknown",
        facility: null,
        intent: LOADING_INTENT,
        args: { intent: LOADING_INTENT },
        signers: [],
        signatures: [],
      }),
    ];
    renderSection(pending, "khunou");
    expect(screen.queryByText(/^Recorded on devnet/)).not.toBeInTheDocument();
    expect(screen.queryByText("Recorded")).not.toBeInTheDocument();
    expect(screen.getByText("Ready to record")).toBeInTheDocument();
  });
});
