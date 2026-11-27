// live-lending.md §9.4: the lender actions, the command page and the live release screen. Every
// party, quantity and amount is the synthetic demo's (snapshot.ts); wallets are throwaway keys.

import "@testing-library/jest-dom/vitest";
import { createHash, verify as ed25519Verify } from "node:crypto";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { previewRelease } from "@thetis/domain";
import { getWallets } from "@wallet-standard/app";
import bs58 from "bs58";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { FinancialResults } from "@/components/dossier/record-tables";
import { liveReader } from "@/data/live/map";
import type { LiveSnapshot } from "@/data/live/rows";
import { LiveDataError } from "@/data/live/types";
import type { CommandView } from "@/lib/commands";
import { formatClockTime, formatMoney, parseMoneyInput, parseTonnesInput } from "@/lib/format";
import { fakeWallet } from "../access/fake-wallet";
import {
  command,
  FACILITY_ONE,
  FACILITY_TWO,
  facility,
  fakeSupabase,
  INTENT,
  INTENT_EXPIRES_AT,
  intent,
  KHUNOU_POSITION,
  LOAN_ONE,
  LOAN_TWO,
  LOCK_ONE,
  LOCK_TWO,
  LOT,
  loan,
  lock,
  NOW,
  orgId,
  PROGRAM_ID,
  PROTOCOL,
  payment,
  pledgedSnapshot,
  position,
  RELEASE_PAYMENT,
  REPAYMENT,
  VALUATION_ONE,
  valuation,
} from "./snapshot";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  session: {
    access_token: "synthetic-token",
    user: { id: "21000000-0000-4000-8000-000000000001" },
  },
  links: [] as { wallet: string; organisation_id: string }[],
  storage: [] as unknown[],
  inserts: [] as { table: string; row: Record<string, unknown> }[],
  failStep: null as string | null,
  log: [] as string[],
}));

vi.mock("next/navigation", async (original) => ({
  ...(await original<typeof import("next/navigation")>()),
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh, replace: vi.fn() }),
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
          const failed = mocks.failStep === `insert ${table}`;
          const reply = failed
            ? { data: null, error: { message: "denied" } }
            : { data: { id }, error: null };
          return { select: () => ({ single: async () => reply }) };
        },
      };
    },
    storage: {
      from: () => ({
        upload: async (path: string, file: File, options: unknown) => {
          mocks.log.push("upload");
          mocks.storage.push({ path, file, options });
          return mocks.failStep === "upload"
            ? { data: null, error: { message: "denied" } }
            : { data: { path }, error: null };
        },
      }),
    },
  }),
}));

const { CommandLive } = await import("@/components/commands/command-live");
const { CommandForm } = await import("@/components/commands/command-form");
const { default: ReleasePage } = await import("@/app/[context]/releases/[releaseId]/page");

const server = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase-server", () => ({ supabaseServer: async () => server.client }));

const lenderOne = { id: "lender-one", name: "Lender One Bank", role: "lender" };
const buyerSmelter = { id: "buyer-smelter", name: "Buyer Smelter Co", role: "buyer" };
const NOW_SECONDS = NOW.getTime() / 1000;

function lotOf(snapshot: LiveSnapshot, context: string) {
  const lot = liveReader(snapshot, NOW).lot("CR-0001", context);
  if (!lot) throw new Error(`CR-0001 is not visible to ${context}`);
  return lot;
}

function refused(snapshot: LiveSnapshot, code: string, path: string) {
  const read = () => liveReader(snapshot, NOW);
  expect(read).toThrow(LiveDataError);
  expect(read).toThrow(expect.objectContaining({ code, path }));
}

/** The snapshot Buyer Smelter Co reads: the intent, its Release payments, the lot; no loan. */
function buyerSnapshot(payments = [payment(RELEASE_PAYMENT)]): LiveSnapshot {
  const snapshot = pledgedSnapshot(["buyer-smelter"]);
  snapshot.facilities = [];
  snapshot.valuations = [];
  snapshot.loans = [];
  snapshot.locks = [];
  snapshot.intents = [intent()];
  snapshot.payments = payments;
  return snapshot;
}

describe("live lending reads", () => {
  test("liveReader maps a pledged lot with its loan, valuation, lock and interest accrued to now", () => {
    const lot = lotOf(pledgedSnapshot(), "lender-one");
    // 60,000,000 x 1,200 bps x 3,600 s / (10,000 x 365 x 86,400) = 821.9, floored
    expect(lot).toMatchObject({
      finance: "Pledged",
      owner: { id: "khunou" },
      position: {
        positionQuantityKg: 5_000_000n,
        activeLockedQuantityKg: 5_000_000n,
        separatelyReservedQuantityKg: 0n,
        availableKg: 0n,
      },
      locks: [{ lender: lenderOne, lockedQuantityKg: 5_000_000n }],
      loan: {
        principalMinor: 60_000_000n,
        bookedInterestMinor: 821n,
        bookedFeesMinor: 0n,
        debtMinor: 60_000_821n,
        status: "Active",
        lender: lenderOne,
        registry: { status: "confirmed" },
      },
      valuation: {
        valuePerKgMinor: 20n,
        haircutBps: 0n,
        maxLtvBps: 6000n,
        validUntil: new Date((NOW_SECONDS + 30 * 86_400) * 1000).toISOString(),
        eligibleValueMinor: 100_000_000n,
        ltvBps: 6000n,
        registry: { status: "confirmed" },
      },
      releases: [],
    });
    expect(lot.lending).toMatchObject({
      lotAddress: LOT,
      primaryLoan: LOAN_ONE,
      hiddenLockedKg: 0n,
      classPolicy: lot.lending?.classPolicy,
      grade: "G1",
      shownPosition: { address: KHUNOU_POSITION, revision: 1n },
      openCommands: [],
    });
    const [only] = lot.lending?.loans ?? [];
    expect(only).toMatchObject({
      address: LOAN_ONE,
      index: 0n,
      principalMinor: 60_000_000n,
      bookedInterestMinor: 0n,
      accruedInterestMinor: 821n,
      debtMinor: 60_000_821n,
      asOf: NOW.toISOString(),
      lock: { address: LOCK_ONE, quantityKg: 5_000_000n, control: "Pledged" },
      valuation: { address: VALUATION_ONE, stale: false },
      facility: { address: FACILITY_ONE, currency: "USD", currencyDecimals: 2, rateBps: 1200n },
    });

    // The borrower sees the same pledge; the finance label follows the primary loan's status.
    expect(lotOf(pledgedSnapshot(["khunou"]), "khunou").finance).toBe("Pledged");
    for (const [status, label] of [
      ["Recovery", "Recovery"],
      ["ExternalHandoff", "External hand-off"],
    ] as const) {
      const snapshot = pledgedSnapshot();
      snapshot.loans = [loan(LOAN_ONE, FACILITY_ONE, "lender-one", { status })];
      expect(lotOf(snapshot, "lender-one").finance).toBe(label);
    }
    const repaid = pledgedSnapshot();
    repaid.positions = [position(KHUNOU_POSITION, "khunou", "5000000", { revision: "2" })];
    repaid.loans = [
      loan(LOAN_ONE, FACILITY_ONE, "lender-one", { status: "Closed", principal: "0" }),
    ];
    repaid.locks = [lock(LOCK_ONE, LOAN_ONE, "0")];
    expect(lotOf(repaid, "lender-one")).toMatchObject({ finance: "Repaid", loan: null, locks: [] });

    // A 100% haircut leaves no eligible value, so the loan to value is not computed.
    const haircut = pledgedSnapshot();
    haircut.valuations = [valuation({ haircut_bps: 10_000 })];
    expect(lotOf(haircut, "lender-one").valuation).toMatchObject({
      eligibleValueMinor: 0n,
      ltvBps: null,
    });
    render(
      <FinancialResults
        source="live"
        lot={lotOf(haircut, "lender-one")}
        money={(minor) => formatMoney(minor, "USD", 2)}
      />,
    );
    expect(screen.getByText("Eligible value is zero at this haircut")).toBeInTheDocument();
  });

  test("the primary loan is the lender's own, else the largest open lock", () => {
    const snapshot = pledgedSnapshot(["lender-two", "khunou"]);
    snapshot.facilities = [
      facility(FACILITY_ONE, "lender-one", { loan_count: 1 }),
      facility(FACILITY_TWO, "lender-two", { loan_count: 1 }),
    ];
    snapshot.loans = [
      loan(LOAN_ONE, FACILITY_ONE, "lender-one"),
      loan(LOAN_TWO, FACILITY_TWO, "lender-two", { principal: "0" }),
    ];
    snapshot.locks = [lock(LOCK_ONE, LOAN_ONE, "3000000"), lock(LOCK_TWO, LOAN_TWO, "2000000")];
    expect(lotOf(snapshot, "lender-two").lending?.primaryLoan).toBe(LOAN_TWO);
    expect(lotOf(snapshot, "khunou").lending?.primaryLoan).toBe(LOAN_ONE);
    expect(lotOf(snapshot, "khunou").locks).toEqual([
      { lender: lenderOne, lockedQuantityKg: 3_000_000n },
      {
        lender: { id: "lender-two", name: "Lender Two Bank", role: "lender" },
        lockedQuantityKg: 2_000_000n,
      },
    ]);

    // Equal locks: the smaller loan address.
    snapshot.locks = [lock(LOCK_ONE, LOAN_ONE, "2500000"), lock(LOCK_TWO, LOAN_TWO, "2500000")];
    expect(lotOf(snapshot, "khunou").lending?.primaryLoan).toBe([LOAN_ONE, LOAN_TWO].toSorted()[0]);

    // A lender without a loan of its own on the position has no primary loan.
    const own = pledgedSnapshot(["lender-two"]);
    own.facilities = [facility(FACILITY_TWO, "lender-two")];
    own.valuations = [];
    own.loans = [];
    own.locks = [];
    expect(lotOf(own, "lender-two").lending?.primaryLoan).toBeNull();
  });

  test("a position whose locked_kg is below its visible locks is BAD_ROW, and a hidden remainder is shown", () => {
    const below = pledgedSnapshot();
    below.positions = [position(KHUNOU_POSITION, "khunou", "5000000", { locked_kg: "4999999" })];
    refused(below, "BAD_ROW", "positions[0].locked_kg");

    // Lender Two reads its own facility only; Lender One's 5,000 t lock is the hidden remainder.
    const hidden = pledgedSnapshot(["lender-two"]);
    hidden.facilities = [facility(FACILITY_TWO, "lender-two")];
    hidden.valuations = [];
    hidden.loans = [];
    hidden.locks = [];
    const lot = lotOf(hidden, "lender-two");
    expect(lot).toMatchObject({ finance: "Pledged", loan: null, valuation: null, locks: [] });
    expect(lot.lending).toMatchObject({ hiddenLockedKg: 5_000_000n, primaryLoan: null });
    expect(lot.lending?.facilities.map(({ address }) => address)).toEqual([FACILITY_TWO]);
  });

  test("workQueue lists commands awaiting the context, payments to confirm, releases to accept and repayments to apply", () => {
    const snapshot = pledgedSnapshot();
    snapshot.intents = [intent()];
    snapshot.payments = [
      payment(REPAYMENT, {
        purpose: "Repayment",
        subject: LOAN_ONE,
        amount: "10000",
        payment_id_hex: "32".repeat(32),
      }),
    ];
    snapshot.commands = [command()];
    const reader = liveReader(snapshot, NOW);
    const items = reader.workQueue("lender-one");
    const lotRef = {
      id: "CR-0001",
      gradeClass: "CHROME v1, grade G1",
      quantityKg: 5_000_000n,
    };
    const signedBy = formatClockTime(new Date((NOW_SECONDS + 210) * 1000).toISOString());
    expect(items).toEqual([
      {
        id: "2cc199ec-0000-4000-8000-000000000001",
        lot: expect.objectContaining(lotRef),
        action: "Sign: Pledge receipts",
        nextActor: lenderOne,
        blocker: `1 of 2 signatures collected. The text expires at ${signedBy}.`,
        deadline: new Date((NOW_SECONDS + 210) * 1000).toISOString(),
        href: "/lender-one/commands/2cc199ec-0000-4000-8000-000000000001",
        amountMinor: null,
        quantityKg: 5_000_000n,
        registry: { status: "awaiting_signatures" },
      },
      {
        id: `confirm:${INTENT}`,
        lot: expect.objectContaining(lotRef),
        action: "Confirm payment",
        nextActor: lenderOne,
        blocker:
          "Buyer Smelter Co pays USD 400,000.00 outside Thetis. Record it once your bank shows it.",
        deadline: new Date(Number(INTENT_EXPIRES_AT) * 1000).toISOString(),
        href: `/lender-one/releases/${INTENT}`,
        amountMinor: 40_000_000n,
        quantityKg: 2_000_000n,
        registry: { status: "not_submitted" },
      },
      {
        id: `apply:${REPAYMENT}`,
        lot: expect.objectContaining(lotRef),
        action: "Apply repayment",
        nextActor: lenderOne,
        blocker: "USD 100.00 confirmed on 26 Nov 2026, 01:50 SAST. Apply it to the loan.",
        deadline: null,
        href: "/lender-one/lots/CR-0001?tab=financing",
        amountMinor: 10_000n,
        quantityKg: null,
        registry: { status: "not_submitted" },
      },
    ]);
    expect(reader.workItemMoney("lender-one", `confirm:${INTENT}`)).toEqual({
      currency: "USD",
      minorDigits: 2,
    });
    expect(reader.workItemMoney("lender-one", "2cc199ec-0000-4000-8000-000000000001")).toBeNull();

    // Khunou signed already, and an expired text asks nobody.
    expect(reader.workQueue("khunou")).toEqual([]);
    const expired = pledgedSnapshot(["lender-one"]);
    expired.commands = [command({ valid_until: String(NOW_SECONDS + 30) })];
    expect(liveReader(expired, NOW).workQueue("lender-one")).toEqual([]);

    // A transaction role waits until every text role has signed.
    const advance = pledgedSnapshot(["lender-one"]);
    advance.commands = [
      command({
        kind: "record_advance",
        loan: LOAN_ONE,
        args: { loan: LOAN_ONE, amountMinor: "60000000" },
        signers: [
          { role: "borrower", organisationId: orgId("khunou"), method: "text", scope: "PLEDGE" },
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
    expect(liveReader(advance, NOW).workQueue("lender-one")).toEqual([]);

    // The buyer accepts once the payment is confirmed, and not while a sell command is open.
    const buyer = liveReader(buyerSnapshot(), NOW);
    expect(buyer.workQueue("buyer-smelter")).toEqual([
      expect.objectContaining({
        id: `accept:${INTENT}`,
        action: "Accept and buy",
        blocker: "Lender One Bank confirmed your payment. Sign to receive the units.",
        href: `/buyer-smelter/releases/${INTENT}`,
        amountMinor: 40_000_000n,
        quantityKg: 2_000_000n,
      }),
    ]);
    const selling = buyerSnapshot();
    selling.commands = [
      command({
        id: "3dd2aa00-0000-4000-8000-000000000002",
        kind: "sell_pledged",
        initiator_org: orgId("buyer-smelter"),
        intent: INTENT,
        args: { intent: INTENT },
        signers: [
          {
            role: "buyer",
            organisationId: orgId("buyer-smelter"),
            method: "text",
            scope: "BUY",
          },
        ],
        signatures: [],
      }),
    ];
    expect(
      liveReader(selling, NOW)
        .workQueue("buyer-smelter")
        .map(({ id }) => id),
    ).toEqual(["3dd2aa00-0000-4000-8000-000000000002"]);

    // A voided release payment raises nothing (T064b.2 decision 4).
    const voided = pledgedSnapshot();
    voided.intents = [intent()];
    voided.payments = [payment(RELEASE_PAYMENT, { status: "Voided" })];
    expect(liveReader(voided, NOW).workQueue("lender-one")).toEqual([]);
  });

  test("liveRelease previews from the chain rows, and the buyer alone gets the terms without a preview", () => {
    const snapshot = pledgedSnapshot();
    snapshot.intents = [intent()];
    const view = liveReader(snapshot, NOW).liveRelease(INTENT, "lender-one");
    const inputs = {
      principal: 60_000_000n,
      bookedInterest: 821n,
      bookedFees: 0n,
      buyerAmount: 40_000_000n,
      sellerTopUp: 0n,
      lockedQuantity: 5_000_000n,
      soldLockedQuantity: 2_000_000n,
      valuePerUnit: 20n,
      haircutBps: 0n,
      maxLtvBps: 6000n,
    };
    expect(view).toMatchObject({
      intent: { address: INTENT, quantityKg: 2_000_000n, priceMinor: 40_000_000n, payment: "none" },
      lender: lenderOne,
      currency: "USD",
      minorDigits: 2,
      loan: { address: LOAN_ONE },
      inputs,
      preview: previewRelease(inputs),
      previewBlocked: null,
      asOf: NOW.toISOString(),
      paymentAddress: null,
      sale: { registry: { status: "not_submitted" }, command: null },
    });

    const buyer = liveReader(buyerSnapshot([]), NOW).liveRelease(INTENT, "buyer-smelter");
    expect(buyer).toMatchObject({
      intent: { buyer: buyerSmelter, quantityKg: 2_000_000n, currency: "USD" },
      loan: null,
      inputs: null,
      preview: null,
      previewBlocked: "buyer",
    });

    const unvalued = pledgedSnapshot();
    unvalued.valuations = [];
    unvalued.intents = [intent()];
    expect(liveReader(unvalued, NOW).liveRelease(INTENT, "lender-one")).toMatchObject({
      preview: null,
      previewBlocked: "no_valuation",
    });

    // Not visible to the context, or not an intent: null.
    expect(liveReader(snapshot, NOW).liveRelease(LOAN_ONE, "lender-one")).toBeNull();
    expect(liveReader(snapshot, NOW).liveRelease(INTENT, "kopano")).toBeNull();
  });

  test("the release payment state is consumed, confirmed, mismatch, voided or none", () => {
    const stateOf = (payments: ReturnType<typeof payment>[]) => {
      const snapshot = pledgedSnapshot();
      snapshot.intents = [intent()];
      snapshot.payments = payments;
      const reader = liveReader(snapshot, NOW);
      return {
        state: reader.liveRelease(INTENT, "lender-one")?.intent.payment,
        address: reader.liveRelease(INTENT, "lender-one")?.paymentAddress,
        release: lotOf(snapshot, "lender-one").releases[0]?.payment,
      };
    };
    const other = (status: "Unconsumed" | "Consumed" | "Voided", amount = "40000000") =>
      payment(REPAYMENT, { status, amount, payment_id_hex: "33".repeat(32) });
    expect(stateOf([])).toEqual({ state: "none", address: null, release: "none" });
    expect(stateOf([payment(RELEASE_PAYMENT)])).toEqual({
      state: "confirmed",
      address: RELEASE_PAYMENT,
      release: "confirmed",
    });
    expect(stateOf([other("Unconsumed", "1")])).toMatchObject({ state: "mismatch" });
    expect(stateOf([other("Voided")])).toMatchObject({ state: "voided" });
    expect(stateOf([other("Voided"), payment(RELEASE_PAYMENT, { status: "Consumed" })])).toEqual({
      state: "consumed",
      address: RELEASE_PAYMENT,
      release: "consumed",
    });
    // A Repayment naming the loan is not a payment of the intent.
    expect(
      stateOf([payment(RELEASE_PAYMENT, { purpose: "Repayment", subject: LOAN_ONE })]),
    ).toMatchObject({ state: "none" });
  });
});

// ---------------------------------------------------------------------------------------------
// The command page (§6.9.4) against a stubbed API.

const API = "http://api.test";
const COMMAND_ID = "2cc199ec-0000-4000-8000-000000000001";
const TEXT = [
  "Thetis authorisation v1",
  "Network: devnet",
  `Program: ${PROGRAM_ID}`,
  "Protocol: 00112233445566778899aabbccddeeff",
  "Action: Pledge receipts",
  "Lot: CR-0001",
  "Quantity: 5,000.000 t",
  "Owner: Khunou Ore Exports",
  "Lender: Lender One Bank",
  `Facility: ${"11".repeat(16)}`,
  "Loan: 0",
  "Revision: 1",
  "Valid until: 2026-11-26 02:04:10 SAST",
  "Test network only. Synthetic data.",
].join("\n");
const TEXT_BYTES = new TextEncoder().encode(TEXT);
const TEXT_SHA = createHash("sha256").update(TEXT_BYTES).digest("hex");
const KHUNOU_WALLET = bs58.encode(new Uint8Array(32).fill(70));

function view(overrides: Partial<CommandView> = {}): CommandView {
  return {
    id: COMMAND_ID,
    kind: "pledge",
    status: "awaiting_signatures",
    network: "devnet",
    programId: PROGRAM_ID,
    protocol: PROTOCOL,
    initiatorOrganisationId: orgId("khunou"),
    parties: [orgId("khunou"), orgId("lender-one")],
    lot: LOT,
    facility: FACILITY_ONE,
    loan: null,
    intent: null,
    payment: null,
    args: { facility: FACILITY_ONE, lot: LOT, quantityKg: "5000000" },
    fields: [
      { label: "Lot", value: "CR-0001" },
      { label: "Quantity", value: "5,000.000 t" },
      { label: "Owner", value: "Khunou Ore Exports" },
    ],
    text: {
      version: 1,
      messageBase64: Buffer.from(TEXT_BYTES).toString("base64"),
      messageSha256: TEXT_SHA,
      validUntil: new Date((NOW_SECONDS + 240) * 1000).toISOString(),
      validUntilText: "2026-11-26 02:04:10 SAST",
    },
    signers: [
      {
        role: "borrower",
        organisationId: orgId("khunou"),
        method: "text",
        signed: { wallet: KHUNOU_WALLET, signedAt: "2026-11-26T00:00:05.000Z" },
      },
      { role: "lender", organisationId: orgId("lender-one"), method: "text", signed: null },
    ],
    transaction: null,
    confirmedSlot: null,
    confirmedCommitment: null,
    outcome: null,
    error: null,
    createdAt: "2026-11-26T00:00:02.000Z",
    updatedAt: "2026-11-26T00:00:05.000Z",
    ...overrides,
  };
}

const organisations = {
  [orgId("khunou")]: "Khunou Ore Exports",
  [orgId("lender-one")]: "Lender One Bank",
  [orgId("lender-two")]: "Lender Two Bank",
};

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
  mocks.storage = [];
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

function renderCommand(initial: CommandView, memberships = [orgId("lender-one")]) {
  return render(
    <CommandLive
      initial={initial}
      context="lender-one"
      memberships={memberships}
      organisations={organisations}
      lotId="CR-0001"
    />,
  );
}

function register(wallet: ReturnType<typeof fakeWallet>) {
  unregister.push(getWallets().register(wallet.wallet));
  return wallet;
}

describe("command page", () => {
  test("the command page shows the exact text, each signer's state and the API's status line", async () => {
    renderCommand(view(), [orgId("lender-two")]);
    expect(screen.getByRole("heading", { level: 1, name: "Pledge receipts" })).toBeInTheDocument();
    expect(screen.getByText("CR-0001", { selector: ".font-mono" })).toBeInTheDocument();
    expect(screen.getByText("Command 2cc199ec")).toBeInTheDocument();
    expect(document.querySelector("pre")?.textContent).toBe(TEXT);
    expect(screen.getByText(`SHA-256 ${TEXT_SHA.slice(0, 8)}`)).toBeInTheDocument();
    expect(screen.getByText("Valid until 2026-11-26 02:04:10 SAST")).toBeInTheDocument();
    const signers = screen.getByRole("region", { name: "Signers" });
    expect(within(signers).getByText("Khunou Ore Exports", { exact: false })).toBeInTheDocument();
    expect(signers.textContent).toContain(
      `Signed by ${KHUNOU_WALLET.slice(0, 4)}…${KHUNOU_WALLET.slice(-4)} at 02:00:05 SAST`,
    );
    expect(within(signers).getByText("Waiting")).toBeInTheDocument();
    const clock = formatClockTime(new Date((NOW_SECONDS + 210) * 1000).toISOString());
    expect(screen.getByRole("status")).toHaveTextContent(
      `Waiting for 1 of 2 signatures. The text expires at ${clock}.`,
    );
    cleanup();

    const failed = view({
      status: "failed",
      transaction: { signature: "5".repeat(88), sends: 1, explorerUrl: "https://explorer" },
      error: { code: "InsufficientAvailable", detail: null },
    });
    renderCommand(failed);
    expect(screen.getByText("Failed")).toBeInTheDocument();
    const line =
      "Devnet refused this transaction: InsufficientAvailable. Those units are not available: they are already pledged, reserved or sold. The program made no change.";
    expect(screen.getByRole("status")).toHaveTextContent(line);
    expect(document.body.textContent?.split("Those units are not available").length).toBe(2);
    expect(screen.getByRole("link", { name: `${"5".repeat(8)}…${"5".repeat(8)}` })).toHaveAttribute(
      "href",
      "https://explorer",
    );
    expect(screen.getByText("What this command would have recorded")).toBeInTheDocument();
    cleanup();

    renderCommand(
      view({
        status: "confirmed",
        confirmedSlot: "13004",
        confirmedCommitment: "confirmed",
        transaction: { signature: "6".repeat(88), sends: 1, explorerUrl: "https://explorer" },
      }),
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Confirmed on devnet in slot 13,004. The lot's figures update once the indexer reads this transaction.",
    );
    expect(screen.getByText("What was recorded")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open the lot" })).toHaveAttribute(
      "href",
      "/lender-one/lots/CR-0001?tab=financing",
    );
    cleanup();

    renderCommand(view({ status: "expired" }), [orgId("khunou")]);
    expect(screen.getByText("Not on chain")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "The text expired before everyone signed. Nothing was sent.",
    );
    expect(screen.getByRole("button", { name: "Prepare a new text" })).toBeInTheDocument();
  });

  test("signing posts the text's own hash and the wallet's signature, and a cancelled wallet posts nothing", async () => {
    const solflare = register(fakeWallet("Solflare"));
    mocks.links = [{ wallet: solflare.account.address, organisation_id: orgId("lender-one") }];
    renderCommand(view());
    fireEvent.click(await screen.findByRole("button", { name: "Connect Solflare" }));
    const sign = await screen.findByRole("button", { name: "Sign with Solflare" });

    solflare.signMessage.mockRejectedValueOnce(new Error("User rejected"));
    fireEvent.click(sign);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "You cancelled in Solflare. Nothing was signed.",
    );
    expect(calls.filter(({ method }) => method === "POST")).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Sign with Solflare" }));
    await waitFor(() => expect(calls.some(({ method }) => method === "POST")).toBe(true));
    const post = calls.find(({ method }) => method === "POST");
    expect(post?.url).toBe(`${API}/v1/commands/${COMMAND_ID}/signatures`);
    const body = post?.body as Record<string, string>;
    expect(body).toEqual({
      role: "lender",
      wallet: solflare.account.address,
      messageSha256: TEXT_SHA,
      signature: expect.any(String),
    });
    expect(
      ed25519Verify(null, TEXT_BYTES, solflare.key.publicKey, bs58.decode(body.signature ?? "")),
    ).toBe(true);
    cleanup();
    calls.length = 0;

    // A view whose hash is not its text's: nothing is signed or posted.
    renderCommand(
      view({
        text: {
          ...(view().text as NonNullable<CommandView["text"]>),
          messageSha256: "0".repeat(64),
        },
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Connect Solflare" }));
    fireEvent.click(await screen.findByRole("button", { name: "Sign with Solflare" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The text changed. Reload the page.",
    );
    expect(calls.filter(({ method }) => method === "POST")).toEqual([]);
  });

  test("a transaction signer posts the issued bytes back with only its signature added", async () => {
    const solflare = fakeWallet("Solflare");
    const issued = new Uint8Array(200).map((_, index) => (index < 65 ? 0 : index));
    issued[0] = 1;
    const signTransaction = vi.fn(async ({ transaction }: { transaction: Uint8Array }) => {
      const signed = new Uint8Array(transaction);
      signed.set(solflare.key.sign(transaction.slice(65)), 1);
      return [{ signedTransaction: signed }];
    });
    (solflare.wallet.features as Record<string, unknown>)["solana:signTransaction"] = {
      version: "1.0.0",
      supportedTransactionVersions: ["legacy", 0],
      signTransaction,
    };
    register(solflare);
    mocks.links = [{ wallet: solflare.account.address, organisation_id: orgId("lender-one") }];
    const openFacility = view({
      kind: "open_facility",
      lot: null,
      text: null,
      initiatorOrganisationId: orgId("lender-one"),
      fields: [
        { label: "Lender", value: "Lender One Bank" },
        { label: "Facility", value: "22".repeat(16) },
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
    let expiredOnce = true;
    replies.push((call) => {
      if (call.method === "GET") return json(200, { data: openFacility });
      if (call.url.endsWith("/transaction-request"))
        return json(200, {
          data: {
            transactionBase64: Buffer.from(issued).toString("base64"),
            lastValidBlockHeight: "9",
          },
        });
      if (call.url.endsWith("/transaction") && expiredOnce) {
        expiredOnce = false;
        return json(409, { error: { code: "BLOCKHASH_EXPIRED", message: "old" } });
      }
      return undefined;
    });
    renderCommand(openFacility);
    expect(screen.getByRole("heading", { level: 1, name: "Open facility" })).toBeInTheDocument();
    expect(screen.getByText("22222222", { selector: ".font-mono" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Waiting for Lender One Bank to sign the transaction.",
    );
    fireEvent.click(await screen.findByRole("button", { name: "Connect Solflare" }));
    const button = await screen.findByRole("button", {
      name: "Sign the transaction with Solflare",
    });
    fireEvent.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The transaction took too long to sign. Sign it again.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Sign the transaction with Solflare" }));
    await waitFor(() =>
      expect(calls.filter(({ url }) => url.endsWith("/transaction"))).toHaveLength(2),
    );
    expect(calls.find(({ url }) => url.endsWith("/transaction-request"))?.body).toEqual({
      wallet: solflare.account.address,
    });
    const posted = calls.filter(({ url }) => url.endsWith("/transaction")).at(-1)?.body as {
      transactionBase64: string;
    };
    const bytes = new Uint8Array(Buffer.from(posted.transactionBase64, "base64"));
    expect(bytes.length).toBe(issued.length);
    expect(bytes.slice(65)).toEqual(issued.slice(65));
    expect(bytes[0]).toBe(1);
    expect(bytes.slice(1, 65)).toEqual(solflare.key.sign(issued.slice(65)));
    cleanup();

    // The transaction role of a text kind waits for the text: disabled, with its reason.
    renderCommand(
      view({
        kind: "record_advance",
        signers: [
          { role: "borrower", organisationId: orgId("khunou"), method: "text", signed: null },
          {
            role: "lender",
            organisationId: orgId("lender-one"),
            method: "transaction",
            signed: null,
          },
        ],
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Connect Solflare" }));
    expect(
      await screen.findByRole("button", { name: "Sign the transaction with Solflare" }),
    ).toBeDisabled();
    expect(screen.getByText("Sign the text first: 0 of 1 signed.")).toBeInTheDocument();
  });
});

describe("live release route", () => {
  function liveEnvironment() {
    vi.stubEnv("THETIS_DATA_SOURCE", "live");
    vi.stubEnv("THETIS_NETWORK", "devnet");
    vi.stubEnv("THETIS_PROGRAM_ID", PROGRAM_ID);
    vi.stubEnv("THETIS_PROTOCOL", PROTOCOL);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "synthetic-anon-key");
  }
  const releasePage = (releaseId: string, query: Record<string, string> = {}) =>
    ReleasePage({
      params: Promise.resolve({ context: "lender-one", releaseId }),
      searchParams: Promise.resolve(query),
    });

  test("the release route serves a visible intent in live mode and refuses a case parameter", async () => {
    liveEnvironment();
    const snapshot = pledgedSnapshot();
    // The page reads at the wall clock, so the intent expires a day after the real now.
    snapshot.intents = [intent({ expires_at: String(Math.floor(Date.now() / 1000) + 86_400) })];
    snapshot.checkpoint = {
      ...(snapshot.checkpoint as NonNullable<LiveSnapshot["checkpoint"]>),
      last_success_at: new Date().toISOString(),
    };
    server.client = fakeSupabase(snapshot).client;
    render(await releasePage(INTENT));
    expect(
      screen.getByRole("heading", { level: 1, name: "Release 2,000.000 t to Buyer Smelter Co" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Payment, once confirmed")).toBeInTheDocument();
    expect(screen.getByText("Not yet confirmed by Lender One Bank.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm payment" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Release cases" })).not.toBeInTheDocument();
    cleanup();

    await expect(releasePage(INTENT, { case: "sale-2000t-400k" })).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
  });
});

describe("lending forms", () => {
  test("parseMoneyInput and parseTonnesInput accept exact amounts and refuse extra digits", () => {
    expect(parseMoneyInput("600000.00", 2)).toBe(60_000_000n);
    expect(parseMoneyInput("600000", 2)).toBe(60_000_000n);
    expect(parseMoneyInput("0.2", 2)).toBe(20n);
    expect(parseMoneyInput("1.234", 2)).toBeNull();
    expect(parseMoneyInput("-1", 2)).toBeNull();
    expect(parseMoneyInput("600,000.00", 2)).toBeNull();
    expect(parseMoneyInput("", 2)).toBeNull();
    expect(parseMoneyInput("12", 0)).toBe(12n);
    expect(parseMoneyInput("1.5", 0)).toBeNull();
    expect(parseMoneyInput("18446744073709551616", 0)).toBeNull();
    expect(parseTonnesInput("2000")).toBe(2_000_000n);
    expect(parseTonnesInput("0.5")).toBe(500n);
    expect(parseTonnesInput("2000.5")).toBe(2_000_500n);
    expect(parseTonnesInput("1.2345")).toBeNull();
    expect(parseTonnesInput("5000.0001")).toBeNull();
    expect(parseTonnesInput("1e3")).toBeNull();
    expect(parseTonnesInput(" 2000")).toBeNull();
  });

  test("the bank confirmation is uploaded and finalized before the command is created", async () => {
    replies.push((call) =>
      call.url.endsWith("/finalize") ? json(200, { data: { versionId: "v" } }) : undefined,
    );
    replies.push((call) =>
      call.url.endsWith("/v1/commands") ? json(201, { data: view({ id: COMMAND_ID }) }) : undefined,
    );
    const form = (
      <CommandForm
        action="Confirm payment"
        kind="confirm_payment"
        organisationId={orgId("lender-one")}
        context="lender-one"
        args={{ loan: LOAN_ONE, purpose: "Release", intent: INTENT }}
        fields={[
          {
            name: "amountMinor",
            label: "Amount",
            kind: "money",
            currency: "USD",
            digits: 2,
            initial: "400000.00",
          },
          { name: "bankReference", label: "Bank reference", kind: "text", half: true },
          { name: "observedAt", label: "Observed at", kind: "datetime", half: true },
        ]}
        upload={{
          label: "Bank confirmation",
          ownerOrganisationId: orgId("lender-one"),
          lotId: "CR-0001",
        }}
        primary
      />
    );
    const file = new File(["%PDF-1.4 synthetic"], "synthetic-bank-confirmation.pdf", {
      type: "application/pdf",
    });
    const fill = () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm payment" }));
      const dialog = screen.getByRole("dialog", { name: "Confirm payment" });
      fireEvent.change(within(dialog).getByLabelText("Bank reference"), {
        target: { value: "FNB-REL-0001" },
      });
      fireEvent.change(within(dialog).getByLabelText("Observed at"), {
        target: { value: "2026-11-26T01:50" },
      });
      fireEvent.change(within(dialog).getByLabelText("Bank confirmation"), {
        target: { files: [file] },
      });
      fireEvent.click(within(dialog).getByRole("button", { name: "Confirm payment" }));
      return dialog;
    };

    render(form);
    fill();
    await waitFor(() =>
      expect(mocks.push).toHaveBeenCalledWith(`/lender-one/commands/${COMMAND_ID}`),
    );
    expect(mocks.log).toEqual([
      "insert evidence_objects",
      "insert evidence_versions",
      "upload",
      "POST /v1/evidence/32000000-0000-4000-8000-000000000001/finalize",
      "POST /v1/commands",
    ]);
    expect(mocks.inserts).toEqual([
      {
        table: "evidence_objects",
        row: {
          owner_organisation_id: orgId("lender-one"),
          subject_kind: "lot",
          subject_ref: "CR-0001",
          purpose: "bank",
          created_by: mocks.session.user.id,
        },
      },
      {
        table: "evidence_versions",
        row: {
          object_id: "31000000-0000-4000-8000-000000000001",
          version: 1,
          storage_path: `${orgId("lender-one")}/31000000-0000-4000-8000-000000000001/1`,
          mime: "application/pdf",
          uploaded_by: mocks.session.user.id,
        },
      },
    ]);
    expect(mocks.storage).toEqual([
      {
        path: `${orgId("lender-one")}/31000000-0000-4000-8000-000000000001/1`,
        file,
        options: { contentType: "application/pdf", upsert: false },
      },
    ]);
    const created = calls.find(({ url }) => url.endsWith("/v1/commands"));
    expect(created?.body).toEqual({
      kind: "confirm_payment",
      organisationId: orgId("lender-one"),
      args: {
        loan: LOAN_ONE,
        purpose: "Release",
        intent: INTENT,
        amountMinor: "40000000",
        bankReference: "FNB-REL-0001",
        observedAt: String(Math.floor(new Date("2026-11-26T01:50").getTime() / 1000)),
        evidenceVersionId: "32000000-0000-4000-8000-000000000001",
      },
    });
    cleanup();

    // Any failed upload step: the message, and no command.
    for (const step of ["insert evidence_objects", "upload"]) {
      mocks.failStep = step;
      mocks.log = [];
      calls.length = 0;
      render(form);
      const dialog = fill();
      expect(await within(dialog).findByRole("alert")).toHaveTextContent(
        "Thetis could not store the bank confirmation. Nothing was recorded.",
      );
      expect(calls.some(({ url }) => url.endsWith("/v1/commands"))).toBe(false);
      cleanup();
    }
  });
});
