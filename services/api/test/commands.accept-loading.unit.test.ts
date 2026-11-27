// accept_loading as a sponsor-paid relay transaction kind: its spec, args, account order and size
// (field-app.md owner decision 1 on loading, T067r.4 pre-check folds 52–57).
import { type Address, generateKeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  admittedKeys,
  commandInstructions,
  MAX_TRANSACTION_BYTES,
  measureCommand,
  tableCandidates,
} from "../src/commands/compile.ts";
import {
  buildInstruction,
  KIND_SPECS,
  tableSignerAddresses,
  validateArgs,
} from "../src/commands/plan.ts";

const SYSTEM = "11111111111111111111111111111111" as Address;
const newKey = async () => (await generateKeyPairSigner()).address;

async function acceptance(options: { acceptanceExists: boolean }) {
  const plan: Record<string, string> = {};
  for (const key of [
    "lenderOrg",
    "facility",
    "loan",
    "lock",
    "lot",
    "position",
    "intent",
    "acceptance",
  ])
    plan[key] = await newKey();
  plan.expectedRevision = "18446744073709551615";
  const sponsor = await newKey();
  const protocol = await newKey();
  const lender = await newKey();
  const thetis = await buildInstruction({
    kind: "accept_loading",
    plan,
    protocol,
    sponsor,
    wallets: { lender },
  });
  const instructions = commandInstructions(thetis, null);
  const candidates = tableCandidates(thetis, { protocol, sponsor, signers: [lender] });
  // Every account exists when the lender signs except the acceptance on a first acceptance,
  // which the instruction creates (fold 55).
  const keys = admittedKeys(
    candidates,
    candidates.map((key) => options.acceptanceExists || key !== plan.acceptance),
    tableSignerAddresses("accept_loading", plan),
  );
  return {
    plan,
    thetis,
    sponsor,
    protocol,
    lender,
    keys,
    bytes: measureCommand(instructions, sponsor, keys),
  };
}

describe("accept_loading kind spec (owner decision 1, fold 52)", () => {
  it("one lender transaction signer with LEND, pre-checked, and LoadingAccepted as its outcome", () => {
    const spec = KIND_SPECS.accept_loading;
    expect(spec.mode).toBe("both");
    expect(spec.args).toStrictEqual(["intent", "loan"]);
    expect(spec.signers).toStrictEqual([
      { role: "lender", method: "transaction", scope: "LEND", preCheckAuthority: true },
    ]);
    expect(spec.event).toBe("LoadingAccepted");
    expect(spec.trailingEvent).toBeUndefined();
    expect(spec.tableSigners).toBeUndefined();
  });

  it("takes exactly intent and loan, both addresses", async () => {
    const intent = await newKey();
    const loan = await newKey();
    expect(validateArgs("accept_loading", { intent, loan })).toStrictEqual({ intent, loan });
    expect(() => validateArgs("accept_loading", { intent })).toThrow(/VALIDATION/);
    expect(() => validateArgs("accept_loading", { intent, loan, expectedRevision: "1" })).toThrow(
      /VALIDATION/,
    );
    expect(() => validateArgs("accept_loading", { intent, loan: "not-an-address" })).toThrow(
      /VALIDATION/,
    );
  });
});

describe("accept_loading transaction (folds 52, 55, 57)", () => {
  it("names the IDL's thirteen accounts in order: lender, the sponsor as payer at 1, protocol at 2", async () => {
    const { thetis, plan, sponsor, protocol, lender } = await acceptance({
      acceptanceExists: false,
    });
    const accounts = thetis.accounts ?? [];
    expect(accounts).toHaveLength(13);
    expect(accounts.map((meta) => meta.address)).toStrictEqual([
      lender,
      sponsor,
      protocol,
      expect.any(String), // the lender wallet's Authority PDA
      plan.lenderOrg,
      plan.facility,
      plan.loan,
      plan.lock,
      plan.lot,
      plan.position,
      plan.intent,
      plan.acceptance,
      SYSTEM,
    ]);
    // lender readonly signer, payer writable signer, the acceptance writable.
    expect(accounts.map((meta) => meta.role)).toStrictEqual([
      2, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0,
    ]);
    expect(Buffer.from(thetis.data ?? new Uint8Array()).subarray(0, 8)).toStrictEqual(
      Buffer.from([90, 171, 147, 76, 57, 142, 187, 88]),
    );
    // expected_revision, u64 LE, read from the plan (the chain's loan.revision).
    expect(
      Buffer.from(thetis.data ?? new Uint8Array())
        .subarray(8)
        .toString("hex"),
    ).toBe("ffffffffffffffff");
  });

  it("keeps a first acceptance static and is under 1,232 bytes either way", async () => {
    const first = await acceptance({ acceptanceExists: false });
    expect(first.keys).not.toContain(first.plan.acceptance);
    const again = await acceptance({ acceptanceExists: true });
    expect(again.keys).toContain(again.plan.acceptance);
    expect(first.bytes).toBeLessThanOrEqual(MAX_TRANSACTION_BYTES);
    expect(again.bytes).toBeLessThan(first.bytes);
    expect([first.bytes, again.bytes]).toStrictEqual([MEASURED_FIRST, MEASURED_AGAIN]);
  });
});

/** Measured through compile.ts (fold 55): a first acceptance and a re-acceptance. */
const MEASURED_FIRST = 0;
const MEASURED_AGAIN = 0;
