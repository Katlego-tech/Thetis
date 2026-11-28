// Test helper: compile a command as the relay does and read its compute-budget instructions back
// from the wire (the relay sets a 1 micro-lamport price when the transaction still fits, so a
// wallet such as Solflare leaves the fee alone; 28 Nov).
import {
  type Address,
  type Blockhash,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type Instruction,
} from "@solana/kit";
import { compileCommandWire } from "../src/commands/compile.ts";

export const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const BLOCKHASH = "11111111111111111111111111111111" as Blockhash;
const TABLE = "AddressLookupTab1e1111111111111111111111111" as Address;

type Compiled = {
  staticAccounts: Address[];
  instructions: {
    programAddressIndex: number;
    accountIndices?: readonly number[];
    data?: Uint8Array;
  }[];
};

export function decodeMessage(wireBase64: string): Compiled {
  const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(wireBase64));
  return getCompiledTransactionMessageDecoder().decode(
    transaction.messageBytes,
  ) as unknown as Compiled;
}

/** Each instruction's program, and every SetComputeUnitPrice's index and price. */
export function computeShape(wireBase64: string) {
  const message = decodeMessage(wireBase64);
  const programs = message.instructions.map(
    (instruction) => message.staticAccounts[instruction.programAddressIndex] as string,
  );
  const prices: { index: number; microLamports: bigint }[] = [];
  message.instructions.forEach((instruction, index) => {
    const data = instruction.data ?? new Uint8Array();
    if (programs[index] === COMPUTE_BUDGET && data[0] === 3 && data.length === 9) {
      prices.push({
        index,
        microLamports: new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(
          1,
          true,
        ),
      });
    }
  });
  const limitData = message.instructions[0]?.data ?? new Uint8Array();
  return {
    programs,
    prices,
    limitFirst: programs[0] === COMPUTE_BUDGET && limitData[0] === 2 && limitData.length === 5,
  };
}

/** The wire the relay would issue for these instructions against a table holding `keys`. */
export function issued(
  instructions: readonly Instruction[],
  sponsor: Address,
  keys: readonly Address[],
) {
  return compileCommandWire(
    instructions,
    sponsor,
    { blockhash: BLOCKHASH, lastValidBlockHeight: 0n },
    { address: TABLE, keys },
  );
}

/** The relay's shape for a transaction that fits with the price: [limit, price, (Ed25519), Thetis]. */
export function expectPriced(
  expect: (
    value: unknown,
    message?: string,
  ) => { toBe(v: unknown): void; toStrictEqual(v: unknown): void },
  wireBase64: string,
  label: string,
) {
  const shape = computeShape(wireBase64);
  expect(shape.limitFirst, `${label}: limit first`).toBe(true);
  expect(shape.prices, `${label}: one price right after the limit`).toStrictEqual([
    { index: 1, microLamports: 1n },
  ]);
}

/** A transaction that only fits without the price carries none. */
export function expectUnpriced(
  expect: (
    value: unknown,
    message?: string,
  ) => { toBe(v: unknown): void; toStrictEqual(v: unknown): void },
  wireBase64: string,
  label: string,
) {
  const shape = computeShape(wireBase64);
  expect(shape.limitFirst, `${label}: limit first`).toBe(true);
  expect(shape.prices, `${label}: no price`).toStrictEqual([]);
}
