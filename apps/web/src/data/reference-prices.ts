// web.md §10.3: the committed USGS chromium-products reference and its validation. These are prices
// for chromium metal and ferrochromium, not chrome ore; nothing in the valuation path reads them.

export type ReferencePrice = {
  product: string;
  measure: string;
  period: string;
  amount: string;
  currency: "USD";
  unit: string;
};

export type ReferencePrices = {
  kind: "chromium_products_reference";
  source: {
    publisher: string;
    publication: string;
    issue: string;
    url: string;
    location: string;
    priceSource: string;
    sha256: string;
    retrievedOn: string;
    note: string;
  };
  prices: ReferencePrice[];
};

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DECIMAL = /^(0|[1-9]\d*)\.\d+$/;
const SHA256 = /^[0-9a-f]{64}$/;
const STORE = "https://d9-wret.s3.us-west-2.amazonaws.com/";
const SOURCE_FIELDS = [
  "publisher",
  "publication",
  "issue",
  "url",
  "location",
  "priceSource",
  "sha256",
  "retrievedOn",
  "note",
] as const;
const PRICE_FIELDS = ["product", "measure", "period", "amount", "currency", "unit"] as const;

class Refused extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function text(record: Record<string, unknown>, field: string, path: string): string {
  const value = record[field];
  if (value === undefined) throw new Refused(`${path} is missing`);
  if (typeof value !== "string" || value.trim() === "")
    throw new Refused(`${path} is not a non-empty string`);
  return value;
}

function isRealDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function parse(value: unknown): ReferencePrices {
  if (!isRecord(value)) throw new Refused("the reference prices are missing or not an object");
  if (value.kind !== "chromium_products_reference")
    throw new Refused("kind is not chromium_products_reference");
  if (!isRecord(value.source)) throw new Refused("source is missing");
  const source = value.source;
  for (const field of SOURCE_FIELDS) text(source, field, `source.${field}`);
  const issue = source.issue as string;
  if (!MONTH.test(issue)) throw new Refused("source.issue is not a YYYY-MM month");
  const url = source.url as string;
  if (!url.startsWith(STORE) || !url.endsWith(`/mis-${issue.replace("-", "")}-chrom.pdf`))
    throw new Refused("source.url is not the USGS chromium issue it names");
  if (!SHA256.test(source.sha256 as string)) throw new Refused("source.sha256 is not a sha256");
  if (!isRealDate(source.retrievedOn as string))
    throw new Refused("source.retrievedOn is not a real YYYY-MM-DD date");
  if (!Array.isArray(value.prices) || value.prices.length === 0)
    throw new Refused("prices is missing or empty");
  value.prices.forEach((price, index) => {
    const path = `prices[${index}]`;
    if (!isRecord(price)) throw new Refused(`${path} is not an object`);
    for (const field of PRICE_FIELDS) text(price, field, `${path}.${field}`);
    if (!MONTH.test(price.period as string))
      throw new Refused(`${path}.period is not a YYYY-MM month`);
    if (!DECIMAL.test(price.amount as string))
      throw new Refused(`${path}.amount is not a decimal string`);
    if (price.currency !== "USD") throw new Refused(`${path}.currency is not USD`);
  });
  return value as ReferencePrices;
}

export function parseReferencePrices(
  value: unknown,
): { ok: true; data: ReferencePrices } | { ok: false; reason: string } {
  try {
    return { ok: true, data: parse(value) };
  } catch (error) {
    if (error instanceof Refused) return { ok: false, reason: error.message };
    throw error;
  }
}
