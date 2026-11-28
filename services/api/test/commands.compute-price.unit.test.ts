// The relay's compute price (28 Nov): Solflare inserted its own SetComputeUnitPrice into a
// sponsor-paid transaction, which changed the message and was refused as TRANSACTION_MISMATCH.
// Wallets leave the fee alone when the transaction already sets a price, so the relay compiles a
// 1 micro-lamport price right after the limit whenever the transaction still fits 1,232 bytes,
// and the same transaction without it otherwise. Every key here is a throwaway.
import {
  AccountRole,
  type Address,
  generateKeyPairSigner,
  getBase64Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageEncoder,
  getTransactionDecoder,
  getTransactionEncoder,
  type Instruction,
  signBytes,
  type Transaction,
} from "@solana/kit";
import { THETIS_PROGRAM_ADDRESS } from "@thetis/contracts";
import { describe, expect, it } from "vitest";
import {
  COMPUTE_UNIT_PRICE_MICRO_LAMPORTS,
  commandInstructions,
  MAX_TRANSACTION_BYTES,
  measureCommand,
  thetisInstructionIndex,
} from "../src/commands/compile.ts";
import { sharedMessageInstruction } from "../src/commands/ed25519.ts";
import type { Caller, Relay } from "../src/commands/lifecycle.ts";
import { postTransaction } from "../src/commands/lifecycle.ts";
import { COMPUTE_BUDGET, computeShape, decodeMessage, issued } from "./compute-price.ts";

const sponsorKey = await generateKeyPairSigner();
const walletKey = await generateKeyPairSigner();
const sponsor = sponsorKey.address;
const wallet = walletKey.address;
const protocol = (await generateKeyPairSigner()).address;
const other = (await generateKeyPairSigner()).address;

/** A Thetis instruction whose data is `length` bytes: the sponsor pays, the wallet signs. */
function thetis(length: number): Instruction {
  return {
    programAddress: THETIS_PROGRAM_ADDRESS,
    accounts: [
      { address: sponsor, role: AccountRole.WRITABLE_SIGNER },
      { address: protocol, role: AccountRole.READONLY },
      { address: wallet, role: AccountRole.READONLY_SIGNER },
      { address: other, role: AccountRole.WRITABLE },
    ],
    data: new Uint8Array(length),
  };
}

function ed25519(text: Uint8Array) {
  return sharedMessageInstruction([{ wallet, signature: new Uint8Array(64) }], text);
}

/** The largest data length whose transaction still carries the price, and the next one. */
function boundary() {
  for (let length = 700; length < 1_000; length++) {
    const priced = issued(commandInstructions(thetis(length), null), sponsor, [other]);
    const next = issued(commandInstructions(thetis(length + 1), null), sponsor, [other]);
    if (
      computeShape(priced.wire).prices.length === 1 &&
      computeShape(next.wire).prices.length === 0
    )
      return { length, priced, next };
  }
  throw new Error("no length where the price stops fitting");
}

describe("the relay's compute price (28 Nov Solflare fix)", () => {
  it("is the named constant, one micro-lamport", () => {
    expect(COMPUTE_UNIT_PRICE_MICRO_LAMPORTS).toBe(1n);
  });

  it("compiles [limit, price, (Ed25519), Thetis] while that fits, the same transaction without the price once it does not", () => {
    const plain = issued(commandInstructions(thetis(40), null), sponsor, [other]);
    expect(computeShape(plain.wire)).toStrictEqual({
      programs: [COMPUTE_BUDGET, COMPUTE_BUDGET, THETIS_PROGRAM_ADDRESS],
      prices: [{ index: 1, microLamports: 1n }],
      limitFirst: true,
    });
    const text = issued(commandInstructions(thetis(40), ed25519(new Uint8Array(300))), sponsor, [
      other,
    ]);
    expect(computeShape(text.wire).programs).toStrictEqual([
      COMPUTE_BUDGET,
      COMPUTE_BUDGET,
      "Ed25519SigVerify111111111111111111111111111",
      THETIS_PROGRAM_ADDRESS,
    ]);
    expect(computeShape(text.wire).prices).toStrictEqual([{ index: 1, microLamports: 1n }]);

    // The price costs 12 bytes: the last length with it is at most 1,232; the next one drops it
    // and is 11 bytes smaller, still a valid transaction the relay issues.
    const { length, priced, next } = boundary();
    expect(priced.bytes).toBe(MAX_TRANSACTION_BYTES);
    expect(next.bytes).toBe(priced.bytes + 1 - 12);
    expect(computeShape(next.wire)).toMatchObject({
      programs: [COMPUTE_BUDGET, THETIS_PROGRAM_ADDRESS],
      limitFirst: true,
    });
    // measureCommand reports the size of the form the relay compiles.
    expect(measureCommand(commandInstructions(thetis(length), null), sponsor, [other])).toBe(
      priced.bytes,
    );
    expect(measureCommand(commandInstructions(thetis(length + 1), null), sponsor, [other])).toBe(
      next.bytes,
    );
  });

  it("names Thetis's instruction index from the issued wire: 2 or 3 with the price, 1 or 2 without", () => {
    const text = ed25519(new Uint8Array(300));
    expect(
      thetisInstructionIndex(issued(commandInstructions(thetis(40), null), sponsor, [other]).wire),
    ).toBe(2);
    expect(
      thetisInstructionIndex(issued(commandInstructions(thetis(40), text), sponsor, [other]).wire),
    ).toBe(3);
    const { next } = boundary();
    expect(thetisInstructionIndex(next.wire)).toBe(1);
  });

  it("is null for a stored wire that does not decode (PR #84 review), never a guessed index", () => {
    expect(thetisInstructionIndex("")).toBeNull();
    expect(thetisInstructionIndex("AAAA")).toBeNull();
    expect(thetisInstructionIndex("not base64 at all")).toBeNull();
  });
});

// ------------------------------------------------------------- postTransaction (no database)

const COMMAND_ID = "6f1c4a52-0d3e-4c4b-9b7e-2a1f0c9d8e7a";

/** A caller whose only row is the issued command awaiting the wallet's signature. */
function pendingCaller(issuedWire: string): Caller {
  const messageBytes = getTransactionDecoder().decode(
    getBase64Encoder().encode(issuedWire),
  ).messageBytes;
  const row = {
    id: COMMAND_ID,
    status: "awaiting_signatures",
    valid_until: null,
    pending_message_base64: getBase64Decoder().decode(new Uint8Array(messageBytes)),
    pending_wallet: wallet,
    pending_last_valid_block_height: "1000",
  };
  const query = {
    select: () => query,
    eq: () => query,
    maybeSingle: async () => ({ data: row, error: null }),
    single: async () => ({ data: row, error: null }),
  };
  const client = { from: () => query } as unknown as Caller["caller"];
  return { userId: "user", caller: client, service: client };
}

/** The relay never reaches the chain or the sponsor for a mismatched message. */
const relay = new Proxy({} as Relay, {
  get(_, key) {
    if (key === "then") return undefined;
    throw new Error(`the relay touched ${String(key)}`);
  },
});

/** What Solflare did: insert a SetComputeUnitPrice (100,000 micro-lamports, no accounts) at
 * `at`, or replace the instruction there, then sign the altered message with the wallet. */
async function walletAlters(issuedWire: string, at: number, replace: boolean): Promise<string> {
  const message = decodeMessage(issuedWire);
  const budget = message.staticAccounts.indexOf(COMPUTE_BUDGET as Address);
  expect(budget).toBeGreaterThanOrEqual(0);
  const data = new Uint8Array(9);
  data[0] = 3;
  new DataView(data.buffer).setBigUint64(1, 100_000n, true);
  const instructions = [...message.instructions];
  instructions.splice(at, replace ? 1 : 0, { programAddressIndex: budget, data });
  const messageBytes = getCompiledTransactionMessageEncoder().encode({
    ...(message as object),
    instructions,
  } as never);
  const original = getTransactionDecoder().decode(getBase64Encoder().encode(issuedWire));
  const altered = {
    messageBytes,
    signatures: {
      ...original.signatures,
      [wallet]: await signBytes(walletKey.keyPair.privateKey, messageBytes),
    },
  } as unknown as Transaction;
  return getBase64Decoder().decode(getTransactionEncoder().encode(altered));
}

async function codeOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return "accepted";
}

describe("postTransaction refuses a wallet-altered message", () => {
  it("a wallet-inserted price on a transaction the relay issued without one is TRANSACTION_MISMATCH", async () => {
    const { next } = boundary();
    expect(computeShape(next.wire).prices).toStrictEqual([]);
    const altered = await walletAlters(next.wire, 1, false);
    expect(decodeMessage(altered).instructions).toHaveLength(3);
    expect(
      await codeOf(
        postTransaction(relay, pendingCaller(next.wire), COMMAND_ID, {
          transactionBase64: altered,
        }),
      ),
    ).toBe("TRANSACTION_MISMATCH");
  });

  it("a wallet that replaces or adds to the relay's price is TRANSACTION_MISMATCH", async () => {
    const priced = issued(commandInstructions(thetis(40), null), sponsor, [other]);
    expect(computeShape(priced.wire).prices).toHaveLength(1);
    for (const [at, replace] of [
      [1, true],
      [2, false],
    ] as const) {
      const altered = await walletAlters(priced.wire, at, replace);
      expect(
        await codeOf(
          postTransaction(relay, pendingCaller(priced.wire), COMMAND_ID, {
            transactionBase64: altered,
          }),
        ),
        `at ${at} replace ${replace}`,
      ).toBe("TRANSACTION_MISMATCH");
    }
  });
});
