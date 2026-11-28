// The loading field kinds, create_loading_intent and record_loading: their texts, specs, args and
// transaction sizes (field-app.md §6.3, §7.7 and the T067r.3 pre-check folds 41–50).
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { type Address, generateKeyPairSigner } from "@solana/kit";
import { THETIS_PROGRAM_ADDRESS } from "@thetis/contracts";
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
import { formatSast, loadingIntentMessage, recordLoadingMessage } from "../src/commands/texts.ts";
import { expectPriced, expectUnpriced, issued } from "./compute-price.ts";

const PROGRAM = "jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3";
const INSTANCE_HEX = "00112233445566778899aabbccddeeff";
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const hexBytes = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));
const I64_MAX = 9_223_372_036_854_775_807n;
const U64_MAX = 18_446_744_073_709_551_615n;
const SYSVAR_INSTRUCTIONS = "Sysvar1nstructions1111111111111111111111111" as Address;
const SYSTEM = "11111111111111111111111111111111" as Address;
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;

/** program-custody.md §6.2's loading intent vector inputs. */
function intentVector() {
  return loadingIntentMessage(
    PROGRAM,
    hexBytes(INSTANCE_HEX),
    "CR-0001",
    3_000_000n,
    "Khunou Ore Exports",
    "Port Terminal T1",
    "PORT-T1",
    new Uint8Array(32).fill(0xaa),
    1n,
    1_795_185_125n,
    2n,
    1_795_098_725n,
  );
}

/** program-custody.md §6.2's record loading vector inputs. */
function recordVector() {
  return recordLoadingMessage(
    PROGRAM,
    hexBytes(INSTANCE_HEX),
    "CR-0001",
    3_000_000n,
    "Khunou Ore Exports",
    "Port Terminal T1",
    new Uint8Array(32).fill(0xaa),
    1n,
    3_000_000n,
    1,
    3n,
    1_795_098_725n,
  );
}

async function phoneCheck() {
  const field = (name: string) =>
    fileURLToPath(new URL(`../../../apps/field/src/${name}`, import.meta.url));
  return import(field("text.ts"));
}

describe("loading texts (program-custody.md §6.2)", () => {
  it("loadingIntentMessage reproduces the loading intent vector (480 bytes, 44d338aa…31536)", () => {
    const text = intentVector();
    expect(text.length).toBe(480);
    expect(sha256(text)).toBe("44d338aa7908d0254818fe1cf7bfa568e01d1e43d7a362826d2fdebb2bf31536");
    const lines = new TextDecoder().decode(text).split("\n");
    expect(lines).toContain("Action: Prepare loading");
    expect(lines).toContain(`Intent expires: ${formatSast(1_795_185_125n)}`);
  });

  it("recordLoadingMessage reproduces the record loading vector (464 bytes, dfc9feeb…24c6e)", () => {
    const text = recordVector();
    expect(text.length).toBe(464);
    expect(sha256(text)).toBe("dfc9feeb92f83a2dfe7362567f43c921cbfe642f813aae60c583b2db59424c6e");
    expect(new TextDecoder().decode(text).split("\n")).toContain("Loan acceptances: 1");
  });

  it("is the text the phone's own check accepts (apps/field checkMessageText and checkSignedText, §7.7)", async () => {
    const check = await phoneCheck();
    const record = new TextDecoder().decode(recordVector());
    expect(check.checkMessageText(Buffer.from(record).toString("base64"))).toBe(record);
    // §7.7: the phone checks Lot, Quantity, Owner, Terminal, Loading document, Intent, Locked and
    // Loan acceptances; Revision must be present.
    const expected = {
      action: "Record loading",
      program: PROGRAM,
      protocolInstanceHex: INSTANCE_HEX,
      fields: [
        ["Lot", "CR-0001"],
        ["Quantity", "3,000.000 t"],
        ["Owner", "Khunou Ore Exports"],
        ["Terminal", "Port Terminal T1"],
        ["Loading document", "aa".repeat(32)],
        ["Intent", "1"],
        ["Locked", "3,000.000 t"],
        ["Loan acceptances", "1"],
        ["Revision", null],
      ],
      validUntil: 1_795_098_725n,
    };
    expect(check.checkSignedText(record, expected)).toStrictEqual({ ok: true });
    const wrongCount = {
      ...expected,
      fields: expected.fields.map(([label, value]) =>
        label === "Loan acceptances" ? [label, "0"] : [label, value],
      ),
    };
    expect(check.checkSignedText(record, wrongCount).ok).toBe(false);

    // The owner signs Prepare loading on the web, never on the phone (pre-check note 13); the
    // phone's checker still reads the same envelope.
    const intent = new TextDecoder().decode(intentVector());
    expect(check.checkMessageText(Buffer.from(intent).toString("base64"))).toBe(intent);
    expect(
      check.checkSignedText(intent, {
        action: "Prepare loading",
        program: PROGRAM,
        protocolInstanceHex: INSTANCE_HEX,
        fields: [
          ["Lot", "CR-0001"],
          ["Quantity", "3,000.000 t"],
          ["Owner", "Khunou Ore Exports"],
          ["Terminal", "Port Terminal T1"],
          ["Site", "PORT-T1"],
          ["Loading document", "aa".repeat(32)],
          ["Intent", "1"],
          ["Intent expires", formatSast(1_795_185_125n)],
          ["Revision", "2"],
        ],
        validUntil: 1_795_098_725n,
      }),
    ).toStrictEqual({ ok: true });
  });

  it("the widest texts are 631 and 615 bytes (program-custody.md §11.1)", () => {
    const intent = loadingIntentMessage(
      PROGRAM,
      new Uint8Array(16),
      "L".repeat(16),
      U64_MAX,
      "N".repeat(48),
      "N".repeat(48),
      "S".repeat(16),
      new Uint8Array(32),
      U64_MAX,
      I64_MAX,
      U64_MAX,
      I64_MAX,
    );
    expect(intent.length).toBe(631);
    const record = recordLoadingMessage(
      PROGRAM,
      new Uint8Array(16),
      "L".repeat(16),
      U64_MAX,
      "N".repeat(48),
      "N".repeat(48),
      new Uint8Array(32),
      U64_MAX,
      U64_MAX,
      4,
      U64_MAX,
      I64_MAX,
    );
    expect(record.length).toBe(615);
  });
});

describe("loading kind specs (field-app.md §6.3, folds 41–46)", () => {
  it("create_loading_intent: one owner text signer with SHIP, pre-checked, a 570 s window", () => {
    const spec = KIND_SPECS.create_loading_intent;
    expect(spec.mode).toBe("both");
    expect(spec.event).toBe("LoadingIntentCreated");
    expect(spec.textWindowSecs).toBe(570n);
    expect(spec.args).toStrictEqual(["lot", "evidenceVersionId", "expiresInHours"]);
    expect(spec.signers).toStrictEqual([
      { role: "owner", method: "text", scope: "SHIP", preCheckAuthority: true },
    ]);
    expect(spec.tableSigners).toBeUndefined();
    expect(spec.trailingEvent).toBeUndefined();
  });

  it("record_loading: owner SHIP then terminal LOAD, both pre-checked (fold 46), LoanHandedOff trailing", () => {
    const spec = KIND_SPECS.record_loading;
    expect(spec.mode).toBe("both");
    expect(spec.event).toBe("LoadingRecorded");
    expect(spec.trailingEvent).toBe("LoanHandedOff");
    expect(spec.textWindowSecs).toBe(570n);
    expect(spec.args).toStrictEqual(["intent"]);
    expect(spec.signers).toStrictEqual([
      { role: "owner", method: "text", scope: "SHIP", preCheckAuthority: true },
      { role: "terminal", method: "text", scope: "LOAD", preCheckAuthority: true },
    ]);
    expect(spec.tableSigners).toBeUndefined();
    expect(scopeBit("SHIP")).toBe(1 << 9);
    expect(scopeBit("LOAD")).toBe(1 << 12);
  });

  const intentArgs = {
    lot: PROGRAM,
    evidenceVersionId: "6f1c4a52-0d3e-4c4b-9b7e-2a1f0c9d8e7a",
    expiresInHours: "48",
  };

  it("accepts the fold 41 and §6.3 args", () => {
    expect(validateArgs("create_loading_intent", intentArgs)).toStrictEqual(intentArgs);
    expect(
      validateArgs("create_loading_intent", { ...intentArgs, expiresInHours: "720" }),
    ).toMatchObject({ expiresInHours: "720" });
    expect(validateArgs("record_loading", { intent: PROGRAM })).toStrictEqual({ intent: PROGRAM });
  });

  it.each([
    ["lot", "nope"],
    ["evidenceVersionId", "not-a-uuid"],
    ["expiresInHours", "0"],
    ["expiresInHours", "721"],
    ["expiresInHours", "01"],
  ])("create_loading_intent refuses %s = %j as VALIDATION", (key, value) => {
    expect(() => validateArgs("create_loading_intent", { ...intentArgs, [key]: value })).toThrow(
      expect.objectContaining({ code: "VALIDATION", detail: `args.${key}` }),
    );
  });

  it("record_loading refuses a bad intent and extra keys", () => {
    expect(() => validateArgs("record_loading", { intent: "nope" })).toThrow(
      expect.objectContaining({ code: "VALIDATION", detail: "args.intent" }),
    );
    expect(() => validateArgs("record_loading", { intent: PROGRAM, lot: PROGRAM })).toThrow(
      expect.objectContaining({ code: "VALIDATION" }),
    );
  });
});

// ---------------------------------------------------------------- transaction size

const newKey = async () => (await generateKeyPairSigner()).address;

async function intentSize(values: {
  lotId: string;
  owner: string;
  terminal: string;
  site: string;
  quantityKg: bigint;
  nonce: bigint;
  expiresAt: bigint;
  expectedRevision: bigint;
  validUntil: bigint;
}) {
  const plan: Record<string, string> = {};
  for (const key of ["lot", "position", "ownerOrg", "custodianClass", "terminalOrg", "intent"])
    plan[key] = await newKey();
  Object.assign(plan, {
    nonce: String(values.nonce),
    documentSha256: "aa".repeat(32),
    expiresAt: String(values.expiresAt),
    expectedRevision: String(values.expectedRevision),
    validUntil: String(values.validUntil),
  });
  const text = loadingIntentMessage(
    PROGRAM,
    new Uint8Array(16),
    values.lotId,
    values.quantityKg,
    values.owner,
    values.terminal,
    values.site,
    new Uint8Array(32).fill(0xaa),
    values.nonce,
    values.expiresAt,
    values.expectedRevision,
    values.validUntil,
  );
  const sponsor = await newKey();
  const protocol = await newKey();
  const owner = await newKey();
  const thetis = await buildInstruction({
    kind: "create_loading_intent",
    plan,
    protocol,
    sponsor,
    wallets: { owner },
  });
  const ed25519 = sharedMessageInstruction(
    [{ wallet: owner, signature: new Uint8Array(64) }],
    text,
  );
  const candidates = tableCandidates(thetis, { protocol, sponsor, signers: [owner] });
  // The intent is created by the instruction, so it stays static (fold 9); every other account
  // exists or is a fixed key.
  const keys = admittedKeys(
    candidates,
    candidates.map((key) => key !== plan.intent && key !== SYSVAR_INSTRUCTIONS),
    tableSignerAddresses("create_loading_intent", plan),
  );
  return {
    plan,
    thetis,
    text,
    keys,
    candidates,
    bytes: measureCommand(commandInstructions(thetis, ed25519), sponsor, keys),
    wire: issued(commandInstructions(thetis, ed25519), sponsor, keys).wire,
  };
}

async function recordSize(values: {
  lotId: string;
  owner: string;
  terminal: string;
  k: number;
  child: boolean;
  quantityKg: bigint;
  nonce: bigint;
  expectedRevision: bigint;
  validUntil: bigint;
}) {
  const plan: Record<string, string> = {};
  for (const key of [
    "intent",
    "lot",
    "position",
    "custodianClass",
    "ownerOrg",
    "terminalOrg",
    "intake",
    "mint",
    "vaultAuthority",
    "vault",
  ])
    plan[key] = await newKey();
  if (values.child) plan.root = await newKey();
  const triples: Address[] = [];
  for (let index = 0; index < values.k * 3; index++) triples.push(await newKey());
  Object.assign(plan, {
    expectedRevision: String(values.expectedRevision),
    validUntil: String(values.validUntil),
    k: String(values.k),
    triples: triples.join(","),
  });
  const text = recordLoadingMessage(
    PROGRAM,
    new Uint8Array(16),
    values.lotId,
    values.quantityKg,
    values.owner,
    values.terminal,
    new Uint8Array(32).fill(0xaa),
    values.nonce,
    values.quantityKg,
    values.k,
    values.expectedRevision,
    values.validUntil,
  );
  const sponsor = await newKey();
  const protocol = await newKey();
  const owner = await newKey();
  const terminal = await newKey();
  const thetis = await buildInstruction({
    kind: "record_loading",
    plan,
    protocol,
    sponsor,
    wallets: { owner, terminal },
  });
  const ed25519 = sharedMessageInstruction(
    [
      { wallet: owner, signature: new Uint8Array(64) },
      { wallet: terminal, signature: new Uint8Array(64) },
    ],
    text,
  );
  const instructions = commandInstructions(thetis, ed25519);
  const candidates = tableCandidates(thetis, { protocol, sponsor, signers: [owner, terminal] });
  // Nothing is created: the intent, lot, position, Authorities, acceptances, loans and locks all
  // exist when the relay sends (fold 43), so every candidate is admitted.
  const keys = admittedKeys(
    candidates,
    candidates.map((key) => key !== SYSVAR_INSTRUCTIONS),
    tableSignerAddresses("record_loading", plan),
  );
  return {
    plan,
    triples,
    thetis,
    text,
    keys,
    candidates,
    instructions,
    sponsor,
    bytes: measureCommand(instructions, sponsor, keys),
    wire: issued(instructions, sponsor, keys).wire,
  };
}

const DEMO_INTENT = {
  lotId: "CR-0001",
  owner: "Khunou Ore Exports",
  terminal: "Port Terminal T1",
  site: "PORT-T1",
  quantityKg: 3_000_000n,
  nonce: 1n,
  expiresAt: 1_795_185_125n,
  expectedRevision: 2n,
  validUntil: 1_795_098_725n,
};
const WIDEST_INTENT = {
  lotId: "L".repeat(16),
  owner: "N".repeat(48),
  terminal: "N".repeat(48),
  site: "S".repeat(16),
  quantityKg: U64_MAX,
  nonce: U64_MAX,
  expiresAt: I64_MAX,
  expectedRevision: U64_MAX,
  validUntil: I64_MAX,
};
const DEMO_RECORD = {
  lotId: "CR-0001",
  owner: "Khunou Ore Exports",
  terminal: "Port Terminal T1",
  k: 1,
  child: false,
  quantityKg: 3_000_000n,
  nonce: 1n,
  expectedRevision: 3n,
  validUntil: 1_795_098_725n,
};
const WIDEST_RECORD = {
  lotId: "L".repeat(16),
  owner: "N".repeat(48),
  terminal: "N".repeat(48),
  k: 4,
  child: true,
  quantityKg: U64_MAX,
  nonce: U64_MAX,
  expectedRevision: U64_MAX,
  validUntil: I64_MAX,
};

describe("create_loading_intent transaction (fold 49, fold 50)", () => {
  it("names the IDL's eleven accounts in order, sponsor at 0, protocol at 1, the intent static", async () => {
    const { thetis, plan, candidates, keys } = await intentSize(DEMO_INTENT);
    const accounts = thetis.accounts ?? [];
    expect(accounts).toHaveLength(11);
    expect(accounts.map((meta) => meta.address)).toStrictEqual([
      accounts[0]?.address,
      accounts[1]?.address,
      plan.ownerOrg,
      expect.any(String),
      plan.lot,
      plan.position,
      plan.custodianClass,
      plan.terminalOrg,
      plan.intent,
      SYSVAR_INSTRUCTIONS,
      SYSTEM,
    ]);
    // sponsor writable signer, position and intent writable.
    expect(accounts.map((meta) => meta.role)).toStrictEqual([3, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0]);
    expect(candidates).toHaveLength(9);
    expect(keys).not.toContain(plan.intent);
    expect(keys).toHaveLength(8);
  });

  it("measures the demo intent at 1,028 and the widest at 1,179 (program-custody.md §11.2), both under 1,232", async () => {
    const demo = await intentSize(DEMO_INTENT);
    expect(demo.text.length).toBe(480);
    expect(demo.bytes).toBe(1_040);
    expectPriced(expect, demo.wire, "demo intent");
    const widest = await intentSize(WIDEST_INTENT);
    expect(widest.text.length).toBe(631);
    expect(widest.bytes).toBe(1_191);
    expectPriced(expect, widest.wire, "widest intent");
    expect(widest.bytes).toBeLessThanOrEqual(MAX_TRANSACTION_BYTES);
  });
});

describe("record_loading transaction (folds 43, 49, 50)", () => {
  it("names the IDL's seventeen accounts, then the triples in plan order, acceptance read-only, loan and lock writable", async () => {
    const { thetis, plan, triples } = await recordSize({ ...DEMO_RECORD, k: 2 });
    const accounts = thetis.accounts ?? [];
    expect(accounts).toHaveLength(17 + 6);
    expect(accounts[1]?.address).not.toBe(plan.intent);
    expect(accounts[7]?.address).toBe(plan.lot);
    // No root for a lot without a parent: the optional slot is the program id (fold 49).
    expect(accounts[8]?.address).toBe(THETIS_PROGRAM_ADDRESS);
    expect(accounts[14]?.address).toBe(plan.intent);
    expect(accounts[15]?.address).toBe(SYSVAR_INSTRUCTIONS);
    expect(accounts[16]?.address).toBe(TOKEN_2022);
    expect(accounts.slice(17).map((meta) => meta.address)).toStrictEqual(triples);
    expect(accounts.slice(17).map((meta) => meta.role)).toStrictEqual([0, 1, 1, 0, 1, 1]);
  });

  it("names the root when the lot is a child, and no triples when k = 0", async () => {
    const child = await recordSize({ ...DEMO_RECORD, child: true, k: 0 });
    const accounts = child.thetis.accounts ?? [];
    expect(accounts).toHaveLength(17);
    expect(accounts[8]?.address).toBe(child.plan.root);
    expect(accounts[8]?.role).toBe(1);
  });

  it("measures the demo loading at 1,060 and every k at the widest fields, the widest k = 4 child at 1,230", async () => {
    const demo = await recordSize(DEMO_RECORD);
    expect(demo.text.length).toBe(464);
    expect(demo.bytes).toBe(1_072);
    expectPriced(expect, demo.wire, "demo loading");
    const widths: number[] = [];
    for (const k of [0, 1, 2, 3, 4]) {
      const sized = await recordSize({ ...WIDEST_RECORD, k });
      widths.push(sized.bytes);
      expect(sized.bytes, `k = ${k}`).toBeLessThanOrEqual(MAX_TRANSACTION_BYTES);
      // k = 3 and 4 at the widest fields fit only without the price (28 Nov decision).
      (k <= 2 ? expectPriced : expectUnpriced)(expect, sized.wire, `k = ${k}`);
    }
    // Each triple adds three accounts, each one instruction index and one table index; the text
    // is the same width for every k (program-custody.md §11.2's 27 Nov note: 1,230 at k = 4).
    // k = 0 to 2 carry the 12-byte price; k = 3 and 4 do not.
    expect(widths).toStrictEqual([1_218, 1_224, 1_230, 1_224, 1_230]);
  });

  it("the k = 4 widest is 2 bytes under the limit only with every triple key in the table: one left static is over 1,232 (fold 26's guard refuses it)", async () => {
    const widest = await recordSize(WIDEST_RECORD);
    expect(widest.bytes).toBe(1_230);
    expect(widest.keys).toStrictEqual(widest.candidates);
    expect(widest.keys).toEqual(expect.arrayContaining(widest.triples));
    for (const key of widest.triples) {
      const without = widest.keys.filter((admitted) => admitted !== key);
      const bytes = measureCommand(widest.instructions, widest.sponsor, without);
      expect(bytes).toBeGreaterThan(MAX_TRANSACTION_BYTES);
      expect(bytes - widest.bytes).toBe(31);
    }
  });

  it("T056r R8, re-measured after R7: record_loading creates no account, so the table already holds every key but the protocol, and the k = 4 widest with the price would be 1,242 bytes, so it still goes unpriced", async () => {
    expect(KIND_SPECS.record_loading.tableCreated).toBeUndefined();
    const widest = await recordSize(WIDEST_RECORD);
    expect(widest.keys).toStrictEqual(widest.candidates);
    expect(widest.bytes).toBe(1_230);
    expectUnpriced(expect, widest.wire, "k = 4 widest");
    // The price is 12 bytes: 1,242 is 10 over the limit (bypass_custody.rs relay shape agrees).
    expect(widest.bytes + 12).toBe(1_242);
    expect(widest.bytes + 12).toBeGreaterThan(MAX_TRANSACTION_BYTES);
  });
});
