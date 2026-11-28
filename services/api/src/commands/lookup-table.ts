// One address lookup table per instance, authority and payer the sponsor (live-lending.md §4.4.2).

import {
  type Address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  type Instruction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import {
  findAddressLookupTablePda,
  getCreateLookupTableInstruction,
  getExtendLookupTableInstruction,
} from "@solana-program/address-lookup-table";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChainPort } from "./chain.ts";
import type { SponsorPort } from "./sponsor.ts";

export const MAX_TABLE_KEYS = 256;
const PER_EXTEND = 20;

/** A table that would pass 256 keys: nothing is signed (503). */
export class LookupTableFullError extends Error {
  constructor() {
    super("LOOKUP_TABLE_FULL");
    this.name = "LookupTableFullError";
  }
}

export interface TableContext {
  service: SupabaseClient;
  chain: ChainPort;
  sponsor: SponsorPort;
  network: "devnet";
  programId: Address;
  protocol: Address;
  sleep: (ms: number) => Promise<void>;
}

async function sendSponsored(
  context: TableContext,
  sponsor: Address,
  instruction: Instruction,
  table: Address | null,
) {
  const { blockhash, lastValidBlockHeight } = await context.chain.latestBlockhash();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(sponsor, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: blockhash as never, lastValidBlockHeight },
        m,
      ),
    (m) => appendTransactionMessageInstructions([instruction], m),
  );
  const wire = getBase64EncodedWireTransaction(compileTransaction(message));
  const signed = await context.sponsor.sign(wire, table);
  await context.chain.send(signed);
}

async function waitForSlotAbove(context: TableContext, slot: bigint) {
  for (let attempt = 0; attempt < 60; attempt++) {
    if ((await context.chain.slot()) > slot) return;
    await context.sleep(500);
  }
  throw new Error(`the chain did not pass slot ${slot}`);
}

async function storedTable(context: TableContext): Promise<Address | null> {
  const { data, error } = await context.service
    .from("relay_lookup_tables")
    .select("address")
    .eq("network", context.network)
    .eq("program_id", context.programId)
    .eq("protocol", context.protocol)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data?.address as Address | undefined) ?? null;
}

async function createTable(context: TableContext, sponsor: Address): Promise<Address> {
  const recentSlot = await context.chain.slot();
  const [address, bump] = await findAddressLookupTablePda({ authority: sponsor, recentSlot });
  const noop = createNoopSigner(sponsor);
  await sendSponsored(
    context,
    sponsor,
    getCreateLookupTableInstruction({
      address: [address, bump],
      authority: noop,
      payer: noop,
      recentSlot,
    }),
    null,
  );
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await context.chain.lookupTable(address)) break;
    await context.sleep(500);
  }
  if (!(await context.chain.lookupTable(address)))
    throw new Error("the lookup table was not created");
  const { error } = await context.service.from("relay_lookup_tables").insert({
    network: context.network,
    program_id: context.programId,
    protocol: context.protocol,
    address,
    authority: sponsor,
  });
  if (error) {
    // Another command created and stored one first: use that.
    const existing = await storedTable(context);
    if (existing) return existing;
    throw new Error(error.message);
  }
  return address;
}

/** Returns the instance's table holding every key in `keys`, creating and extending it first. */
export async function ensureTableKeys(context: TableContext, keys: readonly Address[]) {
  const sponsor = await context.sponsor.address();
  const table = (await storedTable(context)) ?? (await createTable(context, sponsor));
  const current = await context.chain.lookupTable(table);
  if (!current) throw new Error(`lookup table ${table} is missing`);
  const missing = [...new Set(keys)].filter((key) => !current.addresses.includes(key));
  if (missing.length === 0) {
    // PR #92 review: a key another command appended in slot S is active only from S + 1.
    await waitForSlotAbove(context, current.lastExtendedSlot);
    return { table, addresses: current.addresses };
  }
  if (current.addresses.length + missing.length > MAX_TABLE_KEYS) throw new LookupTableFullError();
  const noop = createNoopSigner(sponsor);
  for (let start = 0; start < missing.length; start += PER_EXTEND) {
    await sendSponsored(
      context,
      sponsor,
      getExtendLookupTableInstruction({
        address: table,
        authority: noop,
        payer: noop,
        addresses: missing.slice(start, start + PER_EXTEND),
      }),
      table,
    );
  }
  for (let attempt = 0; attempt < 60; attempt++) {
    const read = await context.chain.lookupTable(table);
    if (read && missing.every((key) => read.addresses.includes(key))) {
      await waitForSlotAbove(context, read.lastExtendedSlot);
      return { table, addresses: read.addresses };
    }
    await context.sleep(500);
  }
  throw new Error("the lookup table extension did not land");
}
