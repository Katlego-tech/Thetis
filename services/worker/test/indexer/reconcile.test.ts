import { describe, expect, it } from "vitest";
import { expectHalt, harness, RECONCILE_MS, rows } from "../fixtures/harness.ts";
import { fixture, lotHistory, seedHistory, seedOrganisations } from "../fixtures/synthetic.ts";

describe("reconcile", () => {
  it("reconcile promotes rows to finalized and refreshes slugs", async () => {
    const f = await fixture();
    const organisations = await seedOrganisations();
    const h = await harness(await seedHistory(), { organisations });
    await h.pollUntilLive();
    for (const table of ["chain_protocols", "chain_class_policies", "chain_organisations"]) {
      for (const row of rows(h.store, table)) {
        expect(row, table).toMatchObject({
          commitment: "finalized",
          slot: 10_000,
          last_signature: null,
        });
      }
    }
    const khunou = organisations.find((row) => row.slug === "khunou");
    if (!khunou) throw new Error("no khunou");
    khunou.slug = "khunou-renamed";
    khunou.synthetic = false;

    // Not due yet: the slug stays until the interval has passed.
    expect(await h.poll()).toBe("ok");
    const row = () =>
      rows(h.store, "chain_organisations").find((r) => r.address === f.org("khunou"));
    expect(row()).toMatchObject({ slug: "khunou", synthetic: true });

    h.advance(RECONCILE_MS + 1);
    expect(await h.poll()).toBe("ok");
    expect(row()).toMatchObject({
      slug: "khunou-renamed",
      synthetic: false,
      commitment: "finalized",
    });
  });

  it("reconcile halts with EVENT_GAP on a missing row and on a changed account, and with ACCOUNT_VANISHED", async () => {
    const f = await fixture();
    const cases = [
      {
        reason: "EVENT_GAP",
        // A Position appears on chain with no transaction the indexer could see.
        accounts: async () => {
          const [address, account] = await f.build.position({
            lot: f.lot,
            owner: f.org("mosela"),
            quantityKg: 1n,
            revision: 0n,
          });
          return { address, accounts: { [address]: account } };
        },
      },
      {
        reason: "EVENT_GAP",
        // Khunou's Organisation changes on chain with no transaction in the listing.
        accounts: async () => ({
          address: f.org("khunou"),
          accounts: {
            [f.org("khunou")]: f.build.organisationAccount("khunou", {
              displayName: "Khunou Renamed",
            }),
          },
        }),
      },
      {
        reason: "ACCOUNT_VANISHED",
        accounts: async () => ({ address: f.org("mosela"), accounts: { [f.org("mosela")]: null } }),
      },
    ];
    for (const item of cases) {
      const history = await seedHistory();
      const h = await harness(history);
      await h.pollUntilLive();
      const { address, accounts } = await item.accounts();
      history.push({ slot: 10_500, blockTime: null, transactions: [], accounts });
      h.chain.setHistory(history);
      h.chain.setConfirmedSlot(11_000);
      h.chain.setFinalizedSlot(11_000);
      h.advance(RECONCILE_MS + 1);
      await expectHalt(h, await h.poll(), item.reason, {
        step: "reconcile",
        signature: null,
        mentions: [address],
      });
      expect((await h.checkpoint())?.indexedThroughSlot).toBe(11_000);
    }
  });

  it("reconcile halts with ACCOUNT_DECODE_FAILED on an account kind it does not handle", async () => {
    const f = await fixture();
    const history = await seedHistory();
    const h = await harness(history);
    await h.pollUntilLive();
    const [facility, account] = await f.build.facilityAccount();
    history.push({
      slot: 10_500,
      blockTime: null,
      transactions: [],
      accounts: { [facility]: account },
    });
    h.chain.setHistory(history);
    h.chain.setConfirmedSlot(11_000);
    h.chain.setFinalizedSlot(11_000);
    h.advance(RECONCILE_MS + 1);
    await expectHalt(h, await h.poll(), "ACCOUNT_DECODE_FAILED", {
      step: "reconcile",
      signature: null,
      mentions: [facility, "Facility"],
    });
  });

  it("reconcile skips rows newer than its scan", async () => {
    const f = await fixture();
    const h = await harness(await lotHistory());
    h.chain.setConfirmedSlot(10_000);
    h.chain.setFinalizedSlot(10_000);
    await h.pollUntilLive();

    h.chain.setConfirmedSlot(15_000);
    h.chain.setFinalizedSlot(13_000);
    h.advance(RECONCILE_MS + 1);
    await h.pollUntilLive();
    // Rows read at 15,000 are newer than the finalized scan at 13,000: skipped, even though the
    // scan holds older values (the lot's supply before the split).
    const lot = rows(h.store, "chain_lots").find((row) => row.address === f.lot);
    expect(lot).toMatchObject({ slot: 15_000, commitment: "confirmed", supply_kg: "4000000" });
    for (const row of rows(h.store, "chain_positions")) expect(row.commitment).toBe("confirmed");
    // Rows at or below the scan were compared and promoted at the scan's slot.
    for (const row of rows(h.store, "chain_organisations")) {
      expect(row).toMatchObject({ slot: 13_000, commitment: "finalized" });
    }
    expect((await h.checkpoint())?.status).toBe("live");
  });
});
