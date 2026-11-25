import {
  type Address,
  createNoopSigner,
  getAddressDecoder,
  getAddressEncoder,
  getProgramDerivedAddress,
} from "@solana/kit";
import { describe, expect, it } from "vitest";
import * as client from "../src/index.ts";
import {
  findAuthorityPda,
  getConfirmPaymentInstruction,
  getConfirmPaymentInstructionAsync,
  getOpenFacilityInstruction,
  getRepayInstruction,
  PaymentPurpose,
  parseConfirmPaymentInstruction,
  parseRepayInstruction,
  THETIS_PROGRAM_ADDRESS,
} from "../src/index.ts";
import { bytes, idl } from "./samples.ts";

const address = (seed: number) =>
  getAddressDecoder().decode(bytes(32).map((_, i) => (i + seed) % 256)) as Address;
const [protocol, wallet, facility, loan, lenderOrg, payment, subject, target, other, override] = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
].map(address) as [
  Address,
  Address,
  Address,
  Address,
  Address,
  Address,
  Address,
  Address,
  Address,
  Address,
];
const ONES = bytes(32);

/** The slots of `repay` after the fiat accounts: pool, pool authority, vault, token, mint, program. */
const POOL_SLOTS = [7, 8, 9, 10, 11, 12];

function repayAccounts(programAddress?: Address) {
  return getRepayInstruction(
    {
      signer: createNoopSigner(wallet),
      protocol,
      facility,
      loan,
      authority: other,
      lenderOrg,
      payment,
      amount: 3_000_000n,
    },
    programAddress === undefined ? undefined : { programAddress },
  );
}

const confirmInput = {
  lender: createNoopSigner(wallet),
  payer: createNoopSigner(other),
  protocol,
  lenderOrg,
  facility,
  loan,
  subject,
  paymentId: ONES,
  purpose: PaymentPurpose.Repayment,
  amount: 3_000_000n,
  currency: new Uint8Array([85, 83, 68]),
  evidenceDigest: ONES,
  observedAt: 1_795_000_000n,
};

describe("omitted optional accounts stay absent", () => {
  it("repay with only the fiat accounts encodes the sentinel in every pool slot", () => {
    const instruction = repayAccounts();
    expect(instruction.accounts).toHaveLength(13);
    for (const slot of POOL_SLOTS) {
      expect(instruction.accounts[slot]?.address, `slot ${slot}`).toBe(THETIS_PROGRAM_ADDRESS);
    }
    expect(instruction.accounts.slice(0, 7).map((a) => a.address)).toEqual([
      wallet,
      protocol,
      facility,
      loan,
      other,
      lenderOrg,
      payment,
    ]);
  });

  it("encodes the instruction's own program address when it is overridden", () => {
    const instruction = repayAccounts(override);
    expect(instruction.programAddress).toBe(override);
    for (const slot of POOL_SLOTS) {
      expect(instruction.accounts[slot]?.address, `slot ${slot}`).toBe(override);
    }
  });

  it("gives no optional account a default value, in any instruction", async () => {
    const optional = idl.instructions.flatMap((instruction) =>
      (
        instruction as unknown as { accounts: { name: string; optional?: boolean }[] }
      ).accounts.filter((account) => account.optional),
    );
    expect(optional.length).toBeGreaterThan(0);
    // Fiat open_facility: the pool slot is the sentinel, not a derived pool address.
    const open = getOpenFacilityInstruction({
      lender: createNoopSigner(wallet),
      payer: createNoopSigner(other),
      protocol,
      authority: other,
      lenderOrg,
      borrowerOrg: subject,
      facility,
      facilityId: ONES.slice(0, 16),
      currency: new Uint8Array([85, 83, 68]),
      currencyDecimals: 2,
      termsVersion: 1,
      rateBps: 1_200,
      maxLtvBps: 6_000,
      termsDigest: ONES,
    });
    expect(open.accounts[7]?.address).toBe(THETIS_PROGRAM_ADDRESS);
    // The async confirm builder derives the required accounts and still leaves the target out.
    const confirm = await getConfirmPaymentInstructionAsync({ ...confirmInput });
    expect(confirm.accounts[8]?.address).toBe(THETIS_PROGRAM_ADDRESS);
  });
});

describe("one canonical authority PDA", () => {
  const exported = Object.keys(client);

  it("exports findAuthorityPda with the on-chain seeds { protocol, wallet }", async () => {
    expect(exported).toContain("findAuthorityPda");
    const expected = await getProgramDerivedAddress({
      programAddress: THETIS_PROGRAM_ADDRESS,
      seeds: [
        new TextEncoder().encode("authority"),
        getAddressEncoder().encode(protocol),
        getAddressEncoder().encode(wallet),
      ],
    });
    expect(await findAuthorityPda({ protocol, wallet })).toEqual(expected);
  });

  it("emits no per-instruction duplicate authority helpers", () => {
    for (const name of [
      "findOpenFacilityAuthorityPda",
      "findDelegateAuthorityAuthorityPda",
      "findRepayAuthorityPda",
      "findConfirmPaymentAuthorityPda",
    ]) {
      expect(exported, name).not.toContain(name);
    }
  });

  it("derives each instruction's authority default from that canonical PDA", async () => {
    const [derived] = await findAuthorityPda({ protocol, wallet });
    const confirm = await getConfirmPaymentInstructionAsync({ ...confirmInput });
    expect(confirm.accounts[3]?.address).toBe(derived);
  });
});

describe("parsers read an omitted optional account against the instruction's program address", () => {
  it("confirm_payment: no target, with the default and an overridden program", async () => {
    for (const programAddress of [undefined, override]) {
      const instruction = await getConfirmPaymentInstructionAsync(
        { ...confirmInput },
        programAddress === undefined ? undefined : { programAddress },
      );
      const parsed = parseConfirmPaymentInstruction(instruction);
      expect(parsed.programAddress).toBe(programAddress ?? THETIS_PROGRAM_ADDRESS);
      expect(parsed.accounts.target).toBeUndefined();
      expect(parsed.accounts.subject.address).toBe(subject);
      expect(parsed.data.amount).toBe(3_000_000n);
    }
  });

  it("confirm_payment: a target is read back, also under an overridden program", () => {
    for (const programAddress of [undefined, override]) {
      const instruction = getConfirmPaymentInstruction(
        {
          ...confirmInput,
          authority: other,
          target,
          payment,
          purpose: PaymentPurpose.Correction,
          amount: 0n,
        },
        programAddress === undefined ? undefined : { programAddress },
      );
      const parsed = parseConfirmPaymentInstruction(instruction);
      expect(parsed.accounts.target?.address).toBe(target);
    }
  });

  it("an address equal to the default program is a real account under an override", () => {
    // Under an override the sentinel is the override, so the default program's address is just
    // another account the caller passed.
    const instruction = getRepayInstruction(
      {
        signer: createNoopSigner(wallet),
        protocol,
        facility,
        loan,
        authority: other,
        lenderOrg,
        payment,
        poolAuthority: THETIS_PROGRAM_ADDRESS,
        amount: 1n,
      },
      { programAddress: override },
    );
    const parsed = parseRepayInstruction(instruction);
    expect(parsed.accounts.poolAuthority?.address).toBe(THETIS_PROGRAM_ADDRESS);
    expect(parsed.accounts.pool).toBeUndefined();
    expect(parsed.accounts.tokenProgram).toBeUndefined();
  });

  it("repay: the fiat accounts round-trip with every pool slot absent", () => {
    for (const programAddress of [undefined, override]) {
      const parsed = parseRepayInstruction(repayAccounts(programAddress));
      expect(parsed.accounts.payment?.address).toBe(payment);
      expect(parsed.accounts.authority?.address).toBe(other);
      expect(parsed.accounts.lenderOrg?.address).toBe(lenderOrg);
      for (const slot of [
        "pool",
        "poolAuthority",
        "poolVault",
        "payerToken",
        "mint",
        "tokenProgram",
      ] as const) {
        expect(parsed.accounts[slot], slot).toBeUndefined();
      }
      expect(parsed.data.amount).toBe(3_000_000n);
    }
  });
});
