// Signed texts and digests (live-lending.md §6.7). The builders reproduce the program's
// `intent/message.rs` byte for byte; program-lending.md §6.2's vectors pin them.
import { createHash } from "node:crypto";

function group(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// formatTonnes and formatSast: copied unchanged from tools/signing-relay/src/intent/message.ts.
export function formatTonnes(kg: bigint): string {
  const tonnes = (kg / 1000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${tonnes}.${(kg % 1000n).toString().padStart(3, "0")} t`;
}

export function formatSast(unix: bigint): string {
  const local = unix + 7200n;
  const seconds = local % 86400n;

  // Use March-based Gregorian years to match the program over the full i64 range.
  const days = local / 86400n + 719468n;
  const era = days / 146097n;
  const dayOfEra = days % 146097n;
  const yearOfEra = (dayOfEra - dayOfEra / 1460n + dayOfEra / 36524n - dayOfEra / 146096n) / 365n;
  const dayOfYear = dayOfEra - (365n * yearOfEra + yearOfEra / 4n - yearOfEra / 100n);
  const marchMonth = (5n * dayOfYear + 2n) / 153n;
  const day = dayOfYear - (153n * marchMonth + 2n) / 5n + 1n;
  const month = marchMonth < 10n ? marchMonth + 3n : marchMonth - 9n;
  const year = era * 400n + yearOfEra + (month <= 2n ? 1n : 0n);

  const pad = (value: bigint, width = 2) => value.toString().padStart(width, "0");
  return `${pad(year, 4)}-${pad(month)}-${pad(day)} ${pad(seconds / 3600n)}:${pad((seconds / 60n) % 60n)}:${pad(seconds % 60n)} SAST`;
}

/** `<code> <whole>[.<fraction>]`, comma-grouped whole part (program-lending.md §6.2). */
export function formatMoney(minor: bigint, decimals: number, code: string): string {
  const digits = minor.toString().padStart(decimals + 1, "0");
  const whole = group(digits.slice(0, digits.length - decimals));
  return decimals === 0
    ? `${code} ${whole}`
    : `${code} ${whole}.${digits.slice(digits.length - decimals)}`;
}

/** Basis points as a percentage with two decimals: 6000 is `60.00%`. */
export function formatBps(bps: bigint): string {
  return `${bps / 100n}.${(bps % 100n).toString().padStart(2, "0")}%`;
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/** program-lots.md §6.2's envelope: UTF-8, `\n` line ends, no trailing newline. */
export function envelope(
  programId: string,
  instanceIdHex: string,
  action: string,
  fields: readonly (readonly [string, string])[],
  validUntil: bigint,
): Uint8Array {
  const lines = [
    "Thetis authorisation v1",
    "Network: devnet",
    `Program: ${programId}`,
    `Protocol: ${instanceIdHex}`,
    `Action: ${action}`,
    ...fields.map(([label, value]) => `${label}: ${value}`),
    `Valid until: ${formatSast(validUntil)}`,
    "Test network only. Synthetic data.",
  ];
  return new TextEncoder().encode(lines.join("\n"));
}

/** The field lines of a text (between `Action:` and `Valid until:`), as `[label, value]`. */
export function textFields(text: Uint8Array): { label: string; value: string }[] {
  const lines = new TextDecoder().decode(text).split("\n");
  return lines.slice(5, -2).map((line) => {
    const at = line.indexOf(": ");
    return { label: line.slice(0, at), value: line.slice(at + 2) };
  });
}

const rate = (bps: bigint) => `${formatBps(bps)} a year, simple, actual/365`;

export function pledgeMessage(
  programId: string,
  instanceId: Uint8Array,
  lotId: string,
  quantityKg: bigint,
  owner: string,
  lender: string,
  facilityId: Uint8Array,
  loanIndex: number,
  currency: string,
  rateBps: bigint,
  maxLtvBps: bigint,
  termsVersion: bigint,
  expectedRevision: bigint,
  validUntil: bigint,
): Uint8Array {
  return envelope(
    programId,
    hex(instanceId),
    "Pledge receipts",
    [
      ["Lot", lotId],
      ["Quantity", formatTonnes(quantityKg)],
      ["Owner", owner],
      ["Lender", lender],
      ["Facility", hex(facilityId)],
      ["Loan", String(loanIndex)],
      ["Currency", currency],
      ["Rate", rate(rateBps)],
      ["Max LTV", formatBps(maxLtvBps)],
      ["Terms", `v${termsVersion}`],
      ["Revision", String(expectedRevision)],
    ],
    validUntil,
  );
}

export function advanceMessage(
  programId: string,
  instanceId: Uint8Array,
  lotId: string,
  owner: string,
  lender: string,
  facilityId: Uint8Array,
  loanIndex: number,
  amount: bigint,
  principalAfter: bigint,
  currency: string,
  decimals: number,
  rateBps: bigint,
  termsVersion: bigint,
  expectedRevision: bigint,
  validUntil: bigint,
): Uint8Array {
  return envelope(
    programId,
    hex(instanceId),
    "Accept advance",
    [
      ["Lot", lotId],
      ["Owner", owner],
      ["Lender", lender],
      ["Facility", hex(facilityId)],
      ["Loan", String(loanIndex)],
      ["Advance", formatMoney(amount, decimals, currency)],
      ["Principal after", formatMoney(principalAfter, decimals, currency)],
      ["Rate", rate(rateBps)],
      ["Terms", `v${termsVersion}`],
      ["Revision", String(expectedRevision)],
    ],
    validUntil,
  );
}

export function borrowMessage(
  programId: string,
  instanceId: Uint8Array,
  lotId: string,
  owner: string,
  lender: string,
  facilityId: Uint8Array,
  loanIndex: number,
  amount: bigint,
  principalAfter: bigint,
  currency: string,
  decimals: number,
  destination: string,
  rateBps: bigint,
  expectedRevision: bigint,
  validUntil: bigint,
): Uint8Array {
  return envelope(
    programId,
    hex(instanceId),
    "Borrow test tokens",
    [
      ["Lot", lotId],
      ["Owner", owner],
      ["Lender", lender],
      ["Facility", hex(facilityId)],
      ["Loan", String(loanIndex)],
      ["Amount", formatMoney(amount, decimals, currency)],
      ["Principal after", formatMoney(principalAfter, decimals, currency)],
      ["Pay to", destination],
      ["Rate", rate(rateBps)],
      ["Revision", String(expectedRevision)],
    ],
    validUntil,
  );
}

export function releaseIntentMessage(
  programId: string,
  instanceId: Uint8Array,
  lotId: string,
  quantityKg: bigint,
  seller: string,
  buyer: string,
  lender: string,
  facilityId: Uint8Array,
  loanIndex: number,
  nonce: bigint,
  price: bigint,
  topUp: bigint,
  currency: string,
  decimals: number,
  expiresAt: bigint,
  expectedRevision: bigint,
  validUntil: bigint,
): Uint8Array {
  return envelope(
    programId,
    hex(instanceId),
    "Create release intent",
    [
      ["Lot", lotId],
      ["Quantity", formatTonnes(quantityKg)],
      ["Seller", seller],
      ["Buyer", buyer],
      ["Lender", lender],
      ["Facility", hex(facilityId)],
      ["Loan", String(loanIndex)],
      ["Intent", String(nonce)],
      ["Price", formatMoney(price, decimals, currency)],
      ["Top-up", formatMoney(topUp, decimals, currency)],
      ["Intent expires", formatSast(expiresAt)],
      ["Revision", String(expectedRevision)],
    ],
    validUntil,
  );
}

export function buyPledgedMessage(
  programId: string,
  instanceId: Uint8Array,
  lotId: string,
  quantityKg: bigint,
  seller: string,
  buyer: string,
  lender: string,
  facilityId: Uint8Array,
  loanIndex: number,
  nonce: bigint,
  price: bigint,
  topUp: bigint,
  currency: string,
  decimals: number,
  expectedRevision: bigint,
  validUntil: bigint,
): Uint8Array {
  return envelope(
    programId,
    hex(instanceId),
    "Buy pledged receipts",
    [
      ["Lot", lotId],
      ["Quantity", formatTonnes(quantityKg)],
      ["Seller", seller],
      ["Buyer", buyer],
      ["Lender", lender],
      ["Facility", hex(facilityId)],
      ["Loan", String(loanIndex)],
      ["Intent", String(nonce)],
      ["Price", formatMoney(price, decimals, currency)],
      ["Top-up", formatMoney(topUp, decimals, currency)],
      ["Revision", String(expectedRevision)],
    ],
    validUntil,
  );
}

function sha256(text: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(text, "utf8").digest());
}

export function termsDigest(terms: {
  lenderOrgId: string;
  borrowerOrgId: string;
  currency: string;
  currencyDecimals: number;
  termsVersion: bigint;
  rateBps: bigint;
  maxLtvBps: bigint;
}): Uint8Array {
  return sha256(
    [
      "thetis-facility-terms-v1",
      terms.lenderOrgId,
      terms.borrowerOrgId,
      terms.currency,
      String(terms.currencyDecimals),
      String(terms.termsVersion),
      String(terms.rateBps),
      String(terms.maxLtvBps),
    ].join("\n"),
  );
}

export function sourceDigest(sourceNote: string): Uint8Array {
  return sha256(`thetis-valuation-source-v1\n${sourceNote}`);
}

export function paymentId(lenderOrgId: string, bankReference: string): Uint8Array {
  return sha256(`thetis-payment-v1\n${lenderOrgId}\n${bankReference}`);
}

export function correctionPaymentId(lenderOrgId: string, correctionReference: string): Uint8Array {
  return sha256(`thetis-correction-v1\n${lenderOrgId}\n${correctionReference}`);
}

// ---------------------------------------------------------------- custody texts (field-app.md §6.3, §6.4)

/** field-app.md §6.4: printable ASCII only, ASCII spaces removed, letters uppercased, 1 to 64
 * characters after normalising; null otherwise. The phone's `normaliseTicket` is the same rule. */
export function normaliseTicket(raw: string): string | null {
  if (!/^[\x20-\x7e]*$/.test(raw)) return null;
  const ticket = raw.replaceAll(" ", "").toUpperCase();
  return ticket.length >= 1 && ticket.length <= 64 ? ticket : null;
}

/** The `intake_digest` argument of issue_lot: SHA-256 of `thetis-intake-v1\n<site>\n<ticket>`,
 * 64 lowercase hex (field-app.md §6.4). `ticket` is already normalised. */
export function intakeDigest(siteCode: string, ticket: string): string {
  return createHash("sha256")
    .update(`thetis-intake-v1\n${siteCode}\n${ticket}`, "utf8")
    .digest("hex");
}

/** program-lots.md §6.2's `issue_message`, byte for byte. `origin` is null when the class does not
 * require one ("not required"). Imported by scripts/demo-reset.ts (demo.md §5.1 L4). */
export function issueLotMessage(
  programId: string,
  instanceId: Uint8Array,
  lotId: string,
  classCode: string,
  classVersion: number,
  grade: string,
  quantityKg: bigint,
  owner: string,
  custodian: string,
  siteCode: string,
  intake: Uint8Array,
  origin: { sha256: Uint8Array; version: number } | null,
  validUntil: bigint,
): Uint8Array {
  return envelope(
    programId,
    hex(instanceId),
    "Issue lot",
    [
      ["Lot", lotId],
      ["Class", `${classCode} v${classVersion}`],
      ["Grade", grade],
      ["Quantity", formatTonnes(quantityKg)],
      ["Owner", owner],
      ["Custodian", custodian],
      ["Site", siteCode],
      ["Intake", hex(intake)],
      ["Origin document", origin ? `${hex(origin.sha256)} v${origin.version}` : "not required"],
    ],
    validUntil,
  );
}

export type HandoverStageName = "Departure" | "Transfer" | "Arrival";

/** program-custody.md §6.3 (handover.rs step 5): the stage the program derives from the batch and
 * the recipient. Where the program would refuse the recipient (RecipientNotApproved) or the stage
 * (StageOutOfOrder), the stage the batch is attempting goes in the text and the program refuses it
 * on chain (field-app.md fold 24). */
export function handoverStage(input: {
  batchStage: "AtSource" | "InTransit" | "Arrived";
  to: string;
  destinationCustodian: string;
}): HandoverStageName {
  if (input.batchStage === "AtSource") return "Departure";
  if (input.batchStage === "Arrived" || input.to === input.destinationCustodian) return "Arrival";
  return "Transfer";
}

/** program-custody.md §6.2's `custody_handover_message`, byte for byte. */
export function custodyHandoverMessage(
  programId: string,
  instanceId: Uint8Array,
  lotId: string,
  shipmentId: Uint8Array,
  batchNumber: number,
  batchCount: number,
  quantityKg: bigint,
  from: string,
  to: string,
  stage: HandoverStageName,
  manifestDigest: Uint8Array,
  expectedSequence: bigint,
  validUntil: bigint,
): Uint8Array {
  return envelope(
    programId,
    hex(instanceId),
    "Hand over custody",
    [
      ["Lot", lotId],
      ["Shipment", hex(shipmentId)],
      ["Batch", `${batchNumber} of ${batchCount}`],
      ["Quantity", formatTonnes(quantityKg)],
      ["From", from],
      ["To", to],
      ["Stage", stage],
      ["Manifest", hex(manifestDigest)],
      ["Sequence", String(expectedSequence)],
    ],
    validUntil,
  );
}

export type ObservationKindName = "Checkpoint" | "Border";

/** program-custody.md §6.2's `observation_message`, byte for byte. */
export function observationMessage(
  programId: string,
  instanceId: Uint8Array,
  lotId: string,
  shipmentId: Uint8Array,
  batchNumber: number,
  batchCount: number,
  holder: string,
  observer: string,
  kind: ObservationKindName,
  locationCode: string,
  evidenceDigest: Uint8Array,
  observedAt: bigint,
  expectedObservation: number,
  validUntil: bigint,
): Uint8Array {
  return envelope(
    programId,
    hex(instanceId),
    "Record observation",
    [
      ["Lot", lotId],
      ["Shipment", hex(shipmentId)],
      ["Batch", `${batchNumber} of ${batchCount}`],
      ["Holder", holder],
      ["Observer", observer],
      ["Kind", kind],
      ["Location", locationCode],
      ["Evidence", hex(evidenceDigest)],
      ["Observed at", formatSast(observedAt)],
      ["Observation", String(expectedObservation)],
    ],
    validUntil,
  );
}
