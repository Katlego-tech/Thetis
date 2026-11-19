import type { ReadonlyUint8Array } from "@solana/kit";

const SIGNATURE_BYTES = 64;

export function getMessageSignature(payload: ReadonlyUint8Array): ReadonlyUint8Array | undefined {
  return payload.length >= SIGNATURE_BYTES ? payload.slice(-SIGNATURE_BYTES) : undefined;
}

function equalBytes(left: ReadonlyUint8Array, right: ReadonlyUint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

export function matchesSignedMessage(
  payload: ReadonlyUint8Array,
  message: ReadonlyUint8Array,
): boolean {
  return (
    payload.length === SIGNATURE_BYTES ||
    (payload.length === message.length + SIGNATURE_BYTES &&
      equalBytes(payload.subarray(0, message.length), message))
  );
}
