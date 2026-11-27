// The record_observation field kind: its text, spec, args and size (field-app.md §6.3, §7.8 and
// the T067r.2 pre-check folds 31–40).
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { type Address, generateKeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  admittedKeys,
  commandInstructions,
  MAX_TRANSACTION_BYTES,
  measureCommand,
  tableCandidates,
} from "../src/commands/compile.ts";
import { sharedMessageInstruction } from "../src/commands/ed25519.ts";
import {
  buildInstruction,
  KIND_SPECS,
  scopeBit,
  tableSignerAddresses,
  validateArgs,
} from "../src/commands/plan.ts";
import { formatSast, observationMessage } from "../src/commands/texts.ts";

const PROGRAM = "jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3";
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const hexBytes = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));
const I64_MAX = 9_223_372_036_854_775_807n;
const U32_MAX = 4_294_967_295;

/** program-custody.md §6.2's observation vector inputs. */
function vectorText() {
  return observationMessage(
    PROGRAM,
    hexBytes("00112233445566778899aabbccddeeff"),
    "CR-0001",
    new Uint8Array(16).fill(0x22),
    1,
    1,
    "Mosela Haulage",
    "Mosela Haulage",
    "Border",
    "BORDER-1",
    new Uint8Array(32).fill(0x77),
    1_795_098_425n,
    0,
    1_795_098_725n,
  );
}

describe("observationMessage", () => {
  it("reproduces program-custody.md's observation vector (513 bytes, 629424cd…68bb1b)", () => {
    const text = vectorText();
    expect(text.length).toBe(513);
    expect(sha256(text)).toBe("629424cd51436a48b5e2254e3faa2c952da9825f787dd852875dd986b368bb1b");
    expect(new TextDecoder().decode(text).split("\n")).toContain(
      "Observed at: 2026-11-19 16:27:05 SAST",
    );
  });

  it("is the text the phone's own check accepts (apps/field checkMessageText and checkSignedText, §7.8)", async () => {
    const field = (name: string) =>
      fileURLToPath(new URL(`../../../apps/field/src/${name}`, import.meta.url));
    const check = await import(field("text.ts"));
    const text = new TextDecoder().decode(vectorText());
    expect(check.checkMessageText(Buffer.from(text).toString("base64"))).toBe(text);
    // §7.8: the phone checks Lot, Batch, Holder, Observer, Kind, Location, Evidence and Observed at;
    // Shipment and Observation must be present.
    const expected = {
      action: "Record observation",
      program: PROGRAM,
      protocolInstanceHex: "00112233445566778899aabbccddeeff",
      fields: [
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
      ],
      validUntil: 1_795_098_725n,
    };
    expect(check.checkSignedText(text, expected)).toStrictEqual({ ok: true });
    const wrongKind = {
      ...expected,
      fields: expected.fields.map(([label, value]) =>
        label === "Kind" ? [label, "Checkpoint"] : [label, value],
      ),
    };
    expect(check.checkSignedText(text, wrongKind).ok).toBe(false);
  });

  it("prints Checkpoint, and the widest text is 629 bytes", () => {
    const widest = observationMessage(
      PROGRAM,
      new Uint8Array(16),
      "L".repeat(16),
      new Uint8Array(16),
      16,
      16,
      "N".repeat(48),
      "N".repeat(48),
      "Checkpoint",
      "B".repeat(16),
      new Uint8Array(32),
      I64_MAX,
      U32_MAX,
      I64_MAX,
    );
    expect(new TextDecoder().decode(widest).split("\n")).toContain("Kind: Checkpoint");
    expect(widest.length).toBe(629);
  });
});

describe("record_observation kind spec (field-app.md §6.3)", () => {
  it("is one observer text signer with OBSERVE, the Authority pre-checked, a 570 s window", () => {
    const spec = KIND_SPECS.record_observation;
    expect(spec.mode).toBe("both");
    expect(spec.event).toBe("ObservationRecorded");
    expect(spec.textWindowSecs).toBe(570n);
    expect(spec.args).toStrictEqual([
      "batch",
      "kind",
      "locationCode",
      "evidenceVersionId",
      "observedAt",
    ]);
    expect(spec.signers).toStrictEqual([
      { role: "observer", method: "text", scope: "OBSERVE", preCheckAuthority: true },
    ]);
    expect(spec.tableSigners).toBeUndefined();
    expect(scopeBit("OBSERVE")).toBe(1 << 11);
  });

  const args = {
    batch: "jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3",
    kind: "Border",
    locationCode: "BORDER-1",
    evidenceVersionId: "6f1c4a52-0d3e-4c4b-9b7e-2a1f0c9d8e7a",
    observedAt: "1795098425",
  };

  it("accepts the §6.3 args, Border and Checkpoint", () => {
    expect(validateArgs("record_observation", args)).toStrictEqual(args);
    expect(validateArgs("record_observation", { ...args, kind: "Checkpoint" })).toMatchObject({
      kind: "Checkpoint",
    });
    expect(
      validateArgs("record_observation", { ...args, locationCode: "A".repeat(16) }),
    ).toMatchObject({ locationCode: "A".repeat(16) });
  });

  it.each([
    ["batch", "nope"],
    ["kind", "border"],
    ["kind", "Crossing"],
    ["locationCode", "border-1"],
    ["locationCode", ""],
    ["locationCode", "B".repeat(17)],
    ["locationCode", "BORDER 1"],
    ["evidenceVersionId", "not-a-uuid"],
    ["observedAt", "-1"],
    ["observedAt", "01"],
  ])("refuses %s = %j as VALIDATION", (key, value) => {
    expect(() => validateArgs("record_observation", { ...args, [key]: value })).toThrow(
      expect.objectContaining({ code: "VALIDATION", detail: `args.${key}` }),
    );
  });
});

// ---------------------------------------------------------------- transaction size

const SYSVAR_INSTRUCTIONS = "Sysvar1nstructions1111111111111111111111111" as Address;
const newKey = async () => (await generateKeyPairSigner()).address;

async function observationSize(values: {
  lotId: string;
  holder: string;
  observer: string;
  kind: "Border" | "Checkpoint";
  locationCode: string;
  batch: [number, number];
  observedAt: bigint;
  expectedObservation: number;
  validUntil: bigint;
}) {
  const plan: Record<string, string> = {};
  for (const key of ["shipment", "batch", "lot", "holderOrg", "observerOrg"])
    plan[key] = await newKey();
  Object.assign(plan, {
    observationKind: values.kind,
    locationCode: values.locationCode,
    evidenceDigest: "77".repeat(32),
    observedAt: String(values.observedAt),
    expectedObservation: String(values.expectedObservation),
    validUntil: String(values.validUntil),
  });
  const text = observationMessage(
    PROGRAM,
    new Uint8Array(16),
    values.lotId,
    new Uint8Array(16),
    values.batch[0],
    values.batch[1],
    values.holder,
    values.observer,
    values.kind,
    values.locationCode,
    new Uint8Array(32).fill(0x77),
    values.observedAt,
    values.expectedObservation,
    values.validUntil,
  );
  const sponsor = await newKey();
  const protocol = await newKey();
  const observer = await newKey();
  const thetis = await buildInstruction({
    kind: "record_observation",
    plan,
    protocol,
    sponsor,
    wallets: { observer },
  });
  const ed25519 = sharedMessageInstruction(
    [{ wallet: observer, signature: new Uint8Array(64) }],
    text,
  );
  const candidates = tableCandidates(thetis, { protocol, sponsor, signers: [observer] });
  // Nothing is created; the observer's Authority exists (the relay pre-checks it). Only the
  // instructions sysvar has no account, and it is a fixed key.
  const keys = admittedKeys(
    candidates,
    candidates.map((key) => key !== SYSVAR_INSTRUCTIONS),
    tableSignerAddresses("record_observation", plan),
  );
  return {
    thetis,
    text,
    keys,
    candidates,
    bytes: measureCommand(commandInstructions(thetis, ed25519), sponsor, keys),
  };
}

describe("record_observation transaction (field-app.md T067r.2 folds)", () => {
  it("names the IDL's nine accounts in order, protocol at 1, sponsor at 0, batch the only writable one", async () => {
    const { thetis, candidates, keys } = await observationSize({
      lotId: "CR-0001",
      holder: "Mosela Haulage",
      observer: "Mosela Haulage",
      kind: "Border",
      locationCode: "BORDER-1",
      batch: [1, 1],
      observedAt: 1_795_098_425n,
      expectedObservation: 0,
      validUntil: 1_795_098_725n,
    });
    const accounts = thetis.accounts ?? [];
    expect(accounts).toHaveLength(9);
    expect(accounts[8]?.address).toBe(SYSVAR_INSTRUCTIONS);
    expect(accounts.map((meta) => meta.role)).toStrictEqual([3, 0, 0, 0, 0, 0, 1, 0, 0]);
    // Every non-signer account except the protocol goes into the table: observer_org,
    // observer_authority, holder_org, shipment, batch, lot, the instructions sysvar.
    expect(candidates).toHaveLength(7);
    expect(keys).toStrictEqual(candidates);
  });

  it("measures the demo observation at 818 bytes and the widest at 934, both under 1,232", async () => {
    const demo = await observationSize({
      lotId: "CR-0001",
      holder: "Mosela Haulage",
      observer: "Mosela Haulage",
      kind: "Border",
      locationCode: "BORDER-1",
      batch: [1, 1],
      observedAt: 1_795_098_425n,
      expectedObservation: 0,
      validUntil: 1_795_098_725n,
    });
    expect(demo.text.length).toBe(513);
    expect(demo.bytes).toBe(818);
    const widest = await observationSize({
      lotId: "L".repeat(16),
      holder: "N".repeat(48),
      observer: "N".repeat(48),
      kind: "Checkpoint",
      locationCode: "B".repeat(16),
      batch: [16, 16],
      observedAt: I64_MAX,
      expectedObservation: U32_MAX,
      validUntil: I64_MAX,
    });
    expect(widest.text.length).toBe(629);
    expect(widest.bytes).toBe(934);
    expect(widest.bytes).toBeLessThanOrEqual(MAX_TRANSACTION_BYTES);
  });
});
