// Test harness: one indexer over a fake chain and a store, with a controllable clock and the
// JSON log lines it writes. Everything it passes in is synthetic (see synthetic.ts).

import { expect } from "vitest";
import { parseConfig } from "../../src/indexer/config.ts";
import { createIndexer } from "../../src/indexer/loop.ts";
import { memoryStore, type ReadModelStore, type Stream } from "../../src/indexer/store.ts";
import {
  type FakeChain,
  fakeChain,
  fixture,
  type History,
  PROGRAM,
  seedOrganisations,
} from "./synthetic.ts";

export const RECONCILE_MS = 60_000;
export const POLL_MS = 5_000;

export async function indexerEnv(overrides: Record<string, string | undefined> = {}) {
  const f = await fixture();
  return {
    THETIS_INDEXER: "on",
    THETIS_NETWORK: "devnet",
    THETIS_RPC_URL: "https://rpc.synthetic.invalid",
    THETIS_PROGRAM_ID: PROGRAM,
    THETIS_PROTOCOL: f.protocol,
    THETIS_FIRST_SIGNATURE: f.seedSignatures.deploy,
    SUPABASE_URL: "http://127.0.0.1:54321",
    SUPABASE_SERVICE_ROLE_KEY: "synthetic-service-role-key",
    INDEXER_POLL_MS: String(POLL_MS),
    INDEXER_RECONCILE_MS: String(RECONCILE_MS),
    ...overrides,
  };
}

export type Line = Record<string, unknown>;

export type Harness = Awaited<ReturnType<typeof harness>>;

export async function harness(
  history: History,
  options: {
    env?: Record<string, string | undefined>;
    store?: ReadModelStore;
    chain?: FakeChain;
    organisations?: { id: string; slug: string; synthetic: boolean }[];
  } = {},
) {
  const f = await fixture();
  const organisations = options.organisations ?? (await seedOrganisations());
  const store = options.store ?? memoryStore(organisations);
  const chain = options.chain ?? fakeChain(history);
  const config = parseConfig(await indexerEnv(options.env));
  if (!config) throw new Error("parseConfig returned null with THETIS_INDEXER=on");
  let time = Date.parse("2026-11-26T12:00:00Z");
  const lines: Line[] = [];
  const deps = {
    chain,
    store,
    config,
    now: () => new Date(time),
    log: (line: object) => {
      lines.push(JSON.parse(JSON.stringify(line)) as Line);
    },
  };
  const stream: Stream = { network: "devnet", programId: PROGRAM, protocol: f.protocol };
  const h = {
    f,
    chain,
    store,
    config,
    deps,
    lines,
    stream,
    organisations,
    indexer: createIndexer(deps),
    advance(ms: number) {
      time += ms;
    },
    /** A new indexer on the same chain and store (a restarted worker). */
    restart() {
      h.indexer = createIndexer(deps);
      return h.indexer;
    },
    async poll() {
      return h.indexer.runPoll();
    },
    /** Polls until a poll returns "ok" with the stream live, at most `max` polls. */
    async pollUntilLive(max = 5) {
      for (let i = 0; i < max; i += 1) {
        const result = await h.indexer.runPoll();
        const checkpoint = await store.checkpoint(stream);
        if (result === "ok" && checkpoint?.status === "live") return checkpoint;
        if (result === "halted") throw new Error(`halted: ${JSON.stringify(checkpoint?.halt)}`);
      }
      throw new Error(`not live after ${max} polls`);
    },
    async checkpoint() {
      return store.checkpoint(stream);
    },
    halts() {
      return lines.filter((line) => line.code === "INDEXER_HALTED");
    },
    polls() {
      return lines.filter((line) => line.code === "INDEXER_POLL");
    },
  };
  return h;
}

/** The rows of a table of a memoryStore. */
export function rows(store: ReadModelStore, table: string) {
  return (store as ReturnType<typeof memoryStore>).rows(table);
}

export function counts(store: ReadModelStore) {
  const tables = [
    "chain_transactions",
    "chain_events",
    "chain_protocols",
    "chain_class_policies",
    "chain_organisations",
    "chain_authorities",
    "chain_custodian_classes",
    "chain_documents",
    "chain_intakes",
    "chain_lots",
    "chain_positions",
  ];
  return Object.fromEntries(tables.map((table) => [table, rows(store, table).length]));
}

/** Asserts the stream halted once with this reason and returns the halt as stored and logged. */
export async function expectHalt(
  h: Harness,
  result: string,
  reason: string,
  expected: { step: string; signature: string | null; mentions?: string[] },
) {
  expect(result).toBe("halted");
  const checkpoint = await h.checkpoint();
  expect(checkpoint?.status).toBe("halted");
  expect(checkpoint?.halt?.reason).toBe(reason);
  expect(checkpoint?.halt?.signature).toBe(expected.signature);
  const detail = checkpoint?.halt?.detail ?? "";
  expect(detail.startsWith(`${expected.step}: `), detail).toBe(true);
  for (const text of expected.mentions ?? []) expect(detail).toContain(text);
  const [row] = rows(h.store, "indexer_checkpoints");
  expect(row).toMatchObject({
    status: "halted",
    halt_reason: reason,
    halted_signature: expected.signature,
    halt_detail: detail,
  });
  expect(h.halts().at(-1)).toEqual({
    level: "error",
    code: "INDEXER_HALTED",
    reason,
    signature: expected.signature,
    detail,
  });
  return checkpoint;
}

export function eventKeys(store: ReadModelStore) {
  return rows(store, "chain_events")
    .filter((row) => row.lot !== null)
    .map((row) => `${row.lot}:${row.lot_revision}`)
    .sort();
}
