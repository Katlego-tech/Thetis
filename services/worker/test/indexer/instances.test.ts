import { readFileSync } from "node:fs";
import { ThetisInstruction } from "@thetis/contracts";
import { describe, expect, it } from "vitest";
import { DEFAULT_INSTANCE, SIMULATION_INSTANCE } from "../../../../scripts/seed-demo.ts";
import { type InstructionName, PROTOCOL_ACCOUNT_POSITION } from "../../src/indexer/decode.ts";
import type { memoryStore } from "../../src/indexer/store.ts";
import { counts, expectHalt, harness, rows } from "../fixtures/harness.ts";
import {
  combine,
  initializeProtocol,
  mergeHistories,
  openPool,
  ownPause,
  protocolOf,
  README_FIAT_PROTOCOL,
  README_SIMULATION_PROTOCOL,
  simulationSeed,
} from "../fixtures/instances.ts";
import {
  type FakeTransaction,
  fixture,
  type History,
  lotBlockTime,
  lotHistory,
  seedHistory,
  syntheticSignature,
} from "../fixtures/synthetic.ts";

const IDL = new URL("../../../../packages/contracts/idl/thetis.json", import.meta.url);

type IdlInstruction = { name: string; accounts: { name: string; optional?: boolean }[] };

function pascal(snake: string): string {
  return snake
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/** The seed history with one extra slot after it, holding these transactions. */
async function afterSeed(transactions: FakeTransaction[], slot = 10_500): Promise<History> {
  const history = await seedHistory();
  history.push({ slot, blockTime: lotBlockTime(0), transactions, accounts: {} });
  return history;
}

function fetchedAddresses(h: Awaited<ReturnType<typeof harness>>): string[] {
  return h.chain.calls
    .filter(({ method }) => method === "getMultipleAccounts")
    .flatMap(({ args }) => args[0] as string[]);
}

function transactionRow(h: Awaited<ReturnType<typeof harness>>, signature: string) {
  return rows(h.store, "chain_transactions").find((row) => row.signature === signature);
}

function byKey(list: Record<string, unknown>[], key: (row: Record<string, unknown>) => string) {
  return [...list].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

describe("protocol instances", () => {
  it("the protocol account position of every Thetis instruction matches the IDL", () => {
    const idl = JSON.parse(readFileSync(IDL, "utf8")) as { instructions: IdlInstruction[] };
    const names = Object.keys(ThetisInstruction).filter((key) => !/^[0-9]+$/.test(key));
    expect(Object.keys(PROTOCOL_ACCOUNT_POSITION).sort()).toEqual([...names].sort());
    expect(idl.instructions).toHaveLength(names.length);
    for (const instruction of idl.instructions) {
      const position = instruction.accounts.findIndex((account) => account.name === "protocol");
      expect(position, instruction.name).toBeGreaterThanOrEqual(0);
      expect(
        PROTOCOL_ACCOUNT_POSITION[pascal(instruction.name) as InstructionName],
        instruction.name,
      ).toBe(position);
      for (const [index, account] of instruction.accounts.entries()) {
        if (account.optional)
          expect(index, `${instruction.name}.${account.name}`).toBeGreaterThan(position);
      }
    }
  });

  it("skips another instance's open_pool after the D35 checks and records it as other-instance", async () => {
    const f = await fixture();
    expect(f.protocol).toBe(README_FIAT_PROTOCOL);
    expect(await protocolOf(SIMULATION_INSTANCE)).toBe(README_SIMULATION_PROTOCOL);
    const pool = await openPool(syntheticSignature(190), SIMULATION_INSTANCE);
    const h = await harness(await afterSeed([pool]));
    const checkpoint = await h.pollUntilLive();
    expect(checkpoint.indexedThroughSlot).toBe(10_500);
    expect(checkpoint.halt).toBeNull();
    expect(transactionRow(h, pool.signature)).toMatchObject({
      slot: 10_500,
      succeeded: true,
      protocol: null,
      event_count: 0,
      other_instance: true,
    });
    expect(counts(h.store)).toMatchObject({
      chain_transactions: 11,
      chain_events: 9,
      chain_protocols: 1,
      chain_class_policies: 1,
      chain_organisations: 7,
    });
    const named = new Set(pool.instructions.flatMap((ix) => ix.accounts.map((a) => a.address)));
    expect(fetchedAddresses(h).filter((address) => named.has(address))).toEqual([]);
    for (const row of rows(h.store, "chain_transactions")) {
      if (row.signature !== pool.signature) expect(row.other_instance).toBe(false);
    }

    // OpenPool is handled, so another instance's is parsed too (indexer.md §12.2): data cut to
    // eight bytes no longer parses, and the stream halts before the event line is read.
    const unreadable = await openPool(syntheticSignature(191), SIMULATION_INSTANCE);
    const instruction = unreadable.instructions[0];
    if (!instruction) throw new Error("no instruction");
    instruction.data = instruction.data.slice(0, 8);
    unreadable.logs = (unreadable.logs ?? []).map((line) =>
      line.startsWith("Program data: ")
        ? `Program data: ${Buffer.from(new Uint8Array(12).fill(0xee)).toString("base64")}`
        : line,
    );
    const second = await harness(await afterSeed([unreadable]));
    await expectHalt(second, await second.poll(), "UNKNOWN_INSTRUCTION", {
      step: "decode",
      signature: unreadable.signature,
    });
    expect(transactionRow(second, unreadable.signature)).toBeUndefined();
  });

  it("skips another instance's initialize_protocol and records it as other-instance", async () => {
    const f = await fixture();
    const simulation = await protocolOf(SIMULATION_INSTANCE);
    const init = await initializeProtocol(syntheticSignature(192), SIMULATION_INSTANCE);
    const h = await harness(await afterSeed([init]));
    await h.pollUntilLive();
    expect(transactionRow(h, init.signature)).toMatchObject({
      succeeded: true,
      protocol: null,
      event_count: 0,
      other_instance: true,
    });
    expect(rows(h.store, "chain_protocols").map((row) => row.address)).toEqual([f.protocol]);
    expect(rows(h.store, "chain_events")).toHaveLength(9);
    expect(rows(h.store, "chain_events").map((row) => row.signature)).not.toContain(init.signature);
    expect(fetchedAddresses(h)).not.toContain(simulation);
  });

  it("halts with MIXED_INSTANCE when one transaction mixes its own instance and another", async () => {
    const f = await fixture();
    const simulation = await protocolOf(SIMULATION_INSTANCE);
    const mixed = combine(syntheticSignature(193), [
      await ownPause(syntheticSignature(200)),
      await openPool(syntheticSignature(201), SIMULATION_INSTANCE),
    ]);
    const first = await harness(await afterSeed([mixed]));
    await expectHalt(first, await first.poll(), "MIXED_INSTANCE", {
      step: "decode",
      signature: mixed.signature,
      mentions: [f.protocol, simulation],
    });
    expect((await first.checkpoint())?.indexedThroughSlot).toBe(10_000);
    expect(transactionRow(first, mixed.signature)).toBeUndefined();

    // Its own part is not in the handled list either: the mixed instances still name the halt.
    const unhandled = combine(syntheticSignature(194), [
      await initializeProtocol(syntheticSignature(202), SIMULATION_INSTANCE),
      await openPool(syntheticSignature(203), DEFAULT_INSTANCE),
    ]);
    const second = await harness(await afterSeed([unhandled]));
    await expectHalt(second, await second.poll(), "MIXED_INSTANCE", {
      step: "decode",
      signature: unhandled.signature,
      mentions: [f.protocol, simulation],
    });
  });

  it("halts with UNKNOWN_INSTRUCTION on its own instance's open_pool", async () => {
    const own = await openPool(syntheticSignature(195), DEFAULT_INSTANCE);
    const cut = own.instructions[0];
    if (!cut) throw new Error("no instruction");
    cut.data = cut.data.slice(0, -1);
    const h = await harness(await afterSeed([own]));
    await expectHalt(h, await h.poll(), "UNKNOWN_INSTRUCTION", {
      step: "decode",
      signature: own.signature,
      mentions: ["OpenPool"],
    });
    expect((await h.checkpoint())?.indexedThroughSlot).toBe(10_000);
  });

  it("halts with UNKNOWN_INSTRUCTION when a Thetis instruction has no account at its protocol position", async () => {
    const short = await openPool(syntheticSignature(196), SIMULATION_INSTANCE);
    const instruction = short.instructions[0];
    if (!instruction) throw new Error("no instruction");
    instruction.accounts = instruction.accounts.slice(0, 2);
    const first = await harness(await afterSeed([short]));
    await expectHalt(first, await first.poll(), "UNKNOWN_INSTRUCTION", {
      step: "decode",
      signature: short.signature,
      mentions: ["OpenPool", "position 2"],
    });

    // A discriminator no instruction carries cannot be placed in any instance, even next to an
    // instruction of another instance.
    const unknown = await openPool(syntheticSignature(204), SIMULATION_INSTANCE);
    unknown.instructions[0]?.data.fill(0xee, 0, 8);
    const beside = combine(syntheticSignature(197), [
      await initializeProtocol(syntheticSignature(205), SIMULATION_INSTANCE),
      unknown,
    ]);
    const second = await harness(await afterSeed([beside]));
    await expectHalt(second, await second.poll(), "UNKNOWN_INSTRUCTION", {
      step: "decode",
      signature: beside.signature,
    });
    expect((await second.checkpoint())?.indexedThroughSlot).toBe(10_000);
  });

  it("does not mark a program-listing transaction with no Thetis instruction and null inner instructions as other-instance", async () => {
    const f = await fixture();
    const listing = await f.build.namesProgramOnly(syntheticSignature(198));
    listing.edit = (raw) => ({
      ...raw,
      meta: raw.meta ? { ...raw.meta, innerInstructions: null } : raw.meta,
    });
    const h = await harness(await afterSeed([listing]));
    const checkpoint = await h.pollUntilLive();
    expect(checkpoint.halt).toBeNull();
    expect(checkpoint.indexedThroughSlot).toBe(10_500);
    expect(transactionRow(h, listing.signature)).toMatchObject({
      succeeded: true,
      protocol: null,
      event_count: 0,
      other_instance: false,
    });
  });

  it("replays a history with the token-simulation instance twice and keeps its own rows identical", async () => {
    const reference = await harness(await lotHistory());
    await reference.pollUntilLive();

    const simulation = await simulationSeed();
    const other = simulation.flatMap((entry) => entry.transactions.map((tx) => tx.signature));
    expect(other).toHaveLength(10);
    const h = await harness(mergeHistories(await lotHistory(), simulation));
    const first = await h.pollUntilLive();
    expect(first.indexedThroughSlot).toBe(15_000);

    const expected = counts(reference.store);
    expect(counts(h.store)).toEqual({
      ...expected,
      chain_transactions: (expected.chain_transactions ?? 0) + 10,
    });
    const tables = [
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
    const key = (row: Record<string, unknown>) =>
      `${String(row.address ?? "")}:${String(row.signature ?? "")}:${String(row.event_index ?? "")}`;
    for (const table of tables) {
      expect(byKey(rows(h.store, table), key), table).toEqual(
        byKey(rows(reference.store, table), key),
      );
    }
    const own = rows(h.store, "chain_transactions").filter(
      (row) => !other.includes(String(row.signature)),
    );
    expect(byKey(own, key)).toEqual(byKey(rows(reference.store, "chain_transactions"), key));
    for (const signature of other) {
      expect(transactionRow(h, signature)).toMatchObject({
        succeeded: true,
        protocol: null,
        event_count: 0,
        other_instance: true,
        commitment: "finalized",
      });
    }
    for (const row of own) expect(row.other_instance).toBe(false);

    const before = counts(h.store);
    const fetchedBefore = h.chain.calls.filter(({ method }) => method === "getTransaction").length;
    (h.store as ReturnType<typeof memoryStore>).deleteCheckpoint();
    h.restart();
    const second = await h.pollUntilLive();
    expect(second.indexedThroughSlot).toBe(15_000);
    expect(counts(h.store)).toEqual(before);
    expect(h.chain.calls.filter(({ method }) => method === "getTransaction").length).toBe(
      fetchedBefore,
    );
  });
});
