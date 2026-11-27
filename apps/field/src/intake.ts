// Intake form rules: field checks, the footer's first unmet condition, and the Issue lot text
// the phone expects back from the relay.
import type { IntakeDraft } from "./drafts/store";
import type { EvidenceItem, Purpose } from "./evidence/upload";
import { formatTonnes, parseTonnes } from "./format";
import { intakeDigest, normaliseTicket } from "./intake-digest";
import type { ExpectedText } from "./text";

export const LOT_ID = /^[A-Z0-9-]{1,16}$/;

export const FIELD_LABELS = {
  site: "Site",
  lotId: "Lot ID",
  owner: "Owner",
  grade: "Grade",
  quantity: "Quantity (tonnes)",
  ticket: "Weighbridge ticket number",
} as const;

export const FILE_LABELS: Record<Exclude<Purpose, "transport">, string> = {
  weighbridge: "Weighbridge ticket",
  assay: "Assay certificate",
  origin: "Origin document",
};

export function lotIdError(lotId: string): string | null {
  if (lotId === "") return null;
  return LOT_ID.test(lotId) ? null : "Use 1 to 16 capital letters, digits or hyphens.";
}

export function quantityError(text: string, touched: boolean): string | null {
  const parsed = parseTonnes(text);
  if (parsed === "empty") return touched ? "Enter the quantity in tonnes." : null;
  if (parsed === "shape")
    return "Use tonnes with up to three decimals, for example 5000 or 4999.875.";
  if (parsed === "zero") return "The quantity must be more than zero.";
  return null;
}

export function ticketError(raw: string): string | null {
  if (raw === "") return null;
  return normaliseTicket(raw) === null
    ? "Use letters, digits, spaces and common symbols only (no line breaks or accented letters), up to 64 characters."
    : null;
}

export function requiredPurposes(originRequired: boolean): Exclude<Purpose, "transport">[] {
  return originRequired ? ["weighbridge", "assay", "origin"] : ["weighbridge", "assay"];
}

export function latestFile(draft: IntakeDraft, purpose: Purpose): EvidenceItem | null {
  return draft.evidence.filter((item) => item.purpose === purpose).at(-1) ?? null;
}

export interface FooterInput {
  online: boolean;
  walletLinked: boolean;
  draft: IntakeDraft;
  originRequired: boolean;
}

/** The first unmet condition for "Review and sign", or null when it can be pressed. */
export function footerReason(input: FooterInput): string | null {
  const { draft } = input;
  if (!input.online) return "Offline. Your draft is saved on this phone.";
  if (!input.walletLinked) return "Connect a wallet first.";
  const values: [string, boolean][] = [
    [FIELD_LABELS.site, draft.custodianClass !== null],
    [FIELD_LABELS.lotId, draft.lotId !== ""],
    [FIELD_LABELS.owner, draft.ownerOrgId !== null],
    [FIELD_LABELS.grade, draft.grade !== null],
    [FIELD_LABELS.quantity, draft.quantityText.trim() !== ""],
    [FIELD_LABELS.ticket, draft.weighbridgeTicket !== ""],
  ];
  for (const [label, present] of values) if (!present) return `${label} needs a value.`;
  const errors: [string, string | null][] = [
    [FIELD_LABELS.lotId, lotIdError(draft.lotId)],
    [FIELD_LABELS.quantity, quantityError(draft.quantityText, true)],
    [FIELD_LABELS.ticket, ticketError(draft.weighbridgeTicket)],
  ];
  for (const [label, error] of errors) if (error) return `Fix ${label} first.`;
  for (const purpose of requiredPurposes(input.originRequired)) {
    if (latestFile(draft, purpose)?.upload !== "finalized")
      return `${FILE_LABELS[purpose]} not uploaded yet.`;
  }
  return null;
}

export interface IssueContext {
  program: string;
  protocolInstanceHex: string;
  classLabel: string;
  custodianName: string;
  originRequired: boolean;
}

/** The Issue lot text the phone expects, line for line, from the draft and the read model. */
export function expectedIssueText(
  draft: IntakeDraft,
  ctx: IssueContext,
  validUntil: bigint,
): ExpectedText {
  const kg = parseTonnes(draft.quantityText);
  const ticket = normaliseTicket(draft.weighbridgeTicket);
  if (typeof kg !== "bigint" || ticket === null || draft.siteCode === null) {
    throw new Error("The draft is not complete.");
  }
  return {
    action: "Issue lot",
    program: ctx.program,
    protocolInstanceHex: ctx.protocolInstanceHex,
    fields: [
      ["Lot", draft.lotId],
      ["Class", ctx.classLabel],
      ["Grade", draft.grade],
      ["Quantity", formatTonnes(kg)],
      ["Owner", draft.ownerName],
      ["Custodian", ctx.custodianName],
      ["Site", draft.siteCode],
      ["Intake", intakeDigest(draft.siteCode, ticket)],
      ["Origin document", ctx.originRequired ? null : "not required"],
    ],
    validUntil,
  };
}

/** The `issue_lot` args, exactly as the relay takes them. */
export function issueArgs(draft: IntakeDraft, ownerOrgId: string): Record<string, string> {
  const kg = parseTonnes(draft.quantityText);
  const ticket = normaliseTicket(draft.weighbridgeTicket);
  if (
    typeof kg !== "bigint" ||
    ticket === null ||
    draft.custodianClass === null ||
    draft.grade === null
  ) {
    throw new Error("The draft is not complete.");
  }
  return {
    custodianClass: draft.custodianClass,
    owner: ownerOrgId,
    lotId: draft.lotId,
    grade: draft.grade,
    quantityKg: kg.toString(),
    weighbridgeTicket: ticket,
  };
}

/** Reads one `Label: value` line from a decoded text. */
export function textLine(text: string, label: string): string | null {
  const prefix = `${label}: `;
  return (
    text
      .split("\n")
      .find((line) => line.startsWith(prefix))
      ?.slice(prefix.length) ?? null
  );
}
