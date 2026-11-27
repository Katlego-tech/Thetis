import { describe, expect, test } from "vitest";
import { liveReader } from "@/data/live/map";
import type { LiveSnapshot } from "@/data/live/rows";
import { checkRow, parseI64 } from "@/data/live/rows";
import { LiveDataError } from "@/data/live/types";
import {
  address,
  BUYER_POSITION,
  CUSTODIAN_CLASS,
  checkpoint,
  document,
  INTAKE,
  ISSUE_SIGNATURE,
  ISSUED_AT,
  issuedSnapshot,
  KHUNOU_POSITION,
  lotRow,
  membership,
  NOW,
  orgAccount,
  orgId,
  PROTOCOL,
  position,
  transferredSnapshot,
} from "./snapshot";

const khunou = { id: "khunou", name: "Khunou Ore Exports", role: "exporter" };
const kopano = { id: "kopano", name: "Kopano Stockyard Custody", role: "custodian" };
const buyer = { id: "buyer-smelter", name: "Buyer Smelter Co", role: "buyer" };
const site = { id: CUSTODIAN_CLASS, name: "PORT-STOCKYARD", kind: "custodian site" };

function refused(snapshot: LiveSnapshot, code: string, path: string) {
  const read = () => liveReader(snapshot, NOW);
  expect(read).toThrow(LiveDataError);
  expect(read).toThrow(expect.objectContaining({ code, path }));
}

function lotOf(snapshot: LiveSnapshot, context = "khunou") {
  const lot = liveReader(snapshot, NOW).lot("CR-0001", context);
  if (!lot) throw new Error(`CR-0001 is not visible to ${context}`);
  return lot;
}

describe("live mapping", () => {
  test("liveReader maps a Phase 1 lot to a LiveLotView", () => {
    const reader = liveReader(issuedSnapshot(), NOW);
    expect(reader.mode).toBe("live");
    expect(reader.scenario).toEqual({
      label: "synthetic",
      scenarioVersion: `devnet ${PROTOCOL}`,
      settlementMode: "FIAT_ATTESTATION_TEST",
      network: "devnet",
      facilityCurrency: null,
      currencyMinorDigits: null,
    });
    expect(reader.workQueue("khunou")).toEqual([]);
    expect(reader.exceptions("khunou")).toEqual([]);
    expect(reader.release("rel-0001")).toBeNull();
    expect(reader.lotStale("CR-0001")).toBeNull();
    expect(reader.lots("khunou").map(({ id }) => id)).toEqual(["CR-0001"]);
    expect(reader.lot("CR-0001", "khunou")).toEqual({
      id: "CR-0001",
      mineral: "chrome",
      gradeClass: "CHROME v1, grade G1",
      quantityKg: 5_000_000n,
      site,
      owner: khunou,
      custodian: kopano,
      custody: "Stored",
      finance: "Available",
      restriction: "Normal",
      position: {
        positionQuantityKg: 5_000_000n,
        activeLockedQuantityKg: 0n,
        separatelyReservedQuantityKg: 0n,
        availableKg: 5_000_000n,
      },
      locks: [],
      discrepancyKg: 0n,
      registry: { status: "confirmed" },
      loan: null,
      valuation: null,
      custodyTimeline: [
        {
          id: `${ISSUE_SIGNATURE}:0`,
          kind: "intake",
          site,
          quantityKg: 5_000_000n,
          by: [kopano],
          at: ISSUED_AT,
          registry: { status: "confirmed" },
        },
      ],
      evidence: [],
      releases: [],
      // live-lending.md §6.8: liveReader sets `lending`; a Phase 1 lot has no lending records.
      lending: expect.objectContaining({
        primaryLoan: null,
        loans: [],
        intents: [],
        hiddenLockedKg: 0n,
      }),
    });

    const redeemed = issuedSnapshot();
    redeemed.lots = [lotRow({ state: "Redeemed", commitment: "finalized" })];
    redeemed.protocol = null;
    const collected = liveReader(redeemed, NOW);
    expect(collected.scenario.settlementMode).toBe("NOT_INDEXED");
    expect(lotOf(redeemed)).toMatchObject({
      custody: "Collected",
      registry: { status: "finalized" },
    });

    const simulation = issuedSnapshot();
    if (!simulation.protocol) throw new Error("expected a protocol row");
    simulation.protocol.settlement_mode = "DevnetTokenSimulation";
    expect(liveReader(simulation, NOW).scenario.settlementMode).toBe("DEVNET_TOKEN_SIMULATION");
  });

  test("the shown position is the viewer's own, else the largest holder", () => {
    const snapshot = transferredSnapshot(["khunou", "buyer-smelter", "kopano"]);
    expect(lotOf(snapshot, "khunou")).toMatchObject({
      owner: khunou,
      position: { positionQuantityKg: 3_000_000n, availableKg: 3_000_000n },
    });
    expect(lotOf(snapshot, "buyer-smelter")).toMatchObject({
      owner: buyer,
      position: { positionQuantityKg: 2_000_000n, availableKg: 2_000_000n },
    });
    // The custodian holds nothing, so it sees the largest holder.
    expect(lotOf(snapshot, "kopano")).toMatchObject({
      owner: khunou,
      position: { positionQuantityKg: 3_000_000n },
    });

    const sold = transferredSnapshot(["khunou"]);
    sold.positions = [
      position(KHUNOU_POSITION, "khunou", "0", { revision: "1" }),
      position(BUYER_POSITION, "buyer-smelter", "5000000"),
    ];
    expect(lotOf(sold, "khunou")).toMatchObject({
      owner: buyer,
      position: { positionQuantityKg: 5_000_000n },
    });
    expect(
      liveReader(sold, NOW)
        .lots("khunou")
        .map(({ id }) => id),
    ).toEqual(["CR-0001"]);

    const tied = transferredSnapshot(["kopano"]);
    tied.positions = [
      position(KHUNOU_POSITION, "khunou", "2500000"),
      position(BUYER_POSITION, "buyer-smelter", "2500000"),
    ];
    const smaller = orgAccount("khunou") < orgAccount("buyer-smelter") ? khunou : buyer;
    expect(lotOf(tied, "kopano").owner).toEqual(smaller);
  });

  test("lot returns null for a lot outside the selected context", () => {
    const reader = liveReader(issuedSnapshot(["khunou", "lender-one"]), NOW);
    expect(reader.lot("CR-0001", "khunou")?.id).toBe("CR-0001");
    expect(reader.lot("CR-0001", "lender-one")).toBeNull();
    expect(reader.lots("lender-one")).toEqual([]);
    expect(reader.lot("CR-0001", "mosela")).toBeNull();
    expect(reader.lots("mosela")).toEqual([]);
    expect(reader.lot("CR-0002", "khunou")).toBeNull();
  });

  test("liveReader refuses a commitment other than confirmed or finalized, a non-canonical integer and an out-of-range i64, naming the path", () => {
    const processed = issuedSnapshot();
    processed.lots = [lotRow({ commitment: "processed" as never })];
    refused(processed, "BAD_ROW", "lots[0].commitment");

    const eventCommitment = issuedSnapshot();
    eventCommitment.intakeEvents = [
      { ...eventCommitment.intakeEvents[0], commitment: "processed" } as never,
    ];
    refused(eventCommitment, "BAD_ROW", "intakeEvents[0].commitment");

    const leadingZero = issuedSnapshot();
    leadingZero.lots = [lotRow({ supply_kg: "05000000" })];
    refused(leadingZero, "BAD_ROW", "lots[0].supply_kg");

    const plusSign = issuedSnapshot();
    plusSign.positions = [position(KHUNOU_POSITION, "khunou", "+5000000")];
    refused(plusSign, "BAD_ROW", "positions[0].quantity_kg");

    const tooLarge = issuedSnapshot();
    tooLarge.lots = [lotRow({ expires_at: "9223372036854775808" })];
    refused(tooLarge, "BAD_ROW", "lots[0].expires_at");

    const firstFailure = issuedSnapshot();
    firstFailure.lots = [lotRow({ supply_kg: "1.5", expires_at: "x" })];
    firstFailure.positions = [position(KHUNOU_POSITION, "khunou", "-1")];
    refused(firstFailure, "BAD_ROW", "lots[0].supply_kg");

    expect(parseI64("9223372036854775807", "p")).toBe(9223372036854775807n);
    expect(parseI64("-9223372036854775808", "p")).toBe(-9223372036854775808n);
    expect(parseI64("0", "p")).toBe(0n);
    for (const text of [
      "-9223372036854775809",
      "9223372036854775808",
      "-0",
      "01",
      "1e3",
      " 1",
      "",
    ]) {
      expect(() => parseI64(text, "documents[0].valid_until")).toThrow(
        expect.objectContaining({ code: "BAD_ROW", path: "documents[0].valid_until" }),
      );
    }
  });

  test("liveReader refuses a position with reserved_kg above zero", () => {
    const reserved = issuedSnapshot();
    reserved.positions = [position(KHUNOU_POSITION, "khunou", "5000000", { reserved_kg: "1000" })];
    refused(reserved, "BAD_ROW", "positions[0].reserved_kg");
  });

  test("liveReader throws NOT_SYNTHETIC for a rendered organisation not marked synthetic", () => {
    const custodian = issuedSnapshot();
    const kopanoRow = custodian.organisations.findIndex(({ slug }) => slug === "kopano");
    const kopanoOrganisation = custodian.organisations[kopanoRow];
    if (!kopanoOrganisation) throw new Error("expected the kopano row");
    kopanoOrganisation.synthetic = false;
    refused(custodian, "NOT_SYNTHETIC", `organisations[${kopanoRow}].synthetic`);

    const unmirrored = issuedSnapshot();
    const khunouRow = unmirrored.organisations.findIndex(({ slug }) => slug === "khunou");
    const khunouOrganisation = unmirrored.organisations[khunouRow];
    if (!khunouOrganisation) throw new Error("expected the khunou row");
    khunouOrganisation.slug = null;
    khunouOrganisation.synthetic = null;
    refused(unmirrored, "NOT_SYNTHETIC", `organisations[${khunouRow}].slug`);

    const member = issuedSnapshot();
    member.memberships = [{ ...membership("khunou"), synthetic: false }];
    refused(member, "NOT_SYNTHETIC", "memberships[0].synthetic");

    const issuer = issuedSnapshot();
    issuer.documents = [document(address(60), 0)];
    const portRow = issuer.organisations.findIndex(({ slug }) => slug === "port-t1");
    const portOrganisation = issuer.organisations[portRow];
    if (!portOrganisation) throw new Error("expected the port-t1 row");
    portOrganisation.synthetic = false;
    refused(issuer, "NOT_SYNTHETIC", `organisations[${portRow}].synthetic`);

    // An organisation no shown lot refers to is not rendered, so it is not checked.
    const unrelated = issuedSnapshot();
    const moselaOrganisation = unrelated.organisations.find(({ slug }) => slug === "mosela");
    if (!moselaOrganisation) throw new Error("expected the mosela row");
    moselaOrganisation.synthetic = false;
    expect(liveReader(unrelated, NOW).scenario.label).toBe("synthetic");
  });

  test("contexts come from the caller's memberships, by slug, and a slug outside the grammar is refused", () => {
    const reader = liveReader(issuedSnapshot(["lender-one", "khunou", "buyer-smelter"]), NOW);
    expect(reader.contexts()).toEqual([
      { organisationId: "buyer-smelter", role: "buyer", organisation: buyer },
      { organisationId: "khunou", role: "exporter", organisation: khunou },
      {
        organisationId: "lender-one",
        role: "lender",
        organisation: { id: "lender-one", name: "Lender One Bank", role: "lender" },
      },
    ]);
    expect(reader.context("khunou")).toEqual({
      organisationId: "khunou",
      role: "exporter",
      organisation: khunou,
    });
    expect(reader.context(orgId("khunou"))).toBeNull();
    expect(reader.context("kopano")).toBeNull();

    for (const slug of [
      "Khunou",
      "khunou_",
      "-khunou",
      "khunou--one",
      "",
      "reference",
      "login",
      "invite",
      "account",
    ]) {
      const snapshot = issuedSnapshot(["lender-one", "khunou"]);
      snapshot.memberships = [membership("lender-one"), { ...membership("khunou"), slug }];
      refused(snapshot, "BAD_ROW", "memberships[1].slug");
    }

    const kind = issuedSnapshot();
    kind.memberships = [{ ...membership("khunou"), kind: "smelter" }];
    refused(kind, "BAD_ROW", "memberships[0].kind");

    const id = issuedSnapshot();
    id.memberships = [{ ...membership("khunou"), id: "11000000-0000-4000-8000-00000000000A" }];
    refused(id, "BAD_ROW", "memberships[0].id");

    expect(liveReader(issuedSnapshot([]), NOW).contexts()).toEqual([]);
  });

  test("lot states, restrictions and document kinds of the custody instructions parse and map to plain labels", () => {
    const custody = [
      ["Prepared", "Awaiting departure"],
      ["InTransit", "In transit"],
      ["Loaded", "Loaded"],
    ] as const;
    for (const [state, label] of custody) {
      const snapshot = issuedSnapshot();
      snapshot.lots = [lotRow({ state })];
      expect(lotOf(snapshot).custody, state).toBe(label);
    }
    const restrictions = [
      ["ReviewRequired", "Review required"],
      ["Disputed", "Disputed"],
      ["Frozen", "Frozen"],
    ] as const;
    for (const [restriction, label] of restrictions) {
      const snapshot = issuedSnapshot();
      snapshot.lots = [lotRow({ restriction })];
      expect(lotOf(snapshot).restriction, restriction).toBe(label);
    }

    const departure = issuedSnapshot();
    departure.documents = [document(address(60), 1, { kind: "Departure" })];
    expect(
      checkRow("documents", departure.documents[0], "documents[0]", departure.env),
    ).toMatchObject({
      kind: "Departure",
    });
    expect(lotOf(departure).evidence).toEqual([
      expect.objectContaining({ id: address(60), kind: "Departure attestation, version 1" }),
    ]);

    const unknown = issuedSnapshot();
    unknown.lots = [lotRow({ state: "Shipped" as never })];
    refused(unknown, "BAD_ROW", "lots[0].state");
  });

  test("evidence is Expired at valid_until and Revoked when revoked_at is set", () => {
    const snapshot = issuedSnapshot();
    const nowSeconds = String(NOW.getTime() / 1000);
    const later = String(NOW.getTime() / 1000 + 1);
    snapshot.documents = [
      document(address(62), 2, {
        valid_until: later,
        revoked_at: String(NOW.getTime() / 1000 - 5),
      }),
      document(address(61), 1, { valid_until: nowSeconds }),
      document(address(60), 0, { valid_until: later }),
      document(address(63), 3, { subject_hex: "7c".repeat(32) }),
    ];
    const port = { id: "port-t1", name: "Port Terminal T1", role: "terminal" };
    expect(lotOf(snapshot).evidence).toEqual([
      {
        id: address(60),
        kind: "Origin attestation, version 0",
        issuer: port,
        status: "Human-attested",
        file: null,
      },
      {
        id: address(61),
        kind: "Origin attestation, version 1",
        issuer: port,
        status: "Expired",
        file: null,
      },
      {
        id: address(62),
        kind: "Origin attestation, version 2",
        issuer: port,
        status: "Revoked",
        file: null,
      },
    ]);

    const wrongIssuer = issuedSnapshot();
    wrongIssuer.documents = [document(address(60), 0, { issuer_org_id: orgId("mosela") })];
    refused(wrongIssuer, "BAD_ROW", "documents[0].issuer_org_id");

    const unknownIssuer = issuedSnapshot();
    unknownIssuer.documents = [document(address(60), 0, { issuer: address(90) })];
    refused(unknownIssuer, "BAD_ROW", "documents[0].issuer");
  });

  test("lotStale is halted for every lot while halted, and skew for a lot whose positions do not sum to its supply", () => {
    const twoLots = (halted: boolean) => {
      const snapshot = issuedSnapshot();
      const second = address(50);
      snapshot.lots.push(
        lotRow({
          address: second,
          lot_id: "CR-0002",
          root: second,
          mint: address(52),
          supply_kg: "1000000",
        }),
      );
      snapshot.positions.push(position(address(51), "khunou", "999999", { lot: second }));
      if (halted) {
        snapshot.checkpoint = checkpoint({
          status: "halted",
          halt_reason: "EVENT_GAP",
          halted_at: "2026-11-26T00:00:07.000Z",
        });
      }
      return liveReader(snapshot, NOW);
    };

    const halted = twoLots(true);
    expect(halted.freshness.state).toBe("halted");
    expect(halted.lotStale("CR-0001")).toBe("halted");
    expect(halted.lotStale("CR-0002")).toBe("halted");

    const running = twoLots(false);
    expect(running.lotStale("CR-0001")).toBeNull();
    expect(running.lotStale("CR-0002")).toBe("skew");
    expect(running.lots("khunou").map(({ id }) => id)).toEqual(["CR-0001", "CR-0002"]);
    expect(running.lot("CR-0002", "khunou")?.quantityKg).toBe(1_000_000n);
  });

  test("references, denormalised ids and events are checked against the rows they copy", () => {
    const noPosition = issuedSnapshot();
    noPosition.positions = [];
    refused(noPosition, "BAD_ROW", "lots[0]");

    const ownerId = issuedSnapshot();
    ownerId.positions = [
      position(KHUNOU_POSITION, "khunou", "5000000", { owner_org_id: orgId("mosela") }),
    ];
    refused(ownerId, "BAD_ROW", "positions[0].owner_org_id");

    const custodianId = issuedSnapshot();
    custodianId.lots = [lotRow({ custodian_org_id: orgId("khunou") })];
    refused(custodianId, "BAD_ROW", "lots[0].custodian_org_id");

    const noIntake = issuedSnapshot();
    noIntake.intakes = [];
    refused(noIntake, "BAD_ROW", "lots[0].intake");

    const otherProtocol = issuedSnapshot();
    otherProtocol.lots = [lotRow({ protocol: address(70) })];
    refused(otherProtocol, "BAD_ROW", "lots[0].protocol");

    const eventIntake = issuedSnapshot();
    const [issue] = eventIntake.intakeEvents;
    if (!issue) throw new Error("expected the issue event");
    eventIntake.intakeEvents = [{ ...issue, data: { ...issue.data, intake: address(71) } }];
    refused(eventIntake, "BAD_ROW", "intakeEvents[0].data");

    const extraKey = issuedSnapshot();
    extraKey.intakeEvents = [{ ...issue, data: { ...issue.data, extra: "1" } as never }];
    refused(extraKey, "BAD_ROW", "intakeEvents[0].data");

    const revision = issuedSnapshot();
    revision.intakeEvents = [
      { ...issue, lot_revision: "1", data: { ...issue.data, revision: "1" } },
    ];
    refused(revision, "BAD_ROW", "intakeEvents[0].lot_revision");

    const haltWithoutTime = issuedSnapshot();
    haltWithoutTime.checkpoint = checkpoint({
      status: "halted",
      halt_reason: "EVENT_GAP",
      halted_at: null,
    });
    refused(haltWithoutTime, "BAD_ROW", "checkpoint.halted_at");

    const unknownReason = issuedSnapshot();
    unknownReason.checkpoint = checkpoint({
      status: "halted",
      halt_reason: "STOPPED" as never,
      halted_at: ISSUED_AT,
    });
    refused(unknownReason, "BAD_ROW", "checkpoint.halt_reason");

    // Rows of lots the caller cannot read are dropped, not refused.
    const foreign = issuedSnapshot();
    foreign.positions.push(position(address(72), "khunou", "1", { lot: address(73) }));
    foreign.intakeEvents.push({
      ...issue,
      lot: address(73),
      data: { ...issue.data, lot: address(73), intake: INTAKE },
    });
    expect(liveReader(foreign, NOW).lot("CR-0001", "khunou")?.custodyTimeline).toHaveLength(1);
  });
});
