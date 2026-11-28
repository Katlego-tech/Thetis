// Pure rules for the custody screens: the texts a phone expects to be asked to sign, the next
// holder of a batch, and the small formats the screens share. No React and no I/O.
import type { CommandView } from "./api/commands";
import type { AcceptanceState, FieldBatch, LoadingIntent } from "./api/field";
import { formatSast, formatTonnes } from "./format";
import {
  checkMessageText,
  type ExpectedText,
  type RelayText,
  type TextCheck,
  verifyCommandText,
} from "./text";

export const HANDOVER_STAGES = ["Departure", "Arrival", "Transfer"] as const;

/** "batch 1 of 1" (lower case, as the confirmation copy uses it). */
export function batchLine(index: number, batchCount: number): string {
  return `batch ${index} of ${batchCount}`;
}

/** The next holder a holder hands to: at source the carrier, in transit the destination custodian. */
export function nextHolderOf(
  batch: FieldBatch,
): { address: string; name: string; why: string } | null {
  switch (batch.stage) {
    case "AtSource":
      return {
        address: batch.carrier,
        name: batch.carrierName,
        why: "The carrier on the manifest",
      };
    case "InTransit":
      return {
        address: batch.destinationCustodian,
        name: batch.destinationName,
        why: "The destination custodian",
      };
    case "Arrived":
      return null;
  }
}

interface Envelope {
  program: string;
  protocolInstanceHex: string;
  validUntil: bigint;
}

export function expectedHandoverText(
  input: Envelope & {
    lotId: string;
    index: number;
    batchCount: number;
    quantityKg: bigint;
    from: string;
    to: string;
  },
): ExpectedText {
  return {
    action: "Hand over custody",
    program: input.program,
    protocolInstanceHex: input.protocolInstanceHex,
    validUntil: input.validUntil,
    fields: [
      ["Lot", input.lotId],
      ["Shipment", null],
      ["Batch", `${input.index} of ${input.batchCount}`],
      ["Quantity", formatTonnes(input.quantityKg)],
      ["From", input.from],
      ["To", input.to],
      ["Stage", null],
      ["Manifest", null],
      ["Sequence", null],
    ],
  };
}

/**
 * The relay-text checks, then the Stage line: the relay chooses it from the batch's state, so the
 * phone accepts any of the three words but nothing else.
 */
export function checkHandoverText(text: RelayText, expected: ExpectedText): TextCheck {
  const base = verifyCommandText(text, expected);
  if (!base.ok) return base;
  const lines = checkMessageText(text.messageBase64).split("\n");
  const at = lines.findIndex((line) => line.startsWith("Stage: "));
  const stage = at === -1 ? null : (lines[at]?.slice("Stage: ".length) ?? null);
  if (stage !== null && (HANDOVER_STAGES as readonly string[]).includes(stage)) {
    return { ok: true };
  }
  return {
    ok: false,
    mismatches: [
      {
        line: at === -1 ? 0 : at + 1,
        label: "Stage",
        expected: "Departure, Arrival or Transfer",
        actual: stage,
      },
    ],
  };
}

export function expectedObservationText(
  input: Envelope & {
    lotId: string;
    index: number;
    batchCount: number;
    holder: string;
    observer: string;
    locationCode: string;
    evidenceSha256: string;
    observedAt: bigint;
  },
): ExpectedText {
  return {
    action: "Record observation",
    program: input.program,
    protocolInstanceHex: input.protocolInstanceHex,
    validUntil: input.validUntil,
    fields: [
      ["Lot", input.lotId],
      ["Shipment", null],
      ["Batch", `${input.index} of ${input.batchCount}`],
      ["Holder", input.holder],
      ["Observer", input.observer],
      ["Kind", "Border"],
      ["Location", input.locationCode],
      ["Evidence", input.evidenceSha256],
      ["Observed at", formatSast(input.observedAt)],
      ["Observation", null],
    ],
  };
}

export function expectedLoadingText(
  input: Envelope & { intent: LoadingIntent; terminalName: string },
): ExpectedText {
  const { intent } = input;
  const accepted = intent.acceptances.filter((a) => a.state === "accepted").length;
  return {
    action: "Record loading",
    program: input.program,
    protocolInstanceHex: input.protocolInstanceHex,
    validUntil: input.validUntil,
    fields: [
      ["Lot", intent.lotId],
      ["Quantity", formatTonnes(BigInt(intent.quantityKg))],
      ["Owner", intent.ownerName],
      ["Terminal", input.terminalName],
      ["Loading document", intent.documentSha256],
      ["Intent", intent.nonce],
      ["Locked", formatTonnes(BigInt(intent.lockedKg))],
      ["Loan acceptances", String(accepted)],
      ["Revision", null],
    ],
  };
}

/** Value of a `Label: value` field in a command's fields list, or null. */
export function fieldValue(view: CommandView, label: string): string | null {
  return view.fields.find((field) => field.label === label)?.value ?? null;
}

export const LOCATION_CODE = /^[A-Z0-9-]{1,16}$/;

/** The typed text uppercased, nothing else changed; validity is LOCATION_CODE. */
export function normaliseLocation(raw: string): string {
  return raw.toUpperCase();
}

export function locationError(code: string): string | null {
  if (code === "" || LOCATION_CODE.test(code)) return null;
  return "Use 1 to 16 capital letters, digits or hyphens, for example BORDER-1.";
}

/** The first 8 characters of a command id, read aloud between phones. */
export function shortCode(commandId: string): string {
  return commandId.slice(0, 8);
}

export function intentExpired(intent: LoadingIntent, nowUnix: bigint): boolean {
  return nowUnix >= BigInt(intent.expiresAt);
}

/** "2026-11-28 12:51 SAST": formatSast without seconds. */
export function formatSastMinute(unix: bigint): string {
  return formatSast(unix).replace(/:\d{2} SAST$/, " SAST");
}

/** One warning line per acceptance not accepted, in list order. */
export function acceptanceWarnings(intent: LoadingIntent): string[] {
  const lines: string[] = [];
  for (const acceptance of intent.acceptances) {
    if (acceptance.state === "missing") {
      lines.push(
        `${acceptance.lenderName} has not accepted this hand-off. Thetis will refuse the loading until every lender with a lock accepts.`,
      );
    } else if (acceptance.state === "stale") {
      lines.push(
        `${acceptance.lenderName} accepted before the loan changed, so Thetis will refuse the loading until it accepts again.`,
      );
    }
  }
  return lines;
}

export function acceptanceLabel(state: AcceptanceState): string {
  switch (state) {
    case "accepted":
      return "Accepted";
    case "missing":
      return "Not accepted";
    case "stale":
      return "Accepted before a change";
  }
}
