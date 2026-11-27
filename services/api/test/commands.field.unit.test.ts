// The field kinds' texts, digests and specs (field-app.md §6.3, §6.4 and the T067r folds).
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  type Address,
  decodeAccount,
  generateKeyPairSigner,
  type Instruction,
  lamports,
  type MaybeEncodedAccount,
} from "@solana/kit";
import {
  getCustodianClassDecoder,
  getCustodianClassEncoder,
  THETIS_PROGRAM_ADDRESS,
} from "@thetis/contracts";
import { describe, expect, it } from "vitest";
import {
  admittedKeys,
  commandInstructions,
  FIXED_TABLE_KEYS,
  MAX_TRANSACTION_BYTES,
  measureCommand,
  tableCandidates,
} from "../src/commands/compile.ts";
import { sharedMessageInstruction } from "../src/commands/ed25519.ts";
import {
  buildInstruction,
  KIND_SPECS,
  type KindSpec,
  Reader,
  tableSignerAddresses,
  validateArgs,
} from "../src/commands/plan.ts";
import {
  custodyHandoverMessage,
  handoverStage,
  intakeDigest,
  issueLotMessage,
  normaliseTicket,
} from "../src/commands/texts.ts";
import type { SignerRole } from "../src/commands/views.ts";

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
    const field = (name: string) =>
      fileURLToPath(new URL(`../../../apps/field/src/${name}`, import.meta.url));
    const intake = await import(field("intake.ts"));
    const check = await import(field("text.ts"));
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

describe("custodyHandoverMessage", () => {
  it("reproduces program-custody.md's handover vector (480 bytes, e81d1fa1…)", () => {
    const text = custodyHandoverMessage(
      PROGRAM,
      hexBytes("00112233445566778899aabbccddeeff"),
      "CR-0001",
      new Uint8Array(16).fill(0x22),
      1,
      1,
      5_000_000n,
      "Kopano Stockyard Custody",
      "Mosela Haulage",
      "Departure",
      new Uint8Array(32).fill(0x44),
      0n,
      1_795_098_725n,
    );
    expect(text.length).toBe(480);
    expect(sha256(text)).toBe("e81d1fa1436bfe8fffc851a44068124ba956f00faf175a5226c513e51d36e0d9");
  });

  it("derives the stage as the program does, and the stage the program refuses otherwise", () => {
    const at = (batchStage: "AtSource" | "InTransit" | "Arrived", to: string) =>
      handoverStage({ batchStage, to, destinationCustodian: "destination" });
    expect(at("AtSource", "carrier")).toBe("Departure");
    expect(at("AtSource", "other")).toBe("Departure"); // RecipientNotApproved on chain
    expect(at("InTransit", "destination")).toBe("Arrival");
    expect(at("InTransit", "carrier")).toBe("Transfer");
    expect(at("Arrived", "destination")).toBe("Arrival"); // StageOutOfOrder on chain
  });
});

describe("handover kind spec (field-app.md §6.3)", () => {
  it("is holder then next_holder, both CARRY texts, next_holder not pre-checked, a 570 s window", () => {
    const spec = KIND_SPECS.handover;
    expect(spec.mode).toBe("both");
    expect(spec.event).toBe("CustodyHandedOver");
    expect(spec.textWindowSecs).toBe(570n);
    expect(spec.args).toStrictEqual(["batch", "to"]);
    expect(spec.signers).toStrictEqual([
      { role: "holder", method: "text", scope: "CARRY", preCheckAuthority: true },
      { role: "next_holder", method: "text", scope: "CARRY", preCheckAuthority: false },
    ]);
  });

  it("validates batch as an address and to as a uuid", () => {
    const args = {
      batch: "jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3",
      to: "6f1c4a52-0d3e-4c4b-9b7e-2a1f0c9d8e7a",
    };
    expect(validateArgs("handover", args)).toStrictEqual(args);
    expect(() => validateArgs("handover", { ...args, to: "x" })).toThrow(
      expect.objectContaining({ code: "VALIDATION", detail: "args.to" }),
    );
    expect(() => validateArgs("handover", { ...args, batch: "x" })).toThrow(
      expect.objectContaining({ code: "VALIDATION", detail: "args.batch" }),
    );
  });
});

// ---------------------------------------------------------------- transaction size (PR #69 folds)

const SYSVAR_INSTRUCTIONS = "Sysvar1nstructions1111111111111111111111111" as Address;
const newKey = async () => (await generateKeyPairSigner()).address;

/** The size the relay computes for one command, with the accounts named in `absent` not on chain
 * (the ones the instruction creates, a wallet-derived Authority that was never delegated, and
 * the instructions sysvar, which never has an account). */
async function commandSize(
  kind: "issue_lot" | "handover",
  plan: Record<string, string>,
  wallets: Partial<Record<SignerRole, Address>>,
  text: Uint8Array,
  absent: (thetis: Instruction) => Address[],
) {
  const sponsor = await newKey();
  const protocol = await newKey();
  const thetis = await buildInstruction({ kind, plan, protocol, sponsor, wallets });
  const signers = Object.values(wallets) as Address[];
  const ed25519 = sharedMessageInstruction(
    signers.map((wallet) => ({ wallet, signature: new Uint8Array(64) })),
    text,
  );
  const candidates = tableCandidates(thetis, { protocol, sponsor, signers });
  const missing = new Set([SYSVAR_INSTRUCTIONS, ...absent(thetis)]);
  const keys = admittedKeys(
    candidates,
    candidates.map((key) => !missing.has(key)),
    tableSignerAddresses(kind, plan),
  );
  return {
    keys,
    candidates,
    bytes: measureCommand(commandInstructions(thetis, ed25519), sponsor, keys),
  };
}

async function issueSize(values: {
  lotId: string;
  grade: string;
  classCode: string;
  siteCode: string;
  owner: string;
  custodian: string;
  origin: boolean;
}) {
  const plan: Record<string, string> = {};
  for (const key of [
    "classPolicy",
    "custodianClass",
    "ownerOrg",
    "custodianOrg",
    "intake",
    "lot",
    "mint",
    "mintAuthority",
    "position",
    "vaultAuthority",
    "vault",
    ...(values.origin ? ["origin", "originIssuer"] : []),
  ])
    plan[key] = await newKey();
  Object.assign(plan, {
    lotId: values.lotId,
    grade: values.grade,
    quantityKg: "5000000",
    intakeDigest: "ab".repeat(32),
    validUntil: String(DEMO.validUntil),
  });
  const text = issueLotMessage(
    PROGRAM,
    DEMO.instanceId,
    values.lotId,
    values.classCode,
    1,
    values.grade,
    5_000_000n,
    values.owner,
    values.custodian,
    values.siteCode,
    new Uint8Array(32),
    values.origin ? { sha256: new Uint8Array(32), version: 1 } : null,
    DEMO.validUntil,
  );
  const created = ["intake", "lot", "mint", "position", "vault", "mintAuthority", "vaultAuthority"];
  return commandSize("issue_lot", plan, { custodian: await newKey() }, text, () =>
    created.map((key) => plan[key] as Address),
  );
}

async function handoverSize(values: {
  lotId: string;
  from: string;
  to: string;
  stage: "Departure" | "Transfer" | "Arrival";
  nextHolderAuthority: boolean;
}) {
  const plan: Record<string, string> = {};
  for (const key of [
    "shipment",
    "batch",
    "lot",
    "fromOrg",
    "toOrg",
    "sourceClass",
    "destinationClass",
    "handover",
    ...(values.stage === "Departure" ? ["departureDocument"] : []),
  ])
    plan[key] = await newKey();
  Object.assign(plan, {
    manifestDigest: "44".repeat(32),
    expectedSequence: "0",
    validUntil: String(DEMO.validUntil),
  });
  const text = custodyHandoverMessage(
    PROGRAM,
    DEMO.instanceId,
    values.lotId,
    new Uint8Array(16),
    1,
    1,
    5_000_000n,
    values.from,
    values.to,
    values.stage,
    new Uint8Array(32),
    0n,
    DEMO.validUntil,
  );
  const wallets = { holder: await newKey(), next_holder: await newKey() };
  return commandSize("handover", plan, wallets, text, (thetis) => [
    plan.handover as Address,
    // toAuthority, slot 8: absent when the next holder was never delegated.
    ...(values.nextHolderAuthority ? [] : [thetis.accounts?.[8]?.address as Address]),
  ]);
}

const DEMO_FIELDS = {
  lotId: "CR-0001",
  grade: "G1",
  classCode: "CHROME",
  siteCode: "KOPANO-YARD-1",
};
const WIDEST = {
  lotId: "L".repeat(16),
  grade: "G".repeat(8),
  classCode: "C".repeat(8),
  siteCode: "S".repeat(16),
};
const name = (length: number) => "N".repeat(length);

describe("transaction size (field-app.md PR #69 review folds)", () => {
  it("lets the fixed program and sysvar addresses into the table, the instructions sysvar too", async () => {
    const { keys } = await issueSize({
      ...DEMO_FIELDS,
      owner: DEMO.owner,
      custodian: DEMO.custodian,
      origin: false,
    });
    expect(keys).toContain(SYSVAR_INSTRUCTIONS);
    for (const fixed of [
      SYSVAR_INSTRUCTIONS,
      "11111111111111111111111111111111",
      "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
      "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
    ]) {
      expect(FIXED_TABLE_KEYS.has(fixed as Address)).toBe(true);
    }
  });

  it("fits the demo issue_lot, with and without origin, under 1,232 bytes", async () => {
    const plain = await issueSize({
      ...DEMO_FIELDS,
      owner: DEMO.owner,
      custodian: DEMO.custodian,
      origin: false,
    });
    const origin = await issueSize({
      ...DEMO_FIELDS,
      owner: DEMO.owner,
      custodian: DEMO.custodian,
      origin: true,
    });
    expect(plain.bytes).toBe(1_162);
    expect(origin.bytes).toBe(1_219);
    expect(MAX_TRANSACTION_BYTES).toBe(1_232);
  });

  it("fits the widest issue_lot names claimed: 48 and 48 without origin, 55 in all with origin", async () => {
    const plain = await issueSize({
      ...DEMO_FIELDS,
      owner: name(48),
      custodian: name(48),
      origin: false,
    });
    expect(plain.bytes).toBeLessThanOrEqual(MAX_TRANSACTION_BYTES);
    const fits = await issueSize({
      ...DEMO_FIELDS,
      owner: name(27),
      custodian: name(28),
      origin: true,
    });
    expect(fits.bytes).toBe(MAX_TRANSACTION_BYTES);
    const over = await issueSize({
      ...DEMO_FIELDS,
      owner: name(28),
      custodian: name(28),
      origin: true,
    });
    expect(over.bytes).toBe(MAX_TRANSACTION_BYTES + 1);
    // Every field at its widest: 77 name characters in all without origin, 20 with it.
    expect(
      (await issueSize({ ...WIDEST, owner: name(48), custodian: name(29), origin: false })).bytes,
    ).toBeLessThanOrEqual(MAX_TRANSACTION_BYTES);
    expect(
      (await issueSize({ ...WIDEST, owner: name(48), custodian: name(30), origin: false })).bytes,
    ).toBeGreaterThan(MAX_TRANSACTION_BYTES);
    expect(
      (await issueSize({ ...WIDEST, owner: name(10), custodian: name(10), origin: true })).bytes,
    ).toBeLessThanOrEqual(MAX_TRANSACTION_BYTES);
    // The guard's case: every field at its widest, with origin.
    expect(
      (await issueSize({ ...WIDEST, owner: name(48), custodian: name(48), origin: true })).bytes,
    ).toBe(1_308);
  });

  it("fits every handover with 48-character names and a 16-character lot ID", async () => {
    for (const stage of ["Departure", "Transfer", "Arrival"] as const) {
      for (const nextHolderAuthority of [true, false]) {
        const { bytes } = await handoverSize({
          lotId: "L".repeat(16),
          from: name(48),
          to: name(48),
          stage,
          nextHolderAuthority,
        });
        expect(bytes, `${stage} ${nextHolderAuthority}`).toBeLessThanOrEqual(MAX_TRANSACTION_BYTES);
      }
    }
    const widest = await handoverSize({
      lotId: "L".repeat(16),
      from: name(48),
      to: name(48),
      stage: "Departure",
      nextHolderAuthority: false,
    });
    expect(widest.bytes).toBe(1_228);
  });

  it("never admits a wallet-derived key that is not on chain: the undelegated next holder's Authority stays static", async () => {
    const { keys, candidates } = await handoverSize({
      lotId: "CR-0001",
      from: DEMO.custodian,
      to: "Mosela Haulage",
      stage: "Departure",
      nextHolderAuthority: false,
    });
    const admittedOnly = candidates.filter((key) => !keys.includes(key));
    // The handover PDA the instruction creates and the next holder's missing Authority.
    expect(admittedOnly).toHaveLength(2);
  });

  it("types tableSigners as plan keys, so a misspelt key does not compile", () => {
    // @ts-expect-error: not a program-signer plan key
    const misspelt: KindSpec["tableSigners"] = ["mintAuthorty"];
    expect(misspelt).toBeDefined();
    expect(KIND_SPECS.issue_lot.tableSigners).toStrictEqual(["mintAuthority", "vaultAuthority"]);
  });
});

describe("Reader owner check (field-app.md PR #69 fold 29)", () => {
  it("refuses an account another program owns before decoding, whatever the decoder checks", async () => {
    const [protocol, custodian, classPolicy, address, otherProgram] = (await Promise.all(
      Array.from({ length: 5 }, newKey),
    )) as [Address, Address, Address, Address, Address];
    const data = new Uint8Array(
      getCustodianClassEncoder().encode({
        protocol,
        custodian,
        classPolicy,
        siteCode: "KOPANO-YARD-1",
        approvedCapacityKg: 10_000_000n,
        occupiedKg: 0n,
        reservedInboundKg: 0n,
        bump: 255,
      }),
    );
    const account = (programAddress: Address): MaybeEncodedAccount => ({
      exists: true,
      address,
      programAddress,
      data,
      executable: false,
      lamports: lamports(1_000_000n),
      space: BigInt(data.length),
    });
    // A decoder without the generated owner guard: only the Reader stands between it and the
    // lookalike.
    const unguarded = (encoded: MaybeEncodedAccount) =>
      decodeAccount(encoded, getCustodianClassDecoder());
    const chainOf = (programAddress: Address) =>
      ({ accounts: async (keys: Address[]) => keys.map(() => account(programAddress)) }) as never;
    const lookalike = new Reader(chainOf(otherProgram), protocol);
    await expect(
      lookalike.read("custodianClass", address, unguarded as never, "CustodianClass"),
    ).rejects.toMatchObject({
      code: "ACCOUNT_MISSING",
      detail: `${address}: not a CustodianClass`,
    });
    const real = new Reader(chainOf(THETIS_PROGRAM_ADDRESS), protocol);
    await expect(
      real.read("custodianClass", address, unguarded as never, "CustodianClass"),
    ).resolves.toMatchObject({ custodian, siteCode: "KOPANO-YARD-1" });
  });
});
