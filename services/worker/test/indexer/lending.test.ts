// Phase 2: lending events and accounts into the read model (live-lending.md §4.1, §9.1).
// Every history here is synthetic (fixtures/synthetic.ts, "The lending fixtures").

import { createHash } from "node:crypto";
import { AccountRole, type Address } from "@solana/kit";
import {
  getAdvanceRecordedEventDecoder,
  getAdvanceRecordedEventEncoder,
  getLoanDecoder,
  getLoanEncoder,
  getPaymentConfirmedEventEncoder,
  getPaymentCorrectedEventDecoder,
  getPaymentCorrectedEventEncoder,
  getPoolShareDecoder,
  getPoolShareEncoder,
  getRepaidEventDecoder,
  getRepaidEventEncoder,
  getSimulationPoolDecoder,
  getSimulationPoolEncoder,
  getValuationDecoder,
  getValuationEncoder,
  PaymentPurpose,
} from "@thetis/contracts";
import { describe, expect, it } from "vitest";
import type { memoryStore, ReadModelStore, Stream } from "../../src/indexer/store.ts";
import { counts, eventKeys, expectHalt, harness, RECONCILE_MS, rows } from "../fixtures/harness.ts";
import {
  bytesOf,
  editEvent,
  type FakeChain,
  type FakeTransaction,
  type History,
  LENDING_STEPS,
  type LendingScenario,
  type LendingStep,
  lastSlot,
  lendingHistory,
  PROGRAM,
  poolHistory,
  seedOrganisations,
  slotOf,
  syntheticSignature,
  syntheticSigner,
  thetis,
  thetisTransaction,
  transactionOf,
} from "../fixtures/synthetic.ts";

const LENDING_TABLES = [
  "chain_facilities",
  "chain_valuations",
  "chain_loans",
  "chain_locks",
  "chain_payments",
  "chain_release_intents",
  "chain_pools",
  "chain_pool_shares",
];
const NEW_EVENT_KEYS = [
  "facility",
  "loan",
  "loan_revision",
  "pool",
  "pool_revision",
  "valuation",
  "valuation_version",
  "created",
];

function allCounts(store: ReadModelStore) {
  return {
    ...counts(store),
    ...Object.fromEntries(LENDING_TABLES.map((table) => [table, rows(store, table).length])),
  };
}

function row(store: ReadModelStore, table: string, address: string) {
  return rows(store, table).find((entry) => entry.address === address);
}

function events(store: ReadModelStore) {
  return rows(store, "chain_events");
}

function keysOf(store: ReadModelStore, column: string, revision: string, value: string) {
  return events(store)
    .filter((entry) => entry[column] === value && entry[revision] !== null)
    .map((entry) => String(entry[revision]))
    .sort((a, b) => Number(a) - Number(b));
}

async function orgId(slug: string): Promise<string> {
  const found = (await seedOrganisations()).find((entry) => entry.slug === slug);
  if (!found) throw new Error(`no organisation ${slug}`);
  return found.id;
}

function stepTx(scenario: LendingScenario, step: LendingStep): FakeTransaction {
  const found = scenario.steps[step];
  if (!found) throw new Error(`the scenario has no ${step}`);
  return transactionOf(scenario.history, found.signature);
}

function slotNumber(scenario: LendingScenario, step: LendingStep): number {
  const found = scenario.steps[step];
  if (!found) throw new Error(`the scenario has no ${step}`);
  return found.slot;
}

/** Decodes the n-th event line of a transaction, edits it, and writes it back. */
function rewriteEvent<T extends object>(
  tx: FakeTransaction,
  n: number,
  decoder: { decode: (bytes: Uint8Array) => T },
  encoder: { encode: (value: never) => ArrayLike<number> },
  edit: (value: T) => T,
) {
  editEvent(tx, n, (bytes) => bytesOf(encoder, edit(decoder.decode(bytes))));
}

/** Removes a step's transaction and keeps its accounts, so the chain state stays the same. */
function dropTransaction(scenario: LendingScenario, step: LendingStep) {
  const found = scenario.steps[step];
  if (!found) throw new Error(`the scenario has no ${step}`);
  const slot = slotOf(scenario.history, found.signature);
  slot.transactions = slot.transactions.filter((tx) => tx.signature !== found.signature);
}

/** A harness on the token-simulation stream (live-lending.md, T063c folds item 7). */
async function poolHarness(history: History, scenario: LendingScenario) {
  const h = await harness(history, {
    env: {
      THETIS_PROTOCOL: scenario.protocol,
      THETIS_FIRST_SIGNATURE: scenario.firstSignature,
    },
  });
  const stream: Stream = { network: "devnet", programId: PROGRAM, protocol: scenario.protocol };
  return {
    h,
    stream,
    async checkpoint() {
      return h.store.checkpoint(stream);
    },
    async untilLive(max = 5) {
      for (let i = 0; i < max; i += 1) {
        const result = await h.poll();
        const checkpoint = await h.store.checkpoint(stream);
        if (result === "ok" && checkpoint?.status === "live") return checkpoint;
        if (result === "halted") throw new Error(`halted: ${JSON.stringify(checkpoint?.halt)}`);
      }
      throw new Error(`not live after ${max} polls`);
    },
  };
}

/** The last state of an account in a history, decoded. */
function lastState<T>(
  history: History,
  address: string,
  decoder: { decode: (bytes: Uint8Array) => T },
): T {
  const data = history
    .flatMap((entry) => (entry.accounts[address] ? [entry.accounts[address]] : []))
    .at(-1)?.data;
  if (!data) throw new Error(`no state for ${address}`);
  return decoder.decode(data);
}

/**
 * Moves an account on chain with no transaction, 500 slots after the last entry: the indexer then
 * reads the moved state for the account's last event, and only the event column tells them apart.
 */
function moveWithoutEvent<T extends object>(
  history: History,
  address: string,
  decoder: { decode: (bytes: Uint8Array) => T },
  encoder: { encode: (value: never) => ArrayLike<number> },
  edit: (value: T) => T,
): T {
  const before = lastState(history, address, decoder);
  history.push({
    slot: lastSlot(history) + 500,
    blockTime: null,
    transactions: [],
    accounts: { [address]: thetis(bytesOf(encoder, edit(before))) },
  });
  return before;
}

/** Polls at most five times, until a poll halts. */
async function pollToHalt(poll: () => Promise<string>): Promise<string> {
  let result = "ok";
  for (let i = 0; i < 5 && result !== "halted"; i += 1) result = await poll();
  return result;
}

type ShareScan = Parameters<FakeChain["getProgramAccounts"]>;

/** Wraps the chain's pool-share scans (dataSize 89) only; every other call is unchanged. */
function wrapShareScans(
  chain: FakeChain,
  wrap: (
    original: (...args: ShareScan) => ReturnType<FakeChain["getProgramAccounts"]>,
    ...args: ShareScan
  ) => ReturnType<FakeChain["getProgramAccounts"]>,
) {
  const original = chain.getProgramAccounts.bind(chain);
  chain.getProgramAccounts = (filter, signal) =>
    filter.dataSize === 89 ? wrap(original, filter, signal) : original(filter, signal);
}

/** How many pool-share scans the chain has answered. */
function shareScans(chain: FakeChain): number {
  return chain.calls.filter(
    ({ method, args }) =>
      method === "getProgramAccounts" && (args[0] as { dataSize: number | null }).dataSize === 89,
  ).length;
}

async function expectPoolHalt(
  pool: Awaited<ReturnType<typeof poolHarness>>,
  result: string,
  reason: string,
  expected: { step: string; signature: string | null; mentions?: string[] },
) {
  expect(result).toBe("halted");
  const checkpoint = await pool.checkpoint();
  expect(checkpoint?.status).toBe("halted");
  expect(checkpoint?.halt?.reason).toBe(reason);
  expect(checkpoint?.halt?.signature).toBe(expected.signature);
  const detail = checkpoint?.halt?.detail ?? "";
  expect(detail.startsWith(`${expected.step}: `), detail).toBe(true);
  for (const text of expected.mentions ?? []) expect(detail).toContain(text);
  expect(pool.h.halts().at(-1)).toMatchObject({ code: "INDEXER_HALTED", reason });
}

describe("Phase 2 lending", () => {
  it("indexes the lending history with one row per loan revision, lot revision, valuation version and created account", async () => {
    const scenario = await lendingHistory();
    const h = await harness(scenario.history);
    await h.pollUntilLive();

    expect(keysOf(h.store, "loan", "loan_revision", scenario.loan)).toEqual([
      "0",
      "1",
      "2",
      "3",
      "4",
      "5",
    ]);
    expect(keysOf(h.store, "lot", "lot_revision", scenario.lot)).toEqual(["0", "1"]);
    expect(
      keysOf(h.store, "valuation", "valuation_version", scenario.valuation).map(Number),
    ).toEqual([1, 2]);
    const created = events(h.store)
      .map((entry) => entry.created)
      .filter((value) => value !== null)
      .sort();
    expect(created).toEqual(
      [
        scenario.facility,
        scenario.intents[0],
        scenario.payments.release,
        scenario.payments.repayment,
        scenario.payments.correction,
      ].sort(),
    );

    // 14 lending transactions and events beyond the seed's 10 transactions and 9 events.
    expect(allCounts(h.store)).toMatchObject({
      chain_transactions: 24,
      chain_events: 23,
      chain_protocols: 1,
      chain_class_policies: 1,
      chain_organisations: 7,
      chain_custodian_classes: 1,
      chain_intakes: 1,
      chain_lots: 1,
      chain_positions: 2,
      chain_facilities: 1,
      chain_valuations: 1,
      chain_loans: 1,
      chain_locks: 1,
      chain_payments: 3,
      chain_release_intents: 1,
      chain_pools: 0,
      chain_pool_shares: 0,
    });
    for (const entry of events(h.store)) {
      for (const key of NEW_EVENT_KEYS) expect(entry, `${entry.event}.${key}`).toHaveProperty(key);
    }
    for (const entry of events(h.store).filter((event) => Number(event.slot) <= 10_000)) {
      for (const key of NEW_EVENT_KEYS) expect(entry[key], `${entry.event}.${key}`).toBeNull();
    }

    const lenderOne = await orgId("lender-one");
    const khunou = await orgId("khunou");
    const buyer = await orgId("buyer-smelter");
    expect(row(h.store, "chain_loans", scenario.loan)).toMatchObject({
      facility: scenario.facility,
      lender_org_id: lenderOne,
      borrower: scenario.org("khunou"),
      borrower_org_id: khunou,
      lot: scenario.lot,
      position: scenario.positions.khunou,
      loan_index: 0,
      status: "Closed",
      rate_bps: 1200,
      terms_version: 1,
      principal: "0",
      booked_interest: "0",
      open_exceptions: 1,
      revision: "5",
      event_revision: "5",
    });
    expect(row(h.store, "chain_facilities", scenario.facility)).toMatchObject({
      lender: scenario.org("lender-one"),
      lender_org_id: lenderOne,
      borrower: scenario.org("khunou"),
      borrower_org_id: khunou,
      facility_id_hex: "11".repeat(16),
      currency: "USD",
      currency_decimals: 2,
      terms_version: 1,
      rate_bps: 1200,
      max_ltv_bps: 6000,
      terms_digest_hex: "21".repeat(32),
      loan_count: 1,
    });
    expect(row(h.store, "chain_valuations", scenario.valuation)).toMatchObject({
      facility: scenario.facility,
      grade: "G1",
      custodian_class: scenario.custodianClass,
      value_per_kg: "20",
      haircut_bps: 0,
      source_digest_hex: "23".repeat(32),
      version: 2,
      event_version: 2,
    });
    expect(row(h.store, "chain_locks", scenario.lock)).toMatchObject({
      loan: scenario.loan,
      position: scenario.positions.khunou,
      quantity_kg: "0",
      control: "Pledged",
    });
    expect(row(h.store, "chain_release_intents", scenario.intents[0] as string)).toMatchObject({
      loan: scenario.loan,
      lot: scenario.lot,
      seller_org_id: khunou,
      buyer: scenario.org("buyer-smelter"),
      buyer_org_id: buyer,
      lender: scenario.org("lender-one"),
      lender_org_id: lenderOne,
      currency_decimals: 2,
      nonce: "1",
      quantity_kg: "2000000",
      price: "40000000",
      top_up: "0",
      currency: "USD",
      position_revision: "1",
      status: "Executed",
    });
    expect(row(h.store, "chain_payments", scenario.payments.release)).toMatchObject({
      lender_org_id: lenderOne,
      purpose: "Release",
      subject: scenario.intents[0],
      amount: "40000000",
      applied: "40000000",
      surplus: "0",
      status: "Consumed",
      payment_id_hex: "31".repeat(32),
      evidence_digest_hex: "41".repeat(32),
    });
    expect(row(h.store, "chain_payments", scenario.payments.correction)).toMatchObject({
      purpose: "Correction",
      subject: scenario.payments.repayment,
      amount: "0",
      status: "Consumed",
    });
    // The buyer position the sale created, and the seller's after the lock was released.
    expect(row(h.store, "chain_positions", scenario.positions.buyer)).toMatchObject({
      owner_org_id: buyer,
      quantity_kg: "2000000",
      locked_kg: "0",
      revision: "0",
    });
    expect(row(h.store, "chain_positions", scenario.positions.khunou)).toMatchObject({
      quantity_kg: "3000000",
      locked_kg: "0",
      revision: "3",
    });
    expect(row(h.store, "chain_lots", scenario.lot)).toMatchObject({
      revision: "1",
      event_revision: "1",
    });

    const byEvent = (name: string) => events(h.store).filter((entry) => entry.event === name);
    expect(byEvent("PledgedSold")).toEqual([
      expect.objectContaining({
        scope: "lot",
        lot: scenario.lot,
        lot_revision: "1",
        loan: scenario.loan,
        loan_revision: "2",
        facility: null,
        created: null,
      }),
    ]);
    expect(byEvent("PaymentCorrected")).toEqual([
      expect.objectContaining({
        scope: "facility",
        facility: scenario.facility,
        lot: null,
        loan: scenario.loan,
        loan_revision: "5",
        created: scenario.payments.correction,
        data: expect.objectContaining({ voided: false, loanRevision: "5", openExceptions: 1 }),
      }),
    ]);
    expect(byEvent("PaymentConfirmed").map((entry) => entry.data)).toEqual([
      expect.objectContaining({ purpose: "Release", amount: "40000000" }),
      expect.objectContaining({ purpose: "Repayment", amount: "21000000" }),
    ]);
    expect(byEvent("Repaid")).toEqual([
      expect.objectContaining({
        loan_revision: "3",
        pool: null,
        pool_revision: null,
        data: expect.objectContaining({
          payment: scenario.payments.repayment,
          pool: null,
          poolRevision: null,
        }),
      }),
    ]);
    expect(byEvent("FacilityOpened")[0]).toMatchObject({
      scope: "facility",
      facility: scenario.facility,
      created: scenario.facility,
      loan: null,
      org_id: null,
    });
  });

  it("replays the lending history twice and writes each transaction and event once", async () => {
    const scenario = await lendingHistory();
    const h = await harness(scenario.history);
    await h.pollUntilLive();
    const before = allCounts(h.store);
    const tables = ["chain_events", "chain_transactions", ...LENDING_TABLES];
    const snapshot = Object.fromEntries(tables.map((table) => [table, rows(h.store, table)]));
    (h.store as ReturnType<typeof memoryStore>).deleteCheckpoint();
    h.restart();
    await h.pollUntilLive();
    expect(allCounts(h.store)).toEqual(before);
    expect(eventKeys(h.store)).toEqual([`${scenario.lot}:0`, `${scenario.lot}:1`]);
    for (const table of tables) {
      const strip = (list: Record<string, unknown>[]) =>
        list.map(({ commitment: _c, slot: _s, last_signature: _l, ...rest }) => rest);
      expect(strip(rows(h.store, table)), table).toEqual(strip(snapshot[table] ?? []));
    }
  });

  it("indexes the pool history under both the loan and the pool keys", async () => {
    const scenario = await poolHistory();
    const pool = await poolHarness(scenario.history, scenario);
    await pool.untilLive();
    const { store } = pool.h;
    const address = scenario.pool as string;
    const share = scenario.share as string;

    expect(keysOf(store, "pool", "pool_revision", address)).toEqual(["1", "2", "3", "4"]);
    expect(keysOf(store, "loan", "loan_revision", scenario.loan)).toEqual(["0", "1", "2"]);
    const byEvent = (name: string) => events(store).filter((entry) => entry.event === name);
    expect(byEvent("PoolOpened")).toEqual([
      expect.objectContaining({
        scope: "pool",
        pool: address,
        pool_revision: null,
        created: address,
      }),
    ]);
    expect(byEvent("Borrowed")).toEqual([
      expect.objectContaining({
        scope: "facility",
        facility: scenario.facility,
        loan: scenario.loan,
        loan_revision: "1",
        pool: address,
        pool_revision: "2",
      }),
    ]);
    expect(byEvent("Repaid")).toEqual([
      expect.objectContaining({
        scope: "facility",
        loan_revision: "2",
        pool: address,
        pool_revision: "3",
        data: expect.objectContaining({ payment: null, pool: address, poolRevision: "3" }),
      }),
    ]);
    expect(byEvent("Withdrawn")).toEqual([
      expect.objectContaining({ scope: "pool", pool: address, pool_revision: "4", loan: null }),
    ]);
    expect(row(store, "chain_pools", address)).toMatchObject({
      protocol: scenario.protocol,
      currency: "USD",
      currency_decimals: 2,
      total_shares: "50000000",
      revision: "4",
      event_revision: "4",
    });
    expect(row(store, "chain_pool_shares", share)).toMatchObject({
      protocol: scenario.protocol,
      pool: address,
      organisation: scenario.org("lender-one"),
      org_id: await orgId("lender-one"),
      shares: "50000000",
    });
    expect(row(store, "chain_loans", scenario.loan)).toMatchObject({
      status: "Active",
      revision: "2",
      event_revision: "2",
    });
    expect(rows(store, "chain_protocols").map((entry) => entry.address)).toEqual([
      scenario.protocol,
    ]);
  });

  it("halts with REVISION_SEQUENCE on a skipped or repeated loan revision and on a second Pledged for one loan", async () => {
    const skipped = await lendingHistory();
    rewriteEvent(
      stepTx(skipped, "recordAdvance"),
      0,
      getAdvanceRecordedEventDecoder(),
      getAdvanceRecordedEventEncoder(),
      (value) => ({ ...value, revision: 2n }),
    );
    const first = await harness(skipped.history);
    await expectHalt(first, await first.poll(), "REVISION_SEQUENCE", {
      step: "sequence",
      signature: null,
      mentions: [skipped.loan],
    });
    expect((await first.checkpoint())?.indexedThroughSlot).toBe(
      slotNumber(skipped, "recordAdvance") - 1000,
    );

    const repeated = await lendingHistory();
    rewriteEvent(
      stepTx(repeated, "repay"),
      0,
      getRepaidEventDecoder(),
      getRepaidEventEncoder(),
      (value) => ({ ...value, revision: 2n }),
    );
    const second = await harness(repeated.history);
    await expectHalt(second, await second.poll(), "REVISION_SEQUENCE", {
      step: "sequence",
      signature: null,
      mentions: [repeated.loan],
    });
    expect((await second.checkpoint())?.indexedThroughSlot).toBe(
      slotNumber(repeated, "repay") - 1000,
    );

    const twice = await lendingHistory();
    const pledge = stepTx(twice, "pledge");
    const slot = slotOf(twice.history, pledge.signature);
    slot.transactions.push({ ...structuredClone(pledge), signature: syntheticSignature(219) });
    const third = await harness(twice.history);
    await expectHalt(third, await third.poll(), "REVISION_SEQUENCE", {
      step: "sequence",
      signature: null,
      mentions: [twice.loan, "pledged by 2 events"],
    });
    expect((await third.checkpoint())?.indexedThroughSlot).toBe(slot.slot - 1000);
  });

  it("a voided correction repeats the loan revision without advancing it, and one outside the slot's range halts", async () => {
    const steps: LendingStep[] = [...LENDING_STEPS.slice(0, 10), "voidRepayment"];
    const scenario = await lendingHistory(steps);
    const h = await harness(scenario.history);
    await h.pollUntilLive();
    const voided = events(h.store).find((entry) => entry.event === "PaymentCorrected");
    expect(voided).toMatchObject({
      scope: "facility",
      facility: scenario.facility,
      loan: scenario.loan,
      loan_revision: null,
      created: scenario.payments.correction,
      data: expect.objectContaining({ voided: true, loanRevision: "2" }),
    });
    expect(row(h.store, "chain_loans", scenario.loan)).toMatchObject({
      revision: "2",
      event_revision: "2",
      open_exceptions: 0,
    });
    expect(row(h.store, "chain_payments", scenario.payments.repayment)).toMatchObject({
      status: "Voided",
    });
    expect(keysOf(h.store, "loan", "loan_revision", scenario.loan)).toEqual(["0", "1", "2"]);

    const outside = await lendingHistory(steps);
    rewriteEvent(
      stepTx(outside, "voidRepayment"),
      0,
      getPaymentCorrectedEventDecoder(),
      getPaymentCorrectedEventEncoder(),
      (value) => ({ ...value, loanRevision: 1n }),
    );
    const second = await harness(outside.history);
    await expectHalt(second, await second.poll(), "REVISION_SEQUENCE", {
      step: "sequence",
      signature: null,
      mentions: [outside.loan],
    });
    expect((await second.checkpoint())?.indexedThroughSlot).toBe(
      slotNumber(outside, "voidRepayment") - 1000,
    );
  });

  it("halts with EVENT_MISMATCH when ConfirmPayment emits the event its target does not allow, and when Repaid names another payment", async () => {
    const wrongEvent = await lendingHistory();
    const correction = stepTx(wrongEvent, "correctRepayment");
    editEvent(correction, 0, () =>
      bytesOf(getPaymentConfirmedEventEncoder(), {
        payment: wrongEvent.payments.correction,
        loan: wrongEvent.loan,
        purpose: PaymentPurpose.Correction,
        subject: wrongEvent.payments.repayment,
        amount: 0n,
        currency: new TextEncoder().encode("USD"),
      }),
    );
    const first = await harness(wrongEvent.history);
    await expectHalt(first, await first.poll(), "EVENT_MISMATCH", {
      step: "decode",
      signature: correction.signature,
      mentions: ["ConfirmPayment", "PaymentConfirmed", "PaymentCorrected"],
    });

    const otherPayment = await lendingHistory();
    const repay = stepTx(otherPayment, "repay");
    rewriteEvent(repay, 0, getRepaidEventDecoder(), getRepaidEventEncoder(), (value) => ({
      ...value,
      payment: { __option: "Some", value: otherPayment.payments.release } as typeof value.payment,
    }));
    const second = await harness(otherPayment.history);
    await expectHalt(second, await second.poll(), "EVENT_MISMATCH", {
      step: "decode",
      signature: repay.signature,
      mentions: ["Repaid.payment", otherPayment.payments.release, otherPayment.payments.repayment],
    });
  });

  it("halts with EVENT_GAP when AdvanceRecorded names an unprojected loan, and when ValuationSet version 2 has no stored valuation", async () => {
    const noPledge = await lendingHistory();
    dropTransaction(noPledge, "pledge");
    const first = await harness(noPledge.history);
    await expectHalt(first, await first.poll(), "EVENT_GAP", {
      step: "sequence",
      signature: null,
      mentions: [noPledge.loan],
    });
    expect((await first.checkpoint())?.indexedThroughSlot).toBe(
      slotNumber(noPledge, "recordAdvance") - 2000,
    );

    const noValuation = await lendingHistory();
    dropTransaction(noValuation, "setValuation");
    const second = await harness(noValuation.history);
    await expectHalt(second, await second.poll(), "EVENT_GAP", {
      step: "sequence",
      signature: null,
      mentions: [noValuation.valuation],
    });
    expect((await second.checkpoint())?.indexedThroughSlot).toBe(
      slotNumber(noValuation, "setValuation2") - 1000,
    );
  });

  it("a sale creates the buyer position only when it is not stored", async () => {
    const one = await lendingHistory();
    const h = await harness(one.history);
    await h.pollUntilLive();
    expect(row(h.store, "chain_positions", one.positions.buyer)).toMatchObject({
      quantity_kg: "2000000",
      revision: "0",
    });

    // A second sale to the same buyer updates the position the first one created.
    const steps: LendingStep[] = [
      ...LENDING_STEPS.slice(0, 9),
      "createReleaseIntent2",
      "confirmRelease2",
      "sellPledged2",
    ];
    const two = await lendingHistory(steps);
    const second = await harness(two.history);
    await second.pollUntilLive();
    expect(row(second.store, "chain_positions", two.positions.buyer)).toMatchObject({
      quantity_kg: "3000000",
      revision: "1",
      owner_org_id: await orgId("buyer-smelter"),
    });
    expect(keysOf(second.store, "lot", "lot_revision", two.lot)).toEqual(["0", "1", "2"]);
    expect(keysOf(second.store, "loan", "loan_revision", two.loan)).toEqual(["0", "1", "2", "3"]);
    expect(rows(second.store, "chain_release_intents")).toHaveLength(2);
    const sales = events(second.store).filter((entry) => entry.event === "PledgedSold");
    expect(sales.map((entry) => entry.data)).toEqual([
      expect.objectContaining({ buyerPosition: two.positions.buyer, quantityKg: "2000000" }),
      expect.objectContaining({ buyerPosition: two.positions.buyer, quantityKg: "1000000" }),
    ]);
  });

  it("reconcile promotes Phase 2 rows, scans pool shares by pool, and halts with EVENT_GAP when a loan revision differs from its event revision", async () => {
    const scenario = await poolHistory();
    const pool = await poolHarness(scenario.history, scenario);
    const live = await pool.untilLive();
    const { store, chain } = pool.h;
    for (const table of LENDING_TABLES.filter(
      (name) => name !== "chain_payments" && name !== "chain_release_intents",
    )) {
      const found = rows(store, table);
      expect(found.length, table).toBeGreaterThan(0);
      for (const entry of found) {
        expect(entry, table).toMatchObject({
          commitment: "finalized",
          last_signature: null,
          slot: live.indexedThroughSlot,
        });
      }
    }
    const scans = chain.calls
      .filter(({ method }) => method === "getProgramAccounts")
      .map(({ args }) => args[0]);
    expect(scans).toContainEqual({ offset8: scenario.protocol, dataSize: null });
    expect(scans).toContainEqual({ offset8: scenario.pool, dataSize: 89 });

    // The loan's account moves on chain with no event the indexer could see, before the
    // indexer reads it: its row then holds the moved revision, and only the event revision
    // tells the two apart.
    const moved = await poolHistory();
    const last = moved.history.at(-1);
    if (!last) throw new Error("empty history");
    const data = moved.history
      .flatMap((entry) => (entry.accounts[moved.loan] ? [entry.accounts[moved.loan]] : []))
      .at(-1)?.data as Uint8Array;
    const loan = getLoanDecoder().decode(data);
    moved.history.push({
      slot: last.slot + 500,
      blockTime: null,
      transactions: [],
      accounts: {
        [moved.loan]: thetis(bytesOf(getLoanEncoder(), { ...loan, revision: loan.revision + 1n })),
      },
    });
    const second = await poolHarness(moved.history, moved);
    let result = "ok";
    for (let i = 0; i < 5 && result !== "halted"; i += 1) result = await second.h.poll();
    await expectPoolHalt(second, result, "EVENT_GAP", {
      step: "reconcile",
      signature: null,
      mentions: [moved.loan],
    });
    expect(row(second.h.store, "chain_loans", moved.loan)).toMatchObject({
      revision: String(loan.revision + 1n),
      event_revision: String(loan.revision),
    });
  });

  it("halts with ACCOUNT_DECODE_FAILED on a facility currency that is not three capital letters", async () => {
    const scenario = await lendingHistory();
    const open = stepTx(scenario, "openFacility");
    const slot = slotOf(scenario.history, open.signature);
    // Every state of the facility: discriminator 8, protocol, lender and borrower 32 each,
    // facility id 16, so the currency starts at byte 120.
    for (const entry of scenario.history) {
      entry.accounts[scenario.facility]?.data.set(new TextEncoder().encode("usd"), 120);
    }
    const h = await harness(scenario.history);
    await expectHalt(h, await h.poll(), "ACCOUNT_DECODE_FAILED", {
      step: "fetch",
      signature: null,
      mentions: [scenario.facility, "currency is not three capital letters"],
    });
    expect((await h.checkpoint())?.indexedThroughSlot).toBe(slot.slot - 1000);
  });

  it("a simulated Repay without a pool share account halts with EVENT_MISMATCH", async () => {
    const scenario = await poolHistory();
    const repay = stepTx(scenario, "repaySimulated");
    const instruction = repay.instructions[0];
    if (!instruction) throw new Error("no instruction");
    instruction.accounts = instruction.accounts.slice(0, -1);
    const pool = await poolHarness(scenario.history, scenario);
    await expectPoolHalt(pool, await pool.h.poll(), "EVENT_MISMATCH", {
      step: "decode",
      signature: repay.signature,
      mentions: ["simulated Repay names no pool share"],
    });
  });

  it("halts with EVENT_GAP at reconcile when a valuation version or a pool revision differs from its event column", async () => {
    // The valuation's account moves one version with no ValuationSet the indexer could see.
    const valued = await lendingHistory();
    const valuation = moveWithoutEvent(
      valued.history,
      valued.valuation,
      getValuationDecoder(),
      getValuationEncoder(),
      (value) => ({ ...value, version: value.version + 1 }),
    );
    const first = await harness(valued.history);
    await expectHalt(first, await pollToHalt(first.poll), "EVENT_GAP", {
      step: "reconcile",
      signature: null,
      mentions: [valued.valuation],
    });
    const stored = row(first.store, "chain_valuations", valued.valuation);
    expect(stored).toMatchObject({
      version: valuation.version + 1,
      event_version: valuation.version,
    });
    expect(stored?.commitment).not.toBe("finalized");

    // The pool's account moves one revision with no pool event.
    const moved = await poolHistory();
    const address = moved.pool as string;
    const pool = moveWithoutEvent(
      moved.history,
      address,
      getSimulationPoolDecoder(),
      getSimulationPoolEncoder(),
      (value) => ({ ...value, revision: value.revision + 1n }),
    );
    const second = await poolHarness(moved.history, moved);
    await expectPoolHalt(second, await pollToHalt(second.h.poll), "EVENT_GAP", {
      step: "reconcile",
      signature: null,
      mentions: [address],
    });
    const poolRow = row(second.h.store, "chain_pools", address);
    expect(poolRow).toMatchObject({
      revision: String(pool.revision + 1n),
      event_revision: String(pool.revision),
    });
    expect(poolRow?.commitment).not.toBe("finalized");
  });

  it("halts with EVENT_GAP at fetch when an own-instance pool action reads a pool share of a pool the stream does not have", async () => {
    const scenario = await poolHistory();
    const share = scenario.share as string;
    const unknown = (await syntheticSigner(98)).address as string;
    // Every state of the share names the unknown pool, so the Deposit that creates it reads it.
    const decoder = getPoolShareDecoder();
    for (const entry of scenario.history) {
      const state = entry.accounts[share];
      if (!state) continue;
      entry.accounts[share] = thetis(
        bytesOf(getPoolShareEncoder(), { ...decoder.decode(state.data), pool: unknown as Address }),
      );
    }
    const pool = await poolHarness(scenario.history, scenario);
    await expectPoolHalt(pool, await pool.h.poll(), "EVENT_GAP", {
      step: "fetch",
      signature: null,
      mentions: [`SimulationPool ${unknown}`],
    });
    expect((await pool.checkpoint())?.indexedThroughSlot).toBe(
      slotNumber(scenario, "deposit") - 1000,
    );
    expect(rows(pool.h.store, "chain_pool_shares")).toEqual([]);
  });

  it("reconcile skips while a pool-share scan answers above the cursor", async () => {
    const scenario = await poolHistory();
    const pool = await poolHarness(scenario.history, scenario);
    wrapShareScans(pool.h.chain, async (original, ...args) => {
      const answer = await original(...args);
      return { ...answer, slot: answer.slot + 1000 };
    });
    const live = await pool.untilLive();
    pool.h.advance(RECONCILE_MS + 1);
    await pool.untilLive();
    expect(live.indexedThroughSlot).toBe(lastSlot(scenario.history));
    for (const table of ["chain_pools", "chain_pool_shares", "chain_loans", "chain_facilities"]) {
      for (const entry of rows(pool.h.store, table)) {
        expect(entry.commitment, table).toBe("confirmed");
      }
    }
    expect(pool.h.lines.filter((line) => line.code === "RECONCILE_RETRY")).toEqual([]);
  });

  it("reconcile reads a pool share against its own pool's scan, not the protocol scan", async () => {
    // The pool-share scan answers at a slot before the Deposit, so it returns no share; the share
    // row is newer than that scan, so it is neither vanished nor compared.
    const scenario = await poolHistory();
    const pool = await poolHarness(scenario.history, scenario);
    const head = lastSlot(scenario.history);
    const before = slotNumber(scenario, "deposit") - 1;
    wrapShareScans(pool.h.chain, async (original, ...args) => {
      pool.h.chain.setFinalizedSlot(before);
      try {
        return await original(...args);
      } finally {
        pool.h.chain.setFinalizedSlot(head);
      }
    });
    await pool.untilLive();
    expect(row(pool.h.store, "chain_pools", scenario.pool as string)).toMatchObject({
      commitment: "finalized",
      slot: head,
    });
    expect(row(pool.h.store, "chain_pool_shares", scenario.share as string)).toMatchObject({
      commitment: "confirmed",
      slot: slotNumber(scenario, "withdraw"),
    });
    expect((await pool.checkpoint())?.status).toBe("live");
  });

  it("reconcile halts with ACCOUNT_VANISHED on a pool share whose pool the protocol scan no longer returns", async () => {
    const scenario = await poolHistory();
    const address = scenario.pool as string;
    const share = scenario.share as string;
    const pool = await poolHarness(scenario.history, scenario);
    await pool.untilLive();
    const scansBefore = shareScans(pool.h.chain);

    // The pool account is gone on chain, so no pool-share scan reads its share.
    const head = lastSlot(scenario.history) + 500;
    pool.h.chain.setHistory([
      ...scenario.history,
      { slot: head, blockTime: null, transactions: [], accounts: { [address]: null } },
    ]);
    pool.h.chain.setConfirmedSlot(head);
    pool.h.chain.setFinalizedSlot(head);
    pool.h.advance(RECONCILE_MS + 1);
    await expectPoolHalt(pool, await pool.h.poll(), "ACCOUNT_VANISHED", {
      step: "reconcile",
      signature: null,
      mentions: [address, share],
    });
    expect(shareScans(pool.h.chain)).toBe(scansBefore);
  });

  it("Deposited and Withdrawn rows carry the depositor's org_id, and PoolOpened none", async () => {
    const scenario = await poolHistory();
    const pool = await poolHarness(scenario.history, scenario);
    await pool.untilLive();
    const lenderOne = await orgId("lender-one");
    const byEvent = (name: string) => events(pool.h.store).filter((entry) => entry.event === name);
    expect(byEvent("Deposited")).toEqual([
      expect.objectContaining({ scope: "pool", org_id: lenderOne }),
    ]);
    expect(byEvent("Withdrawn")).toEqual([
      expect.objectContaining({ scope: "pool", org_id: lenderOne }),
    ]);
    expect(byEvent("PoolOpened")).toEqual([
      expect.objectContaining({ scope: "pool", org_id: null }),
    ]);
    for (const entry of events(pool.h.store).filter((event) => event.scope === "facility")) {
      expect(entry.org_id, String(entry.event)).toBeNull();
    }
  });

  // No instruction of the IDL is left unhandled after T063d.5, so this case follows live-custody.md
  // §9.3's fallback and T063d.1 test 12: an Anchor discriminator no instruction carries
  // (live-custody.md, T063d.5 pre-check fold 2).
  it("halts with UNKNOWN_INSTRUCTION on an own-instance instruction the IDL does not have", async () => {
    const scenario = await lendingHistory();
    const sponsor = await syntheticSigner(97);
    const data = new Uint8Array(16);
    data.set(createHash("sha256").update("global:not_in_the_idl").digest().subarray(0, 8), 0);
    const unknown = thetisTransaction({
      signature: syntheticSignature(218),
      feePayer: sponsor.address,
      name: "NotInTheIdl",
      events: [],
      instruction: {
        programAddress: PROGRAM as Address,
        accounts: [
          { address: sponsor.address, role: AccountRole.WRITABLE_SIGNER },
          { address: scenario.protocol as Address, role: AccountRole.READONLY },
        ],
        data,
      },
    });
    const slot = lastSlot(scenario.history) + 1000;
    scenario.history.push({ slot, blockTime: null, transactions: [unknown], accounts: {} });
    const h = await harness(scenario.history);
    await expectHalt(h, await h.poll(), "UNKNOWN_INSTRUCTION", {
      step: "decode",
      signature: unknown.signature,
      mentions: ["has a discriminator no instruction carries"],
    });
    expect((await h.checkpoint())?.indexedThroughSlot).toBe(slot - 1000);
  });
});
