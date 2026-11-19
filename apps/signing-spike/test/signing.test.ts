import { afterEach, describe, expect, it, vi } from "vitest";
import { copy, outcomeCopy, refusalCopy } from "../src/lib/copy";
import { decodeBase58, decodeBase64, encodeBase58, encodeBase64 } from "../src/lib/encoding";
import {
  checkIntentRole,
  type Intent,
  parseCheck,
  parseIntent,
  parseOutcome,
  sameIntent,
} from "../src/lib/relay";
import { getMessageSignature, matchesSignedMessage } from "../src/lib/wire";
import { getIntent, postSignature } from "../src/relay-client";

const sender = encodeBase58(new Uint8Array(32).fill(1));
const receiver = encodeBase58(new Uint8Array(32).fill(2));
const messageText = "Thetis authorisation v1\nTest network only. Synthetic data.";
const message = Buffer.from(messageText);
const intent: Intent = {
  role: "sender",
  expectedAddress: sender,
  messageBase64: encodeBase64(message),
  messageText,
  messageSha256: "0".repeat(64),
  validUntil: "1795098725",
  validUntilText: "2026-11-19 16:32:05 SAST",
  expectedSequence: "0",
  network: "devnet",
};
const outcome = {
  activeMessageSha256: intent.messageSha256,
  state: "unknown",
  signature: "aDevnetSignature",
  sizeBytes: 1232,
  checks: { sender: { verified: true }, receiver: { verified: false, reason: "BAD_SIGNATURE" } },
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
  it("distinguishes attached, detached, short and altered payloads", () => {
    const signature = new Uint8Array(64).fill(19);
    const attached = Uint8Array.of(...message, ...signature);
    const altered = Uint8Array.of(42, ...message, ...signature);
    expect(getMessageSignature(attached)).toEqual(signature);
    expect(getMessageSignature(signature)).toEqual(signature);
    expect(getMessageSignature(new Uint8Array(63))).toBeUndefined();
    expect(matchesSignedMessage(attached, message)).toBe(true);
    expect(matchesSignedMessage(signature, message)).toBe(true);
    expect(matchesSignedMessage(altered, message)).toBe(false);
  });
});

describe("relay responses", () => {
  it.each([
    ["UNKNOWN_ROLE", 400],
    ["BATCH_COMPLETE", 409],
  ] as const)("parses %s from /intent at HTTP %s", (reason, status) => {
    const refusal = { verified: false, reason };
    expect(parseIntent(refusal, status)).toEqual(refusal);
    expect(() => parseIntent(refusal, 200)).toThrow();
    expect(() => parseIntent(refusal, 503)).toThrow();
  });

  it.each(["WRONG_ADDRESS", "BAD_SIGNATURE", "UNKNOWN_ROLE", "ALREADY_SUBMITTED", "STALE_INTENT"])(
    "parses %s from /signature at HTTP 200",
    (reason) => {
      const refusal = { verified: false, reason };
      expect(parseCheck(refusal, 200)).toEqual(refusal);
      expect(() => parseCheck(refusal, 503)).toThrow();
    },
  );

  it("parses BAD_SIGNATURE from /signature at HTTP 400 for malformed requests", () => {
    const refusal = { verified: false, reason: "BAD_SIGNATURE" };
    expect(parseCheck(refusal, 400)).toEqual(refusal);
    expect(() => parseCheck({ ...refusal, reason: "WRONG_ADDRESS" }, 400)).toThrow();
    expect(() => parseCheck({ verified: true }, 400)).toThrow();
  });

  it("parses CHAIN_UNAVAILABLE only at HTTP 503 and keeps the loaded authorization eligible for retry", () => {
    const refusal = { verified: false, reason: "CHAIN_UNAVAILABLE" } as const;
    expect(parseIntent(refusal, 503)).toEqual(refusal);
    expect(parseCheck(refusal, 503)).toEqual(refusal);
    expect(() => parseIntent(refusal, 200)).toThrow();
    expect(() => parseCheck(refusal, 200)).toThrow();
    expect(() => parseIntent(intent, 503)).toThrow();
  });

  it.each(["WRONG_ADDRESS", "BAD_SIGNATURE"])(
    "parses %s as a recorded route check in /outcome",
    (reason) => {
      const response = {
        ...outcome,
        checks: { ...outcome.checks, sender: { verified: false, reason } },
      };
      expect(parseOutcome(response)).toEqual(response);
    },
  );

  it("rejects unknown codes, refusals on the wrong route, and inconsistent verification results", () => {
    for (const reason of ["UNRECOGNIZED", "WRONG_ADDRESS", "BAD_SIGNATURE", "ALREADY_SUBMITTED"]) {
      expect(() => parseIntent({ verified: false, reason })).toThrow();
    }
    for (const reason of ["UNRECOGNIZED", "BATCH_COMPLETE"]) {
      expect(() => parseCheck({ verified: false, reason })).toThrow();
    }
    expect(() => parseCheck({ verified: true, reason: "BAD_SIGNATURE" })).toThrow();
    expect(() => parseCheck({ verified: false })).toThrow();
    for (const reason of ["UNRECOGNIZED", "CHAIN_UNAVAILABLE", "ALREADY_SUBMITTED"]) {
      expect(() =>
        parseOutcome({
          ...outcome,
          checks: { ...outcome.checks, sender: { verified: false, reason } },
        }),
      ).toThrow();
    }
  });

  it("parses a devnet intent and enforces the requested role", () => {
    expect(parseIntent(intent)).toEqual(intent);
    expect(() => checkIntentRole(intent, "sender")).not.toThrow();
    expect(() =>
      checkIntentRole({ ...intent, role: "receiver", expectedAddress: receiver }, "receiver"),
    ).not.toThrow();
    expect(() => checkIntentRole(intent, "receiver")).toThrow();
  });

  it("detects a refresh or address change", () => {
    expect(sameIntent(intent, { ...intent })).toBe(true);
    expect(sameIntent(intent, { ...intent, messageBase64: encodeBase64(Uint8Array.of(1)) })).toBe(
      false,
    );
    expect(sameIntent(intent, { ...intent, messageSha256: "a".repeat(64) })).toBe(false);
    expect(sameIntent(intent, { ...intent, expectedAddress: receiver })).toBe(false);
  });

  it("rejects unknown fields in intents, refusals and signature checks", () => {
    expect(() => parseIntent({ ...intent, extra: true })).toThrow();
    expect(() =>
      parseIntent({ verified: false, reason: "BATCH_COMPLETE", extra: true }, 409),
    ).toThrow();
    expect(() => parseCheck({ verified: false, reason: "STALE_INTENT", extra: true })).toThrow();
  });

  it("rejects malformed intent values, missing fields and display text that differs from signed bytes", () => {
    for (const override of [
      { role: "other" },
      { network: "mainnet" },
      { expectedAddress: "!" },
      { messageBase64: "!" },
      { messageSha256: "00" },
      { validUntil: 1795098725 },
      { expectedSequence: 0 },
      { messageText: undefined },
      { messageText: "Different text" },
    ])
      expect(() => parseIntent({ ...intent, ...override })).toThrow();
  });

  it("parses all five relay outcome states, preserving all route checks", () => {
    for (const state of ["waiting", "submitted", "confirmed", "failed", "unknown"]) {
      const response = { ...outcome, state };
      expect(parseOutcome(response)).toEqual(response);
    }
  });

  it("requires and validates the active digest even while the relay is waiting", () => {
    const waiting = { state: "waiting", checks: {} };
    const response = { ...waiting, activeMessageSha256: intent.messageSha256 };
    expect(parseOutcome(response)).toEqual(response);
    expect(() => parseOutcome(waiting)).toThrow("Invalid /outcome response");
    expect(() => parseOutcome({ ...response, activeMessageSha256: "00" })).toThrow();
  });

  it("preserves the optional authorization digest and rejects an invalid digest", () => {
    const submitted = { ...outcome, submittedMessageSha256: intent.messageSha256 };
    expect(parseOutcome(submitted)).toEqual(submitted);
    expect(() => parseOutcome({ ...submitted, submittedMessageSha256: "00" })).toThrow();
    expect(() => parseOutcome({ ...submitted, submittedMessageSha256: "g".repeat(64) })).toThrow();
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
        checks: { ...outcome.checks, sender: { verified: true, extra: true } },
      }),
    ).toThrow();
  });

  it("rejects wrong outcome types, unknown states, and malformed role checks", () => {
    expect(() => parseOutcome({ ...outcome, state: "success" })).toThrow();
    expect(() => parseOutcome({ ...outcome, signature: 1 })).toThrow();
    expect(() => parseOutcome({ ...outcome, error: null })).toThrow();
    expect(() => parseOutcome({ ...outcome, sizeBytes: "1232" })).toThrow();
    expect(() => parseOutcome({ ...outcome, checks: undefined })).toThrow();
    expect(() =>
      parseOutcome({ ...outcome, checks: { ...outcome.checks, sender: undefined } }),
    ).toThrow();
    expect(() =>
      parseOutcome({
        ...outcome,
        checks: { ...outcome.checks, sender: { verified: "true" } },
      }),
    ).toThrow();
    expect(() =>
      parseOutcome({
        ...outcome,
        checks: { ...outcome.checks, sender: { verified: false, reason: 1 } },
      }),
    ).toThrow();
  });
});

describe("relay HTTP client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("passes HTTP 503 CHAIN_UNAVAILABLE through for loading and submitting", async () => {
    const refusal = { verified: false, reason: "CHAIN_UNAVAILABLE" };
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json(refusal, { status: 503 }))),
    );
    await expect(getIntent("sender")).resolves.toEqual(refusal);
    await expect(
      postSignature({
        role: "sender",
        address: sender,
        messageSha256: intent.messageSha256,
        signatureBase58: "1",
      }),
    ).resolves.toEqual(refusal);
  });
});

describe("screen copy", () => {
  it.each([
    ["WRONG_ADDRESS", "The submitted address does not match this role."],
    ["BAD_SIGNATURE", "The relay could not verify the signature."],
    ["UNKNOWN_ROLE", "The relay did not recognize this role."],
    ["ALREADY_SUBMITTED", "The handover was already submitted."],
    ["BATCH_COMPLETE", "This batch is complete. Ask the operator for a fresh batch."],
    ["CHAIN_UNAVAILABLE", "The relay can't reach devnet right now. Try again."],
  ] as const)("uses the %s refusal copy", (reason, message) => {
    expect(refusalCopy[reason]).toBe(message);
  });

  it("pins all five device states and the account warning", () => {
    expect(copy.connecting).toBe("Connecting…");
    expect(copy.walletRefused).toBe("Wallet refused");
    expect(copy.relayUnreachable).toBe("Run adb reverse tcp:8787 tcp:8787 on the laptop");
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
    expect(copy.verified(true)).toBe("Verified over exact text: yes");
    expect(copy.verified(false)).toBe("Verified over exact text: no");
  });
});
