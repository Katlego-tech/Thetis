import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

const PRINTABLE = /^[\x20-\x7E]*$/;

/** The weighbridge ticket as the relay and the program see it, or null when it can't be used. */
export function normaliseTicket(raw: string): string | null {
  if (!PRINTABLE.test(raw)) return null;
  const ticket = raw.replaceAll(" ", "").toUpperCase();
  return ticket.length >= 1 && ticket.length <= 64 ? ticket : null;
}

export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

/** SHA-256 of "thetis-intake-v1\n<site>\n<ticket>", 64 lowercase hex. */
export function intakeDigest(siteCode: string, ticket: string): string {
  return sha256Hex(utf8ToBytes(`thetis-intake-v1\n${siteCode}\n${ticket}`));
}
