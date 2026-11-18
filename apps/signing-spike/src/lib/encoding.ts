import {
  getBase58Decoder,
  getBase58Encoder,
  getBase64Decoder,
  getBase64Encoder,
  type ReadonlyUint8Array,
} from "@solana/kit";

export const encodeBase58 = (bytes: ReadonlyUint8Array): string => getBase58Decoder().decode(bytes);
export const decodeBase58 = (value: string): ReadonlyUint8Array => getBase58Encoder().encode(value);
export const encodeBase64 = (bytes: ReadonlyUint8Array): string => getBase64Decoder().decode(bytes);

export function decodeBase64(value: string): ReadonlyUint8Array {
  const bytes = getBase64Encoder().encode(value);
  if (encodeBase64(bytes) !== value) throw new Error("Invalid base64");
  return bytes;
}
