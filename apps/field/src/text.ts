// The check a phone makes on a Thetis authorisation text before any wallet opens: the bytes are
// printable ASCII, the digest and validity line agree with the relay's view, and every line is
// exactly what the person entered.

import { formatSast } from "./format";
import { sha256Hex } from "./intake-digest";
import { decodeBase64 } from "./lib/encoding";

export type SignedAction =
  | "Issue lot"
  | "Hand over custody"
  | "Record observation"
  | "Record loading";

export interface ExpectedText {
  action: SignedAction;
  program: string;
  protocolInstanceHex: string;
  /** null: the line must be present, with any value. */
  fields: ReadonlyArray<readonly [label: string, value: string | null]>;
  validUntil: bigint;
}

export interface TextMismatch {
  line: number;
  label: string;
  expected: string;
  actual: string | null;
}

export type TextCheck = { ok: true } | { ok: false; mismatches: TextMismatch[] };

/** Decodes the relay's base64; every byte must be \n or 0x20..0x7E. Throws otherwise. */
export function checkMessageText(messageBase64: string): string {
  const bytes = decodeBase64(messageBase64);
  for (const byte of bytes) {
    if (byte !== 0x0a && (byte < 0x20 || byte > 0x7e)) {
      throw new Error("The text holds a byte that is not printable ASCII.");
    }
  }
  return String.fromCharCode(...bytes);
}

type ExpectedLine = { label: string; value: string | null };

function expectedLines(expected: ExpectedText): ExpectedLine[] {
  return [
    { label: "", value: "Thetis authorisation v1" },
    { label: "Network", value: "devnet" },
    { label: "Program", value: expected.program },
    { label: "Protocol", value: expected.protocolInstanceHex },
    { label: "Action", value: expected.action },
    ...expected.fields.map(([label, value]) => ({ label, value })),
    { label: "Valid until", value: formatSast(expected.validUntil) },
    { label: "", value: "Test network only. Synthetic data." },
  ];
}

function lineValue(line: string, label: string): string | null {
  if (label === "") return line;
  const prefix = `${label}: `;
  return line.startsWith(prefix) ? line.slice(prefix.length) : null;
}

export function checkSignedText(messageText: string, expected: ExpectedText): TextCheck {
  const actual = messageText.split("\n");
  const want = expectedLines(expected);
  const mismatches: TextMismatch[] = [];
  const count = Math.max(actual.length, want.length);
  for (let index = 0; index < count; index++) {
    const line = actual[index];
    const spec = want[index];
    if (!spec) {
      mismatches.push({ line: index + 1, label: "Extra line", expected: "", actual: line ?? null });
      continue;
    }
    const shown = spec.value ?? "any value";
    if (line === undefined) {
      mismatches.push({
        line: index + 1,
        label: spec.label || "Line",
        expected: shown,
        actual: null,
      });
      continue;
    }
    const value = lineValue(line, spec.label);
    const matches = value !== null && (spec.value === null || value === spec.value);
    if (!matches) {
      mismatches.push({
        line: index + 1,
        label: spec.label || "Line",
        expected: shown,
        actual: value ?? line.replace(/^[^:]+: /, ""),
      });
    }
  }
  return mismatches.length === 0 ? { ok: true } : { ok: false, mismatches };
}

export interface RelayText {
  messageBase64: string;
  messageSha256: string;
  validUntil: string;
  validUntilText: string;
}

/** Every §6.4 check on a command's text. A decode failure is reported as line 0. */
export function verifyCommandText(text: RelayText, expected: ExpectedText): TextCheck {
  let decoded: string;
  try {
    decoded = checkMessageText(text.messageBase64);
  } catch {
    return {
      ok: false,
      mismatches: [{ line: 0, label: "Bytes", expected: "printable ASCII", actual: null }],
    };
  }
  const digest = sha256Hex(decodeBase64(text.messageBase64) as Uint8Array);
  if (digest !== text.messageSha256) {
    return {
      ok: false,
      mismatches: [{ line: 0, label: "SHA-256", expected: text.messageSha256, actual: digest }],
    };
  }
  const validUntil = BigInt(text.validUntil);
  if (formatSast(validUntil) !== text.validUntilText) {
    return {
      ok: false,
      mismatches: [
        {
          line: 0,
          label: "Valid until",
          expected: formatSast(validUntil),
          actual: text.validUntilText,
        },
      ],
    };
  }
  if (validUntil !== expected.validUntil) {
    return {
      ok: false,
      mismatches: [
        {
          line: 0,
          label: "Valid until",
          expected: formatSast(expected.validUntil),
          actual: formatSast(validUntil),
        },
      ],
    };
  }
  return checkSignedText(decoded, expected);
}
