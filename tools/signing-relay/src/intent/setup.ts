import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Address, KeyPairSigner } from "@solana/kit";
import { acquireSetupLock } from "../setup.ts";
import { type ChainTransport, requireDevnet, sendConfirmed } from "../transport.ts";
import { type IntentState, readIntentState, writeIntentState } from "./state.ts";
import {
  batchAddress,
  decodeBatch,
  decodeParty,
  FROM,
  LOT_ID,
  openBatchInstruction,
  partyAddress,
  QUANTITY_KG,
  registerPartyInstruction,
  TO,
} from "./wire.ts";

async function programAccount(transport: ChainTransport, key: Address, program: Address) {
  const account = await transport.getAccount(key);
  if (account && account.owner !== program)
    throw new Error(`Unexpected owner for intent account ${key}`);
  return account?.data;
}

export async function readIntentParty(
  transport: ChainTransport,
  state: IntentState,
  role: "sender" | "receiver",
) {
  const { wallet, party } = state[role];
  if (party !== (await partyAddress(state.program, wallet)))
    throw new Error(`Invalid ${role} Party address`);
  const data = await programAccount(transport, party, state.program);
  if (!data) return null;
  const value = decodeParty(data);
  if (value.wallet !== wallet) throw new Error(`Unexpected wallet for ${role} Party ${party}`);
  return value;
}

export async function readIntentBatch(transport: ChainTransport, state: IntentState) {
  const id = Buffer.from(state.batchId, "hex");
  if (state.batch !== (await batchAddress(state.program, id)))
    throw new Error("Invalid intent Batch address");
  const data = await programAccount(transport, state.batch, state.program);
  if (!data) return null;
  const batch = decodeBatch(data);
  if (
    !id.equals(batch.id) ||
    batch.sender !== state.sender.party ||
    batch.receiver !== state.receiver.party
  ) {
    throw new Error("Intent Batch does not match the configured ID and parties");
  }
  return batch;
}

export async function setupIntent(
  transport: ChainTransport,
  sponsor: KeyPairSigner,
  program: Address,
  sender: Address,
  receiver: Address,
  path?: string,
  displayNames = { sender: FROM, receiver: TO },
): Promise<IntentState> {
  await requireDevnet(transport);
  if (sender === receiver) throw new Error("Intent sender and receiver must be different wallets");
  if (path) await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const release = path ? await acquireSetupLock(`${path}.lock`) : undefined;
  try {
    const previous = path ? await readIntentState(path) : null;
    const id = previous ? Buffer.from(previous.batchId, "hex") : randomBytes(16);
    const state: IntentState = {
      program,
      batchId: id.toString("hex"),
      batch: await batchAddress(program, id),
      sender: { wallet: sender, party: await partyAddress(program, sender) },
      receiver: { wallet: receiver, party: await partyAddress(program, receiver) },
      complete: previous?.complete ?? false,
    };
    if (
      previous &&
      (previous.program !== program ||
        previous.batch !== state.batch ||
        previous.sender.party !== state.sender.party ||
        previous.receiver.party !== state.receiver.party ||
        previous.sender.wallet !== sender ||
        previous.receiver.wallet !== receiver)
    ) {
      throw new Error("Existing intent state does not match the configured program and wallets");
    }

    const roles = ["sender", "receiver"] as const;
    const parties = await Promise.all(roles.map((role) => readIntentParty(transport, state, role)));
    for (const [index, role] of roles.entries()) {
      const party = parties[index];
      if (party && party.displayName !== displayNames[role]) {
        throw new Error(
          `Existing ${role} Party display name does not match "${displayNames[role]}"`,
        );
      }
      if (!party && state.complete)
        throw new Error(`Missing ${role} Party for completed intent setup`);
    }

    const batch = await readIntentBatch(transport, state);
    if (batch && (batch.lotId !== LOT_ID || batch.quantityKg !== QUANTITY_KG)) {
      throw new Error("Existing intent Batch has a different lot or quantity");
    }
    if (state.complete) {
      if (!batch) throw new Error("Missing Batch for completed intent setup");
      return state;
    }

    // Reuse the same batch PDA after interruption, including a lost confirmation response.
    if (path && !previous) await writeIntentState(path, state);
    for (const [index, role] of roles.entries()) {
      if (parties[index]) continue;
      await sendConfirmed(transport, sponsor, [
        registerPartyInstruction(program, sponsor.address, state[role].wallet, displayNames[role]),
      ]);
    }
    if (!batch) {
      await sendConfirmed(transport, sponsor, [
        openBatchInstruction(program, sponsor.address, id, sender, receiver, QUANTITY_KG, LOT_ID),
      ]);
    }
    state.complete = true;
    if (path) await writeIntentState(path, state);
    return state;
  } finally {
    await release?.();
  }
}
