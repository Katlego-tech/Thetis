import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Address, address } from "@solana/kit";

export interface IntentState {
  program: Address;
  batchId: string;
  batch: Address;
  sender: { wallet: Address; party: Address };
  receiver: { wallet: Address; party: Address };
  complete: boolean;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid intent relay state");
  }
  return value as Record<string, unknown>;
}

function readAddress(value: unknown): Address {
  if (typeof value !== "string") throw new Error("Missing address in intent relay state");
  return address(value);
}

function readParty(value: unknown): IntentState["sender"] {
  const { wallet, party } = object(value);
  return { wallet: readAddress(wallet), party: readAddress(party) };
}

export async function readIntentState(path: string): Promise<IntentState | null> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  const state = object(JSON.parse(contents));
  if (
    typeof state.batchId !== "string" ||
    !/^[0-9a-f]{32}$/.test(state.batchId) ||
    typeof state.complete !== "boolean"
  ) {
    throw new Error("Invalid intent relay checkpoint");
  }
  return {
    program: readAddress(state.program),
    batchId: state.batchId,
    batch: readAddress(state.batch),
    sender: readParty(state.sender),
    receiver: readParty(state.receiver),
    complete: state.complete,
  };
}

export async function writeIntentState(path: string, state: IntentState) {
  const directory = await mkdtemp(join(dirname(path), ".intent-spike-"));
  try {
    const file = join(directory, "state.json");
    await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(file, path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
