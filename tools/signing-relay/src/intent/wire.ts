import {
  AccountRole,
  type Address,
  address,
  getAddressDecoder,
  type Instruction,
  isOffCurveAddress,
} from "@solana/kit";
import { account, discriminator, keyBytes, sha256, SYSTEM, u32, u64 } from "../wire.ts";

export const INTENT_PROGRAM_KEY = "intent_spike";
export const CUSTODY_WINDOW_SECS = 600n;
export const ISSUE_MARGIN_SECS = 30n;
export const LOT_ID = "CR-0001";
export const FROM = "Kopano Stockyard Custody";
export const TO = "Mosela Haulage";
export const QUANTITY_KG = 2_000_000n;

const INSTRUCTIONS = address("Sysvar1nstructions1111111111111111111111111");
const ED25519 = address("Ed25519SigVerify111111111111111111111111111");
const PDA_MARKER = Buffer.from("ProgramDerivedAddress");

function deriveAddress(program: Address, prefix: string, seed: Uint8Array): Address {
  // The instruction builders are synchronous. Use Kit's curve check with Node's SHA-256.
  const decoder = getAddressDecoder();
  const programBytes = keyBytes(program);
  for (let bump = 255; bump >= 0; bump--) {
    const hash = sha256(
      Buffer.concat([Buffer.from(prefix), seed, Buffer.of(bump), programBytes, PDA_MARKER]),
    );
    const candidate = decoder.decode(hash);
    if (isOffCurveAddress(candidate)) return candidate;
  }
  throw new Error(`Cannot derive ${prefix} PDA`);
}

function partyPda(program: Address, wallet: Address): Address {
  return deriveAddress(program, "party", keyBytes(wallet));
}

function batchPda(program: Address, id: Uint8Array): Address {
  if (id.length !== 16) throw new Error("Batch ID must be 16 bytes");
  return deriveAddress(program, "batch", id);
}

export async function partyAddress(program: Address, wallet: Address): Promise<Address> {
  return partyPda(program, wallet);
}

export async function batchAddress(program: Address, id: Uint8Array): Promise<Address> {
  return batchPda(program, id);
}

function borshString(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([u32(bytes.length), bytes]);
}

function i64(value: bigint): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigInt64LE(value);
  return bytes;
}

export function registerPartyInstruction(
  program: Address,
  payer: Address,
  wallet: Address,
  displayName: string,
): Instruction {
  return {
    programAddress: program,
    accounts: [
      account(payer, AccountRole.WRITABLE_SIGNER),
      account(partyPda(program, wallet), AccountRole.WRITABLE),
      account(SYSTEM),
    ],
    data: Buffer.concat([
      discriminator("global:register_party"),
      keyBytes(wallet),
      borshString(displayName),
    ]),
  };
}

export function openBatchInstruction(
  program: Address,
  payer: Address,
  id: Uint8Array,
  senderWallet: Address,
  receiverWallet: Address,
  quantityKg: bigint,
  lotId: string,
): Instruction {
  return {
    programAddress: program,
    accounts: [
      account(payer, AccountRole.WRITABLE_SIGNER),
      account(batchPda(program, id), AccountRole.WRITABLE),
      account(partyPda(program, senderWallet)),
      account(partyPda(program, receiverWallet)),
      account(SYSTEM),
    ],
    data: Buffer.concat([
      discriminator("global:open_batch"),
      id,
      keyBytes(senderWallet),
      keyBytes(receiverWallet),
      u64(quantityKg),
      borshString(lotId),
    ]),
  };
}

export function handoverInstruction(
  program: Address,
  id: Uint8Array,
  sender: Address,
  receiver: Address,
  quantityKg: bigint,
  validUntil: bigint,
  expectedSequence: bigint,
): Instruction {
  return {
    programAddress: program,
    accounts: [
      account(batchPda(program, id), AccountRole.WRITABLE),
      account(sender),
      account(receiver),
      account(INSTRUCTIONS),
    ],
    data: Buffer.concat([
      discriminator("global:handover"),
      id,
      u64(quantityKg),
      i64(validUntil),
      u64(expectedSequence),
    ]),
  };
}

type VerificationEntry = { publicKey: Address; signature: Uint8Array };

export function ed25519VerifyInstruction(
  entries: [VerificationEntry, VerificationEntry],
  message: Uint8Array,
): Instruction {
  const headerBytes = 2 + 2 * 14;
  const entryBytes = 32 + 64;
  const messageOffset = headerBytes + 2 * entryBytes;
  const data = Buffer.alloc(messageOffset + message.length);
  data[0] = 2;
  entries.forEach(({ publicKey, signature }, index) => {
    if (signature.length !== 64) throw new Error("Ed25519 signatures must be 64 bytes");
    const keyOffset = headerBytes + index * entryBytes;
    const signatureOffset = keyOffset + 32;
    const offsets = [
      signatureOffset,
      0xffff,
      keyOffset,
      0xffff,
      messageOffset,
      message.length,
      0xffff,
    ];
    offsets.forEach((value, field) => data.writeUInt16LE(value, 2 + index * 14 + field * 2));
    data.set(keyBytes(publicKey), keyOffset);
    data.set(signature, signatureOffset);
  });
  data.set(message, messageOffset);
  return { programAddress: ED25519, accounts: [], data };
}

export interface BatchAccount {
  id: Uint8Array;
  lotId: string;
  sender: Address;
  receiver: Address;
  quantityKg: bigint;
  sequence: bigint;
  handedOver: boolean;
  bump: number;
}

export interface PartyAccount {
  wallet: Address;
  displayName: string;
  bump: number;
}

function accountReader(data: Uint8Array, name: string) {
  const bytes = Buffer.from(data);
  let offset = 8;
  if (!bytes.subarray(0, offset).equals(discriminator(`account:${name}`))) {
    throw new Error(`Invalid ${name} account discriminator`);
  }
  function take(length: number) {
    const end = offset + length;
    if (end > bytes.length) throw new Error(`Truncated ${name} account`);
    const value = bytes.subarray(offset, end);
    offset = end;
    return value;
  }
  return {
    take,
    key: () => getAddressDecoder().decode(take(32)),
    string(max: number) {
      const length = take(4).readUInt32LE();
      if (length === 0 || length > max) throw new Error(`Invalid ${name} string length`);
      return take(length).toString("utf8");
    },
    u64: () => take(8).readBigUInt64LE(),
    byte: () => take(1).readUInt8(),
  };
}

export function decodeBatch(data: Uint8Array): BatchAccount {
  const reader = accountReader(data, "Batch");
  const id = reader.take(16);
  const lotId = reader.string(16);
  const sender = reader.key();
  const receiver = reader.key();
  const quantityKg = reader.u64();
  const sequence = reader.u64();
  const handedOver = reader.byte();
  if (handedOver > 1) throw new Error("Invalid Batch handed-over flag");
  return {
    id,
    lotId,
    sender,
    receiver,
    quantityKg,
    sequence,
    handedOver: handedOver === 1,
    bump: reader.byte(),
  };
}

export function decodeParty(data: Uint8Array): PartyAccount {
  const reader = accountReader(data, "Party");
  return { wallet: reader.key(), displayName: reader.string(48), bump: reader.byte() };
}
