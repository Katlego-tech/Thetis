import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  advanceMessage,
  borrowMessage,
  buyPledgedMessage,
  correctionPaymentId,
  formatBps,
  formatMoney,
  formatSast,
  formatTonnes,
  paymentId,
  pledgeMessage,
  releaseIntentMessage,
  sourceDigest,
  termsDigest,
} from "../src/commands/texts.ts";

// program-lending.md §6.2 known-answer inputs.
const PROGRAM = "jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3";
const INSTANCE = Uint8Array.from([
  0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
]);
const FACILITY = new Uint8Array(16).fill(0x11);
const VALID_UNTIL = 1_795_098_725n;
const LOT = "CR-0001";
const OWNER = "Khunou Ore Exports";
const LENDER = "Lender One Bank";
const BUYER = "Buyer Smelter Co";

function sha256(bytes: Uint8Array | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

function vector(bytes: Uint8Array, length: number, digest: string) {
  expect(bytes.length).toBe(length);
  expect(sha256(bytes)).toBe(digest);
}

describe("signed texts", () => {
  it("formatMoney and formatBps match the program's known answers", () => {
    expect(formatMoney(40_000_000n, 2, "USD")).toBe("USD 400,000.00");
    expect(formatMoney(20n, 2, "USD")).toBe("USD 0.20");
    expect(formatMoney(0n, 2, "USD")).toBe("USD 0.00");
    expect(formatMoney(1_500_000n, 6, "USD")).toBe("USD 1.500000");
    expect(formatMoney(7n, 0, "USD")).toBe("USD 7");
    expect(formatMoney(18_446_744_073_709_551_615n, 2, "USD")).toBe(
      "USD 184,467,440,737,095,516.15",
    );
    expect(formatBps(6000n)).toBe("60.00%");
    expect(formatBps(1200n)).toBe("12.00%");
    expect(formatBps(0n)).toBe("0.00%");
    expect(formatBps(10000n)).toBe("100.00%");
    expect(formatBps(5n)).toBe("0.05%");
    expect(formatTonnes(2_000_000n)).toBe("2,000.000 t");
    expect(formatSast(1_795_098_725n)).toBe("2026-11-19 16:32:05 SAST");
  });

  it("the five lending texts match their known-answer vectors", () => {
    const pledge = pledgeMessage(
      PROGRAM,
      INSTANCE,
      LOT,
      5_000_000n,
      OWNER,
      LENDER,
      FACILITY,
      0,
      "USD",
      1200n,
      6000n,
      1n,
      0n,
      VALID_UNTIL,
    );
    vector(pledge, 460, "0d2745d8edc9b94befab1dcca6e06d7aabe7d1a850310f3634f86162bcb77132");
    expect(Buffer.from(pledge).toString("utf8")).toBe(
      [
        "Thetis authorisation v1",
        "Network: devnet",
        `Program: ${PROGRAM}`,
        "Protocol: 00112233445566778899aabbccddeeff",
        "Action: Pledge receipts",
        "Lot: CR-0001",
        "Quantity: 5,000.000 t",
        "Owner: Khunou Ore Exports",
        "Lender: Lender One Bank",
        "Facility: 11111111111111111111111111111111",
        "Loan: 0",
        "Currency: USD",
        "Rate: 12.00% a year, simple, actual/365",
        "Max LTV: 60.00%",
        "Terms: v1",
        "Revision: 0",
        "Valid until: 2026-11-19 16:32:05 SAST",
        "Test network only. Synthetic data.",
      ].join("\n"),
    );

    vector(
      advanceMessage(
        PROGRAM,
        INSTANCE,
        LOT,
        OWNER,
        LENDER,
        FACILITY,
        0,
        60_000_000n,
        60_000_000n,
        "USD",
        2,
        1200n,
        1n,
        0n,
        VALID_UNTIL,
      ),
      463,
      "ce096def0e25dfe374590623223ddd840d32b7898059ea1118648b1964a13d32",
    );

    vector(
      borrowMessage(
        PROGRAM,
        INSTANCE,
        LOT,
        OWNER,
        LENDER,
        FACILITY,
        0,
        600_000_000_000n,
        600_000_000_000n,
        "USD",
        6,
        "3JF3sEqM796hk5WFqA6EtmEwJQ9quALszsfJyvXNQKy3",
        1200n,
        0n,
        VALID_UNTIL,
      ),
      517,
      "4cb99c85b751577bc21ee7165cf52ed10269610dd25e8dafb4b68e4a0e873be2",
    );

    vector(
      releaseIntentMessage(
        PROGRAM,
        INSTANCE,
        LOT,
        2_000_000n,
        OWNER,
        BUYER,
        LENDER,
        FACILITY,
        0,
        1n,
        40_000_000n,
        0n,
        "USD",
        2,
        1_795_185_125n,
        1n,
        VALID_UNTIL,
      ),
      501,
      "98efb3cb89d6b5779b3453d68f9b105fa3777903c3cb5822e3e466cca44bb469",
    );

    vector(
      buyPledgedMessage(
        PROGRAM,
        INSTANCE,
        LOT,
        2_000_000n,
        OWNER,
        BUYER,
        LENDER,
        FACILITY,
        0,
        1n,
        40_000_000n,
        0n,
        "USD",
        2,
        1n,
        VALID_UNTIL,
      ),
      459,
      "579c76287e3112388fdf5e21882e8e56c05ee535a032762705753a0fbd8ce656",
    );
  });

  it("the four digests hash their canonical texts", () => {
    const lender = "0b1c2d3e-4f50-4617-8899-aabbccddeeff";
    const borrower = "11111111-2222-4333-8444-555555555555";
    expect(
      Buffer.from(
        termsDigest({
          lenderOrgId: lender,
          borrowerOrgId: borrower,
          currency: "USD",
          currencyDecimals: 2,
          termsVersion: 1n,
          rateBps: 1200n,
          maxLtvBps: 6000n,
        }),
      ).toString("hex"),
    ).toBe(sha256(`thetis-facility-terms-v1\n${lender}\n${borrower}\nUSD\n2\n1\n1200\n6000`));
    expect(
      Buffer.from(sourceDigest("Synthetic test price, not a market quote")).toString("hex"),
    ).toBe(sha256("thetis-valuation-source-v1\nSynthetic test price, not a market quote"));
    expect(Buffer.from(paymentId(lender, "BANK-REF-0001")).toString("hex")).toBe(
      sha256(`thetis-payment-v1\n${lender}\nBANK-REF-0001`),
    );
    expect(Buffer.from(correctionPaymentId(lender, "CORR-0001")).toString("hex")).toBe(
      sha256(`thetis-correction-v1\n${lender}\nCORR-0001`),
    );
    for (const digest of [paymentId(lender, "A"), sourceDigest("x")]) {
      expect(digest).toBeInstanceOf(Uint8Array);
      expect(digest.length).toBe(32);
    }
  });
});
