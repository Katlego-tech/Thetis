import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { formatSast } from "../src/format";
import {
  checkMessageText,
  checkSignedText,
  type ExpectedText,
  verifyCommandText,
} from "../src/text";

const PROGRAM = "jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3";

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
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

const DEMO_PROTOCOL = Buffer.from("fiat-demo-run-01", "ascii").toString("hex");
const DEMO_VALID_UNTIL = 1_795_767_275n;
const DEMO_FIELDS = [
  ["Lot", "CR-0001"],
  ["Class", "CHROME v1"],
  ["Grade", "G1"],
  ["Quantity", "5,000.000 t"],
  ["Owner", "Khunou Ore Exports"],
  ["Custodian", "Kopano Stockyard Custody"],
  ["Site", "KOPANO-YARD-1"],
  ["Intake", "71813b946d9d53f619f3cd4e1fce2d7d8dd6cbe8e0fc44876ac5e09a3c1483de"],
  ["Origin document", "not required"],
] as const;
const DEMO_TEXT = build("Issue lot", DEMO_PROTOCOL, DEMO_FIELDS, DEMO_VALID_UNTIL);
const expected: ExpectedText = {
  action: "Issue lot",
  program: PROGRAM,
  protocolInstanceHex: DEMO_PROTOCOL,
  fields: DEMO_FIELDS,
  validUntil: DEMO_VALID_UNTIL,
};

describe("the pinned issue text (field-app.md §6.4)", () => {
  it("is 473 bytes with the pinned SHA-256", () => {
    expect(DEMO_PROTOCOL).toBe("666961742d64656d6f2d72756e2d3031");
    expect(Buffer.byteLength(DEMO_TEXT)).toBe(473);
    expect(sha256(DEMO_TEXT)).toBe(
      "fb1d1538fd4da01a02b80abb25b3af7ac4e7fe4bf6daac2c91e5ceb80f96426f",
    );
  });

  it("passes every check", () => {
    expect(checkSignedText(DEMO_TEXT, expected)).toStrictEqual({ ok: true });
    expect(
      verifyCommandText(
        {
          messageBase64: b64(DEMO_TEXT),
          messageSha256: sha256(DEMO_TEXT),
          validUntil: "1795767275",
          validUntilText: "2026-11-27 10:14:35 SAST",
        },
        expected,
      ),
    ).toStrictEqual({ ok: true });
  });

  it("accepts a field expected as present with any value", () => {
    const loose = {
      ...expected,
      fields: DEMO_FIELDS.map(([l, v]) => [l, l === "Owner" ? null : v] as const),
    };
    expect(checkSignedText(DEMO_TEXT.replace("Khunou Ore Exports", "Anyone"), loose).ok).toBe(true);
  });
});

describe("single-line changes fail with that line reported", () => {
  const lines = DEMO_TEXT.split("\n");
  it.each(lines.map((line, index) => [index + 1, line] as const))(
    "line %i (%s)",
    (lineNo, line) => {
      const changed = [...lines];
      changed[lineNo - 1] = `${line}X`;
      const result = checkSignedText(changed.join("\n"), expected);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.mismatches.map((m) => m.line)).toStrictEqual([lineNo]);
      expect(result.mismatches[0]?.actual).toBe(`${line}X`.replace(/^[^:]+: /, ""));
    },
  );

  it("reports the owner line with expected and received values", () => {
    const result = checkSignedText(
      DEMO_TEXT.replace("Owner: Khunou Ore Exports", "Owner: Buyer Smelter Co"),
      expected,
    );
    expect(result).toStrictEqual({
      ok: false,
      mismatches: [
        { line: 10, label: "Owner", expected: "Khunou Ore Exports", actual: "Buyer Smelter Co" },
      ],
    });
  });

  it.each([
    ["the program", `Program: ${PROGRAM}`, "Program: 11111111111111111111111111111111"],
    ["the protocol", `Protocol: ${DEMO_PROTOCOL}`, "Protocol: 00112233445566778899aabbccddeeff"],
    ["the network", "Network: devnet", "Network: mainnet"],
    [
      "the validity line",
      "Valid until: 2026-11-27 10:14:35 SAST",
      "Valid until: 2026-11-27 10:24:35 SAST",
    ],
    ["the notice", "Test network only. Synthetic data.", "Test network only."],
    ["the action", "Action: Issue lot", "Action: Transfer receipts"],
  ])("%s", (_, from, to) => {
    expect(checkSignedText(DEMO_TEXT.replace(from, to), expected).ok).toBe(false);
  });
});

describe("shape failures", () => {
  it("a missing line", () => {
    const result = checkSignedText(DEMO_TEXT.replace("Grade: G1\n", ""), expected);
    expect(result.ok).toBe(false);
  });

  it("an extra line", () => {
    const result = checkSignedText(
      DEMO_TEXT.replace("Grade: G1\n", "Grade: G1\nNote: extra\n"),
      expected,
    );
    expect(result.ok).toBe(false);
  });

  it("a trailing newline", () => {
    const result = checkSignedText(`${DEMO_TEXT}\n`, expected);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.mismatches.at(-1)?.line).toBe(17);
  });

  it("a non-ASCII byte is refused when decoding", () => {
    expect(() => checkMessageText(b64(DEMO_TEXT.replace("Khunou", "Khünou")))).toThrow();
    expect(() => checkMessageText(b64("a\tb"))).toThrow();
    expect(() => checkMessageText("not base64!")).toThrow();
    expect(checkMessageText(b64(DEMO_TEXT))).toBe(DEMO_TEXT);
  });

  it("a SHA-256 that differs from messageSha256", () => {
    const result = verifyCommandText(
      {
        messageBase64: b64(DEMO_TEXT),
        messageSha256: "0".repeat(64),
        validUntil: "1795767275",
        validUntilText: "2026-11-27 10:14:35 SAST",
      },
      expected,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.mismatches[0]?.label).toBe("SHA-256");
  });

  it("a validUntilText that differs from formatSast(validUntil)", () => {
    const result = verifyCommandText(
      {
        messageBase64: b64(DEMO_TEXT),
        messageSha256: sha256(DEMO_TEXT),
        validUntil: "1795767275",
        validUntilText: "2026-11-27 10:14:36 SAST",
      },
      expected,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.mismatches[0]?.label).toBe("Valid until");
  });

  it("a validUntil the phone did not expect", () => {
    const result = verifyCommandText(
      {
        messageBase64: b64(DEMO_TEXT),
        messageSha256: sha256(DEMO_TEXT),
        validUntil: "1795767276",
        validUntilText: "2026-11-27 10:14:36 SAST",
      },
      expected,
    );
    expect(result.ok).toBe(false);
  });
});

describe("program vectors reproduced by the test's builder", () => {
  const T031_PROTOCOL = "606162636465666768696a6b6c6d6e6f";
  const T031_FIELDS = [
    ["Lot", "CR-0001"],
    ["Class", "CHROME v1"],
    ["Grade", "A"],
    ["Quantity", "5,000.000 t"],
    ["Owner", "Khunou Ore Exports"],
    ["Custodian", "Kopano Stockyard Custody"],
    ["Site", "PORT-STOCKYARD"],
    ["Intake", "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"],
    ["Origin document", "202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f v1"],
  ] as const;
  const CUSTODY = "00112233445566778899aabbccddeeff";
  const VALID = 1_795_098_725n;

  it.each([
    [
      "issue (program-lots.md)",
      build("Issue lot", T031_PROTOCOL, T031_FIELDS, VALID),
      528,
      "7e9bbb750a8629a70fefb9c4bce48e0c2869c512511538513546b3c570084638",
    ],
    [
      "issue, origin not required",
      build(
        "Issue lot",
        T031_PROTOCOL,
        T031_FIELDS.map(([l, v]) => [l, l === "Origin document" ? "not required" : v] as const),
        VALID,
      ),
      473,
      "7ad36cd94680f1b3a3417b0357c02635cd52d684794ec5236a110e772e119712",
    ],
    [
      "handover (program-custody.md)",
      build(
        "Hand over custody",
        CUSTODY,
        [
          ["Lot", "CR-0001"],
          ["Shipment", "22".repeat(16)],
          ["Batch", "1 of 1"],
          ["Quantity", "5,000.000 t"],
          ["From", "Kopano Stockyard Custody"],
          ["To", "Mosela Haulage"],
          ["Stage", "Departure"],
          ["Manifest", "44".repeat(32)],
          ["Sequence", "0"],
        ],
        VALID,
      ),
      480,
      "e81d1fa1436bfe8fffc851a44068124ba956f00faf175a5226c513e51d36e0d9",
    ],
    [
      "observation (program-custody.md)",
      build(
        "Record observation",
        CUSTODY,
        [
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
        ],
        VALID,
      ),
      513,
      "629424cd51436a48b5e2254e3faa2c952da9825f787dd852875dd986b368bb1b",
    ],
    [
      "record loading (program-custody.md)",
      build(
        "Record loading",
        CUSTODY,
        [
          ["Lot", "CR-0001"],
          ["Quantity", "3,000.000 t"],
          ["Owner", "Khunou Ore Exports"],
          ["Terminal", "Port Terminal T1"],
          ["Loading document", "aa".repeat(32)],
          ["Intent", "1"],
          ["Locked", "3,000.000 t"],
          ["Loan acceptances", "1"],
          ["Revision", "3"],
        ],
        VALID,
      ),
      464,
      "dfc9feeb92f83a2dfe7362567f43c921cbfe642f813aae60c583b2db59424c6e",
    ],
  ])("%s", (_, text, bytes, hash) => {
    expect(Buffer.byteLength(text)).toBe(bytes);
    expect(sha256(text)).toBe(hash);
    expect(checkMessageText(b64(text))).toBe(text);
  });
});
