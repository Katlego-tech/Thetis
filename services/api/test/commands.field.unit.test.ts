// The field kinds' texts, digests and specs (field-app.md §6.3, §6.4 and the T067r folds).
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { KIND_SPECS, validateArgs } from "../src/commands/plan.ts";
import { intakeDigest, issueLotMessage, normaliseTicket } from "../src/commands/texts.ts";

const PROGRAM = "jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3";
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const hexBytes = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));
const sequence = (base: number) => Uint8Array.from({ length: 32 }, (_, index) => index + base);

// field-app.md §6.4's demo known answer: the text drawn in issue.html.
const DEMO = {
  instanceId: new TextEncoder().encode("fiat-demo-run-01"),
  lotId: "CR-0001",
  grade: "G1",
  quantityKg: 5_000_000n,
  owner: "Khunou Ore Exports",
  custodian: "Kopano Stockyard Custody",
  siteCode: "KOPANO-YARD-1",
  ticketTyped: "wb 2611-0042",
  validUntil: 1_795_767_275n,
};

function demoText() {
  return issueLotMessage(
    PROGRAM,
    DEMO.instanceId,
    DEMO.lotId,
    "CHROME",
    1,
    DEMO.grade,
    DEMO.quantityKg,
    DEMO.owner,
    DEMO.custodian,
    DEMO.siteCode,
    hexBytes(intakeDigest(DEMO.siteCode, normaliseTicket(DEMO.ticketTyped) as string)),
    null,
    DEMO.validUntil,
  );
}

describe("intake digest (field-app.md §6.4)", () => {
  it("normalises the ticket and reproduces the known digest", () => {
    expect(normaliseTicket(DEMO.ticketTyped)).toBe("WB2611-0042");
    expect(intakeDigest(DEMO.siteCode, "WB2611-0042")).toBe(
      "71813b946d9d53f619f3cd4e1fce2d7d8dd6cbe8e0fc44876ac5e09a3c1483de",
    );
  });

  it("refuses what is not printable ASCII, and empty or over 64 characters after normalising", () => {
    expect(normaliseTicket("   ")).toBeNull();
    expect(normaliseTicket("")).toBeNull();
    expect(normaliseTicket("A\nB")).toBeNull();
    expect(normaliseTicket("é")).toBeNull();
    expect(normaliseTicket("A".repeat(64))).toBe("A".repeat(64));
    expect(normaliseTicket("A".repeat(65))).toBeNull();
    expect(normaliseTicket(`${"a ".repeat(64)}`)).toBe("A".repeat(64));
  });
});

describe("issueLotMessage", () => {
  it("is the pinned demo text: 473 bytes, fb1d1538…", () => {
    const text = demoText();
    expect(text.length).toBe(473);
    expect(sha256(text)).toBe("fb1d1538fd4da01a02b80abb25b3af7ac4e7fe4bf6daac2c91e5ceb80f96426f");
  });

  it("reproduces program-lots.md's issue vector (528 bytes, 7e9bbb75…) and its not-required variant", () => {
    const args = [
      PROGRAM,
      hexBytes("606162636465666768696a6b6c6d6e6f"),
      "CR-0001",
      "CHROME",
      1,
      "A",
      5_000_000n,
      "Khunou Ore Exports",
      "Kopano Stockyard Custody",
      "PORT-STOCKYARD",
      sequence(0),
    ] as const;
    const withOrigin = issueLotMessage(
      ...args,
      { sha256: sequence(0x20), version: 1 },
      1_795_098_725n,
    );
    expect(withOrigin.length).toBe(528);
    expect(sha256(withOrigin)).toBe(
      "7e9bbb750a8629a70fefb9c4bce48e0c2869c512511538513546b3c570084638",
    );
    const notRequired = issueLotMessage(...args, null, 1_795_098_725n);
    expect(notRequired.length).toBe(473);
    expect(sha256(notRequired)).toBe(
      "7ad36cd94680f1b3a3417b0357c02635cd52d684794ec5236a110e772e119712",
    );
  });

  it("is the text the phone expects (apps/field expectedIssueText and checkSignedText)", async () => {
    // A computed path: Vitest resolves the field app's modules; the API's tsc does not check them.
    const field = "../../../apps/field/src/";
    const intake = await import(`${field}intake.ts`);
    const check = await import(`${field}text.ts`);
    const draft = {
      lotId: DEMO.lotId,
      grade: DEMO.grade,
      quantityText: "5000",
      ownerName: DEMO.owner,
      siteCode: DEMO.siteCode,
      weighbridgeTicket: DEMO.ticketTyped,
    };
    const expected = intake.expectedIssueText(
      draft,
      {
        program: PROGRAM,
        protocolInstanceHex: Buffer.from(DEMO.instanceId).toString("hex"),
        classLabel: "CHROME v1",
        custodianName: DEMO.custodian,
        originRequired: false,
      },
      DEMO.validUntil,
    );
    const text = new TextDecoder().decode(demoText());
    expect(check.checkMessageText(Buffer.from(text).toString("base64"))).toBe(text);
    expect(check.checkSignedText(text, expected)).toStrictEqual({ ok: true });
  });
});

describe("issue_lot kind spec (field-app.md §6.3)", () => {
  it("is one custodian text signer with ISSUE, the Authority pre-checked, a 570 s window", () => {
    const spec = KIND_SPECS.issue_lot;
    expect(spec.mode).toBe("both");
    expect(spec.event).toBe("LotIssued");
    expect(spec.textWindowSecs).toBe(570n);
    expect(spec.signers).toStrictEqual([
      { role: "custodian", method: "text", scope: "ISSUE", preCheckAuthority: true },
    ]);
    expect(KIND_SPECS.pledge.textWindowSecs).toBe(270n);
  });

  const args = {
    custodianClass: "jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3",
    owner: "6f1c4a52-0d3e-4c4b-9b7e-2a1f0c9d8e7a",
    lotId: "CR-0001",
    grade: "G1",
    quantityKg: "5000000",
    weighbridgeTicket: "wb 2611-0042",
  };

  it("accepts the §6.3 args", () => {
    expect(validateArgs("issue_lot", args)).toStrictEqual(args);
  });

  it.each([
    ["lotId", "cr-0001"],
    ["lotId", "CR-00000000000001"],
    ["owner", "not-a-uuid"],
    ["custodianClass", "nope"],
    ["grade", "toolonggrade"],
    ["quantityKg", "0"],
    ["quantityKg", "05"],
    ["weighbridgeTicket", ""],
    ["weighbridgeTicket", "   "],
    ["weighbridgeTicket", "A\tB"],
    ["weighbridgeTicket", "W".repeat(65)],
  ])("refuses %s = %j as VALIDATION", (key, value) => {
    expect(() => validateArgs("issue_lot", { ...args, [key]: value })).toThrow(
      expect.objectContaining({ code: "VALIDATION", detail: `args.${key}` }),
    );
  });
});
