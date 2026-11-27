const wholeNumber = new Intl.NumberFormat("en-US");
const johannesburg = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Johannesburg",
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const johannesburgClock = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Johannesburg",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function formatFixed(value: bigint, digits: number): string {
  const scale = 10n ** BigInt(digits);
  const magnitude = value < 0n ? -value : value;
  const sign = value < 0n ? "-" : "";
  const whole = wholeNumber.format(magnitude / scale);
  if (digits === 0) return `${sign}${whole}`;

  const fraction = (magnitude % scale).toString().padStart(digits, "0");
  return `${sign}${whole}.${fraction}`;
}

export function formatTonnes(kg: bigint): string {
  return `${formatFixed(kg, 3)} t`;
}

export function formatMoney(minor: bigint, currency: string, minorDigits: number): string {
  return `${currency} ${formatFixed(minor, minorDigits)}`;
}

export function formatBpsPercent(bps: bigint): string {
  return `${formatFixed(bps, 2)}%`;
}

export function formatDateTime(iso: string): string {
  const parts = Object.fromEntries(
    johannesburg.formatToParts(new Date(iso)).map(({ type, value }) => [type, value]),
  );
  return `${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute} SAST`;
}

export function formatClockTime(iso: string): string {
  return `${johannesburgClock.format(new Date(iso))} SAST`;
}

export function formatSlot(slot: bigint): string {
  return wholeNumber.format(slot);
}

const U64_MAX = 2n ** 64n - 1n;

/** Exact decimal text to minor units: no sign, no separators, at most `minorDigits` decimals. */
export function parseMoneyInput(text: string, minorDigits: number): bigint | null {
  return parseDecimal(text, minorDigits);
}

/** Tonnes with at most three decimals to kilograms: "2000" is 2,000,000 kg, "0.5" is 500 kg. */
export function parseTonnesInput(text: string): bigint | null {
  return parseDecimal(text, 3);
}

function parseDecimal(text: string, digits: number): bigint | null {
  const pattern =
    digits === 0 ? /^([0-9]+)$/ : new RegExp(`^([0-9]+)(?:\\.([0-9]{1,${digits}}))?$`);
  const match = pattern.exec(text);
  if (!match) return null;
  const [, whole = "", fraction = ""] = match;
  const value = BigInt(whole) * 10n ** BigInt(digits) + BigInt(fraction.padEnd(digits, "0") || "0");
  return value > U64_MAX ? null : value;
}

export function explorerTxUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}

/** Minor units as the plain decimal a money input accepts: 40000000 at 2 digits is "400000.00". */
export function minorToInput(minor: bigint, minorDigits: number): string {
  if (minorDigits === 0) return minor.toString();
  const text = minor.toString().padStart(minorDigits + 1, "0");
  return `${text.slice(0, -minorDigits)}.${text.slice(-minorDigits)}`;
}
