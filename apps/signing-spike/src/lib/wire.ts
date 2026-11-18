import {
  getCompiledTransactionMessageDecoder,
  getShortU16Encoder,
  type ReadonlyUint8Array,
} from "@solana/kit";

const SIGNATURE_BYTES = 64;

function decodeMessage(bytes: ReadonlyUint8Array) {
  const [message, end] = getCompiledTransactionMessageDecoder().read(bytes, 0);
  const { numSignerAccounts } = message.header;
  if (
    end !== bytes.length ||
    numSignerAccounts === 0 ||
    numSignerAccounts > message.staticAccounts.length
  ) {
    throw new Error("Invalid authorization message");
  }
  return message;
}

export function signatureIndex(
  messageBytes: ReadonlyUint8Array,
  address: string,
): number | undefined {
  const { header, staticAccounts } = decodeMessage(messageBytes);
  const index = staticAccounts.indexOf(address as (typeof staticAccounts)[number]);
  return index >= 0 && index < header.numSignerAccounts ? index : undefined;
}

export function wrapUnsignedTransaction(messageBytes: ReadonlyUint8Array): Uint8Array {
  const {
    version,
    header: { numSignerAccounts },
  } = decodeMessage(messageBytes);
  const slotBytes = SIGNATURE_BYTES * numSignerAccounts;
  // V1 reads the slot count from its header and places the slots after the message.
  if (version === 1) {
    const wire = new Uint8Array(messageBytes.length + slotBytes);
    wire.set(messageBytes);
    return wire;
  }

  const count = getShortU16Encoder().encode(numSignerAccounts);
  const wire = new Uint8Array(count.length + slotBytes + messageBytes.length);
  wire.set(count);
  wire.set(messageBytes, count.length + slotBytes);
  return wire;
}

export function getMessageSignature(
  payload: ReadonlyUint8Array,
  messageLength: number,
): ReadonlyUint8Array {
  if (payload.length !== SIGNATURE_BYTES && payload.length !== messageLength + SIGNATURE_BYTES) {
    throw new Error("Wallet returned a signed message with an unexpected length");
  }
  return payload.slice(-SIGNATURE_BYTES);
}
