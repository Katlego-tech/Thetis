// Phase 3, the shipment part: shipments, batches, Departure documents and intent cancellation into the
// read model (live-custody.md §4.1, §9.1 tests 0–12 and its T063d.1 pre-check folds). Every
// history here is synthetic (fixtures/custody.ts).

import { readFileSync } from "node:fs";
import { type Address, getAddressEncoder, getBase58Decoder } from "@solana/kit";
import {
  getBatchRegisteredEventDecoder,
  getBatchRegisteredEventEncoder,
  getHandoverInstruction,
  getManifestBatchDecoder,
  getManifestBatchEncoder,
  getRecordObservationInstruction,
  getShipmentCancelledEventDecoder,
  getShipmentCancelledEventEncoder,
  getShipmentDecoder,
  getShipmentEncoder,
  getShipmentPreparedEventDecoder,
  getShipmentPreparedEventEncoder,
  ObservationKind,
  type Shipment,
} from "@thetis/contracts";
import { describe, expect, it } from "vitest";
import { HANDLED_EVENTS, HANDLED_INSTRUCTIONS } from "../../src/indexer/decode.ts";
import type { memoryStore, ReadModelStore } from "../../src/indexer/store.ts";
import {
  batchLeaf,
  type CustodyScenario,
  type CustodyStep,
  custodyHistory,
  manifestProof,
  manifestRoot,
} from "../fixtures/custody.ts";
import { counts, expectHalt, harness, rows } from "../fixtures/harness.ts";
import {
  bytesOf,
  editEvent,
  type FakeTransaction,
  type History,
  lastSlot,
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
const pascal = (name: string) =>
  name.replace(/(^|_)([a-z0-9])/g, (_, __, letter: string) => letter.toUpperCase());

function allCounts(store: ReadModelStore) {
  return {
    ...counts(store),
    ...Object.fromEntries(
      [...LENDING_TABLES, ...CUSTODY_TABLES].map((table) => [table, rows(store, table).length]),
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

  it("1. handles every instruction and event of the IDL it is built on, but handover, observation and loading", () => {
    // The IDL at main has handover, record_observation and the three loading instructions: 37
    // instructions and 38 events, of which this slice handles all but those and their events.
    const idl = JSON.parse(readFileSync(IDL, "utf8")) as {
      instructions: { name: string }[];
      events: { name: string }[];
    };
    expect(idl.instructions).toHaveLength(37);
    expect(idl.events).toHaveLength(38);
    const unhandledInstructions = [
      "Handover",
      "RecordObservation",
      "CreateLoadingIntent",
      "AcceptLoading",
      "RecordLoading",
    ];
    const unhandledEvents = [
      "CustodyHandedOver",
      "ObservationRecorded",
      "LoadingIntentCreated",
      "LoadingAccepted",
      "LoadingRecorded",
      "LoanHandedOff",
    ];
    const instructions = idl.instructions.map((entry) => pascal(entry.name));
    for (const name of unhandledInstructions) expect(instructions).toContain(name);
    expect([...HANDLED_INSTRUCTIONS].sort()).toEqual(
      instructions.filter((name) => !unhandledInstructions.includes(name)).sort(),
    );
    expect(HANDLED_INSTRUCTIONS).toHaveLength(32);
    const eventNames = idl.events.map((entry) => entry.name);
    for (const name of unhandledEvents) expect(eventNames).toContain(name);
    expect([...HANDLED_EVENTS].sort()).toEqual(
      eventNames.filter((name) => !unhandledEvents.includes(name)).sort(),
    );
    expect(HANDLED_EVENTS).toHaveLength(32);
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

  it("12. halts with UNKNOWN_INSTRUCTION on its own instance's handover until T063d.2", async () => {
    const scenario = await custodyHistory();
    const sponsor = await syntheticSigner(97);
    const other = async (n: number) => (await syntheticSigner(n)).address;
    const handover = thetisTransaction({
      signature: syntheticSignature(254),
      feePayer: sponsor.address,
      name: "Handover",
      events: [],
      instruction: getHandoverInstruction({
        sponsor,
        protocol: scenario.protocol as Address,
        shipment: scenario.shipments.s2 as Address,
        batch: scenario.batches.b2 as Address,
        lot: scenario.lot as Address,
        fromOrg: scenario.org("kopano") as Address,
        fromAuthority: await other(96),
        toOrg: scenario.org("mosela") as Address,
        toAuthority: await other(95),
        sourceClass: scenario.classes.kopano as Address,
        destinationClass: scenario.classes.port as Address,
        departureDocument: scenario.document as Address,
        handover: await other(94),
        manifestDigest: new Uint8Array(32).fill(0x66),
        expectedSequence: 0n,
        validUntil: 1_800_000_000n,
      }),
    });
    const slot = lastSlot(scenario.history) + 1000;
    scenario.history.push({ slot, blockTime: null, transactions: [handover], accounts: {} });
    const h = await harness(scenario.history);
    await expectHalt(h, await h.poll(), "UNKNOWN_INSTRUCTION", {
      step: "decode",
      signature: handover.signature,
      mentions: ["Handover", "not handled"],
    });
    expect((await h.checkpoint())?.indexedThroughSlot).toBe(slot - 1000);
  });

  it("12. halts with UNKNOWN_INSTRUCTION on its own instance's record_observation until it is handled", async () => {
    const scenario = await custodyHistory();
    const sponsor = await syntheticSigner(97);
    const other = async (n: number) => (await syntheticSigner(n)).address;
    const observation = thetisTransaction({
      signature: syntheticSignature(254),
      feePayer: sponsor.address,
      name: "RecordObservation",
      events: [],
      instruction: getRecordObservationInstruction({
        sponsor,
        protocol: scenario.protocol as Address,
        observerOrg: scenario.org("port-t1") as Address,
        observerAuthority: await other(96),
        holderOrg: scenario.org("kopano") as Address,
        shipment: scenario.shipments.s2 as Address,
        batch: scenario.batches.b2 as Address,
        lot: scenario.lot as Address,
        kind: ObservationKind.Checkpoint,
        locationCode: "CHECKPOINT-1",
        evidenceDigest: new Uint8Array(32).fill(0x77),
        observedAt: 1_795_000_000n,
        expectedObservation: 0,
        validUntil: 1_800_000_000n,
      }),
    });
    const slot = lastSlot(scenario.history) + 1000;
    scenario.history.push({ slot, blockTime: null, transactions: [observation], accounts: {} });
    const h = await harness(scenario.history);
    await expectHalt(h, await h.poll(), "UNKNOWN_INSTRUCTION", {
      step: "decode",
      signature: observation.signature,
      mentions: ["RecordObservation", "not handled"],
    });
    expect((await h.checkpoint())?.indexedThroughSlot).toBe(slot - 1000);
  });
});
