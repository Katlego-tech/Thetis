import { describe, expect, it } from "vitest";
import { expectHalt, harness, rows } from "../fixtures/harness.ts";
import {
  cloneHistory,
  concatBytes,
  editEvent,
  eventLine,
  eventLines,
  fixture,
  type History,
  lotBlockTime,
  lotHistory,
  MEMO_PROGRAM,
  PROGRAM,
  SYSTEM_PROGRAM,
  seedHistory,
  slotOf,
  syntheticSignature,
  transactionOf,
} from "../fixtures/synthetic.ts";

async function seedUpTo(slot: number): Promise<History> {
  return (await lotHistory()).filter((entry) => entry.slot <= slot);
}

/** The stream applied nothing from the halted slot: cursor before it, its transactions absent. */
async function expectNothingFrom(
  h: Awaited<ReturnType<typeof harness>>,
  slot: number,
  signature: string,
) {
  const checkpoint = await h.checkpoint();
  expect(checkpoint?.indexedThroughSlot ?? -1).toBeLessThan(slot);
  expect(rows(h.store, "chain_transactions").map((row) => row.signature)).not.toContain(signature);
}

describe("D35 halts on what the indexer does not recognise", () => {
  it("halts with UNKNOWN_EVENT on an unknown discriminator, and on FacilityOpened inside RegisterClass", async () => {
    const f = await fixture();
    const signature = f.seedSignatures.registerClass;

    const unknown = await seedHistory();
    editEvent(transactionOf(unknown, signature), 0, (bytes) => {
      const edited = bytes.slice();
      edited.fill(0xee, 0, 8);
      return edited;
    });
    const first = await harness(unknown);
    await expectHalt(first, await first.poll(), "UNKNOWN_EVENT", {
      step: "decode",
      signature,
      mentions: [signature],
    });
    await expectNothingFrom(first, 3000, signature);
    expect((await first.checkpoint())?.indexedThroughSlot).toBe(2000);

    const facility = await seedHistory();
    const tx = transactionOf(facility, signature);
    tx.logs = (tx.logs ?? []).map((line) =>
      line.startsWith("Program data: ") ? eventLine(f.build.facilityOpenedEvent()) : line,
    );
    const second = await harness(facility);
    await expectHalt(second, await second.poll(), "UNKNOWN_EVENT", { step: "decode", signature });
    await expectNothingFrom(second, 3000, signature);
  });

  it("halts with UNKNOWN_INSTRUCTION on an unknown discriminator, and on OpenFacility", async () => {
    const f = await fixture();
    const signature = f.seedSignatures.registerClass;
    const unknown = await seedHistory();
    const instruction = transactionOf(unknown, signature).instructions[0];
    if (!instruction) throw new Error("no instruction");
    instruction.data.fill(0xee, 0, 8);
    const first = await harness(unknown);
    await expectHalt(first, await first.poll(), "UNKNOWN_INSTRUCTION", {
      step: "decode",
      signature,
    });
    await expectNothingFrom(first, 3000, signature);

    const facility = await seedHistory();
    const open = await f.build.openFacility(syntheticSignature(130));
    facility.push({ slot: 10_500, blockTime: lotBlockTime(0), transactions: [open], accounts: {} });
    const second = await harness(facility);
    await expectHalt(second, await second.poll(), "UNKNOWN_INSTRUCTION", {
      step: "decode",
      signature: open.signature,
    });
    expect((await second.checkpoint())?.indexedThroughSlot).toBe(10_000);
  });

  it("halts with UNKNOWN_ENUM when OrganisationAccredited carries role 8", async () => {
    const f = await fixture();
    const signature = f.seedSignatures.accredit[0] as string;
    const history = await seedHistory();
    editEvent(transactionOf(history, signature), 0, (bytes) => {
      const edited = bytes.slice();
      edited[40] = 8; // discriminator (8) + organisation (32), then the role byte
      return edited;
    });
    const h = await harness(history);
    await expectHalt(h, await h.poll(), "UNKNOWN_ENUM", { step: "decode", signature });
    await expectNothingFrom(h, 4000, signature);
  });

  it("halts with EVENT_DECODE_FAILED on one byte short, one byte extra, and non-canonical base64", async () => {
    const f = await fixture();
    const signature = f.seedSignatures.registerClass;
    const edits: ((history: History) => void)[] = [
      (history) => editEvent(transactionOf(history, signature), 0, (bytes) => bytes.slice(0, -1)),
      (history) =>
        editEvent(transactionOf(history, signature), 0, (bytes) =>
          concatBytes(bytes, new Uint8Array([0])),
        ),
      (history) => {
        const tx = transactionOf(history, signature);
        // ClassRegistered is 44 bytes, so its canonical base64 ends in "="; drop the padding.
        tx.logs = (tx.logs ?? []).map((line) =>
          line.startsWith("Program data: ") ? line.replace(/=+$/, "") : line,
        );
        expect(
          tx.logs.some((line) => line.startsWith("Program data: ") && !line.endsWith("=")),
        ).toBe(true);
      },
    ];
    for (const edit of edits) {
      const history = await seedHistory();
      edit(history);
      const h = await harness(history);
      await expectHalt(h, await h.poll(), "EVENT_DECODE_FAILED", { step: "decode", signature });
      await expectNothingFrom(h, 3000, signature);
    }
  });

  it("halts with EVENT_MISMATCH when IssueLot emits no event", async () => {
    const f = await fixture();
    const history = await seedUpTo(12_000);
    const issue = transactionOf(history, f.lotSignatures.issue);
    issue.logs = (issue.logs ?? []).filter((line) => !line.startsWith("Program data: "));
    const h = await harness(history);
    await expectHalt(h, await h.poll(), "EVENT_MISMATCH", {
      step: "decode",
      signature: issue.signature,
    });
    expect((await h.checkpoint())?.indexedThroughSlot).toBe(11_000);
  });

  it("accepts Pause with no event", async () => {
    const f = await fixture();
    const history = await seedHistory();
    const pause = await f.build.pause(syntheticSignature(131));
    history.push({ slot: 10_500, blockTime: lotBlockTime(0), transactions: [pause], accounts: {} });
    const h = await harness(history);
    await h.pollUntilLive();
    expect(
      rows(h.store, "chain_transactions").find((row) => row.signature === pause.signature),
    ).toMatchObject({
      succeeded: true,
      protocol: f.protocol,
      event_count: 0,
    });
    expect(
      h.chain.calls.filter(
        ({ method, args }) =>
          method === "getMultipleAccounts" && args[1] === "confirmed" && args[2] === 10_500,
      ),
    ).toEqual([]);
  });

  it("halts with TRANSACTION_UNREADABLE on null logs, an unbalanced stack, a CPI invoke and Log truncated", async () => {
    const f = await fixture();
    const signature = f.seedSignatures.registerClass;
    const edits: ((history: History) => void)[] = [
      (history) => {
        transactionOf(history, signature).logs = null;
      },
      (history) => {
        const tx = transactionOf(history, signature);
        tx.logs = (tx.logs ?? []).filter((line) => line !== `Program ${PROGRAM} success`);
      },
      (history) => {
        // Another program calls the Thetis program (a CPI): no top-level Thetis instruction, no
        // inner-instruction record of it, only the logs show the nested invocation.
        const tx = transactionOf(history, signature);
        tx.instructions = [
          { programAddress: MEMO_PROGRAM, accounts: [], data: new Uint8Array([1]) },
        ];
        tx.inner = [];
        tx.logs = [
          `Program ${MEMO_PROGRAM} invoke [1]`,
          `Program ${PROGRAM} invoke [2]`,
          ...eventLines(tx),
          `Program ${PROGRAM} success`,
          `Program ${MEMO_PROGRAM} success`,
        ];
      },
      (history) => {
        const tx = transactionOf(history, signature);
        tx.logs = [...(tx.logs ?? []).slice(0, 3), "Log truncated"];
      },
    ];
    for (const edit of edits) {
      const history = await seedHistory();
      edit(history);
      const h = await harness(history);
      await expectHalt(h, await h.poll(), "TRANSACTION_UNREADABLE", { step: "decode", signature });
      await expectNothingFrom(h, 3000, signature);
    }
  });

  it("halts with REVISION_SEQUENCE when a revision is skipped, and when another transaction repeats one", async () => {
    const f = await fixture();
    const skipped = await seedUpTo(13_000);
    editEvent(transactionOf(skipped, f.lotSignatures.transfer), 0, (bytes) => {
      const edited = bytes.slice();
      // UnitsTransferred: discriminator, lot, from, to (8 + 96), quantity (8), then the revision.
      new DataView(edited.buffer).setBigUint64(112, 2n, true);
      return edited;
    });
    const first = await harness(skipped);
    await expectHalt(first, await first.poll(), "REVISION_SEQUENCE", {
      step: "sequence",
      signature: null,
      mentions: [f.lot, f.lotSignatures.transfer],
    });
    expect((await first.checkpoint())?.indexedThroughSlot).toBe(12_000);

    const repeated = await seedUpTo(13_000);
    const again = await f.build.transfer({
      signature: syntheticSignature(140),
      lot: f.lot,
      mint: f.mint,
      from: f.org("khunou"),
      to: f.org("buyer-smelter"),
      quantityKg: 1n,
      revision: 1n,
    });
    repeated.push({
      slot: 13_500,
      blockTime: lotBlockTime(3),
      transactions: [again],
      accounts: {},
    });
    const second = await harness(repeated);
    await expectHalt(second, await second.poll(), "REVISION_SEQUENCE", {
      step: "sequence",
      signature: null,
      mentions: [f.lot, again.signature],
    });
    expect((await second.checkpoint())?.indexedThroughSlot).toBe(13_000);
    expect(rows(second.store, "chain_events").filter((row) => row.lot === f.lot)).toHaveLength(2);
  });

  it("halts with EVENT_GAP when a transfer names an unprojected lot, and when an account it may not create is missing", async () => {
    const f = await fixture();
    const khunou = f.org("khunou");
    const buyer = f.org("buyer-smelter");

    // A transfer of a lot whose issue the indexer never saw.
    const unprojected = await seedUpTo(11_000);
    const ghost = await f.build.transfer({
      signature: syntheticSignature(150),
      lot: f.lot,
      mint: f.mint,
      from: khunou,
      to: buyer,
      quantityKg: 2_000_000n,
      revision: 1n,
    });
    unprojected.push({
      slot: 13_000,
      blockTime: lotBlockTime(2),
      transactions: [ghost],
      accounts: Object.fromEntries([
        await f.build.lotAccount({
          lotId: "CR-0001",
          supplyKg: 5_000_000n,
          revision: 1n,
          liveChildren: 0,
          parent: null,
        }),
        await f.build.position({ lot: f.lot, owner: khunou, quantityKg: 3_000_000n, revision: 1n }),
        await f.build.position({ lot: f.lot, owner: buyer, quantityKg: 2_000_000n, revision: 0n }),
      ]),
    });
    const first = await harness(unprojected);
    await expectHalt(first, await first.poll(), "EVENT_GAP", {
      step: "sequence",
      signature: null,
      mentions: [f.lot],
    });
    expect((await first.checkpoint())?.indexedThroughSlot).toBe(11_000);

    // A transfer from an owner whose Position was never created: Transfer may create only the
    // recipient's Position.
    const missing = await seedUpTo(12_000);
    const fromBuyer = await f.build.transfer({
      signature: syntheticSignature(151),
      lot: f.lot,
      mint: f.mint,
      from: buyer,
      to: khunou,
      quantityKg: 1n,
      revision: 1n,
    });
    missing.push({
      slot: 13_000,
      blockTime: lotBlockTime(2),
      transactions: [fromBuyer],
      accounts: Object.fromEntries([
        await f.build.lotAccount({
          lotId: "CR-0001",
          supplyKg: 5_000_000n,
          revision: 1n,
          liveChildren: 0,
          parent: null,
        }),
        await f.build.position({ lot: f.lot, owner: buyer, quantityKg: 0n, revision: 1n }),
        await f.build.position({ lot: f.lot, owner: khunou, quantityKg: 5_000_000n, revision: 1n }),
      ]),
    });
    const second = await harness(missing);
    await expectHalt(second, await second.poll(), "EVENT_GAP", {
      step: "sequence",
      signature: null,
      mentions: [f.positions.buyerParent],
    });
    expect((await second.checkpoint())?.indexedThroughSlot).toBe(12_000);
  });

  it("halts with ACCOUNT_DECODE_FAILED on a Lot owned by another program, and on the Position discriminator", async () => {
    const f = await fixture();
    const owned = await seedUpTo(12_000);
    const issueSlot = slotOf(owned, f.lotSignatures.issue);
    const lot = issueSlot.accounts[f.lot];
    if (!lot) throw new Error("no lot account");
    issueSlot.accounts[f.lot] = { programAddress: SYSTEM_PROGRAM, data: lot.data };
    const first = await harness(owned);
    await expectHalt(first, await first.poll(), "ACCOUNT_DECODE_FAILED", {
      step: "fetch",
      signature: null,
      mentions: [f.lot],
    });
    expect((await first.checkpoint())?.indexedThroughSlot).toBe(11_000);

    const wrongKind = await seedUpTo(12_000);
    const slot = slotOf(wrongKind, f.lotSignatures.issue);
    const position = slot.accounts[f.positions.khunouParent];
    const lotAccount = slot.accounts[f.lot];
    if (!position || !lotAccount) throw new Error("missing accounts");
    const data = lotAccount.data.slice();
    data.set(position.data.slice(0, 8), 0); // the Position discriminator on the Lot's address
    slot.accounts[f.lot] = { programAddress: PROGRAM, data };
    const second = await harness(wrongKind);
    await expectHalt(second, await second.poll(), "ACCOUNT_DECODE_FAILED", {
      step: "fetch",
      signature: null,
      mentions: [f.lot],
    });
  });

  it("halts with EVENT_GAP when an account names the all-zero key as its organisation", async () => {
    const f = await fixture();
    const history = await seedUpTo(12_000);
    const issueSlot = slotOf(history, f.lotSignatures.issue);
    const [, zeroOwned] = await f.build.position({
      lot: f.lot,
      owner: SYSTEM_PROGRAM,
      quantityKg: 5_000_000n,
      revision: 0n,
    });
    issueSlot.accounts[f.positions.khunouParent] = zeroOwned;
    const h = await harness(history);
    await expectHalt(h, await h.poll(), "EVENT_GAP", {
      step: "fetch",
      signature: null,
      mentions: [SYSTEM_PROGRAM],
    });
    expect((await h.checkpoint())?.indexedThroughSlot).toBe(11_000);
  });

  it("halts with HISTORY_INCOMPLETE when the listing ends before THETIS_FIRST_SIGNATURE or before the cursor", async () => {
    const pruned = await harness(await seedHistory());
    pruned.chain.setListingFloor(2000); // the provider no longer serves the deploy
    await expectHalt(pruned, await pruned.poll(), "HISTORY_INCOMPLETE", {
      step: "listing",
      signature: null,
    });
    expect(rows(pruned.store, "chain_transactions")).toEqual([]);
    expect((await pruned.checkpoint())?.indexedThroughSlot).toBeNull();

    const anchored = await harness(await seedHistory(), {
      env: { THETIS_FIRST_SIGNATURE: syntheticSignature(160) },
    });
    await expectHalt(anchored, await anchored.poll(), "HISTORY_INCOMPLETE", {
      step: "listing",
      signature: null,
    });
    expect(rows(anchored.store, "chain_transactions")).toEqual([]);

    const h = await harness(cloneHistory(await lotHistory()));
    h.chain.setConfirmedSlot(10_000);
    h.chain.setFinalizedSlot(10_000);
    await h.pollUntilLive();
    h.chain.setConfirmedSlot(15_000);
    h.chain.setListingFloor(12_000); // history between the cursor and 12,000 is gone
    await expectHalt(h, await h.poll(), "HISTORY_INCOMPLETE", { step: "listing", signature: null });
    expect((await h.checkpoint())?.indexedThroughSlot).toBe(10_000);
    expect(rows(h.store, "chain_transactions")).toHaveLength(10);
  });
});
