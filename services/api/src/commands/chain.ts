// The relay's only view of the chain (live-lending.md §7). Every read is at `confirmed`.
import {
  type Address,
  createSolanaRpc,
  type EncodedAccount,
  fetchEncodedAccounts,
  getAddressDecoder,
  type MaybeEncodedAccount,
  type Signature,
} from "@solana/kit";

export interface ChainPort {
  genesisHash(): Promise<string>;
  slot(): Promise<bigint>;
  /** getBlockTime(slot()), never the server clock. */
  chainTime(): Promise<bigint>;
  blockHeight(): Promise<bigint>;
  latestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: bigint }>;
  /** getMultipleAccounts, at most 100 per call. */
  accounts(addresses: Address[]): Promise<MaybeEncodedAccount[]>;
  programAccounts(filters: {
    memcmp?: { offset: number; bytes: Address };
    dataSize: number;
  }): Promise<EncodedAccount[]>;
  lookupTable(address: Address): Promise<{ addresses: Address[]; lastExtendedSlot: bigint } | null>;
  /** skipPreflight true, maxRetries 0. */
  send(wireBase64: string): Promise<void>;
  /** searchTransactionHistory true. */
  status(signature: string): Promise<{
    slot: bigint;
    failed: unknown | null;
    confirmationStatus: "processed" | "confirmed" | "finalized" | null;
  } | null>;
  transaction(signature: string): Promise<{ slot: bigint; logs: string[] } | null>;
}

/** An RPC call failed or timed out: nothing was changed (CHAIN_UNAVAILABLE). */
export class ChainUnavailableError extends Error {
  constructor(cause: unknown) {
    super("CHAIN_UNAVAILABLE", { cause });
    this.name = "ChainUnavailableError";
  }
}

const TIMEOUT_MS = 10_000;
const LOOKUP_TABLE_PROGRAM = "AddressLookupTab1e1111111111111111111111111";
const THETIS_PROGRAM = "jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3";

async function guarded<T>(read: (signal: AbortSignal) => Promise<T>): Promise<T> {
  try {
    return await read(AbortSignal.timeout(TIMEOUT_MS));
  } catch (error) {
    throw new ChainUnavailableError(error);
  }
}

function tableFrom(data: Uint8Array) {
  const bytes = Buffer.from(data);
  if (bytes.length < 56 || (bytes.length - 56) % 32 !== 0 || bytes.readUInt32LE(0) !== 1)
    return null;
  const addresses: Address[] = [];
  for (let offset = 56; offset < bytes.length; offset += 32) {
    addresses.push(getAddressDecoder().decode(bytes.subarray(offset, offset + 32)));
  }
  return { addresses, lastExtendedSlot: bytes.readBigUInt64LE(12) };
}

export function rpcChain(url: string): ChainPort {
  const rpc = createSolanaRpc(url);
  const confirmed = { commitment: "confirmed" as const };
  const port: ChainPort = {
    genesisHash: () => guarded((abortSignal) => rpc.getGenesisHash().send({ abortSignal })),
    slot: () => guarded((abortSignal) => rpc.getSlot(confirmed).send({ abortSignal })),
    async chainTime() {
      const slot = await port.slot();
      return guarded(async (abortSignal) => {
        const time = await rpc.getBlockTime(slot).send({ abortSignal });
        if (time === null) throw new Error(`no block time for slot ${slot}`);
        return BigInt(time);
      });
    },
    blockHeight: () =>
      guarded((abortSignal) => rpc.getBlockHeight(confirmed).send({ abortSignal })),
    latestBlockhash: () =>
      guarded(async (abortSignal) => {
        const { value } = await rpc.getLatestBlockhash(confirmed).send({ abortSignal });
        return { blockhash: value.blockhash, lastValidBlockHeight: value.lastValidBlockHeight };
      }),
    accounts: (addresses) =>
      guarded(async (abortSignal) => {
        const out: MaybeEncodedAccount[] = [];
        for (let start = 0; start < addresses.length; start += 100) {
          out.push(
            ...(await fetchEncodedAccounts(rpc, addresses.slice(start, start + 100), {
              ...confirmed,
              abortSignal,
            })),
          );
        }
        return out;
      }),
    programAccounts: ({ memcmp, dataSize }) =>
      guarded(async (abortSignal) => {
        const filters = [
          { dataSize: BigInt(dataSize) },
          ...(memcmp
            ? [
                {
                  memcmp: {
                    offset: BigInt(memcmp.offset),
                    bytes: memcmp.bytes,
                    encoding: "base58" as const,
                  },
                },
              ]
            : []),
        ];
        const found = await rpc
          .getProgramAccounts(THETIS_PROGRAM as Address, {
            ...confirmed,
            encoding: "base64",
            filters: filters as never,
          })
          .send({ abortSignal });
        return (
          found as unknown as {
            pubkey: Address;
            account: {
              data: [string, string];
              owner: Address;
              lamports: bigint;
              executable: boolean;
              space: bigint;
            };
          }[]
        ).map(
          ({ pubkey, account }) =>
            ({
              address: pubkey,
              data: new Uint8Array(Buffer.from(account.data[0], "base64")),
              programAddress: account.owner,
              lamports: account.lamports,
              executable: account.executable,
              space: account.space,
            }) as unknown as EncodedAccount,
        );
      }),
    async lookupTable(address) {
      const [account] = await port.accounts([address]);
      if (!account?.exists || account.programAddress !== LOOKUP_TABLE_PROGRAM) return null;
      return tableFrom(account.data);
    },
    send: (wireBase64) =>
      guarded(async (abortSignal) => {
        await rpc
          .sendTransaction(wireBase64 as never, {
            encoding: "base64",
            skipPreflight: true,
            maxRetries: 0n,
          })
          .send({ abortSignal });
      }),
    status: (signature) =>
      guarded(async (abortSignal) => {
        const { value } = await rpc
          .getSignatureStatuses([signature as Signature], { searchTransactionHistory: true })
          .send({ abortSignal });
        const status = value[0];
        if (!status) return null;
        return {
          slot: status.slot,
          failed: status.err ?? null,
          confirmationStatus: status.confirmationStatus ?? null,
        };
      }),
    transaction: (signature) =>
      guarded(async (abortSignal) => {
        const found = await rpc
          .getTransaction(signature as Signature, {
            ...confirmed,
            encoding: "json",
            maxSupportedTransactionVersion: 0,
          })
          .send({ abortSignal });
        if (!found) return null;
        return { slot: found.slot, logs: [...(found.meta?.logMessages ?? [])] };
      }),
  };
  return port;
}
