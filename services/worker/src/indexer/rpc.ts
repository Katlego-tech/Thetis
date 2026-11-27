// The indexer's view of a Solana node: eight read calls, each with plain values. Slots are numbers
// (checked with Number.isSafeInteger), block times are ISO strings, account data is raw bytes. A
// response of another shape, or a list whose length differs from the request, is an RpcShapeError,
// which the loop treats like any other RPC failure.

import {
  type Address,
  createSolanaRpc,
  type EncodedAccount,
  isSolanaError,
  type MaybeEncodedAccount,
  parseBase64RpcAccount,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_BLOCK_NOT_AVAILABLE,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_UNSUPPORTED_TRANSACTION_VERSION,
} from "@solana/kit";
import { THETIS_PROGRAM_ADDRESS } from "@thetis/contracts";

export type SignatureEntry = {
  signature: string;
  slot: number;
  failed: boolean;
  blockTime: string | null;
};

/** A Kit MaybeEncodedAccount: address, exists, programAddress (the RPC owner), data, lamports. */
export type FetchedAccount = MaybeEncodedAccount;

export type RawInstruction = { programIdIndex: number; accounts: number[]; data: string };

export type RawTransaction = {
  slot: number;
  blockTime: string | null;
  version: "legacy" | 0;
  transaction: {
    message: {
      accountKeys: string[];
      header: {
        numRequiredSignatures: number;
        numReadonlySignedAccounts: number;
        numReadonlyUnsignedAccounts: number;
      };
      instructions: RawInstruction[];
      addressTableLookups?: unknown[];
    };
  };
  meta: {
    err: unknown;
    logMessages: string[] | null;
    loadedAddresses?: { writable: string[]; readonly: string[] };
    innerInstructions: { index: number; instructions: RawInstruction[] }[] | null;
  } | null;
};

export type ProgramAccountsFilter = { offset8: string; dataSize: number | null };

export interface ChainSource {
  getGenesisHash(signal: AbortSignal): Promise<string>;
  getSlot(commitment: "confirmed" | "finalized", signal: AbortSignal): Promise<number>;
  getSignatures(
    before: string | null,
    minContextSlot: number,
    signal: AbortSignal,
  ): Promise<SignatureEntry[]>;
  getTransaction(signature: string, signal: AbortSignal): Promise<RawTransaction | null>;
  getBlockTime(slot: number, signal: AbortSignal): Promise<string | null>;
  getMultipleAccounts(
    addresses: string[],
    commitment: "confirmed" | "finalized",
    minContextSlot: number | null,
    signal: AbortSignal,
  ): Promise<{ slot: number; accounts: FetchedAccount[] }>;
  /**
   * The program's accounts at the finalized commitment whose bytes 8 to 40 are `offset8` (the
   * protocol, or a PoolShare's pool), of `dataSize` bytes when it is not null.
   */
  getProgramAccounts(
    filter: ProgramAccountsFilter,
    signal: AbortSignal,
  ): Promise<{ slot: number; accounts: EncodedAccount[] }>;
  getSignatureStatuses(
    signatures: string[],
    signal: AbortSignal,
  ): Promise<({ slot: number; failed: boolean; confirmationStatus: string | null } | null)[]>;
}

export class RpcShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcShapeError";
  }
}

/** The node cannot return this transaction because its message version is not supported. */
export class UnsupportedVersionError extends Error {
  readonly signature: string;

  constructor(signature: string) {
    super(`the node does not support the message version of transaction ${signature}`);
    this.name = "UnsupportedVersionError";
    this.signature = signature;
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RpcShapeError(`${label}: expected an object`);
  }
  return value as Record<string, unknown>;
}

function list(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new RpcShapeError(`${label}: expected a list`);
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string") throw new RpcShapeError(`${label}: expected a string`);
  return value;
}

function safeInteger(value: unknown, label: string): number {
  const converted = typeof value === "bigint" ? Number(value) : value;
  if (typeof converted !== "number" || !Number.isSafeInteger(converted) || converted < 0) {
    throw new RpcShapeError(`${label}: expected a non-negative safe integer`);
  }
  if (typeof value === "bigint" && BigInt(converted) !== value) {
    throw new RpcShapeError(`${label}: ${value} is not a safe integer`);
  }
  return converted;
}

function isoTime(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  const seconds = safeInteger(value, label);
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) throw new RpcShapeError(`${label}: not a time`);
  return date.toISOString();
}

function stringList(value: unknown, label: string): string[] {
  return list(value, label).map((item, index) => text(item, `${label}[${index}]`));
}

function intList(value: unknown, label: string): number[] {
  return list(value, label).map((item, index) => safeInteger(item, `${label}[${index}]`));
}

function instructionList(value: unknown, label: string): RawInstruction[] {
  return list(value, label).map((item, index) => {
    const entry = record(item, `${label}[${index}]`);
    return {
      programIdIndex: safeInteger(entry.programIdIndex, `${label}[${index}].programIdIndex`),
      accounts: intList(entry.accounts, `${label}[${index}].accounts`),
      data: text(entry.data, `${label}[${index}].data`),
    };
  });
}

/**
 * Checks a transaction response for the shape the decoder relies on. Everything wrong with the
 * response itself (a wrong JSON type, a wrong length) is an RpcShapeError; whether an index points
 * at a real key is the decoder's question.
 */
export function checkRawTransaction(raw: RawTransaction): RawTransaction {
  const value = record(raw, "transaction");
  safeInteger(value.slot, "slot");
  if (value.blockTime !== null && typeof value.blockTime !== "string") {
    throw new RpcShapeError("blockTime: expected a string or null");
  }
  if (value.version !== "legacy" && value.version !== 0) {
    throw new RpcShapeError("version: expected legacy or 0");
  }
  const message = record(record(value.transaction, "transaction.transaction").message, "message");
  const keys = stringList(message.accountKeys, "message.accountKeys");
  const header = record(message.header, "message.header");
  for (const name of [
    "numRequiredSignatures",
    "numReadonlySignedAccounts",
    "numReadonlyUnsignedAccounts",
  ]) {
    if (safeInteger(header[name], `message.header.${name}`) > keys.length) {
      throw new RpcShapeError(`message.header.${name} exceeds the account keys`);
    }
  }
  const instructions = instructionList(message.instructions, "message.instructions");
  if (message.addressTableLookups !== undefined) {
    list(message.addressTableLookups, "message.addressTableLookups");
  }
  if (value.meta === null) return raw;
  const meta = record(value.meta, "meta");
  if (meta.logMessages !== null) stringList(meta.logMessages, "meta.logMessages");
  if (meta.loadedAddresses !== undefined && meta.loadedAddresses !== null) {
    const loaded = record(meta.loadedAddresses, "meta.loadedAddresses");
    stringList(loaded.writable, "meta.loadedAddresses.writable");
    stringList(loaded.readonly, "meta.loadedAddresses.readonly");
  }
  if (meta.innerInstructions !== null) {
    for (const [position, group] of list(
      meta.innerInstructions,
      "meta.innerInstructions",
    ).entries()) {
      const entry = record(group, `meta.innerInstructions[${position}]`);
      const index = safeInteger(entry.index, `meta.innerInstructions[${position}].index`);
      if (index >= instructions.length) {
        throw new RpcShapeError(
          `meta.innerInstructions[${position}].index is outside the instructions`,
        );
      }
      instructionList(entry.instructions, `meta.innerInstructions[${position}].instructions`);
    }
  }
  return raw;
}

type RpcCall = (...args: unknown[]) => {
  send(options: { abortSignal: AbortSignal }): Promise<unknown>;
};

function convertTransaction(value: unknown): RawTransaction {
  const entry = record(value, "getTransaction");
  const body = record(entry.transaction, "getTransaction.transaction");
  const message = record(body.message, "getTransaction.message");
  const meta = entry.meta === null || entry.meta === undefined ? null : record(entry.meta, "meta");
  const converted: RawTransaction = {
    slot: safeInteger(entry.slot, "getTransaction.slot"),
    blockTime: isoTime(entry.blockTime, "getTransaction.blockTime"),
    version: entry.version as RawTransaction["version"],
    transaction: {
      message: {
        accountKeys: message.accountKeys as string[],
        header: message.header as RawTransaction["transaction"]["message"]["header"],
        instructions: message.instructions as RawInstruction[],
        ...(message.addressTableLookups === undefined
          ? {}
          : { addressTableLookups: message.addressTableLookups as unknown[] }),
      },
    },
    meta:
      meta === null
        ? null
        : {
            err: meta.err ?? null,
            logMessages: (meta.logMessages ?? null) as string[] | null,
            ...(meta.loadedAddresses === undefined || meta.loadedAddresses === null
              ? {}
              : {
                  loadedAddresses: meta.loadedAddresses as {
                    writable: string[];
                    readonly: string[];
                  },
                }),
            innerInstructions: (meta.innerInstructions ?? null) as
              | { index: number; instructions: RawInstruction[] }[]
              | null,
          },
  };
  return checkRawTransaction(converted);
}

export function kitChainSource(url: string): ChainSource {
  const rpc = createSolanaRpc(url) as unknown as Record<string, RpcCall>;
  const call = (method: string, args: unknown[], signal: AbortSignal): Promise<unknown> => {
    const request = rpc[method];
    if (!request) throw new RpcShapeError(`the RPC client has no ${method}`);
    return request(...args).send({ abortSignal: signal });
  };

  return {
    async getGenesisHash(signal) {
      return text(await call("getGenesisHash", [], signal), "getGenesisHash");
    },

    async getSlot(commitment, signal) {
      return safeInteger(await call("getSlot", [{ commitment }], signal), "getSlot");
    },

    async getSignatures(before, minContextSlot, signal) {
      const config: Record<string, unknown> = {
        limit: 1000,
        commitment: "confirmed",
        minContextSlot: BigInt(minContextSlot),
        ...(before === null ? {} : { before }),
      };
      const result = list(
        await call("getSignaturesForAddress", [THETIS_PROGRAM_ADDRESS, config], signal),
        "getSignaturesForAddress",
      );
      return result.map((item, index) => {
        const entry = record(item, `getSignaturesForAddress[${index}]`);
        return {
          signature: text(entry.signature, `getSignaturesForAddress[${index}].signature`),
          slot: safeInteger(entry.slot, `getSignaturesForAddress[${index}].slot`),
          failed: entry.err !== null && entry.err !== undefined,
          blockTime: isoTime(entry.blockTime, `getSignaturesForAddress[${index}].blockTime`),
        };
      });
    },

    async getTransaction(signature, signal) {
      let result: unknown;
      try {
        result = await call(
          "getTransaction",
          [
            signature,
            { commitment: "confirmed", encoding: "json", maxSupportedTransactionVersion: 0 },
          ],
          signal,
        );
      } catch (error) {
        if (
          isSolanaError(error, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_UNSUPPORTED_TRANSACTION_VERSION)
        ) {
          throw new UnsupportedVersionError(signature);
        }
        throw error;
      }
      return result === null ? null : convertTransaction(result);
    },

    async getBlockTime(slot, signal) {
      try {
        return isoTime(await call("getBlockTime", [BigInt(slot)], signal), "getBlockTime");
      } catch (error) {
        if (isSolanaError(error, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_BLOCK_NOT_AVAILABLE))
          return null;
        throw error;
      }
    },

    async getMultipleAccounts(addresses, commitment, minContextSlot, signal) {
      const config: Record<string, unknown> = {
        commitment,
        encoding: "base64",
        ...(minContextSlot === null ? {} : { minContextSlot: BigInt(minContextSlot) }),
      };
      const result = record(
        await call("getMultipleAccounts", [addresses, config], signal),
        "getMultipleAccounts",
      );
      const values = list(result.value, "getMultipleAccounts.value");
      if (values.length !== addresses.length) {
        throw new RpcShapeError(
          `getMultipleAccounts: asked for ${addresses.length} accounts, got ${values.length}`,
        );
      }
      return {
        slot: safeInteger(
          record(result.context, "getMultipleAccounts.context").slot,
          "context.slot",
        ),
        accounts: values.map((item, index) =>
          parseBase64RpcAccount(
            addresses[index] as Address,
            item as Parameters<typeof parseBase64RpcAccount>[1],
          ),
        ),
      };
    },

    async getProgramAccounts(filter, signal) {
      const config = {
        commitment: "finalized",
        withContext: true,
        encoding: "base64",
        filters: [
          { memcmp: { offset: 8n, bytes: filter.offset8, encoding: "base58" } },
          ...(filter.dataSize === null ? [] : [{ dataSize: BigInt(filter.dataSize) }]),
        ],
      };
      const result = record(
        await call("getProgramAccounts", [THETIS_PROGRAM_ADDRESS, config], signal),
        "getProgramAccounts",
      );
      return {
        slot: safeInteger(
          record(result.context, "getProgramAccounts.context").slot,
          "context.slot",
        ),
        accounts: list(result.value, "getProgramAccounts.value").map((item, index) => {
          const entry = record(item, `getProgramAccounts[${index}]`);
          return parseBase64RpcAccount(
            text(entry.pubkey, `getProgramAccounts[${index}].pubkey`) as Address,
            entry.account as Parameters<typeof parseBase64RpcAccount>[1] & object,
          ) as EncodedAccount;
        }),
      };
    },

    async getSignatureStatuses(signatures, signal) {
      const result = record(
        await call(
          "getSignatureStatuses",
          [signatures, { searchTransactionHistory: true }],
          signal,
        ),
        "getSignatureStatuses",
      );
      const values = list(result.value, "getSignatureStatuses.value");
      if (values.length !== signatures.length) {
        throw new RpcShapeError(
          `getSignatureStatuses: asked for ${signatures.length} statuses, got ${values.length}`,
        );
      }
      return values.map((item, index) => {
        if (item === null) return null;
        const entry = record(item, `getSignatureStatuses[${index}]`);
        const status = entry.confirmationStatus;
        return {
          slot: safeInteger(entry.slot, `getSignatureStatuses[${index}].slot`),
          failed: entry.err !== null && entry.err !== undefined,
          confirmationStatus: typeof status === "string" ? status : null,
        };
      });
    },
  };
}
