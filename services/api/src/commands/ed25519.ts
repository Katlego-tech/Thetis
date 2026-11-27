// One Ed25519 precompile instruction for a text-signed command (signing-inhouse.md §6.4,
// program-lots.md §10): one entry per text signer, in `signers` order, every entry pointing at
// the single copy of the shared message; every instruction-index field is 0xFFFF.
import { type Address, getAddressEncoder, type Instruction } from "@solana/kit";

export const ED25519_PROGRAM = "Ed25519SigVerify111111111111111111111111111" as Address;

export function sharedMessageInstruction(
  entries: readonly { wallet: Address; signature: Uint8Array }[],
  message: Uint8Array,
): Instruction {
  const count = entries.length;
  const entriesAt = 2 + 14 * count;
  const messageOffset = entriesAt + 96 * count;
  if (messageOffset + message.length > 0xffff) throw new Error("Ed25519 message is too long");
  const data = new Uint8Array(messageOffset + message.length);
  const view = new DataView(data.buffer);
  data[0] = count;
  entries.forEach(({ wallet, signature }, index) => {
    if (signature.length !== 64) throw new Error("Ed25519 signatures are 64 bytes");
    const signatureOffset = entriesAt + 96 * index;
    const fields = [signatureOffset, 0xffff, signatureOffset + 64, 0xffff, messageOffset, message.length, 0xffff];
    fields.forEach((value, field) => view.setUint16(2 + 14 * index + 2 * field, value, true));
    data.set(signature, signatureOffset);
    data.set(getAddressEncoder().encode(wallet), signatureOffset + 64);
  });
  data.set(message, messageOffset);
  return { programAddress: ED25519_PROGRAM, accounts: [], data };
}
