import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  acceptanceLabel,
  acceptanceWarnings,
  batchLine,
  checkHandoverText,
  expectedHandoverText,
  expectedLoadingText,
  expectedObservationText,
  fieldValue,
  formatSastMinute,
  HANDOVER_STAGES,
  intentExpired,
  LOCATION_CODE,
  locationError,
  nextHolderOf,
  normaliseLocation,
  shortCode,
} from "../src/custody";
import { formatSast } from "../src/format";
import { checkSignedText, type RelayText } from "../src/text";
import {
  addr,
  fieldBatch,
  HANDOVER_ID,
  handoverView,
  lenderOneAccepted,
  lenderTwoMissing,
  lenderTwoStale,
  loadingIntent,
  MOSELA_CHAIN,
  PORT_CHAIN,
} from "./custody-fixtures";

const PROGRAM = "jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3";
const CUSTODY = "00112233445566778899aabbccddeeff";
const VALID = 1_795_098_725n;
const MESSAGE = "Hand over custody";

// The test's own builder: program-lots.md §6.2 envelope, written out independently of src/.
function build(
  action: string,
  protocolHex: string,
  fields: ReadonlyArray<readonly [string, string]>,
  validUntil: bigint,
): string {
  return [
    "Thetis authorisation v1",
    "Network: devnet",
    `Program: ${PROGRAM}`,
    `Protocol: ${protocolHex}`,
    `Action: ${action}`,
    ...fields.map(([label, value]) => `${label}: ${value}`),
    `Valid until: ${formatSast(validUntil)}`,
    "Test network only. Synthetic data.",
  ].join("\n");
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

function relay(text: string, validUntil: bigint = VALID): RelayText {
  return {
    messageBase64: Buffer.from(text, "utf8").toString("base64"),
    messageSha256: sha256(text),
    validUntil: String(validUntil),
    validUntilText: formatSast(validUntil),
  };
}

const HANDOVER_FIELDS = [
  ["Lot", "CR-0001"],
  ["Shipment", "22".repeat(16)],
  ["Batch", "1 of 1"],
  ["Quantity", "5,000.000 t"],
  ["From", "Kopano Stockyard Custody"],
  ["To", "Mosela Haulage"],
  ["Stage", "Departure"],
  ["Manifest", "44".repeat(32)],
  ["Sequence", "0"],
] as const;

const OBSERVATION_FIELDS = [
  ["Lot", "CR-0001"],
  ["Shipment", "22".repeat(16)],
  ["Batch", "1 of 1"],
  ["Holder", "Mosela Haulage"],
  ["Observer", "Mosela Haulage"],
  ["Kind", "Border"],
  ["Location", "BORDER-1"],
  ["Evidence", "77".repeat(32)],
  ["Observed at", formatSast(1_795_098_425n)],
  ["Observation", "0"],
] as const;

const LOADING_FIELDS = [
  ["Lot", "CR-0001"],
  ["Quantity", "3,000.000 t"],
  ["Owner", "Khunou Ore Exports"],
  ["Terminal", "Port Terminal T1"],
  ["Loading document", "aa".repeat(32)],
  ["Intent", "1"],
  ["Locked", "3,000.000 t"],
  ["Loan acceptances", "1"],
  ["Revision", "3"],
] as const;

const handoverInput = {
  program: PROGRAM,
  protocolInstanceHex: CUSTODY,
  validUntil: VALID,
  lotId: "CR-0001",
  index: 1,
  batchCount: 1,
  quantityKg: 5_000_000n,
  from: "Kopano Stockyard Custody",
  to: "Mosela Haulage",
};
const observationInput = {
  program: PROGRAM,
  protocolInstanceHex: CUSTODY,
  validUntil: VALID,
  lotId: "CR-0001",
  index: 1,
  batchCount: 1,
  holder: "Mosela Haulage",
  observer: "Mosela Haulage",
  locationCode: "BORDER-1",
  evidenceSha256: "77".repeat(32),
  observedAt: 1_795_098_425n,
};
const loadingInput = {
  program: PROGRAM,
  protocolInstanceHex: CUSTODY,
  validUntil: VALID,
  intent: loadingIntent(),
  terminalName: "Port Terminal T1",
};

const handoverText = (changes: Record<string, string> = {}) =>
  build(
    MESSAGE,
    CUSTODY,
    HANDOVER_FIELDS.map(([label, value]) => [label, changes[label] ?? value] as const),
    VALID,
  );

describe("the pinned custody texts (program-custody.md §6.2 vectors)", () => {
  it("the handover text: 480 bytes, e81d1fa1..., accepted by expectedHandoverText", () => {
    const text = build(MESSAGE, CUSTODY, HANDOVER_FIELDS, VALID);
    expect(Buffer.byteLength(text)).toBe(480);
    expect(sha256(text)).toBe("e81d1fa1436bfe8fffc851a44068124ba956f00faf175a5226c513e51d36e0d9");
    expect(checkSignedText(text, expectedHandoverText(handoverInput))).toStrictEqual({ ok: true });
  });

  it("the observation text: 513 bytes, 629424cd..., accepted by expectedObservationText", () => {
    const text = build("Record observation", CUSTODY, OBSERVATION_FIELDS, VALID);
    expect(Buffer.byteLength(text)).toBe(513);
    expect(sha256(text)).toBe("629424cd51436a48b5e2254e3faa2c952da9825f787dd852875dd986b368bb1b");
    expect(checkSignedText(text, expectedObservationText(observationInput))).toStrictEqual({
      ok: true,
    });
  });

  it("the loading text: 464 bytes, dfc9feeb..., accepted by expectedLoadingText", () => {
    const text = build("Record loading", CUSTODY, LOADING_FIELDS, VALID);
    expect(Buffer.byteLength(text)).toBe(464);
    expect(sha256(text)).toBe("dfc9feeb92f83a2dfe7362567f43c921cbfe642f813aae60c583b2db59424c6e");
    expect(checkSignedText(text, expectedLoadingText(loadingInput))).toStrictEqual({ ok: true });
  });
});

describe("expectedHandoverText", () => {
  it("names the action and the nine fields in order, the unchecked ones as any value", () => {
    const expected = expectedHandoverText(handoverInput);
    expect(expected.action).toBe("Hand over custody");
    expect(expected.program).toBe(PROGRAM);
    expect(expected.protocolInstanceHex).toBe(CUSTODY);
    expect(expected.validUntil).toBe(VALID);
    expect(expected.fields).toStrictEqual([
      ["Lot", "CR-0001"],
      ["Shipment", null],
      ["Batch", "1 of 1"],
      ["Quantity", "5,000.000 t"],
      ["From", "Kopano Stockyard Custody"],
      ["To", "Mosela Haulage"],
      ["Stage", null],
      ["Manifest", null],
      ["Sequence", null],
    ]);
  });

  it("writes a later batch as 'n of count' and a fractional quantity in tonnes", () => {
    const expected = expectedHandoverText({
      ...handoverInput,
      index: 2,
      batchCount: 3,
      quantityKg: 1_234_567n,
    });
    expect(expected.fields).toContainEqual(["Batch", "2 of 3"]);
    expect(expected.fields).toContainEqual(["Quantity", "1,234.567 t"]);
  });

  it("refuses a text that lacks a line the relay always writes", () => {
    const text = handoverText().replace(`\nManifest: ${"44".repeat(32)}`, "");
    expect(checkSignedText(text, expectedHandoverText(handoverInput)).ok).toBe(false);
  });
});

describe("expectedObservationText", () => {
  it("names the action and the ten fields in order", () => {
    const expected = expectedObservationText(observationInput);
    expect(expected.action).toBe("Record observation");
    expect(expected.fields).toStrictEqual([
      ["Lot", "CR-0001"],
      ["Shipment", null],
      ["Batch", "1 of 1"],
      ["Holder", "Mosela Haulage"],
      ["Observer", "Mosela Haulage"],
      ["Kind", "Border"],
      ["Location", "BORDER-1"],
      ["Evidence", "77".repeat(32)],
      ["Observed at", formatSast(1_795_098_425n)],
      ["Observation", null],
    ]);
  });

  it.each([
    ["Location", { locationCode: "BORDER-2" }],
    ["Evidence", { evidenceSha256: "78".repeat(32) }],
    ["Observed at", { observedAt: 1_795_098_426n }],
    ["Holder", { holder: "Someone Else" }],
    ["Observer", { observer: "Someone Else" }],
  ])("refuses the vector text when %s differs", (label, change) => {
    const text = build("Record observation", CUSTODY, OBSERVATION_FIELDS, VALID);
    const check = checkSignedText(
      text,
      expectedObservationText({ ...observationInput, ...change }),
    );
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.mismatches.map((m) => m.label)).toStrictEqual([label]);
  });
});

describe("expectedLoadingText", () => {
  it("names the action and the nine fields in order, counting only accepted acceptances", () => {
    const intent = loadingIntent({
      acceptances: [lenderOneAccepted, lenderTwoMissing, lenderTwoStale],
    });
    const expected = expectedLoadingText({ ...loadingInput, intent });
    expect(expected.action).toBe("Record loading");
    expect(expected.fields).toStrictEqual([
      ["Lot", "CR-0001"],
      ["Quantity", "3,000.000 t"],
      ["Owner", "Khunou Ore Exports"],
      ["Terminal", "Port Terminal T1"],
      ["Loading document", "aa".repeat(32)],
      ["Intent", "1"],
      ["Locked", "3,000.000 t"],
      ["Loan acceptances", "1"],
      ["Revision", null],
    ]);
  });

  it("is 0 acceptances when none is accepted, and 2 when two are", () => {
    const none = expectedLoadingText({
      ...loadingInput,
      intent: loadingIntent({ acceptances: [lenderTwoMissing] }),
    });
    expect(none.fields).toContainEqual(["Loan acceptances", "0"]);
    const two = expectedLoadingText({
      ...loadingInput,
      intent: loadingIntent({
        acceptances: [lenderOneAccepted, { ...lenderTwoMissing, state: "accepted" }],
      }),
    });
    expect(two.fields).toContainEqual(["Loan acceptances", "2"]);
  });

  it.each([
    [
      "Loan acceptances",
      { acceptances: [lenderOneAccepted, { ...lenderTwoMissing, state: "accepted" as const }] },
    ],
    ["Intent", { nonce: "2" }],
    ["Locked", { lockedKg: "2500000" }],
    ["Quantity", { quantityKg: "2500000" }],
    ["Owner", { ownerName: "Someone Else" }],
    ["Loading document", { documentSha256: "ab".repeat(32) }],
  ])("refuses the vector text when %s differs from the intent", (label, change) => {
    const text = build("Record loading", CUSTODY, LOADING_FIELDS, VALID);
    const intent = loadingIntent(change);
    const check = checkSignedText(text, expectedLoadingText({ ...loadingInput, intent }));
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.mismatches.map((m) => m.label)).toStrictEqual([label]);
  });

  it("refuses the vector text when the terminal's name differs", () => {
    const text = build("Record loading", CUSTODY, LOADING_FIELDS, VALID);
    const check = checkSignedText(
      text,
      expectedLoadingText({ ...loadingInput, terminalName: "Port Terminal T2" }),
    );
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.mismatches.map((m) => m.label)).toStrictEqual(["Terminal"]);
  });
});

describe("checkHandoverText", () => {
  const expected = expectedHandoverText(handoverInput);

  it.each(HANDOVER_STAGES)("accepts the Stage %s", (stage) => {
    expect(checkHandoverText(relay(handoverText({ Stage: stage })), expected)).toStrictEqual({
      ok: true,
    });
  });

  it("the three stages are Departure, Arrival and Transfer", () => {
    expect([...HANDOVER_STAGES]).toStrictEqual(["Departure", "Arrival", "Transfer"]);
  });

  it.each(["Loading", "departure", "Delivered", "Departure, Arrival"])(
    "refuses the Stage %j, reporting the label Stage",
    (stage) => {
      const check = checkHandoverText(relay(handoverText({ Stage: stage })), expected);
      expect(check).toStrictEqual({
        ok: false,
        mismatches: [
          {
            line: 12,
            label: "Stage",
            expected: "Departure, Arrival or Transfer",
            actual: stage,
          },
        ],
      });
    },
  );

  it.each([
    ["Lot", "CR-0002"],
    ["Batch", "1 of 2"],
    ["Quantity", "4,999.999 t"],
    ["From", "Someone Else"],
    ["To", "Someone Else"],
  ])("refuses a changed %s, reporting that label", (label, value) => {
    const check = checkHandoverText(relay(handoverText({ [label]: value })), expected);
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.mismatches.map((m) => m.label)).toStrictEqual([label]);
      expect(check.mismatches[0]?.actual).toBe(value);
    }
  });

  it("still makes the relay-text checks: the digest and the validity line", () => {
    const text = handoverText();
    const tampered = { ...relay(text), messageSha256: "00".repeat(32) };
    const digest = checkHandoverText(tampered, expected);
    expect(digest.ok).toBe(false);
    if (!digest.ok) expect(digest.mismatches[0]?.label).toBe("SHA-256");

    const later = checkHandoverText(relay(text, VALID + 1n), expected);
    expect(later.ok).toBe(false);
    if (!later.ok) expect(later.mismatches[0]?.label).toBe("Valid until");
  });
});

describe("nextHolderOf", () => {
  it("at source it is the carrier on the manifest", () => {
    expect(nextHolderOf(fieldBatch({ stage: "AtSource" }))).toStrictEqual({
      address: MOSELA_CHAIN,
      name: "Mosela Haulage",
      why: "The carrier on the manifest",
    });
  });

  it("in transit it is the destination custodian", () => {
    expect(nextHolderOf(fieldBatch({ stage: "InTransit" }))).toStrictEqual({
      address: PORT_CHAIN,
      name: "Port Terminal T1",
      why: "The destination custodian",
    });
  });

  it("an arrived batch has no next holder", () => {
    expect(nextHolderOf(fieldBatch({ stage: "Arrived" }))).toBeNull();
  });
});

describe("small formats", () => {
  it("batchLine is lower case, as the confirmation copy uses it", () => {
    expect(batchLine(1, 1)).toBe("batch 1 of 1");
    expect(batchLine(2, 3)).toBe("batch 2 of 3");
  });

  it("shortCode is the first 8 characters of the command id", () => {
    expect(shortCode(HANDOVER_ID)).toBe("7b2e9d14");
    expect(shortCode("6a1f0c3e-8b2d-4e5f-9a7b-1c2d3e4f5a6b")).toBe("6a1f0c3e");
  });

  it("formatSastMinute is formatSast without the seconds", () => {
    expect(formatSastMinute(1_795_767_275n)).toBe("2026-11-27 10:14 SAST");
    expect(formatSastMinute(1_795_767_299n)).toBe("2026-11-27 10:14 SAST");
    expect(formatSastMinute(1_795_767_300n)).toBe("2026-11-27 10:15 SAST");
  });

  it("intentExpired is true from expiresAt on", () => {
    const intent = loadingIntent({ expiresAt: "1795767275" });
    expect(intentExpired(intent, 1_795_767_274n)).toBe(false);
    expect(intentExpired(intent, 1_795_767_275n)).toBe(true);
    expect(intentExpired(intent, 1_795_767_276n)).toBe(true);
  });

  it("fieldValue reads a labelled line of the command's fields, or null", () => {
    const view = handoverView("awaiting_signatures");
    expect(fieldValue(view, "Lot")).toBe("CR-0001");
    expect(fieldValue(view, "To")).toBe("Mosela Haulage");
    expect(fieldValue(view, "Stage")).toBe("Departure");
    expect(fieldValue(view, "Manifest")).toBe("44".repeat(32));
    expect(fieldValue(view, "Owner")).toBeNull();
    expect(fieldValue(view, "to")).toBeNull();
  });
});

describe("the location code", () => {
  const MESSAGE_TEXT = "Use 1 to 16 capital letters, digits or hyphens, for example BORDER-1.";

  it("LOCATION_CODE is 1 to 16 capital letters, digits or hyphens", () => {
    expect(LOCATION_CODE.test("BORDER-1")).toBe(true);
    expect(LOCATION_CODE.test("A".repeat(16))).toBe(true);
    expect(LOCATION_CODE.test("A".repeat(17))).toBe(false);
    expect(LOCATION_CODE.test("")).toBe(false);
    expect(LOCATION_CODE.test("Border-1")).toBe(false);
  });

  it("normaliseLocation upper-cases and changes nothing else", () => {
    expect(normaliseLocation("border-1")).toBe("BORDER-1");
    expect(normaliseLocation(" b 1 ")).toBe(" B 1 ");
    expect(normaliseLocation("")).toBe("");
    expect(normaliseLocation("ALREADY-1")).toBe("ALREADY-1");
  });

  it("locationError: a usable code and the empty code have none", () => {
    expect(locationError("BORDER-1")).toBeNull();
    expect(locationError("A".repeat(16))).toBeNull();
    expect(locationError("")).toBeNull();
  });

  it("locationError: a space, 17 characters or a lower-case letter give the message", () => {
    expect(locationError("Border 1")).toBe(MESSAGE_TEXT);
    expect(locationError("BORDER 1")).toBe(MESSAGE_TEXT);
    expect(locationError("A".repeat(17))).toBe(MESSAGE_TEXT);
    expect(locationError("border-1")).toBe(MESSAGE_TEXT);
    expect(locationError("BORDER_1")).toBe(MESSAGE_TEXT);
  });
});

describe("acceptances", () => {
  it("a warning for each acceptance that is not accepted, in list order, verbatim", () => {
    const intent = loadingIntent({
      acceptances: [
        lenderTwoStale,
        lenderOneAccepted,
        { ...lenderTwoMissing, lender: addr(50), lenderName: "Lender Three Bank" },
      ],
    });
    expect(acceptanceWarnings(intent)).toStrictEqual([
      "Lender Two Bank accepted before the loan changed, so Thetis will refuse the loading until it accepts again.",
      "Lender Three Bank has not accepted this hand-off. Thetis will refuse the loading until every lender with a lock accepts.",
    ]);
  });

  it("no warning when every lender accepted, or when there are no lenders", () => {
    expect(acceptanceWarnings(loadingIntent())).toStrictEqual([]);
    expect(acceptanceWarnings(loadingIntent({ acceptances: [] }))).toStrictEqual([]);
  });

  it("acceptanceLabel", () => {
    expect(acceptanceLabel("accepted")).toBe("Accepted");
    expect(acceptanceLabel("missing")).toBe("Not accepted");
    expect(acceptanceLabel("stale")).toBe("Accepted before a change");
  });
});
