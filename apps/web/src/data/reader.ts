import {
  availableQuantity,
  DomainError,
  parseU64,
  previewRelease,
  type ReleaseInput,
} from "@thetis/domain";
import releaseExamples from "../../../../fixtures/domain/release-examples.json";
import type {
  Context,
  ExceptionView,
  LotView,
  Registry,
  ReleaseCase,
  ReleaseView,
  WorkItemView,
} from "./types";

export interface ThetisReader {
  readonly mode: "reference";
  readonly scenario: {
    label: "synthetic";
    scenarioVersion: string;
    settlementMode: string;
    network: string;
    facilityCurrency: string;
    currencyMinorDigits: number;
  };
  contexts(): Context[];
  context(organisationId: string): Context | null;
  workQueue(organisationId: string): WorkItemView[];
  lot(lotId: string): LotView | null;
  release(releaseId: string, releaseCase?: ReleaseCase): ReleaseView | null;
  exceptions(organisationId: string): ExceptionView[];
}

export class ScenarioError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "ScenarioError";
    this.path = path;
  }
}

type Parser<T> = (value: unknown, path: string) => T;

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ScenarioError(path, "Expected an object");
  }
  return value as Record<string, unknown>;
}

function object<S extends Record<string, Parser<unknown>>>(fields: S) {
  return (value: unknown, path: string): { [K in keyof S]: ReturnType<S[K]> } => {
    const input = record(value, path);
    return Object.fromEntries(
      Object.entries(fields).map(([key, parse]) => [key, parse(input[key], `${path}.${key}`)]),
    ) as { [K in keyof S]: ReturnType<S[K]> };
  };
}

function array<T>(parse: Parser<T>): Parser<T[]> {
  return (value, path) => {
    if (!Array.isArray(value)) throw new ScenarioError(path, "Expected an array");
    return value.map((item: unknown, index) => parse(item, `${path}[${index}]`));
  };
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string") throw new ScenarioError(path, "Expected a string");
  return value;
}

function oneOf<const T>(...choices: T[]): Parser<T> {
  return (value, path) => {
    for (const choice of choices) {
      if (choice === value) return choice;
    }
    throw new ScenarioError(path, `Expected one of: ${choices.join(", ")}`);
  };
}

function unsigned(value: unknown, path: string): bigint {
  const decimal = string(value, path);
  try {
    return parseU64(decimal);
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    throw new ScenarioError(path, error.message);
  }
}

function minorDigits(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ScenarioError(path, "Expected a non-negative integer");
  }
  return value;
}

function reference<T extends { id: string }>(rows: T[], kind: string): Parser<T> {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return (value, path) => {
    const id = string(value, path);
    const row = byId.get(id);
    if (!row) throw new ScenarioError(path, `Unknown ${kind} ID: ${id}`);
    return row;
  };
}

const registry: Parser<Registry> = object({ status: oneOf("not_submitted") });
const releaseCaseNames: readonly ReleaseCase[] = [
  "sale-2000t-400k",
  "sale-2000t-210k-refused",
  "sale-2000t-210k-topup-30k",
];
const releaseCase = oneOf(...releaseCaseNames);
const namedExamples = new Map(
  releaseExamples
    .filter(({ name }) => releaseCaseNames.some((caseName) => caseName === name))
    .map(({ name, input }) => [name, input]),
);

const metadata = object({
  label: oneOf("synthetic"),
  scenarioVersion: string,
  settlementMode: oneOf("FIAT_ATTESTATION_TEST"),
  network: oneOf("devnet"),
  facilityCurrency: string,
  currencyMinorDigits: minorDigits,
});

const organisations = array(object({ id: string, name: string, role: string }));
const sites = array(object({ id: string, name: string, kind: string }));

function parseScenario(raw: unknown) {
  const input = record(raw, "$");
  const scenario = metadata(input, "$");
  const organisation = reference(
    organisations(input.organisations, "$.organisations"),
    "organisation",
  );
  const site = reference(sites(input.sites, "$.sites"), "site");

  const contexts = array(object({ organisationId: organisation, role: string }))(
    input.contexts,
    "$.contexts",
  ).map(
    ({ organisationId: org, role }): Context => ({
      organisationId: org.id,
      role,
      organisation: org,
    }),
  );

  const lots = array(
    object({
      id: string,
      mineral: string,
      gradeClass: string,
      quantityKg: unsigned,
      siteId: site,
      ownerId: organisation,
      custodianId: organisation,
      custody: oneOf(
        "Stored",
        "Awaiting departure",
        "In transit",
        "Partly arrived",
        "Arrived",
        "Loaded",
        "Collected",
      ),
      finance: oneOf("Available", "Pledged", "Recovery", "External hand-off", "Repaid"),
      restriction: oneOf("Normal", "Review required", "Disputed", "Frozen"),
      position: object({
        positionQuantityKg: unsigned,
        activeLockedQuantityKg: unsigned,
        separatelyReservedQuantityKg: unsigned,
      }),
      locks: array(object({ lenderId: organisation, lockedQuantityKg: unsigned })),
      discrepancyKg: unsigned,
      registry,
    }),
  )(input.lots, "$.lots");
  const lot = reference(lots, "lot");
  const facility = object({
    id: string,
    lenderId: organisation,
    borrowerId: organisation,
    currency: string,
    loan: object({
      lotId: lot,
      principalMinor: unsigned,
      bookedInterestMinor: unsigned,
      bookedFeesMinor: unsigned,
      status: oneOf("Active", "Recovery", "ExternalHandoff", "Closed"),
      registry,
    }),
    valuation: object({
      valuePerKgMinor: unsigned,
      haircutBps: unsigned,
      maxLtvBps: unsigned,
      validUntil: string,
      registry,
    }),
  })(input.facility, "$.facility");

  const custodyTimeline = array(
    object({
      id: string,
      kind: oneOf("intake", "handover", "observation"),
      siteId: site,
      quantityKg: unsigned,
      by: array(organisation),
      at: string,
      registry,
    }),
  )(input.custodyTimeline, "$.custodyTimeline").map(({ siteId, ...event }) => ({
    ...event,
    site: siteId,
  }));

  const evidence = array(
    object({
      id: string,
      lotId: lot,
      kind: string,
      issuerId: organisation,
      status: oneOf(
        "Uploaded",
        "Extracted draft",
        "Human-attested",
        "Superseded",
        "Revoked",
        "Expired",
      ),
      file: oneOf(null),
    }),
  )(input.evidence, "$.evidence");

  const releases = array(
    object({
      id: string,
      lotId: lot,
      sellerId: organisation,
      buyerId: organisation,
      lenderId: organisation,
      fixture: releaseCase,
      soldLockedQuantityKg: unsigned,
      buyerAmountMinor: unsigned,
      sellerTopUpMinor: unsigned,
      payment: object({ status: oneOf("reported_by_buyer", "attested_by_lender", "rejected") }),
      registry,
      expiresAt: string,
    }),
  )(input.releaseRequests, "$.releaseRequests");
  const release = reference(releases, "release");

  const workItems = array(
    object({
      id: string,
      contextOrganisationId: organisation,
      lotId: lot,
      action: string,
      nextActorId: organisation,
      releaseId: (value, path) => (value === undefined ? undefined : release(value, path)),
      blocker: string,
      deadline: (value, path) => (value == null ? null : string(value, path)),
    }),
  )(input.workItems, "$.workItems");

  const exceptions = array(
    object({
      id: string,
      kind: string,
      ownerId: organisation,
      lotId: lot,
      reason: string,
      nextAction: string,
      registry,
    }),
  )(input.exceptions, "$.exceptions");

  return {
    scenario,
    contexts,
    lots,
    facility,
    custodyTimeline,
    evidence,
    releases,
    workItems,
    exceptions,
  };
}

type ParsedScenario = ReturnType<typeof parseScenario>;

const BPS_SCALE = 10000n;

function lotView(data: ParsedScenario): LotView {
  const { lotId: lot, ...loan } = data.facility.loan;
  const { siteId, ownerId, custodianId, locks, position, ...details } = lot;
  const { valuation, lenderId } = data.facility;
  const debtMinor = loan.principalMinor + loan.bookedInterestMinor + loan.bookedFeesMinor;
  if (valuation.haircutBps > BPS_SCALE) {
    throw new ScenarioError("$.facility.valuation.haircutBps", "Haircut exceeds 10000 bps");
  }
  const eligibleValueMinor =
    (lot.quantityKg * valuation.valuePerKgMinor * (BPS_SCALE - valuation.haircutBps)) / BPS_SCALE;
  if (eligibleValueMinor === 0n && debtMinor > 0n) {
    throw new ScenarioError(
      "$.facility.valuation",
      "LTV is undefined for debt with zero eligible value",
    );
  }
  return {
    ...details,
    site: siteId,
    owner: ownerId,
    custodian: custodianId,
    position: {
      ...position,
      availableKg: availableQuantity({
        positionQuantity: position.positionQuantityKg,
        activeLockedQuantity: position.activeLockedQuantityKg,
        separatelyReservedQuantity: position.separatelyReservedQuantityKg,
      }),
    },
    locks: locks.map(({ lenderId: lender, lockedQuantityKg }) => ({ lender, lockedQuantityKg })),
    loan: { ...loan, lender: lenderId, debtMinor },
    valuation: {
      ...valuation,
      eligibleValueMinor,
      ltvBps: eligibleValueMinor === 0n ? 0n : (debtMinor * BPS_SCALE) / eligibleValueMinor,
    },
    custodyTimeline: data.custodyTimeline,
    evidence: data.evidence
      .filter(({ lotId }) => lotId === lot)
      .map(({ lotId: _lot, issuerId, ...item }) => ({ ...item, issuer: issuerId })),
    releases: data.releases
      .filter(({ lotId }) => lotId === lot)
      .map(({ id, buyerId, soldLockedQuantityKg, payment, registry }) => ({
        id,
        buyer: buyerId,
        soldLockedQuantityKg,
        payment: payment.status,
        registry,
      })),
  };
}

function lockedQuantity(lot: LotView, lenderId: string): bigint {
  return lot.locks
    .filter(({ lender }) => lender.id === lenderId)
    .reduce((sum, { lockedQuantityKg }) => sum + lockedQuantityKg, 0n);
}

function releasePreview(inputs: ReleaseInput): ReleaseView["preview"] {
  try {
    return previewRelease(inputs);
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    return { error: { code: error.code, message: error.message } };
  }
}

function workItemViews(data: ParsedScenario, lot: LotView) {
  return data.workItems.map(({ contextOrganisationId, releaseId, lotId, nextActorId, ...item }) => {
    let amountMinor: bigint | null = null;
    let quantityKg: bigint | null = null;
    if (releaseId) {
      amountMinor = releaseId.buyerAmountMinor;
      quantityKg = releaseId.soldLockedQuantityKg;
    } else if (item.action === "Approve external hand-off") {
      amountMinor = lot.loan.debtMinor;
      const pending = data.releases.find(
        (request) =>
          request.lotId === lotId &&
          request.lenderId.id === lot.loan.lender.id &&
          request.payment.status !== "rejected",
      );
      const remaining =
        lockedQuantity(lot, lot.loan.lender.id) - (pending?.soldLockedQuantityKg ?? 0n);
      quantityKg = remaining >= 0n ? remaining : null;
    } else if (item.action === "Renew valuation") {
      amountMinor = lot.valuation.eligibleValueMinor;
      quantityKg = lot.quantityKg;
    }

    const href = releaseId
      ? `/${contextOrganisationId.id}/releases/${releaseId.id}`
      : `/${contextOrganisationId.id}/lots/${lot.id}`;
    const view: WorkItemView = {
      ...item,
      lot: { id: lot.id, gradeClass: lot.gradeClass, site: lot.site, quantityKg: lot.quantityKg },
      nextActor: nextActorId,
      href,
      amountMinor,
      quantityKg,
      registry: releaseId?.registry ?? lot.registry,
    };
    return { organisationId: contextOrganisationId.id, view };
  });
}

export function referenceReader(raw: unknown): ThetisReader {
  const data = parseScenario(raw);
  // The scenario supplies one loan, and every lot dossier requires loan and valuation data.
  const unfinancedLot = data.lots.findIndex((lot) => lot !== data.facility.loan.lotId);
  if (unfinancedLot !== -1) {
    throw new ScenarioError(
      `$.lots[${unfinancedLot}].id`,
      "Lot has no loan in the reference facility",
    );
  }
  const lot = lotView(data);
  const queue = workItemViews(data, lot);
  const exceptions = data.exceptions.map(
    ({ ownerId, lotId, ...item }): ExceptionView => ({
      ...item,
      owner: ownerId,
      lot: { id: lotId.id },
    }),
  );

  return {
    mode: "reference",
    scenario: data.scenario,
    contexts: () => [...data.contexts],
    context: (id) => data.contexts.find(({ organisationId }) => organisationId === id) ?? null,
    workQueue: (id) =>
      queue.filter(({ organisationId }) => organisationId === id).map(({ view }) => view),
    lot: (id) => (id === lot.id ? lot : null),
    release(id, selectedCase) {
      const request = data.releases.find((row) => row.id === id);
      if (!request) return null;

      const currentCase = selectedCase ?? request.fixture;
      let buyerAmount = request.buyerAmountMinor;
      let sellerTopUp = request.sellerTopUpMinor;
      let soldLockedQuantity = request.soldLockedQuantityKg;
      if (selectedCase !== undefined) {
        const example = namedExamples.get(selectedCase);
        if (!example) return null;
        buyerAmount = parseU64(example.buyerAmount);
        sellerTopUp = parseU64(example.sellerTopUp);
        soldLockedQuantity = parseU64(example.soldLockedQuantity);
      }
      const inputs: ReleaseInput = {
        principal: lot.loan.principalMinor,
        bookedInterest: lot.loan.bookedInterestMinor,
        bookedFees: lot.loan.bookedFeesMinor,
        buyerAmount,
        sellerTopUp,
        lockedQuantity: lockedQuantity(lot, request.lenderId.id),
        soldLockedQuantity,
        valuePerUnit: lot.valuation.valuePerKgMinor,
        haircutBps: lot.valuation.haircutBps,
        maxLtvBps: lot.valuation.maxLtvBps,
      };
      return {
        id,
        lot,
        seller: request.sellerId,
        buyer: request.buyerId,
        lender: request.lenderId,
        case: currentCase,
        currency: data.facility.currency,
        inputs,
        preview: releasePreview(inputs),
        payment: request.payment.status,
        registry: request.registry,
        expiresAt: request.expiresAt,
      };
    },
    exceptions: (id) =>
      exceptions.filter(({ owner }) => owner.id === id || lot.loan.lender.id === id),
  };
}
