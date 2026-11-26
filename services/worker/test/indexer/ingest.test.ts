import { getBase58Decoder } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { memoryStore, type ReadModelStore } from "../../src/indexer/store.ts";
import { counts, eventKeys, harness, rows } from "../fixtures/harness.ts";
import {
  COMPUTE_BUDGET,
  cloneHistory,
  eventLines,
  fixture,
  lotBlockTime,
  lotHistory,
  MEMO_PROGRAM,
  otherProgramLogs,
  seedHistory,
  seedOrganisations,
  syntheticSignature,
  transactionOf,
} from "../fixtures/synthetic.ts";

/** Counts every signature the store was asked to write, across successful apply calls. */
function spyingStore(store: ReadModelStore) {
  const written: string[] = [];
  const spy: ReadModelStore = new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      if (property !== "apply") return value.bind(target);
      return async (batch: Parameters<ReadModelStore["apply"]>[0]) => {
        await value.call(target, batch);
        written.push(...batch.transactions.map((row) => String(row.signature)));
      };
    },
  });
  return { spy, written };
}

describe("ingest", () => {
  it("replays the seed twice and writes each transaction and event once", async () => {
    const f = await fixture();
    const memory = memoryStore(await seedOrganisations());
    const { spy, written } = spyingStore(memory);
    const h = await harness(await seedHistory(), { store: spy });
    const first = await h.pollUntilLive();
    expect(written).toHaveLength(10);
    expect(first.indexedThroughSlot).toBe(10_000);
    const before = counts(h.store);
    expect(before).toMatchObject({
      chain_transactions: 10,
      chain_events: 9,
      chain_protocols: 1,
      chain_class_policies: 1,
      chain_organisations: 7,
    });
    memory.deleteCheckpoint();
    expect(await h.checkpoint()).toBeNull();
    const second = await h.pollUntilLive();
    expect(second.indexedThroughSlot).toBe(10_000);
    expect(counts(h.store)).toEqual(before);
    expect(written).toHaveLength(10); // the replay wrote no transaction again

    const transactions = rows(h.store, "chain_transactions");
    expect(new Set(transactions.map((row) => row.signature)).size).toBe(10);
    expect(transactions.find((row) => row.signature === f.seedSignatures.deploy)).toMatchObject({
      slot: 1000,
      succeeded: true,
      protocol: null,
      event_count: 0,
    });
    for (const signature of [
      f.seedSignatures.initializeProtocol,
      f.seedSignatures.registerClass,
      ...f.seedSignatures.accredit,
    ]) {
      expect(transactions.find((row) => row.signature === signature)).toMatchObject({
        succeeded: true,
        protocol: f.protocol,
        event_count: 1,
      });
    }
    const events = rows(h.store, "chain_events");
    expect(new Set(events.map((row) => `${row.signature}:${row.event_index}`)).size).toBe(9);
    expect(events.map((row) => row.event).sort()).toEqual(
      ["ClassRegistered", "ProtocolInitialized", ...Array(7).fill("OrganisationAccredited")].sort(),
    );
    const organisations = rows(h.store, "chain_organisations");
    const seeded = await seedOrganisations();
    expect(organisations.map((row) => row.org_id).sort()).toEqual(
      seeded.map((row) => row.id).sort(),
    );
    for (const row of organisations) {
      expect(row.slug).toBe(seeded.find((party) => party.id === row.org_id)?.slug);
      expect(row.synthetic).toBe(true);
    }
    const accreditedKhunou = events.find(
      (row) =>
        row.event === "OrganisationAccredited" &&
        row.data &&
        (row.data as { organisation: string }).organisation === f.org("khunou"),
    );
    expect(accreditedKhunou).toMatchObject({
      scope: "organisation",
      instruction: "AccreditOrganisation",
      org_id: "11000000-0000-4000-8000-000000000001",
      lot: null,
      lot_revision: null,
      data: { organisation: f.org("khunou"), role: "Exporter" },
    });
    expect(h.polls().at(-1)).toEqual({
      level: "info",
      code: "INDEXER_POLL",
      status: "live",
      indexedThroughSlot: 10_000,
      applied: 0,
    });
  });

  it("one row per (lot, revision) after replaying issue, transfer, split and redeem twice", async () => {
    const f = await fixture();
    const h = await harness(await lotHistory());
    await h.pollUntilLive();
    const before = counts(h.store);
    (h.store as ReturnType<typeof memoryStore>).deleteCheckpoint();
    h.restart();
    await h.pollUntilLive();
    expect(counts(h.store)).toEqual(before);
    expect(before).toMatchObject({
      chain_transactions: 15,
      chain_events: 14,
      chain_custodian_classes: 1,
      chain_intakes: 1,
      chain_lots: 2,
      chain_positions: 3,
    });
    expect(eventKeys(h.store)).toEqual(
      [`${f.lot}:0`, `${f.lot}:1`, `${f.lot}:2`, `${f.child}:1`].sort(),
    );
    const lots = rows(h.store, "chain_lots");
    const parent = lots.find((row) => row.address === f.lot);
    const child = lots.find((row) => row.address === f.child);
    expect(parent).toMatchObject({
      lot_id: "CR-0001",
      supply_kg: "4000000",
      revision: "2",
      event_revision: "2",
      live_children: 1,
      parent: null,
      root: f.lot,
      custodian: f.org("kopano"),
      custodian_org_id: "11000000-0000-4000-8000-000000000002",
      issued_owner: f.org("khunou"),
      issued_owner_org_id: "11000000-0000-4000-8000-000000000001",
      state: "Stored",
      restriction: "Normal",
      grade: "G1",
    });
    expect(child).toMatchObject({
      lot_id: "CR-0001-A",
      supply_kg: "500000",
      revision: "1",
      event_revision: "1",
      parent: f.lot,
      root: f.lot,
      issued_owner: f.org("khunou"),
    });
    expect(Date.parse(String(parent?.issued_at))).toBe(Date.parse(lotBlockTime(1)));
    expect(Date.parse(String(child?.issued_at))).toBe(Date.parse(lotBlockTime(3)));
    const positions = Object.fromEntries(
      rows(h.store, "chain_positions").map((row) => [row.address, row]),
    );
    expect(positions[f.positions.khunouParent]).toMatchObject({
      quantity_kg: "2000000",
      owner_org_id: "11000000-0000-4000-8000-000000000001",
    });
    expect(positions[f.positions.buyerParent]).toMatchObject({
      quantity_kg: "2000000",
      owner_org_id: "11000000-0000-4000-8000-000000000007",
    });
    expect(positions[f.positions.khunouChild]).toMatchObject({
      quantity_kg: "500000",
      lot: f.child,
    });
    expect(rows(h.store, "chain_custodian_classes")[0]).toMatchObject({
      occupied_kg: "4500000",
      approved_capacity_kg: "10000000",
      custodian_org_id: "11000000-0000-4000-8000-000000000002",
    });
    const split = rows(h.store, "chain_events").find((row) => row.event === "LotSplit");
    expect(split).toMatchObject({
      scope: "lot",
      lot: f.lot,
      lot_revision: "2",
      data: { parent: f.lot, child: f.child, quantityKg: "1000000", parentRevision: "2" },
    });
  });

  it("records a failed transaction with an unknown instruction without halting", async () => {
    const f = await fixture();
    const history = await seedHistory();
    const junk = await f.build.failed(syntheticSignature(100));
    history.push({ slot: 10_500, blockTime: lotBlockTime(0), transactions: [junk], accounts: {} });
    const h = await harness(history);
    const checkpoint = await h.pollUntilLive();
    expect(checkpoint.indexedThroughSlot).toBe(10_500);
    expect(
      rows(h.store, "chain_transactions").find((row) => row.signature === junk.signature),
    ).toMatchObject({
      slot: 10_500,
      succeeded: false,
      protocol: null,
      event_count: 0,
    });
    expect(
      h.chain.calls.filter(
        ({ method, args }) => method === "getTransaction" && args[0] === junk.signature,
      ),
    ).toEqual([]);
  });

  it("records a transaction that only names the program without halting", async () => {
    const f = await fixture();
    const history = await seedHistory();
    const naming = await f.build.namesProgramOnly(syntheticSignature(101));
    history.push({
      slot: 10_500,
      blockTime: lotBlockTime(0),
      transactions: [naming],
      accounts: {},
    });
    const h = await harness(history);
    await h.pollUntilLive();
    expect(
      rows(h.store, "chain_transactions").find((row) => row.signature === naming.signature),
    ).toMatchObject({
      succeeded: true,
      protocol: null,
      event_count: 0,
    });
    expect(rows(h.store, "chain_events")).toHaveLength(9);
  });

  it("applies two transfers of one lot in one slot whatever their listed order", async () => {
    const f = await fixture();
    const base = (await lotHistory()).filter((entry) => entry.slot <= 12_000);
    const khunou = f.org("khunou");
    const buyer = f.org("buyer-smelter");
    const first = await f.build.transfer({
      signature: syntheticSignature(110),
      lot: f.lot,
      mint: f.mint,
      from: khunou,
      to: buyer,
      quantityKg: 2_000_000n,
      revision: 1n,
    });
    const second = await f.build.transfer({
      signature: syntheticSignature(111),
      lot: f.lot,
      mint: f.mint,
      from: khunou,
      to: buyer,
      quantityKg: 1_000_000n,
      revision: 2n,
    });
    const after = Object.fromEntries([
      await f.build.lotAccount({
        lotId: "CR-0001",
        supplyKg: 5_000_000n,
        revision: 2n,
        liveChildren: 0,
        parent: null,
      }),
      await f.build.position({ lot: f.lot, owner: khunou, quantityKg: 2_000_000n, revision: 2n }),
      await f.build.position({ lot: f.lot, owner: buyer, quantityKg: 3_000_000n, revision: 1n }),
    ]);
    for (const order of [
      [first, second],
      [second, first],
    ]) {
      const history = cloneHistory(base);
      history.push({
        slot: 13_000,
        blockTime: lotBlockTime(2),
        transactions: order,
        accounts: after,
      });
      const h = await harness(history);
      await h.pollUntilLive();
      expect(eventKeys(h.store)).toEqual([`${f.lot}:0`, `${f.lot}:1`, `${f.lot}:2`].sort());
      expect(rows(h.store, "chain_lots")[0]).toMatchObject({ revision: "2", event_revision: "2" });
      const buyerRow = rows(h.store, "chain_positions").find(
        (row) => row.address === f.positions.buyerParent,
      );
      expect(buyerRow).toMatchObject({ quantity_kg: "3000000", owner: buyer });
      expect(rows(h.store, "chain_positions")).toHaveLength(2);
    }
  });

  it("ignores other programs' instructions and data lines", async () => {
    const f = await fixture();
    const history = await seedHistory();
    const tx = transactionOf(history, f.seedSignatures.registerClass);
    tx.instructions.unshift({
      programAddress: COMPUTE_BUDGET,
      accounts: [],
      data: new Uint8Array([2, 64, 13, 3, 0]),
    });
    tx.inner = tx.inner.map((group) => ({ ...group, index: group.index + 1 }));
    tx.instructions.push({
      programAddress: MEMO_PROGRAM,
      accounts: [],
      data: new TextEncoder().encode("synthetic memo"),
    });
    tx.logs = [
      ...otherProgramLogs(COMPUTE_BUDGET),
      ...(tx.logs ?? []),
      ...otherProgramLogs(MEMO_PROGRAM, [
        "Program data: not-base64-and-not-thetis!",
        "Program data: AAAA",
      ]),
    ];
    const h = await harness(history);
    await h.pollUntilLive();
    expect(rows(h.store, "chain_events")).toHaveLength(9);
    expect(rows(h.store, "chain_events").filter((row) => row.signature === tx.signature)).toEqual([
      expect.objectContaining({
        event: "ClassRegistered",
        event_index: 0,
        instruction: "RegisterClass",
      }),
    ]);
  });

  it("skips a foreign protocol's events and still halts on its unknown discriminator", async () => {
    const f = await fixture();
    const history = await seedHistory();
    const foreign = await f.build.foreignInitializeProtocol(syntheticSignature(120));
    history.push({
      slot: 10_500,
      blockTime: lotBlockTime(0),
      transactions: [foreign],
      accounts: {},
    });
    const h = await harness(history);
    await h.pollUntilLive();
    expect(
      rows(h.store, "chain_transactions").find((row) => row.signature === foreign.signature),
    ).toMatchObject({
      succeeded: true,
      protocol: null,
      event_count: 0,
    });
    expect(rows(h.store, "chain_protocols")).toHaveLength(1);
    expect(rows(h.store, "chain_events")).toHaveLength(9);
    const fetched = h.chain.calls
      .filter(({ method, args }) => method === "getMultipleAccounts" && args[1] === "confirmed")
      .flatMap(({ args }) => args[0] as string[]);
    expect(fetched).not.toContain(
      transactionOf(history, foreign.signature).instructions[0]?.accounts[0]?.address,
    );

    const broken = cloneHistory(history);
    const brokenForeign = transactionOf(broken, foreign.signature);
    brokenForeign.signature = syntheticSignature(121);
    const line = eventLines(brokenForeign)[0] as string;
    const bytes = Buffer.from(line.slice("Program data: ".length), "base64");
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    brokenForeign.logs = (brokenForeign.logs ?? []).map((entry) =>
      entry === line ? `Program data: ${bytes.toString("base64")}` : entry,
    );
    const second = await harness(broken);
    const result = await second.poll();
    expect(result).toBe("halted");
    const checkpoint = await second.checkpoint();
    expect(checkpoint?.halt).toMatchObject({
      reason: "UNKNOWN_EVENT",
      signature: brokenForeign.signature,
    });
    expect(checkpoint?.indexedThroughSlot).toBe(10_000);
  });

  it("an older account read keeps newer account columns and still takes the event revision", async () => {
    const f = await fixture();
    const h = await harness(await lotHistory());
    h.chain.setConfirmedSlot(13_000);
    h.chain.setFinalizedSlot(13_000);
    // The account read for the issue's slot lands on a node that has already seen the split
    // (slot 14,000); every other read returns exactly the slot it asked for.
    h.chain.setAccountReadSlot(({ minContextSlot, head }) =>
      minContextSlot === 12_000 ? 14_000 : (minContextSlot ?? head),
    );
    await h.pollUntilLive();
    const parent = rows(h.store, "chain_lots").find((row) => row.address === f.lot);
    expect(parent).toMatchObject({
      slot: 14_000,
      supply_kg: "4000000",
      revision: "2",
      live_children: 1,
      event_revision: "1",
      issued_owner: f.org("khunou"),
    });
    const khunou = rows(h.store, "chain_positions").find(
      (row) => row.address === f.positions.khunouParent,
    );
    expect(khunou).toMatchObject({ slot: 14_000, quantity_kg: "2000000" });
    const buyer = rows(h.store, "chain_positions").find(
      (row) => row.address === f.positions.buyerParent,
    );
    expect(buyer).toMatchObject({ slot: 13_000, quantity_kg: "2000000" });
    expect(eventKeys(h.store)).toEqual([`${f.lot}:0`, `${f.lot}:1`].sort());
  });

  it("keeps applied slots when the poll fails, and the retry writes nothing twice", async () => {
    const f = await fixture();
    const memory = memoryStore(await seedOrganisations());
    const { spy, written } = spyingStore(memory);
    const h = await harness(await seedHistory(), { store: spy });
    const failing = f.seedSignatures.accredit[1] as string; // slot 5,000
    h.chain.failNext("getTransaction", 1, (args) => args[0] === failing);
    expect(await h.poll()).toBe("failed");
    const afterFailure = await h.checkpoint();
    expect(afterFailure?.indexedThroughSlot).toBe(4_000);
    expect(rows(memory, "chain_transactions")).toHaveLength(4);
    expect(rows(memory, "indexer_checkpoints")[0]).toMatchObject({ consecutive_rpc_errors: 1 });
    expect(h.polls().at(-1)).toMatchObject({
      status: "backfilling",
      indexedThroughSlot: 4_000,
      applied: 4,
    });

    const checkpoint = await h.pollUntilLive();
    expect(checkpoint.indexedThroughSlot).toBe(10_000);
    expect(rows(memory, "chain_transactions")).toHaveLength(10);
    expect(rows(memory, "chain_events")).toHaveLength(9);
    expect(written).toHaveLength(10);
    expect(new Set(written).size).toBe(10);
    expect(rows(memory, "indexer_checkpoints")[0]).toMatchObject({ consecutive_rpc_errors: 0 });
  });

  it("goes live on a poll keeping fewer than 1000 and back to backfilling on 1000", async () => {
    const f = await fixture();
    const seed = await seedHistory();
    const h = await harness(seed);
    expect((await h.pollUntilLive()).status).toBe("live");

    const junk = [...seed];
    let k = 0;
    for (let slot = 10_001; slot <= 10_100; slot += 1) {
      const transactions = [];
      for (let i = 0; i < 10; i += 1) {
        k += 1;
        // 1,000 distinct SYNTHETIC signatures: 64 bytes of 200, the last two the counter.
        const bytes = new Uint8Array(64).fill(200);
        bytes[62] = Math.floor(k / 256);
        bytes[63] = k % 256;
        transactions.push(await f.build.failed(getBase58Decoder().decode(bytes)));
      }
      junk.push({ slot, blockTime: lotBlockTime(0), transactions, accounts: {} });
    }
    expect(k).toBe(1000);
    h.chain.setHistory(junk);
    h.chain.setConfirmedSlot(10_100);
    h.chain.setFinalizedSlot(10_100);
    expect(await h.poll()).toBe("ok");
    expect(await h.checkpoint()).toMatchObject({
      status: "backfilling",
      indexedThroughSlot: 10_100,
    });
    expect(h.polls().at(-1)).toMatchObject({ status: "backfilling", applied: 1000 });
    expect(rows(h.store, "chain_transactions")).toHaveLength(1010);

    expect(await h.poll()).toBe("ok");
    expect(await h.checkpoint()).toMatchObject({ status: "live", indexedThroughSlot: 10_100 });

    // A head past the last transaction moves the cursor with it.
    h.chain.setConfirmedSlot(10_200);
    h.chain.setFinalizedSlot(10_200);
    expect(await h.poll()).toBe("ok");
    expect(await h.checkpoint()).toMatchObject({ status: "live", indexedThroughSlot: 10_200 });
    expect(h.polls().at(-1)).toMatchObject({
      status: "live",
      indexedThroughSlot: 10_200,
      applied: 0,
    });
  });
});
