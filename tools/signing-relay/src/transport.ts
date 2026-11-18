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
  getSignatureFromTransaction,
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

const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const CONFIRMATION_TIMEOUT_MS = 180_000;
const STATUS_POLL_MS = 500;
const MAX_CONSECUTIVE_RPC_FAILURES = 5;
const MAX_RECONCILIATION_POLL_MS = 8_000;

interface Lifetime {
  blockhash: Blockhash;
  lastValidBlockHeight: bigint;
}

export interface ChainTransport {
  getGenesisHash(): Promise<string>;
  getSlot(): Promise<bigint>;
  getBlockHeight(): Promise<bigint>;
  getSignatureStatus(signature: Signature): Promise<"confirmed" | "failed" | null>;
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

export class SendPreflightError extends ChainTransactionError {
  override name = "SendPreflightError";
}

export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export async function requireDevnet(transport: ChainTransport) {
  const hash = await transport.getGenesisHash();
  if (hash !== DEVNET_GENESIS_HASH) {
    throw new Error(
      `Signing relay requires devnet genesis hash ${DEVNET_GENESIS_HASH}; RPC returned ${hash}`,
    );
  }
}

export async function reconcileSignature(
  transport: ChainTransport,
  signature: Signature,
  { lastValidBlockHeight }: Lifetime,
  onRpcUnavailable: () => void,
) {
  let consecutiveFailures = 0;
  let pollInterval = STATUS_POLL_MS;
  const getStatus = () => transport.getSignatureStatus(signature).catch(() => undefined);
  for (;;) {
    const status = await getStatus();
    if (status) return status;

    const height = await transport.getBlockHeight().catch(() => null);
    if (height !== null && height > lastValidBlockHeight) {
      // Include any confirmation that arrived between the status and height reads.
      return (await getStatus()) ?? null;
    }
    // A successful poll with no signature status is still a valid RPC response.
    consecutiveFailures = status === undefined || height === null ? consecutiveFailures + 1 : 0;
    if (consecutiveFailures === MAX_CONSECUTIVE_RPC_FAILURES) onRpcUnavailable();
    if (consecutiveFailures >= MAX_CONSECUTIVE_RPC_FAILURES) {
      pollInterval = Math.min(pollInterval * 2, MAX_RECONCILIATION_POLL_MS);
    } else {
      pollInterval = STATUS_POLL_MS;
    }
    await delay(pollInterval);
  }
}

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
  beforeSend?: (signature: Signature, lifetime: Lifetime) => Promise<void>,
) {
  const { transaction, lifetime } = await prepareTransaction(
    transport,
    sponsor,
    instructions,
    options,
  );
  if (beforeSend) await beforeSend(getSignatureFromTransaction(transaction), lifetime);
  const signature = await transport.send(transaction);
  await transport.confirm(signature, lifetime);
  return signature;
}

export function rpcTransport(url: string): ChainTransport {
  const rpc = createSolanaRpc(url);
  const commitment = "confirmed";
  const requestTimeout = () => ({ abortSignal: AbortSignal.timeout(15_000) });
  const getSlot = () => rpc.getSlot({ commitment }).send(requestTimeout());
  const getBlockHeight = () => rpc.getBlockHeight({ commitment }).send(requestTimeout());
  const getSignatureStatus: ChainTransport["getSignatureStatus"] = async (signature) => {
    const {
      value: [status],
    } = await rpc
      .getSignatureStatuses([signature], { searchTransactionHistory: true })
      .send(requestTimeout());
    if (status?.confirmationStatus !== "confirmed" && status?.confirmationStatus !== "finalized") {
      return null;
    }
    return status.err ? "failed" : "confirmed";
  };
  return {
    getGenesisHash: () => rpc.getGenesisHash().send(requestTimeout()),
    getSlot,
    getBlockHeight,
    getSignatureStatus,
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
          throw new SendPreflightError(
            errorMessage(error.cause ?? error),
            error.context.logs ?? [],
            { cause: error },
          );
        }
        throw error;
      }
    },
    async confirm(signature, { lastValidBlockHeight }) {
      const deadline = performance.now() + CONFIRMATION_TIMEOUT_MS;
      for (;;) {
        const status = await getSignatureStatus(signature);
        if (status === "confirmed") return;
        if (status === "failed") {
          // Logs are diagnostic. Preserve the known failure even if the log lookup fails.
          const details = await rpc
            .getTransaction(signature, {
              commitment,
              encoding: "json",
              maxSupportedTransactionVersion: 0,
            })
            .send(requestTimeout())
            .catch(() => null);
          throw new ChainTransactionError(
            `Transaction ${signature} failed`,
            details?.meta?.logMessages ?? [],
          );
        }
        if ((await getBlockHeight()) > lastValidBlockHeight) {
          throw new Error(`Blockhash expired before ${signature} was confirmed`);
        }
        if (performance.now() >= deadline) {
          throw new Error(`Confirmation timed out for ${signature}`);
        }
        await delay(STATUS_POLL_MS);
      }
    },
  };
}
