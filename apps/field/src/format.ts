// Formats shared by every screen and the signed-text check. Quantities are bigint kilograms;
// times are unix seconds shown in SAST (UTC+2, no daylight saving), as the program prints them.

const SAST_OFFSET = 7_200n;

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function formatTonnes(kg: bigint): string {
  const whole = kg / 1_000n;
  const fraction = (kg % 1_000n).toString().padStart(3, "0");
  return `${groupThousands(whole.toString())}.${fraction} t`;
}

export function formatKg(kg: bigint): string {
  return `${groupThousands(kg.toString())} kg`;
}

const TONNES = /^(0|[1-9][0-9]{0,9})(\.[0-9]{1,3})?$/;

export function parseTonnes(text: string): bigint | "empty" | "shape" | "zero" {
  const trimmed = text.trim();
  if (trimmed === "") return "empty";
  const match = TONNES.exec(trimmed);
  if (!match) return "shape";
  const whole = BigInt(match[1] ?? "0");
  const fraction = BigInt((match[2] ?? ".").slice(1).padEnd(3, "0"));
  const kg = whole * 1_000n + fraction;
  return kg === 0n ? "zero" : kg;
}

function sastParts(unix: bigint) {
  const date = new Date(Number((unix + SAST_OFFSET) * 1_000n));
  const pad = (n: number) => n.toString().padStart(2, "0");
  return {
    date: `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`,
    time: `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`,
  };
}

export function formatSast(unix: bigint): string {
  const { date, time } = sastParts(unix);
  return `${date} ${time} SAST`;
}

export function formatTimeOfDay(unix: bigint): string {
  return `${sastParts(unix).time} SAST`;
}

/** Hours and minutes only, for freshness lines ("as of 10:02 SAST"). */
export function formatClock(unix: bigint): string {
  return `${sastParts(unix).time.slice(0, 5)} SAST`;
}

export function formatDate(unix: bigint): string {
  return sastParts(unix).date;
}

export function formatSlot(slot: bigint): string {
  return groupThousands(slot.toString());
}

export function formatSize(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/** Unix seconds from an ISO 8601 time. */
export function unixOf(iso: string): bigint {
  return BigInt(Math.floor(Date.parse(iso) / 1_000));
}
