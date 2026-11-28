import {
  accrueSimple,
  availableQuantity,
  DomainError,
  parseU64,
  previewRelease,
  type ReleaseInput,
} from "@thetis/domain";
import { type CommandKind, kindTitles, type SignerRole } from "@/lib/commands";
import { formatClockTime, formatDateTime, formatMoney } from "@/lib/format";
import type {
  Context,
  CustodyState,
  Organisation,
  Registry,
  RestrictionState,
  Site,
  WorkItemView,
} from "../types";
import { freshnessOf } from "./freshness";
import {
  type ChainDocumentRow,
  type ChainEventRow,
  type ChainFacilityRow,
  type ChainLoadingIntentRow,
  type ChainLoanRow,
  type ChainLotRow,
  type ChainOrganisationRow,
  type ChainPaymentRow,
  type ChainPositionRow,
  type ChainProtocolRow,
  type ChainReleaseIntentRow,
  type ChainValuationRow,
  type CommandRow,
  checkRow,
  type LiveSnapshot,
  type OrganisationRow,
  parseI64,
  parseU64At,
  type RowField,
  type RowsOf,
  SLUG,
} from "./rows";
import {
  type LiveCommandSummary,
  LiveDataError,
  type LiveDataErrorCode,
  type LiveFacility,
  type LiveIntent,
  type LiveLending,
  type LiveLoading,
  type LiveLoadingIntent,
  type LiveLoadingRow,
  type LiveLoan,
  type LiveLotView,
  type LivePayment,
  type LivePaymentState,
  type LiveReader,
  type LiveReleaseView,
  type LiveValuation,
} from "./types";

type Indexed<T> = { row: T; index: number };

function fail(code: LiveDataErrorCode, path: string, message: string): never {
  throw new LiveDataError(code, path, message);
}

function list<F extends RowField>(
  field: F,
  rows: unknown,
  env: LiveSnapshot["env"],
): Indexed<RowsOf[F]>[] {
  if (!Array.isArray(rows)) fail("BAD_ROW", field, "expected a list of rows");
  return rows.map((row: unknown, index) => ({
    row: checkRow(field, row, `${field}[${index}]`, env),
    index,
  }));
}

function one<F extends RowField>(
  field: F,
  row: unknown,
  env: LiveSnapshot["env"],
): RowsOf[F] | null {
  return row === null ? null : checkRow(field, row, field, env);
}

function byAddress<T extends { address: string }>(rows: Indexed<T>[]): Map<string, Indexed<T>> {
  return new Map(rows.map((entry) => [entry.row.address, entry]));
}

function roleLabel(role: string): string {
  return role.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

const SETTLEMENT_MODES: Record<ChainProtocolRow["settlement_mode"], string> = {
  FiatAttestationTest: "FIAT_ATTESTATION_TEST",
  DevnetTokenSimulation: "DEVNET_TOKEN_SIMULATION",
};

/** Checks every row of the snapshot, then the references the screens depend on. */
function validate(snapshot: LiveSnapshot) {
  const { env } = snapshot;
  // (1) every row's fields, in snapshot field order
  const memberships = list("memberships", snapshot.memberships, env);
  const organisations = list("organisations", snapshot.organisations, env);
  const protocol = one("protocol", snapshot.protocol, env);
  const classPolicies = list("classPolicies", snapshot.classPolicies, env);
  const custodianClasses = list("custodianClasses", snapshot.custodianClasses, env);
  const lots = list("lots", snapshot.lots, env);
  const allPositions = list("positions", snapshot.positions, env);
  const intakes = list("intakes", snapshot.intakes, env);
  const allDocuments = list("documents", snapshot.documents, env);
  const allFacilities = list("facilities", snapshot.facilities, env);
  const allValuations = list("valuations", snapshot.valuations, env);
  const allLoans = list("loans", snapshot.loans, env);
  const allLocks = list("locks", snapshot.locks, env);
  const allPayments = list("payments", snapshot.payments, env);
  const allIntents = list("intents", snapshot.intents, env);
  const commands = list("commands", snapshot.commands, env);
  const allLoadingIntents = list("loadingIntents", snapshot.loadingIntents, env);
  const allAcceptances = list("acceptances", snapshot.acceptances, env);
  const allEvents = list("intakeEvents", snapshot.intakeEvents, env);
  const checkpoint = one("checkpoint", snapshot.checkpoint, env);

  // (2) rows of lots that were not selected are dropped
  const lotAddresses = new Set(lots.map(({ row }) => row.address));
  const positions = allPositions.filter(({ row }) => lotAddresses.has(row.lot));
  const intakeEvents = allEvents.filter(({ row }) => lotAddresses.has(row.lot));
  const intakeByAddress = byAddress(intakes);
  const lotDigests = new Set(
    lots.flatMap(({ row }) => {
      const intake = intakeByAddress.get(row.intake);
      return intake ? [intake.row.intake_digest_hex] : [];
    }),
  );
  const documents = allDocuments.filter(({ row }) => lotDigests.has(row.subject_hex));
  // Lending rows of lots that were not selected are dropped too (live-lending.md §4.5.1).
  const loans = allLoans.filter(({ row }) => lotAddresses.has(row.lot));
  const loanLot = new Map(allLoans.map(({ row }) => [row.address, row.lot]));
  const locks = allLocks.filter(({ row }) => lotAddresses.has(loanLot.get(row.loan) ?? ""));
  const intents = allIntents.filter(({ row }) => lotAddresses.has(row.lot));
  const intentLot = new Map(allIntents.map(({ row }) => [row.address, row.lot]));
  const payments = allPayments.filter(({ row }) => {
    if (lotAddresses.has(loanLot.get(row.loan) ?? "")) return true;
    return row.purpose === "Release" && lotAddresses.has(intentLot.get(row.subject) ?? "");
  });
  // Loading rows of lots, intents and loans that were not selected are dropped (§6.10.4).
  const loadingIntents = allLoadingIntents.filter(({ row }) => lotAddresses.has(row.lot));
  const keptLoadingIntents = new Set(loadingIntents.map(({ row }) => row.address));
  const keptLoans = new Set(loans.map(({ row }) => row.address));
  const acceptances = allAcceptances.filter(
    ({ row }) => keptLoadingIntents.has(row.intent) && keptLoans.has(row.loan),
  );

  // (3) references and the ids copied from them
  const organisationByAddress = byAddress(organisations);
  const classPolicyByAddress = byAddress(classPolicies);
  const custodianClassByAddress = byAddress(custodianClasses);
  const organisationAt = (address: string, path: string) =>
    organisationByAddress.get(address) ?? fail("BAD_ROW", path, "names no indexed organisation");
  const sameOrg = (organisation: ChainOrganisationRow, orgId: string, path: string) => {
    if (organisation.org_id !== orgId)
      fail("BAD_ROW", path, "disagrees with the organisation it names");
  };

  for (const { row, index } of lots) {
    const at = `lots[${index}]`;
    if (!classPolicyByAddress.has(row.class_policy))
      fail("BAD_ROW", `${at}.class_policy`, "names no class policy");
    if (!custodianClassByAddress.has(row.custodian_class)) {
      fail("BAD_ROW", `${at}.custodian_class`, "names no custodian class");
    }
    sameOrg(
      organisationAt(row.custodian, `${at}.custodian`).row,
      row.custodian_org_id,
      `${at}.custodian_org_id`,
    );
    if (!intakeByAddress.has(row.intake)) fail("BAD_ROW", `${at}.intake`, "names no intake");
    if (!positions.some((position) => position.row.lot === row.address))
      fail("BAD_ROW", at, "has no position");
  }
  const loanByAddress = byAddress(loans);
  const openLockedOn = (positionAddress: string) =>
    locks
      .filter(({ row }) => {
        const owner = loanByAddress.get(row.loan)?.row;
        return row.position === positionAddress && owner !== undefined && owner.status !== "Closed";
      })
      .reduce((sum, { row }) => sum + parseU64(row.quantity_kg), 0n);
  for (const { row, index } of positions) {
    const at = `positions[${index}]`;
    sameOrg(organisationAt(row.owner, `${at}.owner`).row, row.owner_org_id, `${at}.owner_org_id`);
    if (row.reserved_kg !== "0")
      fail("BAD_ROW", `${at}.reserved_kg`, "reservations need the Phase 3 adapter");
    if (parseU64(row.locked_kg) < openLockedOn(row.address))
      fail("BAD_ROW", `${at}.locked_kg`, "below the visible locks on this position");
  }
  for (const { row, index } of documents) {
    const at = `documents[${index}]`;
    sameOrg(
      organisationAt(row.issuer, `${at}.issuer`).row,
      row.issuer_org_id,
      `${at}.issuer_org_id`,
    );
  }
  const lotByAddress = byAddress(lots);
  for (const { row, index } of intakeEvents) {
    if (row.data.intake !== lotByAddress.get(row.lot)?.row.intake) {
      fail("BAD_ROW", `intakeEvents[${index}].data`, "names another intake than its lot");
    }
  }

  // Lending references (live-lending.md §4.5.1).
  const facilityByAddress = byAddress(allFacilities);
  const memberIds = new Set(memberships.map(({ row }) => row.id));
  const lockByLoan = new Map(locks.map((entry) => [entry.row.loan, entry]));
  for (const { row, index } of allFacilities) {
    const at = `facilities[${index}]`;
    sameOrg(
      organisationAt(row.lender, `${at}.lender`).row,
      row.lender_org_id,
      `${at}.lender_org_id`,
    );
    sameOrg(
      organisationAt(row.borrower, `${at}.borrower`).row,
      row.borrower_org_id,
      `${at}.borrower_org_id`,
    );
  }
  for (const { row, index } of loans) {
    const at = `loans[${index}]`;
    if (!facilityByAddress.has(row.facility))
      fail("BAD_ROW", `${at}.facility`, "names no facility");
    if (!lockByLoan.has(row.address)) fail("BAD_ROW", at, "has no lock");
    sameOrg(
      organisationAt(row.borrower, `${at}.borrower`).row,
      row.borrower_org_id,
      `${at}.borrower_org_id`,
    );
  }
  const buyerOnly = (row: ChainReleaseIntentRow) =>
    memberIds.has(row.buyer_org_id) &&
    !memberIds.has(row.lender_org_id) &&
    !memberIds.has(row.seller_org_id);
  for (const { row, index } of intents) {
    const at = `intents[${index}]`;
    if (!loanByAddress.has(row.loan) && !buyerOnly(row))
      fail("BAD_ROW", `${at}.loan`, "names no loan");
    sameOrg(
      organisationAt(row.seller, `${at}.seller`).row,
      row.seller_org_id,
      `${at}.seller_org_id`,
    );
    sameOrg(organisationAt(row.buyer, `${at}.buyer`).row, row.buyer_org_id, `${at}.buyer_org_id`);
    sameOrg(
      organisationAt(row.lender, `${at}.lender`).row,
      row.lender_org_id,
      `${at}.lender_org_id`,
    );
  }
  const intentByAddress = byAddress(intents);
  for (const { row, index } of payments) {
    const at = `payments[${index}]`;
    const subject = intentByAddress.get(row.subject)?.row;
    const exempt = row.purpose === "Release" && subject !== undefined && buyerOnly(subject);
    if (!loanByAddress.has(row.loan) && !exempt) fail("BAD_ROW", `${at}.loan`, "names no loan");
  }
  // Loading references (live-lending.md §6.10.4).
  const positionAddresses = new Set(positions.map(({ row }) => row.address));
  for (const { row, index } of loadingIntents) {
    const at = `loadingIntents[${index}]`;
    if (!positionAddresses.has(row.position))
      fail("BAD_ROW", `${at}.position`, "names no selected position");
    sameOrg(organisationAt(row.owner, `${at}.owner`).row, row.owner_org_id, `${at}.owner_org_id`);
    sameOrg(
      organisationAt(row.terminal, `${at}.terminal`).row,
      row.terminal_org_id,
      `${at}.terminal_org_id`,
    );
  }
  for (const { row, index } of acceptances) {
    const at = `acceptances[${index}]`;
    if (lockByLoan.get(row.loan)?.row.address !== row.lock)
      fail("BAD_ROW", `${at}.lock`, "is not the lock of its loan");
    sameOrg(
      organisationAt(row.lender, `${at}.lender`).row,
      row.lender_org_id,
      `${at}.lender_org_id`,
    );
  }

  return {
    env,
    memberships,
    organisationByAddress,
    facilities: allFacilities.map(({ row }) => row),
    valuations: allValuations.map(({ row }) => row),
    loans: loans.map(({ row }) => row),
    locks: locks.map(({ row }) => row),
    payments: payments.map(({ row }) => row),
    intents: intents.map(({ row }) => row),
    commands: commands.map(({ row }) => row),
    loadingIntents: loadingIntents.map(({ row }) => row),
    acceptances: acceptances.map(({ row }) => row),
    protocol,
    classPolicyByAddress,
    custodianClassByAddress,
    intakeByAddress,
    lots,
    positions: positions.map(({ row }) => row),
    documents: documents.map(({ row }) => row),
    intakeEvents: intakeEvents.map(({ row }) => row),
    checkpoint,
  };
}

type Valid = ReturnType<typeof validate>;

/** A lot the organisation reads (live-lending.md §4.5.2 `lots(org)`). */
function belongsTo(data: Valid, lot: ChainLotRow, orgId: string): boolean {
  const positions = data.positions.filter((position) => position.lot === lot.address);
  return (
    lot.custodian_org_id === orgId ||
    positions.some((position) => position.owner_org_id === orgId) ||
    data.facilities.some(
      (facility) =>
        facility.lender_org_id === orgId &&
        positions.some((position) => position.owner === facility.borrower),
    ) ||
    data.intents.some((intent) => intent.lot === lot.address && intent.buyer_org_id === orgId)
  );
}

/** The program's lot state as the dossier's custody label (web.md §3 `CustodyState`). */
const CUSTODY_LABEL: Record<ChainLotRow["state"], CustodyState> = {
  Stored: "Stored",
  Redeemed: "Collected",
  Prepared: "Awaiting departure",
  InTransit: "In transit",
  Loaded: "Loaded",
};

/** The program's restriction as the dossier's label (web.md §3 `RestrictionState`). */
const RESTRICTION_LABEL: Record<ChainLotRow["restriction"], RestrictionState> = {
  Normal: "Normal",
  ReviewRequired: "Review required",
  Disputed: "Disputed",
  Frozen: "Frozen",
};

function evidenceOf(data: Valid, lot: ChainLotRow): ChainDocumentRow[] {
  const digest = data.intakeByAddress.get(lot.intake)?.row.intake_digest_hex;
  return data.documents.filter((document) => document.subject_hex === digest);
}

/** (4) Real parties are never called synthetic: every membership, and every rendered organisation. */
function checkSynthetic(data: Valid) {
  for (const { row, index } of data.memberships) {
    if (row.synthetic !== true)
      fail("NOT_SYNTHETIC", `memberships[${index}].synthetic`, "not marked synthetic");
  }
  const memberIds = data.memberships.map(({ row }) => row.id);
  const rendered = new Set<string>();
  for (const { row: lot } of data.lots) {
    const positions = data.positions.filter((position) => position.lot === lot.address);
    if (!memberIds.some((id) => belongsTo(data, lot, id))) continue;
    rendered.add(lot.custodian);
    for (const position of positions) rendered.add(position.owner);
    for (const document of evidenceOf(data, lot)) rendered.add(document.issuer);
  }
  // The live lending views render these too (live-lending.md §4.5.1 synthetic check).
  for (const facility of data.facilities) {
    rendered.add(facility.lender);
    rendered.add(facility.borrower);
  }
  for (const intent of data.intents) {
    rendered.add(intent.seller);
    rendered.add(intent.buyer);
    rendered.add(intent.lender);
  }
  for (const { row } of data.organisationByAddress.values()) {
    if (row.role === "Buyer" || row.role === "Exporter") rendered.add(row.address);
  }
  for (const intent of data.loadingIntents) {
    rendered.add(intent.owner);
    rendered.add(intent.terminal);
  }
  for (const accepted of data.acceptances) rendered.add(accepted.lender);
  const signerOrgs = new Set(
    data.commands.flatMap(({ signers }) => signers.map(({ organisationId }) => organisationId)),
  );
  for (const { row } of data.organisationByAddress.values()) {
    if (signerOrgs.has(row.org_id)) rendered.add(row.address);
  }
  const shown = [...rendered]
    .map((address) => data.organisationByAddress.get(address))
    .filter((entry) => entry !== undefined)
    .toSorted((first, second) => first.index - second.index);
  for (const { row, index } of shown) {
    if (row.slug === null || !SLUG.test(row.slug)) {
      fail("NOT_SYNTHETIC", `organisations[${index}].slug`, "has no synthetic organisation slug");
    }
    if (row.synthetic !== true)
      fail("NOT_SYNTHETIC", `organisations[${index}].synthetic`, "not marked synthetic");
  }
}

export function liveReader(snapshot: LiveSnapshot, now: Date): LiveReader {
  const data = validate(snapshot);
  checkSynthetic(data);
  const freshness = freshnessOf(data.checkpoint, now);

  const memberships = data.memberships
    .map(({ row }) => row)
    .toSorted((first, second) =>
      first.slug < second.slug ? -1 : first.slug > second.slug ? 1 : 0,
    );
  const contexts: Context[] = memberships.map(({ slug, name, kind }) => ({
    organisationId: slug,
    role: kind,
    organisation: { id: slug, name, role: kind },
  }));
  const membershipBySlug = new Map<string, OrganisationRow>(
    memberships.map((row) => [row.slug, row]),
  );

  const organisation = (address: string): Organisation => {
    const row = data.organisationByAddress.get(address)?.row;
    if (!row?.slug)
      throw new LiveDataError("BAD_ROW", "organisations", `no organisation ${address}`);
    return { id: row.slug, name: row.display_name, role: roleLabel(row.role) };
  };
  const positionsOf = (lot: ChainLotRow) =>
    data.positions.filter((position) => position.lot === lot.address);
  const skewed = (lot: ChainLotRow) =>
    positionsOf(lot).reduce((sum, position) => sum + parseU64(position.quantity_kg), 0n) !==
    parseU64(lot.supply_kg);

  const nowMs = BigInt(now.getTime());
  const iso = (seconds: bigint) => new Date(Number(seconds) * 1000).toISOString();
  const facilityByAddress = new Map(data.facilities.map((row) => [row.address, row]));
  const loanByAddress = new Map(data.loans.map((row) => [row.address, row]));
  const lockByLoan = new Map(data.locks.map((row) => [row.loan, row]));
  const lotByAddress = new Map(data.lots.map(({ row }) => [row.address, row]));
  const chainOrgByOrgId = new Map(
    [...data.organisationByAddress.values()].map(({ row }) => [row.org_id, row]),
  );
  const lockedOf = (loan: ChainLoanRow) => {
    const lock = lockByLoan.get(loan.address);
    return lock ? parseU64(lock.quantity_kg) : 0n;
  };
  const largestLock = (loans: ChainLoanRow[]) =>
    loans.reduce<ChainLoanRow | null>((best, loan) => {
      if (best === null) return loan;
      const quantity = lockedOf(loan);
      const bestQuantity = lockedOf(best);
      return quantity > bestQuantity || (quantity === bestQuantity && loan.address < best.address)
        ? loan
        : best;
    }, null);

  function largestPosition(positions: ChainPositionRow[]): ChainPositionRow {
    const [first, ...rest] = positions;
    if (!first) throw new LiveDataError("BAD_ROW", "positions", "a lot without a position");
    return rest.reduce((largest, position) => {
      const quantity = parseU64(position.quantity_kg);
      const largestQuantity = parseU64(largest.quantity_kg);
      return quantity > largestQuantity ||
        (quantity === largestQuantity && position.owner < largest.owner)
        ? position
        : largest;
    }, first);
  }

  function shownPosition(positions: ChainPositionRow[], member: OrganisationRow): ChainPositionRow {
    // A lender reads the lot through its facility's borrower (live-lending.md §4.5.2).
    const borrowers = positions.filter(
      (position) =>
        parseU64(position.quantity_kg) > 0n &&
        data.facilities.some(
          (facility) =>
            facility.lender_org_id === member.id && facility.borrower === position.owner,
        ),
    );
    if (borrowers.length > 0) return largestPosition(borrowers);
    const own = positions.find(
      (position) => position.owner_org_id === member.id && parseU64(position.quantity_kg) > 0n,
    );
    if (own) return own;
    return largestPosition(positions);
  }

  function primaryLoan(shown: ChainPositionRow, member: OrganisationRow): ChainLoanRow | null {
    const open = data.loans.filter(
      (loan) => loan.position === shown.address && loan.status !== "Closed" && lockedOf(loan) > 0n,
    );
    return largestLock(
      member.kind === "lender" ? open.filter((loan) => loan.lender_org_id === member.id) : open,
    );
  }

  function accruedOf(loan: ChainLoanRow): bigint {
    try {
      return accrueSimple({
        principal: parseU64(loan.principal),
        rateBps: BigInt(loan.rate_bps),
        elapsedSeconds: (() => {
          const elapsed = nowMs / 1000n - parseI64(loan.accrued_at, "loans.accrued_at");
          return elapsed > 0n ? elapsed : 0n;
        })(),
        carriedRemainder: parseU64(loan.accrual_remainder),
      }).interest;
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      const index = snapshot.loans.findIndex((row) => row.address === loan.address);
      throw new LiveDataError("BAD_ROW", `loans[${index}]`, error.message);
    }
  }

  function valuationFor(facility: string, lot: ChainLotRow): ChainValuationRow | null {
    return (
      data.valuations.find(
        (valuation) =>
          valuation.facility === facility &&
          valuation.class_policy === lot.class_policy &&
          valuation.grade === lot.grade &&
          valuation.custodian_class === lot.custodian_class,
      ) ?? null
    );
  }

  function liveFacility(row: ChainFacilityRow): LiveFacility {
    return {
      address: row.address,
      facilityIdHex: row.facility_id_hex,
      lender: organisation(row.lender),
      borrower: organisation(row.borrower),
      currency: row.currency,
      currencyDecimals: row.currency_decimals,
      termsVersion: BigInt(row.terms_version),
      rateBps: BigInt(row.rate_bps),
      maxLtvBps: BigInt(row.max_ltv_bps),
      loanCount: BigInt(row.loan_count),
      registry: { status: row.commitment },
    };
  }

  function liveValuation(row: ChainValuationRow): LiveValuation {
    const validUntil = parseI64(row.valid_until, "valuations.valid_until");
    return {
      address: row.address,
      facility: row.facility,
      valuePerKgMinor: parseU64(row.value_per_kg),
      haircutBps: BigInt(row.haircut_bps),
      validUntil: iso(validUntil),
      setAt: iso(parseI64(row.set_at, "valuations.set_at")),
      version: BigInt(row.version),
      stale: validUntil * 1000n < nowMs,
      registry: { status: row.commitment },
    };
  }

  function livePayment(row: ChainPaymentRow): LivePayment {
    return {
      address: row.address,
      purpose: row.purpose,
      subject: row.subject,
      amountMinor: parseU64(row.amount),
      status: row.status,
      appliedMinor: parseU64(row.applied),
      surplusMinor: parseU64(row.surplus),
      observedAt: iso(parseI64(row.observed_at, "payments.observed_at")),
      registry: { status: row.commitment },
    };
  }

  function liveLoan(row: ChainLoanRow): LiveLoan {
    const facility = facilityByAddress.get(row.facility);
    const lock = lockByLoan.get(row.address);
    const lot = lotByAddress.get(row.lot);
    if (!facility || !lock || !lot)
      throw new LiveDataError("BAD_ROW", "loans", `unresolved ${row.address}`);
    const principal = parseU64(row.principal);
    const booked = parseU64(row.booked_interest);
    const accrued = accruedOf(row);
    const valuation = valuationFor(row.facility, lot);
    return {
      address: row.address,
      facility: liveFacility(facility),
      index: BigInt(row.loan_index),
      status: row.status,
      principalMinor: principal,
      bookedInterestMinor: booked,
      accruedInterestMinor: accrued,
      debtMinor: principal + booked + accrued,
      accruedAt: iso(parseI64(row.accrued_at, "loans.accrued_at")),
      asOf: now.toISOString(),
      openExceptions: BigInt(row.open_exceptions),
      revision: parseU64(row.revision),
      position: row.position,
      lock: {
        address: lock.address,
        quantityKg: parseU64(lock.quantity_kg),
        control: lock.control,
      },
      valuation: valuation ? liveValuation(valuation) : null,
      payments: data.payments
        .filter((payment) => payment.loan === row.address)
        .toSorted(
          (first, second) =>
            Number(
              parseI64(first.observed_at, "payments.observed_at") -
                parseI64(second.observed_at, "payments.observed_at"),
            ) || compareText(first.address, second.address),
        )
        .map(livePayment),
      registry: { status: row.commitment },
    };
  }

  /** live-lending.md §4.5.4: the intent's Release payment state, and the payment it picked. */
  function paymentOf(intent: ChainReleaseIntentRow): {
    state: LivePaymentState;
    payment: ChainPaymentRow | null;
  } {
    const amount = parseU64(intent.price) + parseU64(intent.top_up);
    const own = data.payments
      .filter((payment) => payment.purpose === "Release" && payment.subject === intent.address)
      .toSorted((first, second) => compareText(first.address, second.address));
    const consumed = own.find((payment) => payment.status === "Consumed");
    if (consumed) return { state: "consumed", payment: consumed };
    const unconsumed = own.filter((payment) => payment.status === "Unconsumed");
    const exact = unconsumed.find((payment) => parseU64(payment.amount) === amount);
    if (exact) return { state: "confirmed", payment: exact };
    if (unconsumed[0]) return { state: "mismatch", payment: unconsumed[0] };
    const voided = own.find((payment) => payment.status === "Voided");
    if (voided) return { state: "voided", payment: voided };
    return { state: "none", payment: null };
  }

  const unexpired = (intent: ChainReleaseIntentRow) =>
    parseI64(intent.expires_at, "intents.expires_at") * 1000n > nowMs;

  function liveIntent(row: ChainReleaseIntentRow): LiveIntent {
    const lot = lotByAddress.get(row.lot);
    if (!lot) throw new LiveDataError("BAD_ROW", "intents", `unresolved ${row.address}`);
    return {
      address: row.address,
      loan: row.loan,
      lotId: lot.lot_id,
      seller: organisation(row.seller),
      buyer: organisation(row.buyer),
      lender: organisation(row.lender),
      nonce: parseU64(row.nonce),
      quantityKg: parseU64(row.quantity_kg),
      priceMinor: parseU64(row.price),
      topUpMinor: parseU64(row.top_up),
      currency: row.currency,
      currencyDecimals: row.currency_decimals,
      expiresAt: iso(parseI64(row.expires_at, "intents.expires_at")),
      expired: !unexpired(row),
      status: row.status,
      payment: paymentOf(row).state,
      registry: { status: row.commitment },
    };
  }

  const byExpiry = (first: ChainReleaseIntentRow, second: ChainReleaseIntentRow) => {
    const time =
      parseI64(first.expires_at, "intents.expires_at") -
      parseI64(second.expires_at, "intents.expires_at");
    return time !== 0n ? (time < 0n ? -1 : 1) : compareText(first.address, second.address);
  };
  const byCreation = (first: CommandRow, second: CommandRow) =>
    compareText(first.created_at, second.created_at) || compareText(first.id, second.id);

  function summary(row: CommandRow, slug: string): LiveCommandSummary {
    const signed = new Set(row.signatures.map(({ role }) => role));
    return {
      id: row.id,
      kind: row.kind as CommandKind,
      status: row.status,
      awaiting: row.signers
        .filter(({ role }) => !signed.has(role))
        .map(({ role, organisationId }) => {
          const named = organisationByOrgId(organisationId);
          if (!named)
            throw new LiveDataError("BAD_ROW", "commands", `no organisation ${organisationId}`);
          return { role: role as SignerRole, organisation: named };
        }),
      validUntil:
        row.valid_until === null ? null : iso(parseI64(row.valid_until, "commands.valid_until")),
      href: `/${slug}/commands/${row.id}`,
    };
  }

  function organisationByOrgId(orgId: string): Organisation | null {
    const chain = chainOrgByOrgId.get(orgId);
    if (chain?.slug) return organisation(chain.address);
    const member = memberships.find((row) => row.id === orgId);
    return member ? { id: member.slug, name: member.name, role: member.kind } : null;
  }

  /** A position's visible open locks, by lender name then loan, and its locked_kg beyond them. */
  function locksOf(position: ChainPositionRow) {
    const visibleLocks = data.locks
      .filter((row) => {
        const owner = loanByAddress.get(row.loan);
        return (
          row.position === position.address && owner !== undefined && owner.status !== "Closed"
        );
      })
      .map((row) => {
        const owner = loanByAddress.get(row.loan) as ChainLoanRow;
        const facility = facilityByAddress.get(owner.facility) as ChainFacilityRow;
        return {
          loan: owner.address,
          lender: organisation(facility.lender),
          kg: parseU64(row.quantity_kg),
        };
      })
      .toSorted(
        (first, second) =>
          compareText(first.lender.name, second.lender.name) ||
          compareText(first.loan, second.loan),
      );
    const lockedKg = parseU64(position.locked_kg);
    const visibleLockedKg = visibleLocks.reduce((sum, { kg }) => sum + kg, 0n);
    const hiddenLockedKg = lockedKg > visibleLockedKg ? lockedKg - visibleLockedKg : 0n;
    return { visibleLocks, hiddenLockedKg };
  }

  /** live-lending.md §6.10.4: the loading intents of the viewer's positions, from chain rows and `now`. */
  function loadingView(
    lot: ChainLotRow,
    shown: ChainPositionRow,
    member: OrganisationRow,
    loans: LiveLoan[],
  ): LiveLoading {
    const custodian = data.organisationByAddress.get(lot.custodian)?.row;
    const custodianClass = data.custodianClassByAddress.get(lot.custodian_class)?.row;
    const lotPositions = positionsOf(lot);
    const positionByAddress = new Map(lotPositions.map((row) => [row.address, row]));
    // T064b.4 pre-check fold 10: a loaded position (0 kg) stays in view for its owner and lenders.
    const viewed = new Set([
      shown.address,
      ...lotPositions.filter((row) => row.owner_org_id === member.id).map((row) => row.address),
      ...data.loans
        .filter((row) => row.lot === lot.address && row.lender_org_id === member.id)
        .map((row) => row.position),
    ]);
    // An intent whose position is not one of this lot's is left out (T056x X1: a bad row fails
    // soft, never the whole dossier).
    const intents = data.loadingIntents
      .filter(
        (row) =>
          row.lot === lot.address &&
          viewed.has(row.position) &&
          positionByAddress.has(row.position),
      )
      .toSorted((first, second) => {
        const delta = parseU64(second.position_revision) - parseU64(first.position_revision);
        return delta !== 0n ? (delta < 0n ? -1 : 1) : compareText(first.address, second.address);
      })
      .map((row) =>
        loadingIntentView(
          row,
          lot,
          positionByAddress.get(row.position) as ChainPositionRow,
          member,
          loans,
        ),
      );
    return {
      terminal: custodian?.role === "Terminal" ? organisation(lot.custodian) : null,
      site: custodianClass?.site_code ?? "",
      positionQuantityKg: parseU64(shown.quantity_kg),
      intents,
    };
  }

  function loadingIntentView(
    row: ChainLoadingIntentRow,
    lot: ChainLotRow,
    position: ChainPositionRow,
    member: OrganisationRow,
    loans: LiveLoan[],
  ): LiveLoadingIntent {
    // The locks of the intent's own position, not the shown one's (T056x X1).
    const hiddenLockedKg = locksOf(position).hiddenLockedKg;
    const expiresAt = parseI64(row.expires_at, "loadingIntents.expires_at");
    const current = parseU64(row.position_revision) === parseU64(position.revision);
    const unexpiredIntent = expiresAt * 1000n > nowMs;
    const live = row.status === "Open" && row.cancelled_by === null && current && unexpiredIntent;
    const accepted = data.acceptances.filter((entry) => entry.intent === row.address);
    const openCommand = (kind: CommandKind, loan?: string) => {
      const found = data.commands
        .filter(
          (command) =>
            command.kind === kind &&
            command.intent === row.address &&
            (loan === undefined || (command.loan ?? command.args.loan) === loan),
        )
        .toSorted(byCreation)[0];
      return found ? summary(found, member.slug) : null;
    };
    const required = loans.filter(
      (loan) =>
        loan.position === row.position && loan.status !== "Closed" && loan.lock.quantityKg > 0n,
    );
    const registryOf = (commitment: ChainLoadingIntentRow["commitment"]): Registry => ({
      status: commitment,
    });
    let rows: LiveLoadingRow[];
    if (live) {
      rows = required.map((loan) => {
        const own = accepted.find((entry) => entry.loan === loan.address);
        const state: LiveLoadingRow["state"] =
          loan.status === "Recovery"
            ? "recovery"
            : !own
              ? "missing"
              : parseU64(own.loan_revision) === loan.revision &&
                  parseU64(own.lock_quantity_kg) === loan.lock.quantityKg
                ? "accepted"
                : "stale";
        return {
          loan: loan.address,
          loanIndex: loan.index,
          lender: loan.facility.lender,
          lockedKg: loan.lock.quantityKg,
          state,
          acceptedAt: own ? iso(parseI64(own.accepted_at, "acceptances.accepted_at")) : null,
          registry: own ? registryOf(own.commitment) : null,
          openCommand: openCommand("accept_loading", loan.address),
        };
      });
    } else {
      // Recorded as it stands, no freshness check; loans without a row are not listed.
      rows = accepted.flatMap((entry) => {
        const loan = loans.find((candidate) => candidate.address === entry.loan);
        if (!loan) return [];
        return [
          {
            loan: loan.address,
            loanIndex: loan.index,
            lender: loan.facility.lender,
            lockedKg: parseU64(entry.lock_quantity_kg),
            state: "accepted" as const,
            acceptedAt: iso(parseI64(entry.accepted_at, "acceptances.accepted_at")),
            registry: registryOf(entry.commitment),
            openCommand: null,
          },
        ];
      });
    }
    rows = rows.toSorted((first, second) =>
      first.loanIndex !== second.loanIndex
        ? first.loanIndex < second.loanIndex
          ? -1
          : 1
        : compareText(first.loan, second.loan),
    );
    const acceptedCount = rows.filter(({ state }) => state === "accepted").length;
    const requiredCount = hiddenLockedKg > 0n ? null : required.length;
    const state: LiveLoadingIntent["state"] =
      row.status === "Executed"
        ? "recorded"
        : row.cancelled_by !== null
          ? "cancelled"
          : !current
            ? "outdated"
            : !unexpiredIntent
              ? "expired"
              : requiredCount !== null && acceptedCount === requiredCount
                ? "ready"
                : "open";
    const recorded = state === "recorded";
    return {
      address: row.address,
      nonce: parseU64(row.nonce),
      owner: organisation(row.owner),
      terminal: organisation(row.terminal),
      position: row.position,
      quantityKg: parseU64(row.quantity_kg),
      lockedKg: parseU64(row.locked_kg),
      documentSha256Hex: row.document_sha256_hex,
      positionRevision: parseU64(row.position_revision),
      expiresAt: iso(expiresAt),
      executedAt:
        row.executed_at === null
          ? null
          : iso(parseI64(row.executed_at, "loadingIntents.executed_at")),
      cancelledBy: row.cancelled_by,
      state,
      live,
      rows,
      accepted: acceptedCount,
      required: requiredCount,
      hiddenLockedKg,
      handOffs: recorded
        ? rows.flatMap(({ loan: address }) => {
            const loan = loans.find((candidate) => candidate.address === address);
            return loan
              ? [
                  {
                    loan: loan.address,
                    loanIndex: loan.index,
                    lender: loan.facility.lender,
                    status: loan.status,
                    debtMinor: loan.debtMinor,
                    currency: loan.facility.currency,
                    currencyDecimals: loan.facility.currencyDecimals,
                  },
                ]
              : [];
          })
        : [],
      lotLoaded: recorded && lot.state === "Loaded",
      openCommand: openCommand("record_loading"),
      registry: registryOf(row.commitment),
    };
  }

  function lotView(lot: ChainLotRow, member: OrganisationRow): LiveLotView {
    const classPolicy = data.classPolicyByAddress.get(lot.class_policy)?.row;
    const custodianClass = data.custodianClassByAddress.get(lot.custodian_class)?.row;
    if (!classPolicy || !custodianClass)
      throw new LiveDataError("BAD_ROW", "lots", `unresolved ${lot.lot_id}`);
    const site: Site = {
      id: lot.custodian_class,
      name: custodianClass.site_code,
      kind: "custodian site",
    };
    const custodian = organisation(lot.custodian);
    const shown = shownPosition(positionsOf(lot), member);
    const positionQuantity = parseU64(shown.quantity_kg);
    const activeLockedQuantity = parseU64(shown.locked_kg);
    const separatelyReservedQuantity = parseU64(shown.reserved_kg);
    const timeline = data.intakeEvents
      .filter((event) => event.lot === lot.address)
      .toSorted(compareEvents)
      .map((event) => ({
        id: `${event.signature}:${event.event_index}`,
        kind: "intake" as const,
        site,
        quantityKg: parseU64(event.data.quantityKg),
        by: [custodian],
        at: event.block_time,
        registry: { status: event.commitment },
      }));
    const evidence = evidenceOf(data, lot)
      .toSorted((first, second) =>
        first.version !== second.version
          ? first.version - second.version
          : first.address < second.address
            ? -1
            : first.address > second.address
              ? 1
              : 0,
      )
      .map((document) => ({
        id: document.address,
        kind: `${document.kind} attestation, version ${document.version}`,
        issuer: organisation(document.issuer),
        status:
          document.revoked_at !== null
            ? ("Revoked" as const)
            : parseI64(document.valid_until, "documents.valid_until") * 1000n <= nowMs
              ? ("Expired" as const)
              : ("Human-attested" as const),
        file: null,
      }));

    const primary = primaryLoan(shown, member);
    const lockedKg = parseU64(shown.locked_kg);
    const openOnShown = data.loans.filter(
      (loan) => loan.position === shown.address && loan.status !== "Closed",
    );
    let finance: LiveLotView["finance"];
    if (primary?.status === "Active") finance = "Pledged";
    else if (primary?.status === "Recovery") finance = "Recovery";
    else if (primary?.status === "ExternalHandoff") finance = "External hand-off";
    else if (lockedKg > 0n)
      finance = "Pledged"; // a lock the viewer can't see is never available
    else if (
      openOnShown.length === 0 &&
      data.loans.some((loan) => loan.position === shown.address && loan.status === "Closed")
    )
      finance = "Repaid";
    else finance = "Available";

    const primaryView = primary ? liveLoan(primary) : null;
    const loanFacility = primary ? facilityByAddress.get(primary.facility) : undefined;
    const loanView: LiveLotView["loan"] =
      primaryView && loanFacility
        ? {
            principalMinor: primaryView.principalMinor,
            bookedInterestMinor: primaryView.bookedInterestMinor + primaryView.accruedInterestMinor,
            bookedFeesMinor: 0n,
            debtMinor: primaryView.debtMinor,
            status: primaryView.status,
            lender: organisation(loanFacility.lender),
            registry: primaryView.registry,
          }
        : null;
    const valuationRow = primary ? valuationFor(primary.facility, lot) : null;
    let valuationView: LiveLotView["valuation"] = null;
    if (primaryView && loanFacility && valuationRow) {
      const value = parseU64(valuationRow.value_per_kg);
      const haircut = BigInt(valuationRow.haircut_bps);
      const eligible = (primaryView.lock.quantityKg * value * (10000n - haircut)) / 10000n;
      valuationView = {
        valuePerKgMinor: value,
        haircutBps: haircut,
        maxLtvBps: BigInt(loanFacility.max_ltv_bps),
        validUntil: iso(parseI64(valuationRow.valid_until, "valuations.valid_until")),
        eligibleValueMinor: eligible,
        ltvBps: eligible === 0n ? null : (primaryView.debtMinor * 10000n) / eligible,
        registry: { status: valuationRow.commitment },
      };
    }

    const { visibleLocks, hiddenLockedKg } = locksOf(shown);
    const loanViews = data.loans
      .filter((loan) => loan.lot === lot.address)
      .toSorted(
        (first, second) =>
          compareText(first.facility, second.facility) || first.loan_index - second.loan_index,
      )
      .map(liveLoan);
    const lotIntents = data.intents
      .filter((intent) => intent.lot === lot.address)
      .toSorted(byExpiry);

    const lending: LiveLending = {
      lotAddress: lot.address,
      primaryLoan: primary?.address ?? null,
      valuations: data.valuations
        .filter(
          (valuation) =>
            valuation.class_policy === lot.class_policy &&
            valuation.grade === lot.grade &&
            valuation.custodian_class === lot.custodian_class,
        )
        .toSorted((first, second) => compareText(first.facility, second.facility))
        .map(liveValuation),
      facilities: data.facilities
        .filter((facility) => facility.borrower === shown.owner)
        .toSorted((first, second) => compareText(first.address, second.address))
        .map(liveFacility),
      loans: loanViews,
      intents: lotIntents.map(liveIntent),
      hiddenLockedKg,
      openCommands: data.commands
        .filter((command) => command.lot === lot.address)
        .toSorted(byCreation)
        .map((command) => summary(command, member.slug)),
      shownPosition: {
        address: shown.address,
        owner: organisation(shown.owner),
        revision: parseU64(shown.revision),
      },
      classPolicy: lot.class_policy,
      grade: lot.grade,
      custodianClass: lot.custodian_class,
      loading: loadingView(lot, shown, member, loanViews),
    };

    return {
      id: lot.lot_id,
      mineral: classPolicy.class_code.toLowerCase(),
      gradeClass: `${classPolicy.class_code} v${lot.class_version}, grade ${lot.grade}`,
      quantityKg: parseU64(lot.supply_kg),
      site,
      owner: organisation(shown.owner),
      custodian,
      custody: CUSTODY_LABEL[lot.state],
      finance,
      restriction: RESTRICTION_LABEL[lot.restriction],
      position: {
        positionQuantityKg: positionQuantity,
        activeLockedQuantityKg: activeLockedQuantity,
        separatelyReservedQuantityKg: separatelyReservedQuantity,
        availableKg: availableQuantity({
          positionQuantity,
          activeLockedQuantity,
          separatelyReservedQuantity,
        }),
      },
      locks: visibleLocks.map(({ lender, kg }) => ({ lender, lockedQuantityKg: kg })),
      discrepancyKg: 0n,
      registry: { status: lot.commitment },
      loan: loanView,
      valuation: valuationView,
      custodyTimeline: timeline,
      evidence,
      releases: lotIntents.map((intent) => ({
        id: intent.address,
        buyer: organisation(intent.buyer),
        soldLockedQuantityKg: parseU64(intent.quantity_kg),
        payment: paymentOf(intent).state,
        registry: { status: intent.commitment },
      })),
      lending,
    };
  }

  const visibleLots = (member: OrganisationRow) =>
    data.lots
      .map(({ row }) => row)
      .filter((lot) => belongsTo(data, lot, member.id))
      .toSorted((first, second) => {
        const time = Date.parse(second.issued_at) - Date.parse(first.issued_at);
        if (time !== 0) return time;
        return first.lot_id < second.lot_id ? -1 : first.lot_id > second.lot_id ? 1 : 0;
      });

  function lots(organisationId: string): LiveLotView[] {
    const member = membershipBySlug.get(organisationId);
    if (!member) return [];
    return visibleLots(member).map((lot) => lotView(lot, member));
  }

  function releases(organisationId: string): LiveIntent[] {
    const member = membershipBySlug.get(organisationId);
    if (!member) return [];
    const visible = new Set(visibleLots(member).map(({ address }) => address));
    return data.intents
      .filter((intent) => visible.has(intent.lot))
      .toSorted(byExpiry)
      .map(liveIntent);
  }

  function facilities(organisationId: string): LiveFacility[] {
    const member = membershipBySlug.get(organisationId);
    if (!member) return [];
    return data.facilities
      .filter(
        (facility) =>
          facility.lender_org_id === member.id || facility.borrower_org_id === member.id,
      )
      .toSorted((first, second) => compareText(first.address, second.address))
      .map(liveFacility);
  }

  type Money = { currency: string; minorDigits: number };
  const facilityMoney = (address: string | null | undefined): Money | null => {
    const facility = address ? facilityByAddress.get(address) : undefined;
    return facility
      ? { currency: facility.currency, minorDigits: facility.currency_decimals }
      : null;
  };

  /** live-lending.md §4.5.3, with each amount's currency beside it. */
  function queue(organisationId: string): { item: WorkItemView; money: Money | null }[] {
    const member = membershipBySlug.get(organisationId);
    const context = contexts.find((entry) => entry.organisationId === organisationId);
    if (!member || !context) return [];
    const actor = context.organisation;
    const lotRef = (address: string) => {
      const lot = lotByAddress.get(address);
      if (!lot) return null;
      const view = lotView(lot, member);
      return {
        id: view.id,
        gradeClass: view.gradeClass,
        site: view.site,
        quantityKg: view.quantityKg,
      };
    };
    const notSubmitted: Registry = { status: "not_submitted" };
    const out: { item: WorkItemView; money: Money | null }[] = [];

    data.commands.forEach((row, index) => {
      if (row.status !== "awaiting_signatures" || row.lot === null) return;
      const lot = lotRef(row.lot);
      if (!lot) return;
      const validUntil =
        row.valid_until === null
          ? null
          : parseI64(row.valid_until, `commands[${index}].valid_until`);
      if (validUntil !== null && (validUntil - 30n) * 1000n <= nowMs) return;
      const signed = new Set(row.signatures.map(({ role }) => role));
      const textRoles = row.signers.filter(({ method }) => method === "text");
      const textDone = textRoles.every(({ role }) => signed.has(role));
      // A terminal signs on the field app, never in the web (T064b.4 pre-check fold 5).
      const mine = row.signers.some(
        ({ role, organisationId: org, method }) =>
          org === member.id &&
          role !== "terminal" &&
          !signed.has(role) &&
          (method === "text" || textDone),
      );
      if (!mine) return;
      const collected = textRoles.filter(({ role }) => signed.has(role)).length;
      const blocker =
        textRoles.length > 0 && validUntil !== null
          ? `${collected} of ${row.signers.length} signatures collected. The text expires at ${formatClockTime(iso(validUntil - 30n))}.`
          : "Waiting for your wallet to sign the transaction.";
      const arg = (name: string) =>
        row.args[name] === undefined
          ? null
          : parseU64At(row.args[name] as string, `commands[${index}].args.${name}`);
      const amount = arg("amountMinor") ?? arg("priceMinor");
      const loanFacility = row.loan ? loanByAddress.get(row.loan)?.facility : undefined;
      out.push({
        item: {
          id: row.id,
          lot,
          action: `Sign: ${kindTitles[row.kind as CommandKind]}`,
          nextActor: actor,
          blocker,
          deadline: validUntil === null ? null : iso(validUntil - 30n),
          href: `/${organisationId}/commands/${row.id}`,
          amountMinor: amount,
          quantityKg: arg("quantityKg"),
          registry: { status: "awaiting_signatures" },
        },
        money:
          amount === null ? null : (facilityMoney(row.facility) ?? facilityMoney(loanFacility)),
      });
    });

    for (const intent of data.intents) {
      if (intent.status !== "Open" || !unexpired(intent)) continue;
      const lot = lotRef(intent.lot);
      if (!lot) continue;
      const amount = parseU64(intent.price) + parseU64(intent.top_up);
      const money = { currency: intent.currency, minorDigits: intent.currency_decimals };
      const state = paymentOf(intent).state;
      const common = {
        lot,
        nextActor: actor,
        deadline: iso(parseI64(intent.expires_at, "intents.expires_at")),
        href: `/${organisationId}/releases/${intent.address}`,
        amountMinor: amount,
        quantityKg: parseU64(intent.quantity_kg),
        registry: notSubmitted,
      };
      // A voided payment raises nothing (T064b.2 decision 4).
      if (intent.lender_org_id === member.id && (state === "none" || state === "mismatch")) {
        out.push({
          item: {
            id: `confirm:${intent.address}`,
            action: "Confirm payment",
            blocker: `${organisation(intent.buyer).name} pays ${formatMoney(amount, money.currency, money.minorDigits)} outside Thetis. Record it once your bank shows it.`,
            ...common,
          },
          money,
        });
      }
      const selling = data.commands.some(
        (command) => command.kind === "sell_pledged" && command.intent === intent.address,
      );
      if (intent.buyer_org_id === member.id && state === "confirmed" && !selling) {
        out.push({
          item: {
            id: `accept:${intent.address}`,
            action: "Accept and buy",
            blocker: `${organisation(intent.lender).name} confirmed your payment. Sign to receive the units.`,
            ...common,
          },
          money,
        });
      }
    }

    for (const payment of data.payments) {
      if (payment.purpose !== "Repayment" || payment.status !== "Unconsumed") continue;
      const loan = loanByAddress.get(payment.loan);
      if (!loan || loan.status === "Closed" || loan.lender_org_id !== member.id) continue;
      const lot = lotByAddress.get(loan.lot);
      const ref = lotRef(loan.lot);
      const money = facilityMoney(loan.facility);
      if (!lot || !ref || !money) continue;
      const amount = parseU64(payment.amount);
      out.push({
        item: {
          id: `apply:${payment.address}`,
          lot: ref,
          action: "Apply repayment",
          nextActor: actor,
          blocker: `${formatMoney(amount, money.currency, money.minorDigits)} confirmed on ${formatDateTime(iso(parseI64(payment.observed_at, "payments.observed_at")))}. Apply it to the loan.`,
          deadline: null,
          href: `/${organisationId}/lots/${encodeURIComponent(lot.lot_id)}?tab=financing`,
          amountMinor: amount,
          quantityKg: null,
          registry: notSubmitted,
        },
        money,
      });
    }

    // Loading (live-lending.md §6.10.8 work queue): a lender's acceptance, a ready owner's record.
    for (const lot of visibleLots(member)) {
      const view = lotView(lot, member);
      const loading = view.lending?.loading;
      if (!view.lending || !loading?.terminal) continue;
      const ref = {
        id: view.id,
        gradeClass: view.gradeClass,
        site: view.site,
        quantityKg: view.quantityKg,
      };
      const href = `/${organisationId}/lots/${encodeURIComponent(view.id)}?tab=financing`;
      for (const intent of loading.intents) {
        if (!intent.live) continue;
        const common = {
          lot: ref,
          nextActor: actor,
          deadline: intent.expiresAt,
          href,
          amountMinor: null,
          registry: notSubmitted,
        };
        for (const row of intent.rows) {
          const loan = view.lending.loans.find(({ address }) => address === row.loan);
          if (
            row.lender.id !== organisationId ||
            (row.state !== "missing" && row.state !== "stale") ||
            row.openCommand !== null ||
            loan?.status !== "Active"
          )
            continue;
          out.push({
            item: {
              ...common,
              id: `accept-loading:${intent.address}:${row.loan}`,
              action: "Accept loading",
              blocker: `${intent.owner.name} is loading ${view.id} at ${intent.terminal.name}. Accept so the loading can be recorded.`,
              quantityKg: row.lockedKg,
            },
            money: null,
          });
        }
        if (
          intent.owner.id === organisationId &&
          intent.state === "ready" &&
          intent.openCommand === null
        ) {
          out.push({
            item: {
              ...common,
              id: `record-loading:${intent.address}`,
              action: "Record loading",
              // T064b.4 pre-check fold 12: with no lock there was nothing to accept.
              blocker: `${intent.required === 0 ? "No loan holds a lock on this position, so no lender needs to accept." : "Every lender has accepted."} Record the loading with ${intent.terminal.name}.`,
              quantityKg: intent.quantityKg,
            },
            money: null,
          });
        }
      }
    }

    return out.toSorted(({ item: first }, { item: second }) => {
      if (first.deadline !== second.deadline) {
        if (first.deadline === null) return 1;
        if (second.deadline === null) return -1;
        return Date.parse(first.deadline) - Date.parse(second.deadline);
      }
      return compareText(first.id, second.id);
    });
  }

  function liveRelease(address: string, organisationId: string): LiveReleaseView | null {
    const member = membershipBySlug.get(organisationId);
    const intent = data.intents.find((row) => row.address === address);
    if (!member || !intent) return null;
    const lotRow = lotByAddress.get(intent.lot);
    if (!lotRow || !belongsTo(data, lotRow, member.id)) return null;
    const loanRow = loanByAddress.get(intent.loan);
    const loan = loanRow ? liveLoan(loanRow) : null;
    const view = liveIntent(intent);
    let inputs: ReleaseInput | null = null;
    let preview: LiveReleaseView["preview"] = null;
    let previewBlocked: LiveReleaseView["previewBlocked"] = null;
    if (!loan) previewBlocked = "buyer";
    else if (!loan.valuation) previewBlocked = "no_valuation";
    else {
      inputs = {
        principal: loan.principalMinor,
        bookedInterest: loan.bookedInterestMinor + loan.accruedInterestMinor,
        bookedFees: 0n,
        buyerAmount: view.priceMinor,
        sellerTopUp: view.topUpMinor,
        lockedQuantity: loan.lock.quantityKg,
        soldLockedQuantity: view.quantityKg,
        valuePerUnit: loan.valuation.valuePerKgMinor,
        haircutBps: loan.valuation.haircutBps,
        maxLtvBps: loan.facility.maxLtvBps,
      };
      try {
        preview = previewRelease(inputs);
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        preview = { error: { code: error.code, message: error.message } };
      }
    }
    const sell = data.commands
      .filter((command) => command.kind === "sell_pledged" && command.intent === address)
      .toSorted(byCreation)[0];
    const saleRegistry: Registry =
      intent.status === "Executed"
        ? { status: intent.commitment }
        : sell
          ? { status: sell.status }
          : { status: "not_submitted" };
    return {
      intent: view,
      lot: lotView(lotRow, member),
      lender: view.lender,
      currency: view.currency,
      minorDigits: view.currencyDecimals,
      loan,
      inputs,
      preview,
      previewBlocked,
      asOf: now.toISOString(),
      paymentAddress: paymentOf(intent).payment?.address ?? null,
      sale: { registry: saleRegistry, command: sell ? summary(sell, member.slug) : null },
    };
  }

  const settlementMode = data.protocol
    ? SETTLEMENT_MODES[data.protocol.settlement_mode]
    : "NOT_INDEXED";

  return {
    mode: "live",
    scenario: {
      label: "synthetic",
      scenarioVersion: `devnet ${data.env.protocol}`,
      settlementMode,
      network: "devnet",
      facilityCurrency: null,
      currencyMinorDigits: null,
    },
    freshness,
    contexts: () => [...contexts],
    context: (id) => contexts.find(({ organisationId }) => organisationId === id) ?? null,
    workQueue: (organisationId) => queue(organisationId).map(({ item }) => item),
    exceptions: () => [],
    release: () => null,
    lots,
    lot: (lotId, organisationId) => lots(organisationId).find(({ id }) => id === lotId) ?? null,
    lotStale(lotId) {
      if (freshness.state === "halted") return "halted";
      const lot = data.lots.find(({ row }) => row.lot_id === lotId)?.row;
      return lot && skewed(lot) ? "skew" : null;
    },
    liveRelease,
    releases,
    facilityCurrency(organisationId) {
      const kinds = new Map(
        facilities(organisationId).map(({ currency, currencyDecimals }) => [
          `${currency}:${currencyDecimals}`,
          { currency, minorDigits: currencyDecimals },
        ]),
      );
      if (kinds.size === 0) return "none";
      if (kinds.size > 1) return "mixed";
      return [...kinds.values()][0] as Money;
    },
    organisationsByRole: (role) =>
      [...data.organisationByAddress.values()]
        .filter(({ row }) => row.role === role)
        .map(({ row }) => organisation(row.address))
        .toSorted((first, second) => compareText(first.name, second.name)),
    facilities,
    orgIdOf: (organisationId) =>
      membershipBySlug.get(organisationId)?.id ??
      [...data.organisationByAddress.values()].find(({ row }) => row.slug === organisationId)?.row
        .org_id ??
      null,
    organisationByOrgId,
    workItemMoney(organisationId, itemId) {
      const entry = queue(organisationId).find(({ item }) => item.id === itemId);
      return entry && entry.item.amountMinor !== null ? entry.money : null;
    },
  };
}

function compareText(first: string, second: string): number {
  return first < second ? -1 : first > second ? 1 : 0;
}

function compareEvents(first: ChainEventRow, second: ChainEventRow): number {
  const time = Date.parse(first.block_time) - Date.parse(second.block_time);
  if (time !== 0) return time;
  if (first.slot !== second.slot) return first.slot - second.slot;
  if (first.signature !== second.signature) return first.signature < second.signature ? -1 : 1;
  return first.event_index - second.event_index;
}
