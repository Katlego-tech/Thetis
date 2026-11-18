import { setTimeout as delay } from "node:timers/promises";
import {
  type Address,
  type AddressesByLookupTableAddress,
  appendTransactionMessageInstructions,
  assertIsFullySignedTransaction,
  type Blockhash,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getTransactionEncoder,
  type Instruction,
  isSolanaError,
  type KeyPairSigner,
  partiallySignTransaction,
  type Signature,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Transaction,
} from "@solana/kit";

interface Lifetime {
  blockhash: Blockhash;
  lastValidBlockHeight: bigint;
}

export interface ChainTransport {
  getSlot(): Promise<bigint>;
  waitForSlot(after: bigint): Promise<void>;
  getAccount(key: Address): Promise<{ owner: Address; data: Buffer } | null>;
  getRent(space: number): Promise<bigint>;
  getLatestBlockhash(): Promise<Lifetime>;
  send(transaction: Transaction): Promise<Signature>;
  confirm(signature: Signature, lifetime: Lifetime): Promise<void>;
}

export class ChainTransactionError extends Error {
  readonly logs: readonly string[];

  constructor(message: string, logs: readonly string[], options?: ErrorOptions) {
    super(message, options);
    this.name = "ChainTransactionError";
    this.logs = logs;
  }
}

export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export async function prepareTransaction(
  transport: ChainTransport,
  sponsor: KeyPairSigner,
  instructions: Instruction[],
  options: { signers?: KeyPairSigner[]; tables?: AddressesByLookupTableAddress } = {},
) {
  const lifetime = await transport.getLatestBlockhash();
  const message = appendTransactionMessageInstructions(
    instructions,
    setTransactionMessageLifetimeUsingBlockhash(
      lifetime,
      setTransactionMessageFeePayer(sponsor.address, createTransactionMessage({ version: 0 })),
    ),
  );
  const compressed = options.tables
    ? compressTransactionMessageUsingAddressLookupTables(message, options.tables)
    : message;
  const transaction = await partiallySignTransaction(
    [sponsor, ...(options.signers ?? [])].map(({ keyPair }) => keyPair),
    compileTransaction(compressed),
  );
  assertIsFullySignedTransaction(transaction);
  const sizeBytes = getTransactionEncoder().encode(transaction).length;
  if (sizeBytes > 1232) throw new Error(`Signed transaction exceeds 1232 bytes (${sizeBytes})`);
  return { transaction, sizeBytes, lifetime };
}

export async function sendConfirmed(
  transport: ChainTransport,
  sponsor: KeyPairSigner,
  instructions: Instruction[],
  options?: Parameters<typeof prepareTransaction>[3],
) {
  const { transaction, lifetime } = await prepareTransaction(
    transport,
    sponsor,
    instructions,
    options,
  );
  const signature = await transport.send(transaction);
  await transport.confirm(signature, lifetime);
  return signature;
}

export function rpcTransport(url: string): ChainTransport {
  const rpc = createSolanaRpc(url);
  const commitment = "confirmed";
  const requestTimeout = () => ({ abortSignal: AbortSignal.timeout(15_000) });
  const getSlot = () => rpc.getSlot({ commitment }).send(requestTimeout());
  return {
    getSlot,
    async waitForSlot(after) {
      const deadline = Date.now() + 60_000;
      while ((await getSlot()) <= after) {
        if (Date.now() >= deadline) throw new Error(`Confirmed slot did not advance past ${after}`);
        await delay(400);
      }
    },
    async getAccount(key) {
      const { value } = await rpc
        .getAccountInfo(key, { commitment, encoding: "base64" })
        .send(requestTimeout());
      return value ? { owner: value.owner, data: Buffer.from(value.data[0], "base64") } : null;
    },
    getRent: (space) =>
      rpc.getMinimumBalanceForRentExemption(BigInt(space), { commitment }).send(requestTimeout()),
    async getLatestBlockhash() {
      return (await rpc.getLatestBlockhash({ commitment }).send(requestTimeout())).value;
    },
    async send(transaction) {
      try {
        return await rpc
          .sendTransaction(getBase64EncodedWireTransaction(transaction), {
            encoding: "base64",
            preflightCommitment: commitment,
          })
          .send(requestTimeout());
      } catch (error) {
        if (
          isSolanaError(
            error,
            SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
          )
        ) {
          throw new ChainTransactionError(
            errorMessage(error.cause ?? error),
            error.context.logs ?? [],
            { cause: error },
          );
        }
        throw error;
      }
    },
    async confirm(signature, { lastValidBlockHeight }) {
      for (;;) {
        const {
          value: [status],
        } = await rpc.getSignatureStatuses([signature]).send(requestTimeout());
        if (
          status?.confirmationStatus === "confirmed" ||
          status?.confirmationStatus === "finalized"
        ) {
          if (!status.err) return;
          const { meta } =
            (await rpc
              .getTransaction(signature, {
                commitment,
                encoding: "json",
                maxSupportedTransactionVersion: 0,
              })
              .send(requestTimeout())) ?? {};
          throw new ChainTransactionError(
            `Transaction ${signature} failed`,
            meta?.logMessages ?? [],
          );
        }
        if (
          (await rpc.getBlockHeight({ commitment }).send(requestTimeout())) > lastValidBlockHeight
        ) {
          throw new Error(`Blockhash expired before ${signature} was confirmed`);
        }
        await delay(500);
      }
    },
  };
}
