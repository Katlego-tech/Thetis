import { availableQuantity, parseU64 } from "@thetis/domain";
import type { Context, Organisation, Site } from "../types";
import { freshnessOf } from "./freshness";
import {
  type ChainDocumentRow,
  type ChainEventRow,
  type ChainLotRow,
  type ChainOrganisationRow,
  type ChainPositionRow,
  type ChainProtocolRow,
  checkRow,
  type LiveSnapshot,
  type OrganisationRow,
  parseI64,
  type RowField,
  type RowsOf,
  SLUG,
} from "./rows";
import { LiveDataError, type LiveDataErrorCode, type LiveLotView, type LiveReader } from "./types";

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
  for (const { row, index } of positions) {
    const at = `positions[${index}]`;
    sameOrg(organisationAt(row.owner, `${at}.owner`).row, row.owner_org_id, `${at}.owner_org_id`);
    if (row.locked_kg !== "0") fail("BAD_ROW", `${at}.locked_kg`, "locks need the Phase 2 adapter");
    if (row.reserved_kg !== "0")
      fail("BAD_ROW", `${at}.reserved_kg`, "reservations need the Phase 2 adapter");
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

  return {
    env,
    memberships,
    organisationByAddress,
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

function belongsTo(lot: ChainLotRow, positions: ChainPositionRow[], orgId: string): boolean {
  return (
    lot.custodian_org_id === orgId || positions.some((position) => position.owner_org_id === orgId)
  );
}

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
    if (!memberIds.some((id) => belongsTo(lot, positions, id))) continue;
    rendered.add(lot.custodian);
    for (const position of positions) rendered.add(position.owner);
    for (const document of evidenceOf(data, lot)) rendered.add(document.issuer);
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

  function shownPosition(positions: ChainPositionRow[], orgId: string): ChainPositionRow {
    const own = positions.find(
      (position) => position.owner_org_id === orgId && parseU64(position.quantity_kg) > 0n,
    );
    if (own) return own;
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

  function lotView(lot: ChainLotRow, orgId: string): LiveLotView {
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
    const shown = shownPosition(positionsOf(lot), orgId);
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
    const nowMs = BigInt(now.getTime());
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
        kind: `Origin attestation, version ${document.version}`,
        issuer: organisation(document.issuer),
        status:
          document.revoked_at !== null
            ? ("Revoked" as const)
            : parseI64(document.valid_until, "documents.valid_until") * 1000n <= nowMs
              ? ("Expired" as const)
              : ("Human-attested" as const),
        file: null,
      }));

    return {
      id: lot.lot_id,
      mineral: classPolicy.class_code.toLowerCase(),
      gradeClass: `${classPolicy.class_code} v${lot.class_version}, grade ${lot.grade}`,
      quantityKg: parseU64(lot.supply_kg),
      site,
      owner: organisation(shown.owner),
      custodian,
      custody: lot.state === "Stored" ? "Stored" : "Collected",
      finance: "Available",
      restriction: "Normal",
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
      locks: [],
      discrepancyKg: 0n,
      registry: { status: lot.commitment },
      loan: null,
      valuation: null,
      custodyTimeline: timeline,
      evidence,
      releases: [],
    };
  }

  function lots(organisationId: string): LiveLotView[] {
    const member = membershipBySlug.get(organisationId);
    if (!member) return [];
    return data.lots
      .map(({ row }) => row)
      .filter((lot) => belongsTo(lot, positionsOf(lot), member.id))
      .toSorted((first, second) => {
        const time = Date.parse(second.issued_at) - Date.parse(first.issued_at);
        if (time !== 0) return time;
        return first.lot_id < second.lot_id ? -1 : first.lot_id > second.lot_id ? 1 : 0;
      })
      .map((lot) => lotView(lot, member.id));
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
    workQueue: () => [],
    exceptions: () => [],
    release: () => null,
    lots,
    lot: (lotId, organisationId) => lots(organisationId).find(({ id }) => id === lotId) ?? null,
    lotStale(lotId) {
      if (freshness.state === "halted") return "halted";
      const lot = data.lots.find(({ row }) => row.lot_id === lotId)?.row;
      return lot && skewed(lot) ? "skew" : null;
    },
  };
}

function compareEvents(first: ChainEventRow, second: ChainEventRow): number {
  const time = Date.parse(first.block_time) - Date.parse(second.block_time);
  if (time !== 0) return time;
  if (first.slot !== second.slot) return first.slot - second.slot;
  if (first.signature !== second.signature) return first.signature < second.signature ? -1 : 1;
  return first.event_index - second.event_index;
}
