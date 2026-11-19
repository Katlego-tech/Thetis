import type { Address } from "@solana/kit";

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

export interface HandoverFields {
  program: Address;
  lotId: string;
  batchId: Uint8Array;
  quantityKg: bigint;
  from: string;
  to: string;
  sequence: bigint;
  validUntil: bigint;
}

export function handoverMessage(fields: HandoverFields): Uint8Array {
  return Buffer.from(
    [
      "Thetis authorisation v1",
      "Network: devnet",
      `Program: ${fields.program}`,
      "Action: Hand over custody",
      `Lot: ${fields.lotId}`,
      `Batch: ${Buffer.from(fields.batchId).toString("hex")}`,
      `Quantity: ${formatTonnes(fields.quantityKg)}`,
      `From: ${fields.from}`,
      `To: ${fields.to}`,
      `Sequence: ${fields.sequence}`,
      `Valid until: ${formatSast(fields.validUntil)}`,
      "Test network only. Synthetic data.",
    ].join("\n"),
    "utf8",
  );
}
