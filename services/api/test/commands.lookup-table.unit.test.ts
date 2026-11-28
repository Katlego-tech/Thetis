// ensureTableKeys and the table's activation (live-lending.md §4.4.2, program-custody.md §4.6):
// a key appended in slot S is usable only from slot S + 1, so a caller that finds every key
// already present still waits for the slot after the last extension (PR #92 review).
import { type Address, generateKeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { ensureTableKeys, type TableContext } from "../src/commands/lookup-table.ts";

const newKey = async () => (await generateKeyPairSigner()).address;

async function context(lastExtendedSlot: bigint, slots: bigint[]) {
  const [table, key, sponsor] = [await newKey(), await newKey(), await newKey()];
  const read = { slots: 0, sleeps: 0, sends: 0 };
  const query = {
    select: () => query,
    eq: () => query,
    maybeSingle: async () => ({ data: { address: table }, error: null }),
  };
  const ctx = {
    service: { from: () => query },
    chain: {
      lookupTable: async () => ({ addresses: [key], lastExtendedSlot }),
      slot: async () => slots[Math.min(read.slots++, slots.length - 1)] as bigint,
      send: async () => {
        read.sends++;
      },
    },
    sponsor: { address: async () => sponsor, sign: async (wire: string) => wire },
    network: "devnet",
    programId: await newKey(),
    protocol: await newKey(),
    sleep: async () => {
      read.sleeps++;
    },
  } as unknown as TableContext;
  return { ctx, table, key: key as Address, read };
}

describe("ensureTableKeys activation", () => {
  it("with nothing missing, waits until the slot passes the table's last extension before returning", async () => {
    const { ctx, table, key, read } = await context(10n, [10n, 10n, 11n]);
    await expect(ensureTableKeys(ctx, [key])).resolves.toStrictEqual({
      table,
      addresses: [key],
    });
    expect(read.slots).toBe(3);
    expect(read.sleeps).toBe(2);
    expect(read.sends).toBe(0);
  });

  it("returns at once when the extension's slot has already passed", async () => {
    const { ctx, key, read } = await context(10n, [12n]);
    await ensureTableKeys(ctx, [key]);
    expect(read.slots).toBe(1);
    expect(read.sleeps).toBe(0);
  });
});
