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
