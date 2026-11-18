import { expect, test } from "vitest";
import { getReader } from "@/data/get-reader";
import { referenceReader, ScenarioError } from "@/data/reader";
import type { ReleaseCase } from "@/data/types";
import releaseExamples from "../../../fixtures/domain/release-examples.json";
import fixture from "../../../fixtures/web/demo-scenario.json";

const releaseCases: ReleaseCase[] = [
  "sale-2000t-400k",
  "sale-2000t-210k-refused",
  "sale-2000t-210k-topup-30k",
];

function withChange(path: string, value: unknown): unknown {
  const scenario = structuredClone(fixture);
  const segments = path.replace(/\[(\d+)\]/g, ".$1").split(".");
  const field = segments.pop();
  const parent = segments.reduce((current: unknown, key) => {
    if (typeof current !== "object" || current === null) {
      throw new Error(`Invalid fixture path: ${path}`);
    }
    return Reflect.get(current, key);
  }, scenario);
  if (!field || typeof parent !== "object" || parent === null || !Reflect.has(parent, field)) {
    throw new Error(`Invalid fixture path: ${path}`);
  }
  Reflect.set(parent, field, value);
  return scenario;
}

function expectScenarioError(path: string, value: unknown) {
  const raw = withChange(path, value);
  const load = () => referenceReader(raw);
  expect(load).toThrow(ScenarioError);
  expect(load).toThrow(expect.objectContaining({ path: `$.${path}` }));
}

test("loads the reference fixture and resolves contexts and the lot dossier", () => {
  const reader = getReader();
  expect(reader.mode).toBe("reference");
  expect(reader.scenario).toEqual({
    label: "synthetic",
    scenarioVersion: fixture.scenarioVersion,
    settlementMode: "FIAT_ATTESTATION_TEST",
    network: "devnet",
    facilityCurrency: "USD",
    currencyMinorDigits: 2,
  });
  expect(reader.contexts().map(({ organisationId }) => organisationId)).toEqual([
    "lender-one",
    "thaba",
  ]);
  expect(reader.context("lender-one")).toMatchObject({
    role: "lender",
    organisation: { name: "Lender One Bank" },
  });
  expect(reader.lot("CR-0001")).toMatchObject({
    quantityKg: 5000000n,
    owner: { id: "thaba" },
    custodian: { id: "kopano" },
    position: { availableKg: 0n },
    locks: [{ lender: { id: "lender-one" }, lockedQuantityKg: 5000000n }],
    loan: { debtMinor: 60000000n, lender: { id: "lender-one" } },
    valuation: { eligibleValueMinor: 100000000n, ltvBps: 6000n },
    evidence: [
      { id: "doc-weighbridge", issuer: { id: "kopano" }, file: null },
      { id: "doc-assay" },
      { id: "doc-origin" },
      { id: "doc-bol" },
    ],
    custodyTimeline: [
      { id: "ev-intake" },
      { id: "ev-handover-haulier" },
      { id: "ev-border", kind: "observation", by: [{ id: "mosela" }] },
      { id: "ev-arrival" },
    ],
    releases: [{ id: "rel-0001", payment: "reported_by_buyer", buyer: { id: "buyer-smelter" } }],
  });
  expect(reader.context("missing")).toBeNull();
  expect(reader.lot("missing")).toBeNull();
  expect(reader.release("missing")).toBeNull();
  expect(reader.workQueue("missing")).toEqual([]);
  expect(reader.exceptions("missing")).toEqual([]);
});

test.each(releaseCases)("matches every expected preview field for %s", (releaseCase) => {
  const example = releaseExamples.find(({ name }) => name === releaseCase);
  if (!example) throw new Error(`Missing example: ${releaseCase}`);

  const reader = referenceReader(fixture);
  const release = reader.release("rel-0001", releaseCase);
  expect(release).toMatchObject({
    case: releaseCase,
    payment: "reported_by_buyer",
    registry: { status: "not_submitted" },
    preview: Object.fromEntries(
      Object.entries(example.expected).map(([key, value]) => [
        key,
        typeof value === "string" ? BigInt(value) : value,
      ]),
    ),
  });
});

test("uses the request's fixture and amounts unless a case is explicitly selected", () => {
  const raw = structuredClone(fixture);
  const [request] = raw.releaseRequests;
  if (!request) throw new Error("Missing fixture release request");
  Object.assign(request, {
    fixture: "sale-2000t-210k-refused",
    buyerAmountMinor: "40000001",
    sellerTopUpMinor: "1",
    soldLockedQuantityKg: "2000001",
  });
  raw.facility.loan.bookedInterestMinor = "25";
  const reader = referenceReader(raw);

  expect(reader.release("rel-0001")).toMatchObject({
    case: "sale-2000t-210k-refused",
    inputs: {
      buyerAmount: 40000001n,
      sellerTopUp: 1n,
      soldLockedQuantity: 2000001n,
      bookedInterest: 25n,
    },
  });
  expect(reader.release("rel-0001", "sale-2000t-400k")).toMatchObject({
    inputs: {
      buyerAmount: 40000000n,
      sellerTopUp: 0n,
      soldLockedQuantity: 2000000n,
      bookedInterest: 25n,
    },
  });
  expect(reader.release("rel-0001", "overpay-surplus" as ReleaseCase)).toBeNull();
});

test("returns an inline error when the domain refuses to calculate a release preview", () => {
  const raw = withChange("releaseRequests[0].soldLockedQuantityKg", "5000001");
  expect(referenceReader(raw).release("rel-0001")?.preview).toEqual({
    error: { code: "SOLD_EXCEEDS_LOCKED", message: "Sold quantity exceeds locked quantity" },
  });
});

test("resolves all three lender work items with quantities, amounts and destinations", () => {
  const reader = referenceReader(fixture);
  expect(reader.workQueue("lender-one")).toMatchObject([
    {
      id: "wi-payment",
      href: "/lender-one/releases/rel-0001",
      amountMinor: 40000000n,
      quantityKg: 2000000n,
      registry: { status: "not_submitted" },
    },
    {
      id: "wi-handoff",
      href: "/lender-one/lots/CR-0001",
      amountMinor: 60000000n,
      quantityKg: 3000000n,
      registry: { status: "not_submitted" },
    },
    {
      id: "wi-valuation",
      href: "/lender-one/lots/CR-0001",
      amountMinor: 100000000n,
      quantityKg: 5000000n,
      registry: { status: "not_submitted" },
    },
  ]);
  expect(reader.workQueue("thaba")).toMatchObject([
    { id: "wi-release-request", href: "/thaba/releases/rel-0001" },
  ]);
});

test("returns owned exceptions and all exceptions on the lender's lot", () => {
  const reader = referenceReader(fixture);
  expect(reader.exceptions("lender-one").map(({ id }) => id)).toEqual(
    fixture.exceptions.map(({ id }) => id),
  );
  expect(reader.exceptions("kopano")).toMatchObject([
    { id: "ex-duplicate-intake", owner: { id: "kopano" }, lot: { id: "CR-0001" } },
  ]);
  expect(reader.exceptions("thaba")).toEqual([]);
});

test.each([
  "lots[0].registry.status",
  "facility.loan.registry.status",
  "facility.valuation.registry.status",
  ...fixture.custodyTimeline.map((_, i) => `custodyTimeline[${i}].registry.status`),
  "releaseRequests[0].registry.status",
  ...fixture.exceptions.map((_, i) => `exceptions[${i}].registry.status`),
])("rejects a confirmed reference record at %s", (path) => {
  expectScenarioError(path, "confirmed");
});

test.each([
  "lots[0].quantityKg",
  "lots[0].position.positionQuantityKg",
  "lots[0].position.activeLockedQuantityKg",
  "lots[0].position.separatelyReservedQuantityKg",
  "lots[0].locks[0].lockedQuantityKg",
  "lots[0].discrepancyKg",
  "facility.loan.principalMinor",
  "facility.loan.bookedInterestMinor",
  "facility.loan.bookedFeesMinor",
  "facility.valuation.valuePerKgMinor",
  "facility.valuation.haircutBps",
  "facility.valuation.maxLtvBps",
  ...fixture.custodyTimeline.map((_, i) => `custodyTimeline[${i}].quantityKg`),
  "releaseRequests[0].soldLockedQuantityKg",
  "releaseRequests[0].buyerAmountMinor",
  "releaseRequests[0].sellerTopUpMinor",
])("rejects non-canonical unsigned integer strings at %s", (path) => {
  expectScenarioError(path, "01");
  expectScenarioError(path, "1.0");
});

test.each([
  "contexts[0].organisationId",
  "lots[0].siteId",
  "lots[0].ownerId",
  "lots[0].custodianId",
  "lots[0].locks[0].lenderId",
  "facility.lenderId",
  "facility.borrowerId",
  "facility.loan.lotId",
  "custodyTimeline[0].siteId",
  "custodyTimeline[0].by[0]",
  "evidence[0].lotId",
  "evidence[0].issuerId",
  "releaseRequests[0].lotId",
  "releaseRequests[0].sellerId",
  "releaseRequests[0].buyerId",
  "releaseRequests[0].lenderId",
  "workItems[0].contextOrganisationId",
  "workItems[0].lotId",
  "workItems[0].nextActorId",
  "workItems[0].releaseId",
  "exceptions[0].ownerId",
  "exceptions[0].lotId",
])("rejects an unknown reference at %s", (path) => {
  expectScenarioError(path, "missing");
});

test.each([
  "label",
  "lots[0].custody",
  "lots[0].finance",
  "lots[0].restriction",
  "facility.loan.status",
  "custodyTimeline[0].kind",
  "evidence[0].status",
  "releaseRequests[0].payment.status",
  "releaseRequests[0].fixture",
])("rejects an unknown value at %s", (path) => {
  expectScenarioError(path, "unknown");
});
