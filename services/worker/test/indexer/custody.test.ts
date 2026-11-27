// Phase 3, the shipment, handover, observation and loading parts: shipments, batches, Departure
// documents, intent cancellation, custody handovers, observations, loading intents, acceptances and
// the loading with its loan hand-offs into the read model (live-custody.md §4.1, §9.1 tests 0–11,
// 13–16, 18, 19 and 21–25, its T063d.1–T063d.4 pre-check folds). Every history here is synthetic
// (fixtures/custody.ts).

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { AccountRole, type Address, getAddressEncoder, getBase58Decoder } from "@solana/kit";
import {
  findAuthorityPda,
  getBatchRegisteredEventDecoder,
  getBatchRegisteredEventEncoder,
  getCustodyHandedOverEventDecoder,
  getCustodyHandedOverEventEncoder,
  getHandoffAcceptanceDecoder,
  getHandoffAcceptanceEncoder,
  getLoadingAcceptedEventDecoder,
  getLoadingAcceptedEventEncoder,
  getLoadingRecordedEventDecoder,
  getLoadingRecordedEventEncoder,
  getLoanDecoder,
  getLoanHandedOffEventDecoder,
  getLoanHandedOffEventEncoder,
  getManifestBatchDecoder,
  getManifestBatchEncoder,
  getObservationRecordedEventDecoder,
  getObservationRecordedEventEncoder,
  getRecordObservationInstruction,
  getShipmentCancelledEventDecoder,
  getShipmentCancelledEventEncoder,
  getShipmentDecoder,
  getShipmentEncoder,
  getShipmentPreparedEventDecoder,
  getShipmentPreparedEventEncoder,
  HandoverStage,
  LotState,
  ObservationKind,
  type Shipment,
  ShipmentStatus,
} from "@thetis/contracts";
import { describe, expect, it } from "vitest";
import { HANDLED_EVENTS, HANDLED_INSTRUCTIONS } from "../../src/indexer/decode.ts";
import type { memoryStore, ReadModelStore } from "../../src/indexer/store.ts";
import {
  batchLeaf,
  type CustodyScenario,
  type CustodyStep,
  custodyHistory,
  loadingHistory,
  manifestProof,
  manifestRoot,
  routeHistory,
} from "../fixtures/custody.ts";
import { counts, expectHalt, harness, rows } from "../fixtures/harness.ts";
import {
  bytesOf,
  editEvent,
  type FakeTransaction,
  type History,
  lastSlot,
  PROGRAM,
  seedOrganisations,
  slotOf,
  syntheticSignature,
  syntheticSigner,
  thetis,
  thetisTransaction,
  transactionOf,
} from "../fixtures/synthetic.ts";

const IDL = new URL("../../../../packages/contracts/idl/thetis.json", import.meta.url);
const CUSTODY_TABLES = ["chain_shipments", "chain_batches"];
const HANDOVER_TABLE = "chain_handovers";
const LOADING_TABLES = ["chain_loading_intents", "chain_handoff_acceptances"];
const LENDING_TABLES = [
  "chain_facilities",
  "chain_valuations",
  "chain_loans",
  "chain_locks",
  "chain_payments",
  "chain_release_intents",
];
const CUSTODY_EVENT_KEYS = [
  "shipment",
  "shipment_revision",
  "batch",
  "batch_sequence",
  "observation_index",
  "acceptance",
  "acceptance_version",
];

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const unixOf = (iso: string) => Date.parse(iso) / 1000;
const pascal = (name: string) =>
  name.replace(/(^|_)([a-z0-9])/g, (_, __, letter: string) => letter.toUpperCase());

function allCounts(store: ReadModelStore) {
  return {
    ...counts(store),
    ...Object.fromEntries(
      [...LENDING_TABLES, ...CUSTODY_TABLES, HANDOVER_TABLE, ...LOADING_TABLES].map((table) => [
        table,
        rows(store, table).length,
      ]),
    ),
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

function step(scenario: CustodyScenario, name: CustodyStep) {
  const found = scenario.steps[name];
  if (!found) throw new Error(`the scenario has no ${name}`);
  return found;
}

function stepTx(scenario: CustodyScenario, name: CustodyStep): FakeTransaction {
  return transactionOf(scenario.history, step(scenario, name).signature);
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
function dropTransaction(scenario: CustodyScenario, name: CustodyStep) {
  const found = step(scenario, name);
  const slot = slotOf(scenario.history, found.signature);
  slot.transactions = slot.transactions.filter((tx) => tx.signature !== found.signature);
}

/** A copy of a step's transaction in a new slot after the history, under another signature. */
function repeatLater(scenario: CustodyScenario, name: CustodyStep, k: number): FakeTransaction {
  const copy = { ...structuredClone(stepTx(scenario, name)), signature: syntheticSignature(k) };
  scenario.history.push({
    slot: lastSlot(scenario.history) + 1000,
    blockTime: "2026-11-28T00:01:00.000Z",
    transactions: [copy],
    accounts: {},
  });
  return copy;
}

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

/** Moves an account on chain with no transaction, 500 slots after the last entry. */
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

async function pollToHalt(poll: () => Promise<string>): Promise<string> {
  let result = "ok";
  for (let i = 0; i < 5 && result !== "halted"; i += 1) result = await poll();
  return result;
}

describe("Phase 3 custody, the shipment part", () => {
  it("0. the fixture manifest helpers reproduce the M1 and M2 known-answer roots", () => {
    // program-custody.md §6.3: carrier 32 × 0x11, load 0x33 / manifest 0x44 for leaf 0, load
    // 0x55 / manifest 0x66 for leaf 1.
    const carrierKey = getBase58Decoder().decode(new Uint8Array(32).fill(0x11));
    const leaf0 = (quantityKg: bigint) =>
      batchLeaf({
        index: 0,
        quantityKg,
        carrier: carrierKey,
        loadDigest: new Uint8Array(32).fill(0x33),
        manifestDigest: new Uint8Array(32).fill(0x44),
      });
    const m1 = [leaf0(5_000_000n)];
    expect(hex(m1[0] as Uint8Array)).toBe(
      "c462e25edead2a478f7534f928d94a2dd85acedcead8d997c031e715f4bcb8d1",
    );
    expect(hex(manifestRoot(m1))).toBe(
      "8df721d308bd44a37494f5362fff9cb0ac090efc83e7f2cb152177dc7b602486",
    );
    expect(manifestProof(m1, 0).map(hex)).toEqual([
      "00".repeat(32),
      "ae0798d0ecaed2b778eddebf18f071a561c53658c05e76cedecc27cafbdbc577",
      "90534fe0aff6db9edb29eee74e78a386916a581c8e6465349493e1a6c87241e1",
      "bea16162721bca4b6e1782cbdc695a471522157c6716f508db47c599195340f4",
    ]);
    const m2 = [
      leaf0(3_000_000n),
      batchLeaf({
        index: 1,
        quantityKg: 2_000_000n,
        carrier: carrierKey,
        loadDigest: new Uint8Array(32).fill(0x55),
        manifestDigest: new Uint8Array(32).fill(0x66),
      }),
    ];
    expect(hex(manifestRoot(m2))).toBe(
      "4c71a1be02e39b85eacad7da6a0dc84ed7607b211f5e6c66276a5d79080c99cd",
    );
    expect(hex(manifestProof(m2, 0)[0] as Uint8Array)).toBe(
      "c60f926e27312d66dc90683881d5efa8a4fd8b040f14c7794a646a44be9390f6",
    );
    expect(hex(manifestProof(m2, 1)[0] as Uint8Array)).toBe(
      "229ad3dea2350a043f8b528b9c835f9363d6f9aa61d269c5f86c1b610b7a85b1",
    );
  });

  it("1. handles every instruction and event of the IDL it is built on, but shortfalls and restrictions", () => {
    // The IDL at main has 39 instructions and 40 events; this slice handles all but
    // attest_shortfall and set_restriction and their two events, which T063d.5 indexes
    // (live-custody.md, T063d.4 pre-check fold 5).
    const idl = JSON.parse(readFileSync(IDL, "utf8")) as {
      instructions: { name: string }[];
      events: { name: string }[];
    };
    expect(idl.instructions).toHaveLength(39);
    expect(idl.events).toHaveLength(40);
    const unhandledInstructions = ["AttestShortfall", "SetRestriction"];
    const unhandledEvents = ["ShortfallAttested", "RestrictionSet"];
    const instructions = idl.instructions.map((entry) => pascal(entry.name));
    for (const name of unhandledInstructions) expect(instructions).toContain(name);
    expect([...HANDLED_INSTRUCTIONS].sort()).toEqual(
      instructions.filter((name) => !unhandledInstructions.includes(name)).sort(),
    );
    expect(HANDLED_INSTRUCTIONS).toHaveLength(37);
    const eventNames = idl.events.map((entry) => entry.name);
    for (const name of unhandledEvents) expect(eventNames).toContain(name);
    expect([...HANDLED_EVENTS].sort()).toEqual(
      eventNames.filter((name) => !unhandledEvents.includes(name)).sort(),
    );
    expect(HANDLED_EVENTS).toHaveLength(38);
  });

  it("2. indexes the shipment history with one row per shipment revision, lot revision, registration and created account", async () => {
    const scenario = await custodyHistory();
    const h = await harness(scenario.history);
    await h.pollUntilLive();
    const { s1, s2 } = scenario.shipments;
    const { b1, b2 } = scenario.batches;

    expect(keysOf(h.store, "lot", "lot_revision", scenario.lot)).toEqual(["0", "1", "2", "3"]);
    expect(keysOf(h.store, "shipment", "shipment_revision", s1)).toEqual(["0", "1"]);
    expect(keysOf(h.store, "shipment", "shipment_revision", s2)).toEqual(["0"]);
    const created = events(h.store)
      .map((entry) => entry.created)
      .filter((value) => value !== null)
      .sort();
    expect(created).toEqual([scenario.facility, scenario.intents[0], s1, b1, s2, b2].sort());

    // 14 custody transactions and events (one per step) beyond the seed's 10 transactions and 9
    // events.
    expect(allCounts(h.store)).toMatchObject({
      chain_transactions: 24,
      chain_events: 23,
      chain_custodian_classes: 2,
      chain_documents: 1,
      chain_lots: 1,
      chain_positions: 1,
      chain_facilities: 1,
      chain_valuations: 1,
      chain_loans: 1,
      chain_locks: 1,
      chain_release_intents: 1,
      chain_shipments: 2,
      chain_batches: 2,
    });
    for (const entry of events(h.store)) {
      for (const key of CUSTODY_EVENT_KEYS)
        expect(entry, `${entry.event}.${key}`).toHaveProperty(key);
    }
    const custodyEvents = ["ShipmentPrepared", "BatchRegistered", "ShipmentCancelled"];
    for (const entry of events(h.store).filter((e) => !custodyEvents.includes(String(e.event)))) {
      for (const key of CUSTODY_EVENT_KEYS) expect(entry[key], `${entry.event}.${key}`).toBeNull();
    }

    const khunou = await orgId("khunou");
    const kopano = await orgId("kopano");
    const port = await orgId("port-t1");
    expect(row(h.store, "chain_lots", scenario.lot)).toMatchObject({
      state: "Prepared",
      revision: "3",
      event_revision: "3",
      custodian_class: scenario.classes.kopano,
      custodian_org_id: kopano,
    });
    expect(row(h.store, "chain_positions", scenario.position)).toMatchObject({
      revision: "3",
      locked_kg: "5000000",
    });
    const shipmentRow = {
      lot: scenario.lot,
      position: scenario.position,
      owner: scenario.org("khunou"),
      owner_org_id: khunou,
      source: scenario.classes.kopano,
      source_custodian: scenario.org("kopano"),
      source_custodian_org_id: kopano,
      destination: scenario.classes.port,
      destination_custodian: scenario.org("port-t1"),
      destination_custodian_org_id: port,
      committed_kg: "5000000",
      locked_kg: "5000000",
      batch_count: 1,
      departure_document: scenario.document,
      registered_count: 1,
      registered_kg: "5000000",
      departed_count: 0,
      departed_kg: "0",
      arrived_count: 0,
      arrived_kg: "0",
      event_registered: 1,
    };
    expect(row(h.store, "chain_shipments", s1)).toMatchObject({
      ...shipmentRow,
      shipment_id_hex: "22".repeat(16),
      status: "Cancelled",
      prepared_at: String(scenario.preparedAt.s1),
      revision: "1",
      event_revision: "1",
    });
    expect(row(h.store, "chain_shipments", s2)).toMatchObject({
      ...shipmentRow,
      shipment_id_hex: "23".repeat(16),
      status: "Prepared",
      prepared_at: String(scenario.preparedAt.s2),
      revision: "0",
      event_revision: "0",
    });
    const batchRow = {
      lot: scenario.lot,
      batch_index: 0,
      batch_count: 1,
      quantity_kg: "5000000",
      carrier: scenario.org("mosela"),
      holder: scenario.org("kopano"),
      holder_org_id: kopano,
      stage: "AtSource",
      sequence: "0",
      observation_count: 0,
      departed_at: null,
      arrived_at: null,
      event_sequence: "0",
      event_observations: 0,
    };
    expect(row(h.store, "chain_batches", b1)).toMatchObject({
      ...batchRow,
      shipment: s1,
      load_digest_hex: "33".repeat(32),
      manifest_digest_hex: "44".repeat(32),
    });
    expect(row(h.store, "chain_batches", b2)).toMatchObject({
      ...batchRow,
      shipment: s2,
      load_digest_hex: "55".repeat(32),
      manifest_digest_hex: "66".repeat(32),
    });
    expect(row(h.store, "chain_custodian_classes", scenario.classes.port)).toMatchObject({
      site_code: "PORT-T1",
      reserved_inbound_kg: "5000000",
      occupied_kg: "0",
    });
    expect(row(h.store, "chain_custodian_classes", scenario.classes.kopano)).toMatchObject({
      site_code: "KOPANO-YARD-1",
      occupied_kg: "5000000",
    });
    expect(row(h.store, "chain_release_intents", scenario.intents[0] as string)).toMatchObject({
      status: "Open",
      cancelled_by: s1,
    });

    const byEvent = (name: string) => events(h.store).filter((entry) => entry.event === name);
    expect(byEvent("ShipmentPrepared")).toEqual([
      expect.objectContaining({
        scope: "lot",
        lot: scenario.lot,
        shipment: expect.any(String),
        shipment_revision: "0",
        batch: null,
        org_id: null,
        facility: null,
      }),
      expect.objectContaining({ scope: "lot", shipment_revision: "0" }),
    ]);
    expect(byEvent("ShipmentPrepared").map((entry) => [entry.shipment, entry.created])).toEqual(
      expect.arrayContaining([
        [s1, s1],
        [s2, s2],
      ]),
    );
    expect(byEvent("BatchRegistered").map((entry) => entry.batch)).toEqual(
      expect.arrayContaining([b1, b2]),
    );
    for (const entry of byEvent("BatchRegistered")) {
      expect(entry).toMatchObject({
        scope: "shipment",
        lot: null,
        lot_revision: null,
        shipment_revision: null,
        batch_sequence: null,
        observation_index: null,
        org_id: null,
      });
      expect(entry.created).toBe(entry.batch);
      expect(entry.shipment).toBe(entry.batch === b1 ? s1 : s2);
    }
    expect(byEvent("ShipmentCancelled")).toEqual([
      expect.objectContaining({
        scope: "lot",
        lot: scenario.lot,
        lot_revision: "2",
        shipment: s1,
        shipment_revision: "1",
        created: null,
        data: expect.objectContaining({ releasedKg: "5000000", revision: "1" }),
      }),
    ]);
  });

  it("3. replays the shipment history twice and writes each transaction and event once", async () => {
    const scenario = await custodyHistory();
    const h = await harness(scenario.history);
    await h.pollUntilLive();
    const before = allCounts(h.store);
    const tables = ["chain_events", "chain_transactions", ...CUSTODY_TABLES, ...LENDING_TABLES];
    const snapshot = Object.fromEntries(tables.map((table) => [table, rows(h.store, table)]));
    (h.store as ReturnType<typeof memoryStore>).deleteCheckpoint();
    h.restart();
    await h.pollUntilLive();
    expect(allCounts(h.store)).toEqual(before);
    for (const table of tables) {
      const strip = (list: Record<string, unknown>[]) =>
        list.map(({ commitment: _c, slot: _s, last_signature: _l, ...rest }) => rest);
      expect(strip(rows(h.store, table)), table).toEqual(strip(snapshot[table] ?? []));
    }
  });

  it("4. marks the open release intent cancelled by the shipment and leaves one expiring at prepared_at unmarked", async () => {
    const scenario = await custodyHistory({ secondIntent: true });
    const h = await harness(scenario.history);
    await h.pollUntilLive();
    const [first, second] = scenario.intents as [string, string];
    expect(row(h.store, "chain_release_intents", first)).toMatchObject({
      status: "Open",
      position_revision: "1",
      cancelled_by: scenario.shipments.s1,
    });
    expect(row(h.store, "chain_release_intents", second)).toMatchObject({
      status: "Open",
      position_revision: "1",
      expires_at: String(scenario.preparedAt.s1),
      cancelled_by: null,
    });
  });

  it("5. a second shipment of the same position does not re-mark an intent already cancelled", async () => {
    // S2's event is edited to name the position revision S1 named, so intent 1 would match the
    // rule again but for its stored mark.
    const scenario = await custodyHistory();
    rewriteEvent(
      stepTx(scenario, "prepareS2"),
      0,
      getShipmentPreparedEventDecoder(),
      getShipmentPreparedEventEncoder(),
      (value) => ({ ...value, positionRevision: 2n }),
    );
    const h = await harness(scenario.history);
    await h.pollUntilLive();
    expect(row(h.store, "chain_release_intents", scenario.intents[0] as string)).toMatchObject({
      cancelled_by: scenario.shipments.s1,
    });

    const plain = await custodyHistory();
    const p = await harness(plain.history);
    await p.pollUntilLive();
    expect(row(p.store, "chain_release_intents", plain.intents[0] as string)?.cancelled_by).toBe(
      plain.shipments.s1,
    );
  });

  it("6. halts with REVISION_SEQUENCE on a skipped or repeated shipment revision and on a second ShipmentPrepared for one shipment", async () => {
    const skipped = await custodyHistory();
    rewriteEvent(
      stepTx(skipped, "cancelS1"),
      0,
      getShipmentCancelledEventDecoder(),
      getShipmentCancelledEventEncoder(),
      (value) => ({ ...value, revision: 2n }),
    );
    const first = await harness(skipped.history);
    await expectHalt(first, await first.poll(), "REVISION_SEQUENCE", {
      step: "sequence",
      signature: null,
      mentions: [`shipment ${skipped.shipments.s1}`],
    });
    expect((await first.checkpoint())?.indexedThroughSlot).toBe(
      step(skipped, "cancelS1").slot - 1000,
    );

    // A second cancellation of S1 at the next lot revision repeats shipment revision 1.
    const repeated = await custodyHistory();
    const again = repeatLater(repeated, "cancelS1", 254);
    rewriteEvent(
      again,
      0,
      getShipmentCancelledEventDecoder(),
      getShipmentCancelledEventEncoder(),
      (value) => ({ ...value, lotRevision: 4n }),
    );
    const second = await harness(repeated.history);
    await expectHalt(second, await second.poll(), "REVISION_SEQUENCE", {
      step: "sequence",
      signature: null,
      mentions: [`shipment ${repeated.shipments.s1}`],
    });
    expect((await second.checkpoint())?.indexedThroughSlot).toBe(lastSlot(repeated.history) - 1000);

    // Two ShipmentPrepared for S1 in one slot (at lot revisions 1 and 2).
    const twice = await custodyHistory();
    const prepare = stepTx(twice, "prepareS1");
    const copy = { ...structuredClone(prepare), signature: syntheticSignature(255) };
    rewriteEvent(
      copy,
      0,
      getShipmentPreparedEventDecoder(),
      getShipmentPreparedEventEncoder(),
      (value) => ({ ...value, lotRevision: 2n }),
    );
    const slot = slotOf(twice.history, prepare.signature);
    slot.transactions.push(copy);
    const third = await harness(twice.history);
    await expectHalt(third, await third.poll(), "REVISION_SEQUENCE", {
      step: "sequence",
      signature: null,
      mentions: [`shipment ${twice.shipments.s1}`, "prepared by 2 events"],
    });
    expect((await third.checkpoint())?.indexedThroughSlot).toBe(slot.slot - 1000);
  });

  it("7. halts with REVISION_SEQUENCE when a registration count skips or repeats", async () => {
    const skipped = await custodyHistory();
    rewriteEvent(
      stepTx(skipped, "registerB1"),
      0,
      getBatchRegisteredEventDecoder(),
      getBatchRegisteredEventEncoder(),
      (value) => ({ ...value, registeredCount: 2 }),
    );
    const first = await harness(skipped.history);
    await expectHalt(first, await first.poll(), "REVISION_SEQUENCE", {
      step: "sequence",
      signature: null,
      mentions: [`shipment ${skipped.shipments.s1}`, "registration"],
    });
    expect((await first.checkpoint())?.indexedThroughSlot).toBe(
      step(skipped, "registerB1").slot - 1000,
    );

    const repeated = await custodyHistory();
    repeatLater(repeated, "registerB2", 254);
    const second = await harness(repeated.history);
    await expectHalt(second, await second.poll(), "REVISION_SEQUENCE", {
      step: "sequence",
      signature: null,
      mentions: [`shipment ${repeated.shipments.s2}`, "registration"],
    });
    expect((await second.checkpoint())?.indexedThroughSlot).toBe(lastSlot(repeated.history) - 1000);
  });

  it("8. halts with EVENT_GAP when BatchRegistered names an unprojected shipment", async () => {
    const scenario = await custodyHistory();
    dropTransaction(scenario, "prepareS1");
    const h = await harness(scenario.history);
    await expectHalt(h, await h.poll(), "EVENT_GAP", {
      step: "sequence",
      signature: null,
      mentions: [scenario.shipments.s1],
    });
    expect((await h.checkpoint())?.indexedThroughSlot).toBe(
      step(scenario, "registerB1").slot - 2000,
    );
  });

  it("9. halts with EVENT_MISMATCH when ShipmentPrepared names another lot or document than its instruction", async () => {
    const other = (await syntheticSigner(99)).address;
    for (const field of ["lot", "departureDocument"] as const) {
      const scenario = await custodyHistory();
      const prepare = stepTx(scenario, "prepareS1");
      rewriteEvent(
        prepare,
        0,
        getShipmentPreparedEventDecoder(),
        getShipmentPreparedEventEncoder(),
        (value) => ({ ...value, [field]: other }),
      );
      const h = await harness(scenario.history);
      await expectHalt(h, await h.poll(), "EVENT_MISMATCH", {
        step: "decode",
        signature: prepare.signature,
        mentions: [`ShipmentPrepared.${field}`, other],
      });
      expect((await h.checkpoint())?.indexedThroughSlot).toBe(
        step(scenario, "prepareS1").slot - 1000,
      );
    }
  });

  it("10. indexes a Departure document with its subject lot address", async () => {
    const scenario = await custodyHistory();
    const h = await harness(scenario.history);
    await h.pollUntilLive();
    const kopano = await orgId("kopano");
    expect(row(h.store, "chain_documents", scenario.document)).toMatchObject({
      kind: "Departure",
      subject_hex: hex(Uint8Array.from(getAddressEncoder().encode(scenario.lot as Address))),
      subject_address: scenario.lot,
      version: 1,
      issuer: scenario.org("kopano"),
      issuer_org_id: kopano,
      sha256_hex: "dd".repeat(32),
      revoked_at: null,
    });
    expect(events(h.store).filter((entry) => entry.event === "DocumentAttested")).toEqual([
      expect.objectContaining({
        scope: "organisation",
        org_id: kopano,
        shipment: null,
        data: expect.objectContaining({ kind: "Departure" }),
      }),
    ]);
  });

  it("11. reconcile promotes shipment and batch rows and halts with EVENT_GAP when a shipment revision or registered count differs from its event column", async () => {
    const scenario = await custodyHistory();
    const h = await harness(scenario.history);
    const live = await h.pollUntilLive();
    for (const table of CUSTODY_TABLES) {
      const found = rows(h.store, table);
      expect(found.length, table).toBe(2);
      for (const entry of found) {
        expect(entry, table).toMatchObject({
          commitment: "finalized",
          last_signature: null,
          slot: live.indexedThroughSlot,
        });
      }
    }
    expect(row(h.store, "chain_release_intents", scenario.intents[0] as string)).toMatchObject({
      commitment: "finalized",
      cancelled_by: scenario.shipments.s1,
    });

    const cases: {
      edit: (value: Shipment) => Shipment;
      columns: [string, string, string, string];
    }[] = [
      {
        edit: (value) => ({ ...value, revision: value.revision + 1n }),
        columns: ["revision", "1", "event_revision", "0"],
      },
      {
        edit: (value) => ({ ...value, registeredCount: value.registeredCount + 1 }),
        columns: ["registered_count", "2", "event_registered", "1"],
      },
    ];
    for (const { edit, columns } of cases) {
      const moved = await custodyHistory();
      moveWithoutEvent(
        moved.history,
        moved.shipments.s2,
        getShipmentDecoder(),
        getShipmentEncoder(),
        edit,
      );
      const second = await harness(moved.history);
      await expectHalt(second, await pollToHalt(second.poll), "EVENT_GAP", {
        step: "reconcile",
        signature: null,
        mentions: [moved.shipments.s2],
      });
      const stored = row(second.store, "chain_shipments", moved.shipments.s2);
      const [column, value, eventColumn, eventValue] = columns;
      expect(String(stored?.[column])).toBe(value);
      expect(String(stored?.[eventColumn])).toBe(eventValue);
      expect(stored?.commitment).not.toBe("finalized");
    }

    // A batch whose sequence moves with no handover the indexer could see.
    const batch = await custodyHistory();
    moveWithoutEvent(
      batch.history,
      batch.batches.b2,
      getManifestBatchDecoder(),
      getManifestBatchEncoder(),
      (value) => ({ ...value, sequence: value.sequence + 1n }),
    );
    const third = await harness(batch.history);
    await expectHalt(third, await pollToHalt(third.poll), "EVENT_GAP", {
      step: "reconcile",
      signature: null,
      mentions: [batch.batches.b2],
    });
    expect(row(third.store, "chain_batches", batch.batches.b2)).toMatchObject({
      sequence: "1",
      event_sequence: "0",
    });
  });

  it("13. indexes the demo route: departure and arrival move the lot, the batch and the occupancy", async () => {
    const scenario = await routeHistory();
    const h = await harness(scenario.history);
    const live = await h.pollUntilLive();
    const { s2 } = scenario.shipments;
    const { b2 } = scenario.batches;
    const depart = step(scenario, "departB2");
    const arrive = step(scenario, "arriveB2");
    const departRecord = scenario.handovers.departB2 as string;
    const arriveRecord = scenario.handovers.arriveB2 as string;

    expect(keysOf(h.store, "lot", "lot_revision", scenario.lot)).toEqual([
      "0",
      "1",
      "2",
      "3",
      "4",
      "5",
    ]);
    expect(keysOf(h.store, "shipment", "shipment_revision", s2)).toEqual(["0", "1", "2"]);
    expect(keysOf(h.store, "batch", "batch_sequence", b2)).toEqual(["0", "1"]);
    // The route carries the border observation (T063d.3 pre-check fold 2): one more transaction
    // and event than T063d.2's.
    expect(allCounts(h.store)).toMatchObject({
      chain_transactions: 27,
      chain_events: 26,
      chain_shipments: 2,
      chain_batches: 2,
      chain_handovers: 2,
    });

    const kopano = await orgId("kopano");
    const mosela = await orgId("mosela");
    const port = await orgId("port-t1");
    expect(row(h.store, "chain_lots", scenario.lot)).toMatchObject({
      state: "Stored",
      revision: "5",
      event_revision: "5",
      custodian_class: scenario.classes.port,
      custodian: scenario.org("port-t1"),
      custodian_org_id: port,
    });
    expect(row(h.store, "chain_shipments", s2)).toMatchObject({
      status: "Arrived",
      revision: "2",
      event_revision: "2",
      departed_count: 1,
      departed_kg: "5000000",
      arrived_count: 1,
      arrived_kg: "5000000",
    });
    expect(row(h.store, "chain_batches", b2)).toMatchObject({
      stage: "Arrived",
      holder: scenario.org("port-t1"),
      holder_org_id: port,
      sequence: "2",
      event_sequence: "2",
      observation_count: 1,
      event_observations: 1,
      departed_at: String(unixOf(depart.blockTime)),
      arrived_at: String(unixOf(arrive.blockTime)),
    });
    expect(row(h.store, "chain_custodian_classes", scenario.classes.port)).toMatchObject({
      occupied_kg: "5000000",
      reserved_inbound_kg: "0",
    });
    expect(row(h.store, "chain_custodian_classes", scenario.classes.kopano)).toMatchObject({
      occupied_kg: "0",
    });

    const handoverRow = {
      shipment: s2,
      batch: b2,
      quantity_kg: "5000000",
      manifest_digest_hex: "66".repeat(32),
    };
    expect(row(h.store, HANDOVER_TABLE, departRecord)).toMatchObject({
      ...handoverRow,
      sequence: "0",
      from_organisation: scenario.org("kopano"),
      from_org_id: kopano,
      to_organisation: scenario.org("mosela"),
      to_org_id: mosela,
      from_wallet: (await syntheticSigner(43)).address,
      to_wallet: (await syntheticSigner(46)).address,
      stage: "Departure",
      at: String(unixOf(depart.blockTime)),
    });
    expect(row(h.store, HANDOVER_TABLE, arriveRecord)).toMatchObject({
      ...handoverRow,
      sequence: "1",
      from_organisation: scenario.org("mosela"),
      from_org_id: mosela,
      to_organisation: scenario.org("port-t1"),
      to_org_id: port,
      from_wallet: (await syntheticSigner(46)).address,
      to_wallet: (await syntheticSigner(45)).address,
      stage: "Arrival",
      at: String(unixOf(arrive.blockTime)),
    });
    // Reconcile scans HandoverRecord: both rows are promoted with the rest.
    for (const entry of rows(h.store, HANDOVER_TABLE)) {
      expect(entry).toMatchObject({
        commitment: "finalized",
        last_signature: null,
        slot: live.indexedThroughSlot,
      });
    }

    const handed = events(h.store).filter((entry) => entry.event === "CustodyHandedOver");
    expect(handed).toEqual([
      expect.objectContaining({
        signature: depart.signature,
        instruction: "Handover",
        scope: "lot",
        lot: scenario.lot,
        lot_revision: "4",
        shipment: s2,
        shipment_revision: "1",
        batch: b2,
        batch_sequence: "0",
        observation_index: null,
        created: departRecord,
        org_id: null,
        data: expect.objectContaining({
          stage: "Departure",
          shipmentStatus: "InTransit",
          lotState: "InTransit",
        }),
      }),
      expect.objectContaining({
        signature: arrive.signature,
        scope: "lot",
        lot: scenario.lot,
        lot_revision: "5",
        shipment: s2,
        shipment_revision: "2",
        batch: b2,
        batch_sequence: "1",
        created: arriveRecord,
        data: expect.objectContaining({
          stage: "Arrival",
          shipmentStatus: "Arrived",
          lotState: "Stored",
        }),
      }),
    ]);

    // A replay from the first signature writes each transaction and event once.
    const before = allCounts(h.store);
    (h.store as ReturnType<typeof memoryStore>).deleteCheckpoint();
    h.restart();
    await h.pollUntilLive();
    expect(allCounts(h.store)).toEqual(before);
  });

  it("14. a transfer handover and a partial arrival are shipment-scoped and repeat the lot revision", async () => {
    // Transfer: B2 goes Kopano → Mosela → Haulier Two Test Org → Port Terminal T1.
    const transfer = await routeHistory({ transfer: true });
    const t = await harness(transfer.history);
    await t.pollUntilLive();
    const { s2 } = transfer.shipments;
    const { b2 } = transfer.batches;
    const record = transfer.handovers.transferB2 as string;
    expect(keysOf(t.store, "lot", "lot_revision", transfer.lot)).toEqual([
      "0",
      "1",
      "2",
      "3",
      "4",
      "5",
    ]);
    expect(keysOf(t.store, "shipment", "shipment_revision", s2)).toEqual(["0", "1", "2", "3"]);
    expect(keysOf(t.store, "batch", "batch_sequence", b2)).toEqual(["0", "1", "2"]);
    const moved = events(t.store).find((entry) => entry.created === record);
    expect(moved).toMatchObject({
      event: "CustodyHandedOver",
      scope: "shipment",
      lot: null,
      lot_revision: null,
      shipment: s2,
      shipment_revision: "2",
      batch: b2,
      batch_sequence: "1",
      data: expect.objectContaining({ stage: "Transfer", lotRevision: "4" }),
    });
    const haulierOrg = "11000000-0000-4000-8000-000000000009";
    expect(row(t.store, "chain_organisations", transfer.haulier as string)).toMatchObject({
      org_id: haulierOrg,
      role: "Transporter",
      display_name: "Haulier Two Test Org",
      slug: null,
    });
    expect(row(t.store, HANDOVER_TABLE, record)).toMatchObject({
      sequence: "1",
      stage: "Transfer",
      from_organisation: transfer.org("mosela"),
      to_organisation: transfer.haulier,
      to_org_id: haulierOrg,
    });
    expect(row(t.store, "chain_batches", b2)).toMatchObject({
      stage: "Arrived",
      sequence: "3",
      event_sequence: "3",
    });
    expect(row(t.store, "chain_lots", transfer.lot)).toMatchObject({
      state: "Stored",
      event_revision: "5",
    });
    expect(rows(t.store, HANDOVER_TABLE)).toHaveLength(3);

    // Partial arrival: S2 as two batches. Up to the first arrival, the lot and the shipment stay in
    // transit and the arrival repeats lot revision 4.
    const partial = await routeHistory({ partial: true });
    const b3 = partial.batches.b3 as string;
    const firstArrival = step(partial, "arriveB2");
    const upTo = partial.history.filter((entry) => entry.slot <= firstArrival.slot);
    const p = await harness(upTo);
    await p.pollUntilLive();
    expect(row(p.store, "chain_shipments", partial.shipments.s2)).toMatchObject({
      status: "InTransit",
      batch_count: 2,
      departed_count: 2,
      arrived_count: 1,
      arrived_kg: "3000000",
      event_revision: "3",
    });
    expect(row(p.store, "chain_lots", partial.lot)).toMatchObject({
      state: "InTransit",
      revision: "4",
      event_revision: "4",
      custodian_class: partial.classes.kopano,
    });
    expect(row(p.store, "chain_batches", partial.batches.b2)).toMatchObject({
      stage: "Arrived",
      holder: partial.org("port-t1"),
    });
    expect(row(p.store, "chain_batches", b3)).toMatchObject({
      stage: "InTransit",
      holder: partial.org("mosela"),
    });
    expect(row(p.store, "chain_custodian_classes", partial.classes.port)).toMatchObject({
      occupied_kg: "3000000",
      reserved_inbound_kg: "2000000",
    });
    const scopeOf = (store: ReadModelStore, name: CustodyStep) =>
      events(store).find((entry) => entry.signature === step(partial, name).signature);
    expect(scopeOf(p.store, "departB3")).toMatchObject({
      scope: "shipment",
      lot: null,
      shipment_revision: "2",
      batch: b3,
      batch_sequence: "0",
    });
    expect(scopeOf(p.store, "arriveB2")).toMatchObject({
      scope: "shipment",
      lot: null,
      lot_revision: null,
      shipment_revision: "3",
      batch_sequence: "1",
      data: expect.objectContaining({
        stage: "Arrival",
        shipmentStatus: "InTransit",
        lotState: "InTransit",
        lotRevision: "4",
      }),
    });

    // The last arrival advances the lot to Stored at PORT-T1.
    const whole = await harness(partial.history);
    await whole.pollUntilLive();
    expect(scopeOf(whole.store, "arriveB3")).toMatchObject({
      scope: "lot",
      lot: partial.lot,
      lot_revision: "5",
      shipment_revision: "4",
    });
    expect(row(whole.store, "chain_shipments", partial.shipments.s2)).toMatchObject({
      status: "Arrived",
      arrived_count: 2,
      arrived_kg: "5000000",
    });
    expect(row(whole.store, "chain_lots", partial.lot)).toMatchObject({
      state: "Stored",
      event_revision: "5",
      custodian_class: partial.classes.port,
    });
    expect(keysOf(whole.store, "lot", "lot_revision", partial.lot)).toEqual([
      "0",
      "1",
      "2",
      "3",
      "4",
      "5",
    ]);
  });

  it("15. halts with REVISION_SEQUENCE on a skipped or repeated batch sequence", async () => {
    const skipped = await routeHistory();
    rewriteEvent(
      stepTx(skipped, "arriveB2"),
      0,
      getCustodyHandedOverEventDecoder(),
      getCustodyHandedOverEventEncoder(),
      (value) => ({ ...value, sequence: 2n }),
    );
    const first = await harness(skipped.history);
    await expectHalt(first, await first.poll(), "REVISION_SEQUENCE", {
      step: "sequence",
      signature: null,
      mentions: [`batch ${skipped.batches.b2}`, "sequence"],
    });
    expect((await first.checkpoint())?.indexedThroughSlot).toBe(
      step(skipped, "arriveB2").slot - 1000,
    );

    // Two handovers of B2 in one slot that consume sequence 0 (shipment revisions 1 and 2, the
    // second repeating lot revision 4).
    const repeated = await routeHistory();
    const departure = stepTx(repeated, "departB2");
    const copy = { ...structuredClone(departure), signature: syntheticSignature(255) };
    rewriteEvent(
      copy,
      0,
      getCustodyHandedOverEventDecoder(),
      getCustodyHandedOverEventEncoder(),
      (value) => ({ ...value, shipmentRevision: 2n }),
    );
    const slot = slotOf(repeated.history, departure.signature);
    slot.transactions.push(copy);
    const second = await harness(repeated.history);
    await expectHalt(second, await second.poll(), "REVISION_SEQUENCE", {
      step: "sequence",
      signature: null,
      mentions: [`batch ${repeated.batches.b2}`, "sequence"],
    });
    expect((await second.checkpoint())?.indexedThroughSlot).toBe(slot.slot - 1000);
  });

  it("16. halts with EVENT_MISMATCH when a first handover is not a departure, or an arrival leaves the lot in transit", async () => {
    const cases: {
      name: CustodyStep;
      edit: (
        value: ReturnType<ReturnType<typeof getCustodyHandedOverEventDecoder>["decode"]>,
      ) => unknown;
      mentions: string[];
    }[] = [
      {
        name: "departB2",
        edit: (value) => ({ ...value, stage: HandoverStage.Transfer }),
        mentions: ["CustodyHandedOver", "first handover"],
      },
      {
        name: "arriveB2",
        edit: (value) => ({ ...value, lotState: LotState.InTransit }),
        mentions: ["CustodyHandedOver", "Arrived"],
      },
      {
        name: "arriveB2",
        edit: (value) => ({ ...value, shipmentStatus: ShipmentStatus.Prepared }),
        mentions: ["CustodyHandedOver", "InTransit"],
      },
    ];
    for (const { name, edit, mentions } of cases) {
      const scenario = await routeHistory();
      const tx = stepTx(scenario, name);
      rewriteEvent(
        tx,
        0,
        getCustodyHandedOverEventDecoder(),
        getCustodyHandedOverEventEncoder(),
        edit as never,
      );
      const h = await harness(scenario.history);
      await expectHalt(h, await h.poll(), "EVENT_MISMATCH", {
        step: "decode",
        signature: tx.signature,
        mentions,
      });
      expect((await h.checkpoint())?.indexedThroughSlot).toBe(step(scenario, name).slot - 1000);
    }

    // The pairing: the event's recipient is not the instruction's toOrg.
    const other = (await syntheticSigner(99)).address;
    const paired = await routeHistory();
    const departure = stepTx(paired, "departB2");
    rewriteEvent(
      departure,
      0,
      getCustodyHandedOverEventDecoder(),
      getCustodyHandedOverEventEncoder(),
      (value) => ({ ...value, to: other }),
    );
    const h = await harness(paired.history);
    await expectHalt(h, await h.poll(), "EVENT_MISMATCH", {
      step: "decode",
      signature: departure.signature,
      mentions: ["CustodyHandedOver.to", other],
    });
  });

  it("18. indexes a border observation without changing the holder", async () => {
    // The route through Mosela's border observation (237), before the arrival.
    const scenario = await routeHistory();
    const { s2 } = scenario.shipments;
    const { b2 } = scenario.batches;
    const observed = step(scenario, "observeB2");
    const at = slotOf(scenario.history, observed.signature);
    const through = scenario.history.slice(0, scenario.history.indexOf(at) + 1);
    const h = await harness(through);
    await h.pollUntilLive();

    const mosela = scenario.org("mosela");
    const moselaId = await orgId("mosela");
    const unchanged = {
      stage: "InTransit",
      holder: mosela,
      holder_org_id: moselaId,
      sequence: "1",
      event_sequence: "1",
    };
    expect(row(h.store, "chain_batches", b2)).toMatchObject({
      ...unchanged,
      observation_count: 1,
      event_observations: 1,
    });
    expect(row(h.store, "chain_shipments", s2)).toMatchObject({
      status: "InTransit",
      revision: "1",
      event_revision: "1",
    });
    expect(row(h.store, "chain_lots", scenario.lot)).toMatchObject({
      state: "InTransit",
      revision: "4",
      event_revision: "4",
    });
    expect(keysOf(h.store, "lot", "lot_revision", scenario.lot)).toEqual(["0", "1", "2", "3", "4"]);
    expect(keysOf(h.store, "shipment", "shipment_revision", s2)).toEqual(["0", "1"]);
    expect(keysOf(h.store, "batch", "batch_sequence", b2)).toEqual(["0"]);

    const observation = {
      signature: observed.signature,
      instruction: "RecordObservation",
      event: "ObservationRecorded",
      scope: "shipment",
      lot: null,
      lot_revision: null,
      org_id: null,
      shipment: s2,
      shipment_revision: null,
      batch: b2,
      batch_sequence: null,
      created: null,
    };
    const recorded = () => events(h.store).filter((entry) => entry.event === "ObservationRecorded");
    expect(recorded()).toEqual([
      expect.objectContaining({
        ...observation,
        observation_index: 0,
        data: {
          batch: b2,
          shipment: s2,
          lot: scenario.lot,
          observer: mosela,
          holder: mosela,
          kind: "Border",
          locationCode: "BORDER-1",
          evidenceDigest: "77".repeat(32),
          observedAt: String(unixOf(observed.blockTime)),
          index: 0,
        },
      }),
    ]);

    // A second observation, a checkpoint whose observed_at (1) is earlier than the first's: the
    // order comes from the index alone, and the holder still does not move.
    const before = lastState(through, b2, getManifestBatchDecoder());
    const sponsor = await syntheticSigner(30);
    const [observerAuthority] = await findAuthorityPda({
      protocol: scenario.protocol as Address,
      wallet: (await syntheticSigner(46)).address,
    });
    const fields = {
      kind: ObservationKind.Checkpoint,
      locationCode: "CHECKPOINT-1",
      evidenceDigest: new Uint8Array(32).fill(0x78),
      observedAt: 1n,
    };
    const second = thetisTransaction({
      signature: syntheticSignature(254),
      feePayer: sponsor.address,
      name: "RecordObservation",
      instruction: getRecordObservationInstruction({
        sponsor,
        protocol: scenario.protocol as Address,
        observerOrg: mosela as Address,
        observerAuthority,
        holderOrg: mosela as Address,
        shipment: s2 as Address,
        batch: b2 as Address,
        lot: scenario.lot as Address,
        ...fields,
        expectedObservation: 1,
        validUntil: 1_800_000_000n,
      }),
      events: [
        bytesOf(getObservationRecordedEventEncoder(), {
          batch: b2,
          shipment: s2,
          lot: scenario.lot,
          observer: mosela,
          holder: mosela,
          ...fields,
          index: 1,
        }),
      ],
    });
    through.push({
      slot: lastSlot(through) + 1000,
      blockTime: "2026-11-28T00:01:00.000Z",
      transactions: [second],
      accounts: {
        [b2]: thetis(bytesOf(getManifestBatchEncoder(), { ...before, observationCount: 2 })),
      },
    });
    h.chain.setHistory(through);
    h.chain.setConfirmedSlot(lastSlot(through));
    h.chain.setFinalizedSlot(lastSlot(through));
    await h.pollUntilLive();
    expect(row(h.store, "chain_batches", b2)).toMatchObject({
      ...unchanged,
      observation_count: 2,
      event_observations: 2,
    });
    expect(recorded().map((entry) => entry.observation_index)).toEqual([0, 1]);
    expect(recorded()[1]).toMatchObject({
      ...observation,
      signature: second.signature,
      observation_index: 1,
      data: expect.objectContaining({ kind: "Checkpoint", observedAt: "1", index: 1 }),
    });
  });

  it("19. halts with REVISION_SEQUENCE on a skipped observation index", async () => {
    const skipped = await routeHistory();
    rewriteEvent(
      stepTx(skipped, "observeB2"),
      0,
      getObservationRecordedEventDecoder(),
      getObservationRecordedEventEncoder(),
      (value) => ({ ...value, index: 1 }),
    );
    const first = await harness(skipped.history);
    await expectHalt(first, await first.poll(), "REVISION_SEQUENCE", {
      step: "sequence",
      signature: null,
      mentions: [`batch ${skipped.batches.b2}`, "observation"],
    });
    expect((await first.checkpoint())?.indexedThroughSlot).toBe(
      step(skipped, "observeB2").slot - 1000,
    );

    // The same index again in a later slot, once the stored batch has counted it.
    const repeated = await routeHistory();
    repeatLater(repeated, "observeB2", 254);
    const second = await harness(repeated.history);
    await expectHalt(second, await second.poll(), "REVISION_SEQUENCE", {
      step: "sequence",
      signature: null,
      mentions: [`batch ${repeated.batches.b2}`, "observation"],
    });
    expect((await second.checkpoint())?.indexedThroughSlot).toBe(lastSlot(repeated.history) - 1000);
  });

  it("21. indexes the loading: units burned, the loan handed off with its debt, the intent executed", async () => {
    const scenario = await loadingHistory();
    const h = await harness(scenario.history);
    await h.pollUntilLive();
    const intent = scenario.loadingIntent as string;
    const acceptance = scenario.acceptance as string;
    const created = step(scenario, "createLoadingIntent");
    const accepted = step(scenario, "acceptLoading");
    const loaded = step(scenario, "recordLoading");
    const khunou = await orgId("khunou");
    const port = await orgId("port-t1");
    const lender = await orgId("lender-one");

    // Three loading transactions and four events beyond the route's 27 and 26.
    expect(allCounts(h.store)).toMatchObject({
      chain_transactions: 30,
      chain_events: 30,
      chain_loading_intents: 1,
      chain_handoff_acceptances: 1,
      chain_loans: 1,
    });
    expect(keysOf(h.store, "lot", "lot_revision", scenario.lot)).toEqual([
      "0",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
    ]);
    expect(keysOf(h.store, "loan", "loan_revision", scenario.loan)).toEqual(["0", "1", "2"]);
    expect(keysOf(h.store, "acceptance", "acceptance_version", acceptance)).toEqual(["1"]);

    expect(row(h.store, "chain_lots", scenario.lot)).toMatchObject({
      state: "Loaded",
      supply_kg: "0",
      revision: "6",
      event_revision: "6",
      custodian_class: scenario.classes.port,
    });
    expect(row(h.store, "chain_intakes", scenario.intake)).toMatchObject({ retired: true });
    expect(row(h.store, "chain_positions", scenario.position)).toMatchObject({
      quantity_kg: "0",
      locked_kg: "0",
      revision: "5",
    });
    expect(row(h.store, "chain_custodian_classes", scenario.classes.port)).toMatchObject({
      occupied_kg: "0",
      reserved_inbound_kg: "0",
    });
    const loan = lastState(scenario.history, scenario.loan, getLoanDecoder());
    expect(loan.bookedInterest > 0n).toBe(true);
    expect(row(h.store, "chain_loans", scenario.loan)).toMatchObject({
      status: "ExternalHandoff",
      principal: "60000000",
      booked_interest: String(loan.bookedInterest),
      accrued_at: String(unixOf(loaded.blockTime)),
      revision: "2",
      event_revision: "2",
    });
    expect(row(h.store, "chain_locks", scenario.lock)).toMatchObject({ quantity_kg: "0" });
    expect(row(h.store, "chain_loading_intents", intent)).toMatchObject({
      lot: scenario.lot,
      position: scenario.position,
      owner: scenario.org("khunou"),
      owner_org_id: khunou,
      terminal: scenario.org("port-t1"),
      terminal_org_id: port,
      custodian_class: scenario.classes.port,
      nonce: "1",
      quantity_kg: "5000000",
      locked_kg: "5000000",
      document_sha256_hex: "aa".repeat(32),
      position_revision: "4",
      expires_at: String(unixOf(created.blockTime) + 86_400),
      status: "Executed",
      executed_at: String(unixOf(loaded.blockTime)),
      cancelled_by: null,
    });
    expect(row(h.store, "chain_handoff_acceptances", acceptance)).toMatchObject({
      intent,
      loan: scenario.loan,
      lock: scenario.lock,
      lender: scenario.org("lender-one"),
      lender_org_id: lender,
      lock_quantity_kg: "5000000",
      loan_revision: "1",
      principal: "60000000",
      accepted_at: String(unixOf(accepted.blockTime)),
      version: 1,
      event_version: 1,
    });

    const noCustody = {
      shipment: null,
      shipment_revision: null,
      batch: null,
      batch_sequence: null,
      observation_index: null,
    };
    const named = (event: string) => events(h.store).filter((entry) => entry.event === event);
    expect(named("LoadingIntentCreated")).toEqual([
      expect.objectContaining({
        ...noCustody,
        signature: created.signature,
        instruction: "CreateLoadingIntent",
        scope: "loading",
        lot: null,
        lot_revision: null,
        org_id: null,
        facility: null,
        loan: null,
        created: intent,
        acceptance: null,
        acceptance_version: null,
        data: expect.objectContaining({ intent, positionRevision: "4", lockedKg: "5000000" }),
      }),
    ]);
    expect(named("LoadingAccepted")).toEqual([
      expect.objectContaining({
        ...noCustody,
        signature: accepted.signature,
        instruction: "AcceptLoading",
        scope: "facility",
        lot: null,
        facility: scenario.facility,
        loan: scenario.loan,
        loan_revision: null,
        created: null,
        acceptance,
        acceptance_version: 1,
      }),
    ]);
    expect(named("LoadingRecorded")).toEqual([
      expect.objectContaining({
        ...noCustody,
        signature: loaded.signature,
        event_index: 0,
        instruction: "RecordLoading",
        scope: "lot",
        lot: scenario.lot,
        lot_revision: "6",
        facility: null,
        loan: null,
        created: null,
        acceptance: null,
        data: expect.objectContaining({ loansAccepted: 1, lotLoaded: true, quantityKg: "5000000" }),
      }),
    ]);
    expect(named("LoanHandedOff")).toEqual([
      expect.objectContaining({
        ...noCustody,
        signature: loaded.signature,
        event_index: 1,
        instruction: "RecordLoading",
        scope: "facility",
        lot: null,
        lot_revision: null,
        facility: scenario.facility,
        loan: scenario.loan,
        loan_revision: "2",
        created: null,
        acceptance: null,
        data: expect.objectContaining({
          loan: scenario.loan,
          intent,
          releasedKg: "5000000",
          principal: "60000000",
          bookedInterest: String(loan.bookedInterest),
          externalHandoff: true,
          revision: "2",
        }),
      }),
    ]);
    const tx = rows(h.store, "chain_transactions").find(
      (entry) => entry.signature === loaded.signature,
    );
    expect(tx?.event_count).toBe(2);

    // Replayed from the first signature, every transaction and event is written once.
    const again = await harness(scenario.history);
    await again.pollUntilLive();
    expect(allCounts(again.store)).toEqual(allCounts(h.store));
  });

  it("22. halts with EVENT_MISMATCH when record_loading's events don't match its triples or loans_accepted", async () => {
    const cases: { name: string; edit: (scenario: CustodyScenario) => void; mentions: string[] }[] =
      [
        {
          name: "a triple short of its lock",
          edit: (scenario) => {
            stepTx(scenario, "recordLoading").instructions[0]?.accounts.pop();
          },
          mentions: ["record_loading names 2 remaining accounts"],
        },
        {
          name: "loans_accepted 2 for one triple",
          edit: (scenario) =>
            rewriteEvent(
              stepTx(scenario, "recordLoading"),
              0,
              getLoadingRecordedEventDecoder(),
              getLoadingRecordedEventEncoder(),
              (value) => ({ ...value, loansAccepted: 2 }),
            ),
          mentions: ["loansAccepted"],
        },
        {
          name: "no LoanHandedOff",
          edit: (scenario) => {
            const tx = stepTx(scenario, "recordLoading");
            const last = (tx.logs ?? []).findLastIndex((line) => line.startsWith("Program data: "));
            tx.logs?.splice(last, 1);
          },
          mentions: ["RecordLoading emitted [LoadingRecorded]"],
        },
        {
          name: "a LoanHandedOff of another loan",
          edit: (scenario) =>
            rewriteEvent(
              stepTx(scenario, "recordLoading"),
              1,
              getLoanHandedOffEventDecoder(),
              getLoanHandedOffEventEncoder(),
              (value) => ({ ...value, loan: scenario.lock as Address }),
            ),
          mentions: ["LoanHandedOff.loan"],
        },
        {
          name: "a LoanHandedOff of another intent",
          edit: (scenario) =>
            rewriteEvent(
              stepTx(scenario, "recordLoading"),
              1,
              getLoanHandedOffEventDecoder(),
              getLoanHandedOffEventEncoder(),
              (value) => ({ ...value, intent: scenario.acceptance as Address }),
            ),
          mentions: ["LoanHandedOff.intent"],
        },
      ];
    for (const { name, edit, mentions } of cases) {
      const scenario = await loadingHistory();
      edit(scenario);
      const h = await harness(scenario.history);
      const loaded = step(scenario, "recordLoading");
      const checkpoint = await expectHalt(h, await h.poll(), "EVENT_MISMATCH", {
        step: "decode",
        signature: loaded.signature,
        mentions,
      });
      expect(checkpoint?.halt?.detail, name).toContain("RecordLoading");
      expect((await h.checkpoint())?.indexedThroughSlot, name).toBe(loaded.slot - 1000);
    }
  });

  it("23. a re-acceptance advances the acceptance version and a skipped version halts", async () => {
    const scenario = await loadingHistory({ reaccept: true });
    const h = await harness(scenario.history);
    await h.pollUntilLive();
    const acceptance = scenario.acceptance as string;
    const reaccepted = step(scenario, "reacceptLoading");
    expect(keysOf(h.store, "acceptance", "acceptance_version", acceptance)).toEqual(["1", "2"]);
    expect(row(h.store, "chain_handoff_acceptances", acceptance)).toMatchObject({
      version: 2,
      event_version: 2,
      accepted_at: String(unixOf(reaccepted.blockTime)),
      last_signature: null,
      commitment: "finalized",
    });
    expect(row(h.store, "chain_loading_intents", scenario.loadingIntent as string)).toMatchObject({
      status: "Executed",
    });

    // Version 3 after a stored 1: skipped.
    const skipped = await loadingHistory({ reaccept: true });
    rewriteEvent(
      stepTx(skipped, "reacceptLoading"),
      0,
      getLoadingAcceptedEventDecoder(),
      getLoadingAcceptedEventEncoder(),
      (value) => ({ ...value, version: 3 }),
    );
    const second = await harness(skipped.history);
    await expectHalt(second, await second.poll(), "REVISION_SEQUENCE", {
      step: "sequence",
      signature: null,
      mentions: [`acceptance ${skipped.acceptance}`],
    });
    expect((await second.checkpoint())?.indexedThroughSlot).toBe(
      step(skipped, "reacceptLoading").slot - 1000,
    );

    // A first acceptance at version 2: no stored row to advance.
    const gap = await loadingHistory();
    rewriteEvent(
      stepTx(gap, "acceptLoading"),
      0,
      getLoadingAcceptedEventDecoder(),
      getLoadingAcceptedEventEncoder(),
      (value) => ({ ...value, version: 2 }),
    );
    const third = await harness(gap.history);
    await expectHalt(third, await third.poll(), "EVENT_GAP", {
      step: "sequence",
      signature: null,
      mentions: [`acceptance ${gap.acceptance}`],
    });

    // Version 1 again in a later slot, once the acceptance is stored.
    const repeated = await loadingHistory();
    repeatLater(repeated, "acceptLoading", 254);
    const fourth = await harness(repeated.history);
    await expectHalt(fourth, await fourth.poll(), "REVISION_SEQUENCE", {
      step: "sequence",
      signature: null,
      mentions: [`acceptance ${repeated.acceptance}`],
    });

    // Reconcile: an acceptance whose version moves with no event the indexer could see.
    const moved = await loadingHistory();
    moveWithoutEvent(
      moved.history,
      moved.acceptance as string,
      getHandoffAcceptanceDecoder(),
      getHandoffAcceptanceEncoder(),
      (value) => ({ ...value, version: value.version + 1 }),
    );
    const fifth = await harness(moved.history);
    await expectHalt(fifth, await pollToHalt(fifth.poll), "EVENT_GAP", {
      step: "reconcile",
      signature: null,
      mentions: [moved.acceptance as string],
    });
    expect(row(fifth.store, "chain_handoff_acceptances", moved.acceptance as string)).toMatchObject(
      {
        version: 2,
        event_version: 1,
      },
    );
  });

  it("24. marks an open loading intent cancelled by the next shipment of its position", async () => {
    const scenario = await loadingHistory({ ship: true });
    const h = await harness(scenario.history);
    await h.pollUntilLive();
    const s3 = scenario.shipments.s3 as string;
    expect(row(h.store, "chain_loading_intents", scenario.loadingIntent as string)).toMatchObject({
      status: "Open",
      position_revision: "4",
      executed_at: null,
      cancelled_by: s3,
      commitment: "finalized",
    });
    expect(row(h.store, "chain_shipments", s3)).toMatchObject({
      status: "Prepared",
      source: scenario.classes.port,
      destination: scenario.classes.kopano,
    });
    expect(row(h.store, "chain_lots", scenario.lot)).toMatchObject({
      state: "Prepared",
      event_revision: "6",
    });
    // The release intent keeps the mark S1 gave it.
    expect(row(h.store, "chain_release_intents", scenario.intents[0] as string)).toMatchObject({
      cancelled_by: scenario.shipments.s1,
    });
  });

  it("25. halts with UNKNOWN_INSTRUCTION on its own instance's attest_shortfall until T063d.5", async () => {
    // attest_shortfall is not in main's IDL until the program builds it, so its Anchor discriminator names
    // no instruction (live-custody.md, T063d.4 pre-check fold 6, as T063d.1's test 12).
    const scenario = await loadingHistory();
    const sponsor = await syntheticSigner(97);
    const discriminator = createHash("sha256").update("global:attest_shortfall").digest();
    const shortfall: FakeTransaction = {
      ...thetisTransaction({
        signature: syntheticSignature(254),
        feePayer: sponsor.address,
        name: "AttestShortfall",
        events: [],
        instruction: {
          programAddress: PROGRAM as Address,
          accounts: [
            { address: sponsor.address, role: AccountRole.WRITABLE_SIGNER },
            { address: scenario.protocol as Address, role: AccountRole.READONLY },
            { address: scenario.lot as Address, role: AccountRole.WRITABLE },
          ],
          data: new Uint8Array([...discriminator.subarray(0, 8), ...new Uint8Array(8)]),
        },
      }),
    };
    const slot = lastSlot(scenario.history) + 1000;
    scenario.history.push({ slot, blockTime: null, transactions: [shortfall], accounts: {} });
    const h = await harness(scenario.history);
    await expectHalt(h, await h.poll(), "UNKNOWN_INSTRUCTION", {
      step: "decode",
      signature: shortfall.signature,
      mentions: ["discriminator no instruction carries"],
    });
    expect((await h.checkpoint())?.indexedThroughSlot).toBe(slot - 1000);
  });
});
