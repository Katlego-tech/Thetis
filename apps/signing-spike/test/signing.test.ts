import {
  address,
  blockhash,
  getCompiledTransactionMessageEncoder,
  getTransactionDecoder,
} from "@solana/kit";
import { describe, expect, it } from "vitest";
import { copy, outcomeCopy } from "../src/lib/copy";
import { decodeBase58, decodeBase64, encodeBase58, encodeBase64 } from "../src/lib/encoding";
import { checkIntentRole, parseIntent, parseOutcome, sameAuthorization } from "../src/lib/relay";
import { getMessageSignature, signatureIndex, wrapUnsignedTransaction } from "../src/lib/wire";

const sender = address("Vjh6dMxXifovfpqRwhhzp6gVsQUxFv5ZwffNu6QugcY");
const receiver = address("8dRTJ7KTmCiaziBmZf8skeBtPmwWLHyfEZQpPfu5a5px");
const sponsor = address("11111111111111111111111111111111");
const lifetimeToken = blockhash(sponsor);
const header = {
  numSignerAccounts: 2,
  numReadonlySignerAccounts: 1,
  numReadonlyNonSignerAccounts: 1,
};
const staticAccounts = [sender, receiver, sponsor];
const messageEncoder = getCompiledTransactionMessageEncoder();
const legacyMessage = messageEncoder.encode({
  version: "legacy",
  header,
  staticAccounts,
  lifetimeToken,
  instructions: [],
});
const v1Message = messageEncoder.encode({
  version: 1,
  header,
  staticAccounts,
  lifetimeToken,
  configMask: 0,
  configValues: [],
  numInstructions: 0,
  numStaticAccounts: staticAccounts.length,
  instructionHeaders: [],
  instructionPayloads: [],
});
const intent = {
  role: "sender",
  expectedAddress: sender,
  authorizationBase64: Buffer.from(v1Message).toString("base64"),
  authorizationSha256: "0".repeat(64),
  intent: {
    text: "Synthetic test data.",
    batchId: "0123456789abcdef0123456789abcdef",
    quantityKg: "2000000",
    from: "Kopano Stockyard Custody",
    to: "Mosela Haulage",
    expirySlot: 9001,
    expectedSequence: 0,
  },
  network: "devnet",
};
const outcome = {
  state: "unknown",
  signature: "aDevnetSignature",
  sizeBytes: 1232,
  checks: {
    sender: {
      message: { verified: true },
      transaction: { verified: false, reason: "BAD_SIGNATURE" },
    },
    receiver: { message: { verified: true }, transaction: { verified: true } },
  },
};

describe("encoding", () => {
  it("round trips padded base64, including zero and high bytes", () => {
    const bytes = Uint8Array.of(0, 0xff);
    expect(encodeBase64(bytes)).toBe("AP8=");
    expect(decodeBase64("AP8=")).toEqual(bytes);
  });

  it("rejects noncanonical and malformed base64", () => {
    for (const input of ["AP9=", "AP8", "AP8=\n", "%%%%"]) {
      expect(() => decodeBase64(input)).toThrow();
    }
  });

  it("round trips base58 with leading zeroes", () => {
    const bytes = Uint8Array.of(0, 0, 1);
    expect(encodeBase58(bytes)).toBe("112");
    expect(decodeBase58("112")).toEqual(bytes);
  });

  it("rejects characters outside the base58 alphabet", () => {
    expect(() => decodeBase58("0OIl")).toThrow();
  });
});

describe("wallet wire bytes", () => {
  it("wraps legacy and v0 messages with a shortvec count and zeroed signature slots", () => {
    const v0 = messageEncoder.encode({
      version: 0,
      header,
      staticAccounts,
      lifetimeToken,
      instructions: [],
    });
    for (const message of [legacyMessage, v0]) {
      const wire = wrapUnsignedTransaction(message);
      expect(wire).toEqual(Uint8Array.of(2, ...new Uint8Array(128), ...message));
      expect(getTransactionDecoder().decode(wire).messageBytes).toEqual(message);
    }
  });

  it("wraps a v1 message in message-first order with zeroed signature slots", () => {
    const wire = wrapUnsignedTransaction(v1Message);
    expect(wire).toEqual(Uint8Array.of(...v1Message, ...new Uint8Array(128)));
    const decoded = getTransactionDecoder().decode(wire);
    expect(decoded.messageBytes).toEqual(v1Message);
    expect(decoded.signatures).toEqual({ [sender]: null, [receiver]: null });
  });

  it("finds the signature index only among required signer keys", () => {
    for (const message of [legacyMessage, v1Message]) {
      expect(signatureIndex(message, sender)).toBe(0);
      expect(signatureIndex(message, receiver)).toBe(1);
      expect(signatureIndex(message, sponsor)).toBeUndefined();
      expect(signatureIndex(message, "missing")).toBeUndefined();
    }
  });

  it("rejects malformed message bytes", () => {
    expect(() => wrapUnsignedTransaction(Uint8Array.of(129))).toThrow();
  });

  it("extracts the last 64 bytes from an attached message signature or accepts a detached one", () => {
    const signature = new Uint8Array(64).fill(19);
    expect(
      getMessageSignature(Uint8Array.of(...v1Message, ...signature), v1Message.length),
    ).toEqual(signature);
    expect(getMessageSignature(signature, v1Message.length)).toEqual(signature);
    expect(() => getMessageSignature(new Uint8Array(63), v1Message.length)).toThrow();
  });
});

describe("relay responses", () => {
  it("parses a devnet intent and the batch complete refusal", () => {
    expect(parseIntent(intent)).toEqual(intent);
    const refusal = {
      verified: false,
      reason: "BATCH_COMPLETE",
      message: "Run setup for a fresh batch",
    };
    expect(parseIntent(refusal)).toEqual(refusal);
    expect(parseIntent({ verified: false, reason: "BATCH_COMPLETE" })).toEqual({
      verified: false,
      reason: "BATCH_COMPLETE",
    });
  });

  it("parses the relay's explicit expiry refusal", () => {
    const refusal = { verified: false, reason: "INTENT_EXPIRED" };
    expect(parseIntent(refusal)).toEqual(refusal);
  });

  it("binds a loaded intent to the selected role and a required signer key", () => {
    const loaded = parseIntent(intent);
    if (!("intent" in loaded)) throw new Error("Expected an intent");
    expect(() => checkIntentRole(loaded, "sender")).not.toThrow();
    expect(() => checkIntentRole(loaded, "receiver")).toThrow();
    expect(() =>
      checkIntentRole(
        {
          ...loaded,
          expectedAddress: receiver,
          role: "receiver",
          authorizationBase64: encodeBase64(
            messageEncoder.encode({
              version: "legacy",
              header: { ...header, numSignerAccounts: 1, numReadonlySignerAccounts: 0 },
              staticAccounts,
              lifetimeToken,
              instructions: [],
            }),
          ),
        },
        "receiver",
      ),
    ).toThrow();
  });

  it("detects relay refresh by comparing both bytes and fingerprint", () => {
    const loaded = parseIntent(intent);
    if (!("intent" in loaded)) throw new Error("Expected an intent");
    expect(sameAuthorization(loaded, { ...loaded })).toBe(true);
    expect(
      sameAuthorization(loaded, { ...loaded, authorizationBase64: encodeBase64(legacyMessage) }),
    ).toBe(false);
    expect(sameAuthorization(loaded, { ...loaded, authorizationSha256: "a".repeat(64) })).toBe(
      false,
    );
  });

  it("rejects unknown fields in the intent, nested intent, and refusal", () => {
    expect(() => parseIntent({ ...intent, extra: true })).toThrow();
    expect(() => parseIntent({ ...intent, intent: { ...intent.intent, extra: true } })).toThrow();
    expect(() => parseIntent({ verified: false, reason: "BATCH_COMPLETE", extra: true })).toThrow();
  });

  it("rejects malformed intent values and missing fields", () => {
    expect(() => parseIntent({ ...intent, role: "other" })).toThrow();
    expect(() => parseIntent({ ...intent, network: "mainnet" })).toThrow();
    expect(() => parseIntent({ ...intent, authorizationBase64: "!" })).toThrow();
    expect(() => parseIntent({ ...intent, authorizationSha256: "00" })).toThrow();
    expect(() =>
      parseIntent({ ...intent, intent: { ...intent.intent, expirySlot: "9001" } }),
    ).toThrow();
    expect(() =>
      parseIntent({ ...intent, intent: { ...intent.intent, quantityKg: 2000000 } }),
    ).toThrow();
    expect(() => parseIntent({ ...intent, intent: { text: intent.intent.text } })).toThrow();
  });

  it("parses all five relay outcome states, preserving all route checks", () => {
    for (const state of ["waiting", "submitted", "confirmed", "failed", "unknown"]) {
      const response = { ...outcome, state };
      expect(parseOutcome(response)).toEqual(response);
    }
    expect(parseOutcome({ state: "waiting", checks: { sender: {}, receiver: {} } })).toEqual({
      state: "waiting",
      checks: { sender: {}, receiver: {} },
    });
  });

  it("rejects unknown fields at every level of an outcome", () => {
    expect(() => parseOutcome({ ...outcome, extra: true })).toThrow();
    expect(() => parseOutcome({ ...outcome, checks: { ...outcome.checks, extra: {} } })).toThrow();
    expect(() =>
      parseOutcome({
        ...outcome,
        checks: { ...outcome.checks, sender: { ...outcome.checks.sender, extra: {} } },
      }),
    ).toThrow();
    expect(() =>
      parseOutcome({
        ...outcome,
        checks: { ...outcome.checks, sender: { message: { verified: true, extra: true } } },
      }),
    ).toThrow();
  });

  it("rejects wrong outcome types, unknown states, and missing role checks", () => {
    expect(() => parseOutcome({ ...outcome, state: "success" })).toThrow();
    expect(() => parseOutcome({ ...outcome, signature: 1 })).toThrow();
    expect(() => parseOutcome({ ...outcome, error: null })).toThrow();
    expect(() => parseOutcome({ ...outcome, sizeBytes: "1232" })).toThrow();
    expect(() => parseOutcome({ ...outcome, checks: { sender: {} } })).toThrow();
    expect(() =>
      parseOutcome({ ...outcome, checks: { ...outcome.checks, sender: { message: undefined } } }),
    ).toThrow();
    expect(() =>
      parseOutcome({
        ...outcome,
        checks: { ...outcome.checks, sender: { message: { verified: "true" } } },
      }),
    ).toThrow();
    expect(() =>
      parseOutcome({
        ...outcome,
        checks: { ...outcome.checks, sender: { message: { verified: false, reason: 1 } } },
      }),
    ).toThrow();
  });
});

describe("screen copy", () => {
  it("pins all five device states and the account warning", () => {
    expect(copy.connecting).toBe("Connecting…");
    expect(copy.walletRefused).toBe("Wallet refused");
    expect(copy.relayUnreachable).toBe("Run adb reverse tcp:8787 tcp:8787 on the laptop");
    expect(copy.staleIntent).toBe("Intent expired. Reload it.");
    expect(copy.batchComplete).toBe("Ask the operator to run setup");
    expect(copy.walletMismatch).toBe("The authorized address does not match this role.");
  });

  it("shows confirmation only for a confirmed relay outcome", () => {
    expect(outcomeCopy).toEqual({
      waiting: "waiting",
      submitted: "submitted",
      confirmed: "confirmed",
      failed: "failed",
      unknown: "Outcome unknown: check the explorer",
    });
  });

  it("labels verification as a relay yes or no", () => {
    expect(copy.verified(true)).toBe("Verified over exact bytes: yes");
    expect(copy.verified(false)).toBe("Verified over exact bytes: no");
  });
});
