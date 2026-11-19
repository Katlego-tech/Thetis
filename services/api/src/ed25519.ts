import { createPublicKey, verify } from "node:crypto";

const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");

export function decodeBase58(encoded: string): Buffer | null {
  let value = 0n;
  let leadingZeroes = 0;
  while (encoded.charAt(leadingZeroes) === "1") leadingZeroes++;

  for (const character of encoded) {
    const digit = alphabet.indexOf(character);
    if (digit === -1) return null;
    value = value * 58n + BigInt(digit);
  }

  const bytes = [];
  while (value > 0n) {
    bytes.push(Number(value & 255n));
    value >>= 8n;
  }
  return Buffer.concat([Buffer.alloc(leadingZeroes), Buffer.from(bytes.reverse())]);
}

export function verifyEd25519(wallet: Buffer, message: Buffer, signature: Buffer): boolean {
  if (wallet.length !== 32 || signature.length !== 64) return false;
  const key = createPublicKey({
    key: Buffer.concat([spkiPrefix, wallet]),
    format: "der",
    type: "spki",
  });
  return verify(null, message, key, signature);
}
