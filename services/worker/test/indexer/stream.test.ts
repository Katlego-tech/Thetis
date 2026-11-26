import { describe, expect, it } from "vitest";
import { memoryStore, type ReadModelStore } from "../../src/indexer/store.ts";
import { counts, expectHalt, harness, POLL_MS, rows } from "../fixtures/harness.ts";
import {
  editEvent,
  fixture,
  lotHistory,
  seedHistory,
  seedOrganisations,
  transactionOf,
} from "../fixtures/synthetic.ts";

describe("stream", () => {
  it("reloads on CURSOR_MOVED", async () => {
    const memory = memoryStore(await seedOrganisations());
    const history = await seedHistory();
    const other = await harness(history, { store: memory });
    let raced = false;
    // While this worker is in its poll, another worker applies the whole history first.
    const racing: ReadModelStore = new Proxy(memory, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        if (property !== "apply") return value.bind(target);
        return async (batch: Parameters<ReadModelStore["apply"]>[0]) => {
          if (!raced) {
            raced = true;
            await other.pollUntilLive();
          }
          return value.call(target, batch);
        };
      },
    });
    const h = await harness(history, { store: racing });
    expect(await h.poll()).toBe("reloaded");
    expect(h.lines).toContainEqual({
      level: "error",
      code: "STREAM_RELOAD",
      sqlMessage: "CURSOR_MOVED",
    });
    expect(h.indexer.nextDelayMs()).toBe(0);
    expect(await h.poll()).toBe("ok");
    expect(await h.checkpoint()).toMatchObject({ status: "live", indexedThroughSlot: 10_000 });
    expect(counts(memory)).toMatchObject({ chain_transactions: 10, chain_events: 9 });
  });

  it("finalization promotes finalized transactions and events and never a projection row", async () => {
    const f = await fixture();
    const h = await harness(await seedHistory());
    h.chain.setFinalizedSlot(5_000);
    await h.pollUntilLive();
    for (const row of rows(h.store, "chain_transactions")) {
      expect(row.commitment, String(row.signature)).toBe(
        Number(row.slot) <= 5_000 ? "finalized" : "confirmed",
      );
    }
    for (const row of rows(h.store, "chain_events")) {
      expect(row.commitment, String(row.signature)).toBe(
        Number(row.slot) <= 5_000 ? "finalized" : "confirmed",
      );
    }
    // The Protocol row was written by a transaction that is now finalized; only reconcile may
    // promote it, and its read (slot 10,000) is newer than the finalized scan.
    expect(rows(h.store, "chain_protocols")[0]).toMatchObject({
      commitment: "confirmed",
      last_signature: f.seedSignatures.initializeProtocol,
    });
    for (const table of ["chain_protocols", "chain_class_policies", "chain_organisations"]) {
      for (const row of rows(h.store, table)) expect(row.commitment).toBe("confirmed");
    }

    h.chain.setFinalizedSlot(10_000);
    h.chain.setConfirmedSlot(10_000);
    expect(await h.poll()).toBe("ok");
    for (const row of rows(h.store, "chain_transactions")) expect(row.commitment).toBe("finalized");
  });

  it("halts with CONFIRMED_DROPPED on a null status or another outcome", async () => {
    const f = await fixture();
    const dropped = f.seedSignatures.accredit[2] as string;
    const first = await harness(await seedHistory());
    first.chain.setStatus(dropped, null);
    await expectHalt(first, await first.poll(), "CONFIRMED_DROPPED", {
      step: "finalize",
      signature: null,
      mentions: [dropped],
    });

    const second = await harness(await seedHistory());
    second.chain.setStatus(dropped, { slot: 6_000, failed: true, confirmationStatus: "finalized" });
    await expectHalt(second, await second.poll(), "CONFIRMED_DROPPED", {
      step: "finalize",
      signature: null,
      mentions: [dropped],
    });
  });

  it("backs off on RPC errors without changing status", async () => {
    const h = await harness(await seedHistory());
    await h.pollUntilLive();
    expect(h.indexer.nextDelayMs()).toBe(POLL_MS);
    h.chain.failNext("getSlot", 6);
    const delays: number[] = [];
    const errors: unknown[] = [];
    for (let i = 0; i < 6; i += 1) {
      expect(await h.poll()).toBe("failed");
      delays.push(h.indexer.nextDelayMs());
      errors.push(rows(h.store, "indexer_checkpoints")[0]?.consecutive_rpc_errors);
      expect((await h.checkpoint())?.status).toBe("live");
    }
    expect(delays).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
    expect(errors).toEqual([1, 2, 3, 4, 5, 6]);

    expect(await h.poll()).toBe("ok");
    expect(h.indexer.nextDelayMs()).toBe(POLL_MS);
    expect(rows(h.store, "indexer_checkpoints")[0]).toMatchObject({
      consecutive_rpc_errors: 0,
      status: "live",
    });

    // A block time that stays null after every fallback is retried the same way, never a halt.
    const history = await lotHistory();
    const late = history.find((entry) => entry.slot === 11_000);
    if (!late) throw new Error("no slot 11,000");
    late.blockTime = null;
    h.chain.setHistory(history);
    h.chain.setConfirmedSlot(11_000);
    h.chain.setFinalizedSlot(11_000);
    expect(await h.poll()).toBe("failed");
    expect(h.indexer.nextDelayMs()).toBe(5_000);
    expect(await h.checkpoint()).toMatchObject({ status: "live", indexedThroughSlot: 10_000 });
    expect(rows(h.store, "indexer_checkpoints")[0]).toMatchObject({ consecutive_rpc_errors: 1 });
  });

  it("a halted worker logs INDEXER_HALTED every minute and polls again after reset", async () => {
    const f = await fixture();
    const broken = await seedHistory();
    editEvent(transactionOf(broken, f.seedSignatures.registerClass), 0, (bytes) => {
      const edited = bytes.slice();
      edited.fill(0xee, 0, 8);
      return edited;
    });
    const h = await harness(broken);
    expect(await h.poll()).toBe("halted");
    expect(h.halts()).toHaveLength(1);
    expect(h.indexer.nextDelayMs()).toBe(60_000);

    const listings = () => h.chain.calls.filter(({ method }) => method === "getSignatures").length;
    const before = listings();
    for (let minute = 1; minute <= 2; minute += 1) {
      h.advance(60_000);
      expect(await h.poll()).toBe("halted");
      expect(h.halts()).toHaveLength(1 + minute);
      expect(h.indexer.nextDelayMs()).toBe(60_000);
    }
    expect(listings()).toBe(before);
    expect(h.halts().at(-1)).toMatchObject({
      reason: "UNKNOWN_EVENT",
      signature: f.seedSignatures.registerClass,
    });

    // The operator deploys the fix (here: the chain is served correctly) and resets the stream.
    const cleared = await h.store.reset(h.stream);
    expect(cleared).toMatchObject({
      reason: "UNKNOWN_EVENT",
      signature: f.seedSignatures.registerClass,
    });
    expect(counts(h.store)).toMatchObject({
      chain_transactions: 0,
      chain_events: 0,
      chain_protocols: 0,
    });
    h.chain.setHistory(await seedHistory());
    h.advance(60_000);
    const checkpoint = await h.pollUntilLive();
    expect(checkpoint.indexedThroughSlot).toBe(10_000);
    expect(counts(h.store)).toMatchObject({
      chain_transactions: 10,
      chain_events: 9,
      chain_organisations: 7,
    });
    // Reconcile is due again after a reset, so the rebuilt rows are promoted in the same poll.
    for (const row of rows(h.store, "chain_organisations"))
      expect(row.commitment).toBe("finalized");
  });
});
