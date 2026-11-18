import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Address, address, type Signature, signature } from "@solana/kit";
import type { Party, RelayState } from "./wire.ts";

export interface SetupProgress {
  complete: false;
  program: Address;
  sponsor: Address;
  sender: Party;
  receiver: Party;
  batchId?: string;
  batch?: Address;
  nonce?: Address;
  lookupTable?: Address;
  pending?: {
    signature: Signature;
    lastValidBlockHeight: string;
  };
}

type StateFile = SetupProgress | (RelayState & { complete: true });

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid signing relay state");
  }
  return value as Record<string, unknown>;
}

function readAddress(value: unknown): Address {
  if (typeof value !== "string") throw new Error("Missing signing relay address");
  return address(value);
}

function readParty(value: unknown): Party {
  const party = object(value);
  return {
    wallet: readAddress(party.wallet),
    party: readAddress(party.party),
    signer: readAddress(party.signer),
  };
}

function readBatchId(value: unknown) {
  if (typeof value !== "string" || !/^[0-9a-f]{32}$/.test(value)) {
    throw new Error("Invalid batch ID in signing relay state");
  }
  return value;
}

function readPending(value: unknown) {
  const pending = object(value);
  if (
    typeof pending.signature !== "string" ||
    typeof pending.lastValidBlockHeight !== "string" ||
    !/^\d+$/.test(pending.lastValidBlockHeight)
  ) {
    throw new Error("Invalid pending transaction in signing relay state");
  }
  return {
    signature: signature(pending.signature),
    lastValidBlockHeight: pending.lastValidBlockHeight,
  };
}

export async function readState(path: string): Promise<StateFile | null> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }

  const state = object(JSON.parse(contents));
  const common = {
    program: readAddress(state.program),
    sender: readParty(state.sender),
    receiver: readParty(state.receiver),
  };
  if (state.complete === false) {
    const progress: SetupProgress = {
      ...common,
      complete: false,
      sponsor: readAddress(state.sponsor),
    };
    if (state.batch !== undefined) {
      progress.batch = readAddress(state.batch);
      progress.batchId = readBatchId(state.batchId);
    }
    if (state.nonce !== undefined) progress.nonce = readAddress(state.nonce);
    if (state.lookupTable !== undefined) progress.lookupTable = readAddress(state.lookupTable);
    if (state.pending !== undefined) progress.pending = readPending(state.pending);
    if (
      (state.batchId !== undefined && !progress.batch) ||
      ((progress.nonce || progress.pending) && !progress.batch) ||
      (progress.lookupTable && !progress.nonce)
    ) {
      throw new Error("Invalid setup checkpoint in signing relay state");
    }
    return progress;
  }

  // State files written before checkpointing were published only after setup completed.
  if ((state.complete !== undefined && state.complete !== true) || state.pending !== undefined) {
    throw new Error("Invalid signing relay state");
  }
  return {
    ...common,
    complete: true,
    batchId: readBatchId(state.batchId),
    batch: readAddress(state.batch),
    nonce: readAddress(state.nonce),
    lookupTable: readAddress(state.lookupTable),
  };
}

export async function requireCompleteState(path: string) {
  const state = await readState(path);
  if (!state?.complete) throw new Error(`Run signing-relay setup to complete ${path}`);
  return state;
}

export async function writeState(path: string, state: StateFile) {
  const temporaryDirectory = await mkdtemp(join(dirname(path), ".signing-spike-"));
  try {
    const temporaryFile = join(temporaryDirectory, "state.json");
    await writeFile(temporaryFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    // Replace the checkpoint atomically while setup holds the state file's lock.
    await rename(temporaryFile, path);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
