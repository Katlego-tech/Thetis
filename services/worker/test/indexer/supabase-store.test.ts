// supabaseStore against the local Supabase (started by `supabase start`; CI starts it before
// `pnpm test`). Writes as `postgres` (deleting the checkpoint, wiping the read model) go through
// psql inside the local database container, because no API role may write these tables.

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getBase58Decoder } from "@solana/kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StoreCodeError } from "../../src/indexer/errors.ts";
import { type memoryStore, type ReadModelStore, supabaseStore } from "../../src/indexer/store.ts";
import { custodyHistory } from "../fixtures/custody.ts";
import { counts, eventKeys, harness, rows } from "../fixtures/harness.ts";
import { mergeHistories, simulationSeed } from "../fixtures/instances.ts";
import {
  fixture,
  lendingHistory,
  lotHistory,
  PROGRAM,
  seedHistory,
  seedOrganisations,
  syntheticSignature,
} from "../fixtures/synthetic.ts";

const projectRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const projectId = /^project_id\s*=\s*"([^"]+)"/m.exec(
  readFileSync(`${projectRoot}supabase/config.toml`, "utf8"),
)?.[1];
const TABLES = [
  "chain_events",
  "chain_transactions",
  "chain_protocols",
  "chain_class_policies",
  "chain_organisations",
  "chain_authorities",
  "chain_custodian_classes",
  "chain_documents",
  "chain_intakes",
  "chain_lots",
  "chain_positions",
  "indexer_checkpoints",
];

function localSupabase() {
  const result = spawnSync("supabase", ["status", "-o", "env"], {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 15_000,
  });
  if (result.status !== 0) {
    throw new Error("Could not read local Supabase credentials: start Supabase (supabase start).");
  }
  const value = (name: string) => {
    const line = result.stdout.split(/\r?\n/).find((entry) => entry.startsWith(`${name}=`));
    const found = line?.slice(name.length + 1).replace(/^(["'])(.*)\1$/, "$2");
    if (!found) throw new Error(`Missing ${name} in supabase status -o env`);
    return found;
  };
  const url = value("API_URL");
  const host = new URL(url).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error(`refusing a non-local Supabase URL: ${url}`);
  }
  return { url, key: value("SERVICE_ROLE_KEY") };
}

function asPostgres(sql: string): string {
  if (!projectId) throw new Error("supabase/config.toml has no project_id");
  return execFileSync(
    "docker",
    [
      "exec",
      "-i",
      `supabase_db_${projectId}`,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-qAt",
      "-c",
      sql,
    ],
    { encoding: "utf8", timeout: 30_000 },
  ).trim();
}

function wipe() {
  asPostgres(`begin; ${TABLES.map((table) => `delete from public.${table};`).join(" ")} commit;`);
}

function sqlCounts() {
  const names = TABLES.filter((table) => table !== "indexer_checkpoints");
  const output = asPostgres(
    `select ${names.map((table) => `(select count(*) from public.${table})`).join(", ")}`,
  );
  const values = output.split("|").map(Number);
  return Object.fromEntries(names.map((table, index) => [table, values[index]]));
}

/** SYNTHETIC: distinct base58 values of `size` bytes, all 180 except a two-byte counter. */
function syntheticKeys(count: number, size: 32 | 64, start = 0) {
  return Array.from({ length: count }, (_, i) => {
    const bytes = new Uint8Array(size).fill(180);
    bytes[size - 2] = Math.floor((start + i) / 256);
    bytes[size - 1] = (start + i) % 256;
    return getBase58Decoder().decode(bytes);
  });
}

/** The Phase 2 tables, wiped by the lending test itself (TABLES feeds sqlCounts). */
const LENDING_TABLES = [
  "chain_pool_shares",
  "chain_pools",
  "chain_payments",
  "chain_release_intents",
  "chain_locks",
  "chain_loans",
  "chain_valuations",
  "chain_facilities",
];

function wipeLending() {
  asPostgres(
    `begin; ${LENDING_TABLES.map((table) => `delete from public.${table};`).join(" ")} commit;`,
  );
}

/** The Phase 3 tables, wiped by the custody test itself (TABLES feeds sqlCounts). */
const CUSTODY_TABLES = ["chain_batches", "chain_shipments"];

function wipeCustody() {
  asPostgres(
    `begin; ${CUSTODY_TABLES.map((table) => `delete from public.${table};`).join(" ")} commit;`,
  );
}

function lendingCounts() {
  const output = asPostgres(
    `select ${LENDING_TABLES.map((table) => `(select count(*) from public.${table})`).join(", ")}`,
  );
  const values = output.split("|").map(Number);
  return Object.fromEntries(LENDING_TABLES.map((table, index) => [table, values[index]]));
}

let local: { url: string; key: string };

beforeAll(() => {
  local = localSupabase();
  wipe();
});

afterAll(() => {
  if (local) wipe();
});

describe("supabaseStore", () => {
  it("supabaseStore replays the seed and lot histories twice on the local Supabase and reports SQL codes", async () => {
    const f = await fixture();

    // The same replay on memoryStore is the reference.
    const reference = await harness(await lotHistory());
    await reference.pollUntilLive();
    (reference.store as ReturnType<typeof memoryStore>).deleteCheckpoint();
    reference.restart();
    await reference.pollUntilLive();
    const expected = counts(reference.store);

    const store: ReadModelStore = supabaseStore(local.url, local.key);
    const h = await harness(await lotHistory(), {
      store,
      organisations: await seedOrganisations(),
    });
    const first = await h.pollUntilLive();
    expect(first.indexedThroughSlot).toBe(15_000);
    const afterFirst = sqlCounts();
    expect(afterFirst).toEqual(expected);

    asPostgres("delete from public.indexer_checkpoints");
    expect(await store.checkpoint(h.stream)).toBeNull();
    h.restart();
    const second = await h.pollUntilLive();
    expect(second.indexedThroughSlot).toBe(15_000);
    expect(sqlCounts()).toEqual(afterFirst);
    expect(
      asPostgres(
        "select string_agg(lot || ':' || lot_revision, ',' order by lot || ':' || lot_revision) from public.chain_events where lot is not null",
      ).split(","),
    ).toEqual(eventKeys(reference.store));

    const projections = await store.projections(h.stream);
    expect(projections.chain_lots.get(f.child)).toMatchObject({
      event_revision: "1",
      supply_kg: "500000",
    });
    expect(projections.chain_organisations.size).toBe(7);

    // storedSignatures reads more than one 100-key chunk and returns exactly the stored ones.
    const stored = [...h.chain.calls]
      .filter(({ method }) => method === "getTransaction")
      .map(({ args }) => String(args[0]));
    const unknown = syntheticKeys(135, 64);
    const known = [...new Set(stored)];
    expect(known.length).toBeGreaterThanOrEqual(14);
    const found = await store.storedSignatures(h.stream, [...unknown, ...known]);
    expect([...found].sort()).toEqual([...known].sort());

    // A repeated (lot, lot_revision) under another signature is REVISION_SEQUENCE, with the lot
    // named in the detail; a stale cursor is CURSOR_MOVED.
    const blockTime = "2026-11-26T00:01:00.000Z";
    const signature = syntheticSignature(170);
    const transaction = {
      network: "devnet",
      program_id: PROGRAM,
      signature,
      slot: 15_001,
      block_time: blockTime,
      succeeded: true,
      protocol: f.protocol,
      event_count: 1,
      other_instance: false,
    };
    const event = {
      network: "devnet",
      program_id: PROGRAM,
      signature,
      event_index: 0,
      slot: 15_001,
      block_time: blockTime,
      protocol: f.protocol,
      instruction: "Transfer",
      event: "UnitsTransferred",
      scope: "lot",
      lot: f.lot,
      lot_revision: "1",
      org_id: null,
      facility: null,
      loan: null,
      loan_revision: null,
      pool: null,
      pool_revision: null,
      valuation: null,
      valuation_version: null,
      created: null,
      shipment: null,
      shipment_revision: null,
      batch: null,
      batch_sequence: null,
      observation_index: null,
      acceptance: null,
      acceptance_version: null,
      data: {
        lot: f.lot,
        from: f.org("khunou"),
        to: f.org("buyer-smelter"),
        quantityKg: "1",
        revision: "1",
      },
    };
    const batch = {
      stream: h.stream,
      expectedThroughSlot: 15_000,
      throughSlot: 15_001,
      transactions: [transaction],
      events: [event],
      upserts: [],
    };
    const repeat = await store.apply(batch).then(
      () => null,
      (error: unknown) => error,
    );
    expect(repeat).toBeInstanceOf(StoreCodeError);
    expect(repeat).toMatchObject({
      code: "REVISION_SEQUENCE",
      detail: expect.stringContaining(f.lot),
    });
    await expect(store.apply({ ...batch, expectedThroughSlot: 14_000 })).rejects.toMatchObject({
      code: "CURSOR_MOVED",
    });
    expect(sqlCounts()).toEqual(afterFirst);

    // One batch of 1,001 authorities; projections pages past 1,000 rows.
    const wallets = syntheticKeys(1001, 32);
    const addresses = syntheticKeys(1001, 32, 2000);
    const upserts = addresses.map((address, i) => ({
      table: "chain_authorities" as const,
      row: {
        network: "devnet",
        address,
        protocol: f.protocol,
        slot: 15_001,
        commitment: "confirmed",
        last_signature: signature,
        organisation: f.org("khunou"),
        org_id: "11000000-0000-4000-8000-000000000001",
        wallet: wallets[i] as string,
        scopes: 1,
        expires_at: "1800000000",
        revoked_at: null,
      },
    }));
    await store.apply({
      ...batch,
      transactions: [{ ...transaction, event_count: 0 }],
      events: [],
      upserts,
    });
    const paged = await store.projections(h.stream);
    expect(paged.chain_authorities.size).toBe(1001);
    expect(paged.chain_lots.size).toBe(2);
    expect((await store.checkpoint(h.stream))?.indexedThroughSlot).toBe(15_001);
  }, 120_000);

  it("supabaseStore records another instance's transactions as other-instance on the local Supabase", async () => {
    wipe();
    const history = async () => mergeHistories(await seedHistory(), await simulationSeed());
    const reference = await harness(await history());
    await reference.pollUntilLive();
    const expected = counts(reference.store);

    const store: ReadModelStore = supabaseStore(local.url, local.key);
    const h = await harness(await history(), { store, organisations: await seedOrganisations() });
    const first = await h.pollUntilLive();
    expect(first.indexedThroughSlot).toBe(12_000);
    const afterFirst = sqlCounts();
    expect(afterFirst).toEqual(expected);
    const split = () =>
      asPostgres(
        "select count(*) filter (where other_instance), count(*) filter (where not other_instance and protocol is not null), count(*) filter (where not other_instance and protocol is null) from public.chain_transactions",
      );
    expect(split()).toBe("10|9|1");
    expect(
      asPostgres(
        "select count(*) from public.chain_transactions where other_instance and (protocol is not null or event_count <> 0 or not succeeded)",
      ),
    ).toBe("0");

    asPostgres("delete from public.indexer_checkpoints");
    h.restart();
    const second = await h.pollUntilLive();
    expect(second.indexedThroughSlot).toBe(12_000);
    expect(sqlCounts()).toEqual(afterFirst);
    expect(split()).toBe("10|9|1");
  }, 120_000);

  it("supabaseStore applies the lending history and reports REVISION_SEQUENCE for a repeated loan revision on the local Supabase", async () => {
    wipe();
    wipeLending();
    try {
      const reference = await harness((await lendingHistory()).history);
      await reference.pollUntilLive();
      const expected = counts(reference.store);
      const expectedLending = Object.fromEntries(
        LENDING_TABLES.map((table) => [table, rows(reference.store, table).length]),
      );

      const scenario = await lendingHistory();
      const store: ReadModelStore = supabaseStore(local.url, local.key);
      const h = await harness(scenario.history, {
        store,
        organisations: await seedOrganisations(),
      });
      const first = await h.pollUntilLive();
      const last = scenario.steps.correctRepayment?.slot as number;
      expect(first.indexedThroughSlot).toBe(last);
      expect(sqlCounts()).toEqual(expected);
      expect(lendingCounts()).toEqual(expectedLending);
      expect(
        asPostgres(
          `select string_agg(loan_revision, ',' order by loan_revision::numeric) from public.chain_events where loan = '${scenario.loan}' and loan_revision is not null`,
        ),
      ).toBe("0,1,2,3,4,5");
      expect(
        asPostgres(
          `select status || '|' || event_revision || '|' || commitment from public.chain_loans where address = '${scenario.loan}'`,
        ),
      ).toBe("Closed|5|finalized");

      // Replaying after the checkpoint is deleted writes nothing twice.
      asPostgres("delete from public.indexer_checkpoints");
      h.restart();
      await h.pollUntilLive();
      expect(sqlCounts()).toEqual(expected);
      expect(lendingCounts()).toEqual(expectedLending);

      // Another signature repeating (loan, 1) is REVISION_SEQUENCE, with the loan named.
      const blockTime = "2026-11-27T01:00:00.000Z";
      const signature = syntheticSignature(171);
      const batch = {
        stream: h.stream,
        expectedThroughSlot: last,
        throughSlot: last + 1,
        transactions: [
          {
            network: "devnet",
            program_id: PROGRAM,
            signature,
            slot: last + 1,
            block_time: blockTime,
            succeeded: true,
            protocol: scenario.protocol,
            event_count: 1,
            other_instance: false,
          },
        ],
        events: [
          {
            network: "devnet",
            program_id: PROGRAM,
            signature,
            event_index: 0,
            slot: last + 1,
            block_time: blockTime,
            protocol: scenario.protocol,
            instruction: "RecordAdvance",
            event: "AdvanceRecorded",
            scope: "facility",
            lot: null,
            lot_revision: null,
            org_id: null,
            facility: scenario.facility,
            loan: scenario.loan,
            loan_revision: "1",
            pool: null,
            pool_revision: null,
            valuation: null,
            valuation_version: null,
            created: null,
            shipment: null,
            shipment_revision: null,
            batch: null,
            batch_sequence: null,
            observation_index: null,
            acceptance: null,
            acceptance_version: null,
            data: { loan: scenario.loan, revision: "1" },
          },
        ],
        upserts: [],
      };
      await expect(store.apply(batch)).rejects.toMatchObject({
        code: "REVISION_SEQUENCE",
        detail: expect.stringContaining(scenario.loan),
      });
      expect(sqlCounts()).toEqual(expected);
      expect((await store.checkpoint(h.stream))?.indexedThroughSlot).toBe(last);
    } finally {
      wipeLending();
    }
  }, 120_000);
  it("supabaseStore applies the shipment history, reads intents by position, and reports REVISION_SEQUENCE for a repeated shipment revision on the local Supabase", async () => {
    wipe();
    wipeLending();
    wipeCustody();
    try {
      const reference = await harness((await custodyHistory({ secondIntent: true })).history);
      await reference.pollUntilLive();
      const expected = counts(reference.store);
      const tables = [...LENDING_TABLES, ...CUSTODY_TABLES];
      const expectedRows = Object.fromEntries(
        tables.map((table) => [table, rows(reference.store, table).length]),
      );
      const tableCounts = () => {
        const output = asPostgres(
          `select ${tables.map((table) => `(select count(*) from public.${table})`).join(", ")}`,
        );
        const values = output.split("|").map(Number);
        return Object.fromEntries(tables.map((table, index) => [table, values[index]]));
      };

      const scenario = await custodyHistory({ secondIntent: true });
      const store: ReadModelStore = supabaseStore(local.url, local.key);
      const h = await harness(scenario.history, {
        store,
        organisations: await seedOrganisations(),
      });
      const first = await h.pollUntilLive();
      const last = scenario.steps.registerB2?.slot as number;
      expect(first.indexedThroughSlot).toBe(last);
      expect(sqlCounts()).toEqual(expected);
      expect(tableCounts()).toEqual(expectedRows);
      expect(
        asPostgres(
          `select string_agg(shipment || ':' || shipment_revision, ',' order by shipment_revision::numeric, shipment) from public.chain_events where shipment = '${scenario.shipments.s1}' and shipment_revision is not null`,
        ),
      ).toBe(`${scenario.shipments.s1}:0,${scenario.shipments.s1}:1`);
      expect(
        asPostgres(
          `select status || '|' || event_revision || '|' || event_registered || '|' || commitment from public.chain_shipments where address = '${scenario.shipments.s1}'`,
        ),
      ).toBe("Cancelled|1|1|finalized");
      expect(
        asPostgres(
          `select subject_address from public.chain_documents where address = '${scenario.document}'`,
        ),
      ).toBe(scenario.lot);

      // rowsByColumn reads both intents of the position, keyed by address, with their marks.
      const [intent1, intent2] = scenario.intents as [string, string];
      const read = await store.rowsByColumn(h.stream, "chain_release_intents", "position", [
        scenario.position,
        scenario.lot,
      ]);
      expect([...read.keys()].sort()).toEqual([intent1, intent2].sort());
      expect(read.get(intent1)).toMatchObject({
        position: scenario.position,
        cancelled_by: scenario.shipments.s1,
      });
      expect(read.get(intent2)).toMatchObject({ position: scenario.position, cancelled_by: null });
      expect(
        (await store.rowsByColumn(h.stream, "chain_release_intents", "position", [])).size,
      ).toBe(0);

      // Replaying after the checkpoint is deleted writes nothing twice.
      asPostgres("delete from public.indexer_checkpoints");
      h.restart();
      await h.pollUntilLive();
      expect(sqlCounts()).toEqual(expected);
      expect(tableCounts()).toEqual(expectedRows);

      // Another signature repeating (S1, 1) is REVISION_SEQUENCE, with the shipment named.
      const blockTime = "2026-11-28T01:00:00.000Z";
      const signature = syntheticSignature(272);
      const batch = {
        stream: h.stream,
        expectedThroughSlot: last,
        throughSlot: last + 1,
        transactions: [
          {
            network: "devnet",
            program_id: PROGRAM,
            signature,
            slot: last + 1,
            block_time: blockTime,
            succeeded: true,
            protocol: scenario.protocol,
            event_count: 1,
            other_instance: false,
          },
        ],
        events: [
          {
            network: "devnet",
            program_id: PROGRAM,
            signature,
            event_index: 0,
            slot: last + 1,
            block_time: blockTime,
            protocol: scenario.protocol,
            instruction: "CancelShipment",
            event: "ShipmentCancelled",
            scope: "lot",
            lot: scenario.lot,
            lot_revision: "4",
            org_id: null,
            facility: null,
            loan: null,
            loan_revision: null,
            pool: null,
            pool_revision: null,
            valuation: null,
            valuation_version: null,
            created: null,
            shipment: scenario.shipments.s1,
            shipment_revision: "1",
            batch: null,
            batch_sequence: null,
            observation_index: null,
            acceptance: null,
            acceptance_version: null,
            data: { shipment: scenario.shipments.s1, revision: "1" },
          },
        ],
        upserts: [],
      };
      await expect(store.apply(batch)).rejects.toMatchObject({
        code: "REVISION_SEQUENCE",
        detail: expect.stringContaining(scenario.shipments.s1),
      });
      expect(sqlCounts()).toEqual(expected);
      expect((await store.checkpoint(h.stream))?.indexedThroughSlot).toBe(last);
    } finally {
      wipeCustody();
      wipeLending();
    }
  }, 120_000);
});
