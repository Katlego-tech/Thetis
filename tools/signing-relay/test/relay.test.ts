import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Server } from "node:http";
import { Readable } from "node:stream";
import {
  type Address,
  address,
  generateKeyPairSigner,
  getBase58Decoder,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  getTransactionEncoder,
  lamports,
  type Signature,
  signBytes,
  type TransactionMessageBytes,
} from "@solana/kit";
import { FailedTransactionMetadata, LiteSVM } from "litesvm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runRefusalChecks } from "../src/attacks.ts";
import { createRelay, listen } from "../src/relay.ts";
import { setup } from "../src/setup.ts";
import { ChainTransactionError, type ChainTransport } from "../src/transport.ts";

const root = new URL("../../../", import.meta.url);
const program = address("EH7cQ4xmoJ92v2y1JW1xHwVQgtCNvkkVka3jiK1ByQnb");
const fixtures = [
  [
    address("EdSigVfK1DkeMrjFNDMjwfQaJPhPTtX7jW8uPv3oKEgN"),
    "ed25519_signer.so",
    "4824c901ee53e6658024a6cc89aec92e8d29608f315f835a640e11039637c80b",
  ],
  [
    address("ExecxgyHYsAXB4c5dZodV1zJZ9hqfsDCYkRDRATrpkFR"),
    "message_executor.so",
    "276692a010a2f04aa4d540cf8c0f0f74d64d821d72f826f9964782ec2d190344",
  ],
  [
    address("Noncediea1fH12usShuQAz28UhgAeuE5Maf32LsMUQB"),
    "nonce.so",
    "095be5b6bcdf10003db710558a765221dd442a3a13aa7d62747d82871f60d3f7",
  ],
] as const;

async function fixture(rebuiltProgram = false) {
  const svm = new LiteSVM();
  const workspaceProgram = await readFile(new URL("target/deploy/signing_spike.so", root));
  // An ELF with trailing padding still runs, but has a different digest.
  svm.addProgram(
    program,
    rebuiltProgram ? Buffer.concat([workspaceProgram, Buffer.of(0)]) : workspaceProgram,
  );
  for (const [id, path, digest] of fixtures) {
    const bytes = await readFile(new URL(`programs/signing-spike/tests/fixtures/${path}`, root));
    expect(createHash("sha256").update(bytes).digest("hex"), path).toBe(digest);
    svm.addProgram(id, bytes);
  }
  const [sponsor, sender, receiver] = await Promise.all([
    generateKeyPairSigner(),
    generateKeyPairSigner(),
    generateKeyPairSigner(),
  ]);
  svm.airdrop(sponsor.address, lamports(1_000_000_000n));
  for (const wallet of [sender, receiver]) svm.airdrop(wallet.address, lamports(1_000_000n));

  const sent = new Set<Signature>();
  let releaseConfirmation: Promise<void> | undefined;
  let releaseAcceptance: Promise<void> | undefined;
  const submit = vi.fn<ChainTransport["send"]>(async (transaction) => {
    await releaseAcceptance;
    const result = svm.sendTransaction(transaction);
    if (result instanceof FailedTransactionMetadata) {
      throw new ChainTransactionError(result.err().toString(), result.meta().logs());
    }
    const signature = getSignatureFromTransaction(transaction);
    sent.add(signature);
    return signature;
  });
  const signatureStatus = vi.fn(
    async (signature: Signature): Promise<"confirmed" | "failed" | null> =>
      sent.has(signature) ? "confirmed" : null,
  );
  const blockHeight = vi.fn(async () => 1001n);
  const getGenesisHash = vi.fn(async () => "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG");
  const transport = {
    getGenesisHash,
    getSignatureStatus: signatureStatus,
    getBlockHeight: blockHeight,
    async getSlot() {
      return svm.getClock().slot;
    },
    async waitForSlot(slot: bigint) {
      svm.warpToSlot(slot + 1n);
      // LiteSVM warps Clock only. Keep SlotHashes in step for later lookup-table creation.
      const [latest] = svm.getSlotHashes();
      if (!latest) throw new Error("LiteSVM has no slot hash");
      latest.slot = svm.getClock().slot;
      latest.hash = svm.latestBlockhash();
      svm.setSlotHashes([latest]);
    },
    async getAccount(key: Address) {
      const account = svm.getAccount(key);
      return account.exists
        ? { owner: account.programAddress, data: Buffer.from(account.data) }
        : null;
    },
    async getRent(space: number) {
      return svm.minimumBalanceForRentExemption(BigInt(space));
    },
    async getLatestBlockhash() {
      svm.expireBlockhash();
      return { blockhash: svm.latestBlockhash(), lastValidBlockHeight: 1000n };
    },
    send: submit,
    async confirm(signature: Signature) {
      if (!sent.has(signature)) throw new Error("Unknown transaction");
      await releaseConfirmation;
    },
  };
  const state = await setup(transport, sponsor, program, sender.address, receiver.address);
  const relay = await createRelay(transport, sponsor, state, vi.fn());
  const intent = await relay.intent("sender");
  if (!("authorizationBase64" in intent)) throw new Error("Initial intent was refused");
  const authorization = Buffer.from(intent.authorizationBase64, "base64");

  async function messageRequest(role: "sender" | "receiver", bytes = authorization) {
    const signer = role === "sender" ? sender : receiver;
    return {
      role,
      route: "message",
      address: signer.address,
      signatureBase58: getBase58Decoder().decode(await signBytes(signer.keyPair.privateKey, bytes)),
    };
  }

  async function transactionRequest(
    indexAddress?: Address,
    bytes = authorization,
    role: "sender" | "receiver" = "receiver",
  ) {
    const signer = role === "sender" ? sender : receiver;
    const message = getCompiledTransactionMessageDecoder().decode(bytes);
    const signerKeys = message.staticAccounts.slice(0, message.header.numSignerAccounts);
    const signature = await signBytes(signer.keyPair.privateKey, bytes);
    const signatures = Object.fromEntries(
      signerKeys.map((key) => [key, key === (indexAddress ?? signer.address) ? signature : null]),
    );
    const signedTransactionBase64 = Buffer.from(
      getTransactionEncoder().encode({
        messageBytes: bytes as unknown as TransactionMessageBytes,
        signatures,
      }),
    ).toString("base64");
    return {
      role,
      route: "transaction",
      address: signer.address,
      signedTransactionBase64,
    };
  }

  return {
    svm,
    sponsor,
    sender,
    receiver,
    transport,
    submit,
    signatureStatus,
    blockHeight,
    getGenesisHash,
    state,
    relay,
    authorization,
    messageRequest,
    transactionRequest,
    holdConfirmation(pending: Promise<void>) {
      releaseConfirmation = pending;
    },
    holdAcceptance(pending: Promise<void>) {
      releaseAcceptance = pending;
    },
  };
}

it("loads a rebuilt workspace program while verifying the vendored fixtures", async () => {
  const f = await fixture(true);
  expect(f.svm.getAccount(f.state.batch).exists).toBe(true);
});

describe("signing relay against LiteSVM", () => {
  let f: Awaited<ReturnType<typeof fixture>>;

  beforeEach(async () => {
    f = await fixture();
  });

  it("registers both parties, opens the batch, initializes the nonce and activates the lookup table", async () => {
    const batch = f.svm.getAccount(f.state.batch);
    expect(batch.exists).toBe(true);
    if (!batch.exists) throw new Error("Batch is missing");
    const bytes = Buffer.from(batch.data);
    expect(bytes.readBigUInt64LE(88)).toBe(2_000_000n);
    expect(bytes.readBigUInt64LE(96)).toBe(0n);
    expect(bytes[104]).toBe(0);
    for (const key of [
      f.state.sender.party,
      f.state.receiver.party,
      f.state.nonce,
      f.state.lookupTable,
    ]) {
      expect(f.svm.getAccount(key).exists).toBe(true);
    }
    expect(f.submit).toHaveBeenCalled();
  });

  it("serves identical authorization bytes and the exact decoded intent text for both roles", async () => {
    const slot = Number(f.svm.getClock().slot) + 9_000;
    const sender = await f.relay.dispatch("GET", "/intent?role=sender");
    const receiver = await f.relay.dispatch("GET", "/intent?role=receiver");
    const intent = {
      text: `Hand over 2,000.000 t of CR-0001 from Kopano Stockyard Custody to Mosela Haulage. Expires at slot ${slot}. Synthetic test data.`,
      batchId: f.state.batchId,
      quantityKg: "2000000",
      from: "Kopano Stockyard Custody",
      to: "Mosela Haulage",
      expirySlot: slot,
      expectedSequence: 0,
    };
    const shared = {
      authorizationBase64: f.authorization.toString("base64"),
      authorizationSha256: createHash("sha256").update(f.authorization).digest("hex"),
      intent,
      network: "devnet",
    };
    expect(sender).toEqual({ ...shared, role: "sender", expectedAddress: f.sender.address });
    expect(receiver).toEqual({ ...shared, role: "receiver", expectedAddress: f.receiver.address });
  });

  it("accepts both routes, confirms only after confirmation, and charges only the sponsor for the handover", async () => {
    const keys = [f.sponsor.address, f.sender.address, f.receiver.address];
    const before = keys.map((key) => f.svm.getBalance(key));
    let confirm: (() => void) | undefined;
    const confirmation = new Promise<void>((resolve) => {
      confirm = resolve;
    });
    f.holdConfirmation(confirmation);
    expect(await f.relay.dispatch("GET", "/outcome")).toEqual({
      state: "waiting",
      checks: { sender: {}, receiver: {} },
    });
    const senderRequest = await f.messageRequest("sender");
    expect(await f.relay.dispatch("POST", "/signature", senderRequest)).toEqual({ verified: true });
    expect(await f.relay.dispatch("POST", "/signature", await f.transactionRequest())).toEqual({
      verified: true,
    });
    await vi.waitFor(async () => {
      expect(await f.relay.dispatch("GET", "/outcome")).toMatchObject({
        state: "submitted",
        signature: expect.any(String),
      });
    });
    const relayTx = f.submit.mock.lastCall?.[0];
    if (!relayTx) throw new Error("No relay transaction");
    expect(Object.keys(relayTx.signatures)).toEqual([f.sponsor.address]);
    const sizeBytes = getTransactionEncoder().encode(relayTx).length;
    console.log(`Signed relay size: ${sizeBytes} bytes`);
    expect(sizeBytes).toBeLessThanOrEqual(1232);
    expect(await f.relay.dispatch("GET", "/outcome")).toEqual({
      state: "submitted",
      signature: getSignatureFromTransaction(relayTx),
      sizeBytes,
      checks: {
        sender: { message: { verified: true } },
        receiver: { transaction: { verified: true } },
      },
    });
    confirm?.();
    await vi.waitFor(async () => {
      expect(await f.relay.dispatch("GET", "/outcome")).toEqual({
        state: "confirmed",
        signature: getSignatureFromTransaction(relayTx),
        sizeBytes,
        checks: {
          sender: { message: { verified: true } },
          receiver: { transaction: { verified: true } },
        },
      });
    });
    const batch = f.svm.getAccount(f.state.batch);
    if (!batch.exists) throw new Error("Batch is missing");
    expect(Buffer.from(batch.data).readBigUInt64LE(96)).toBe(1n);
    expect(batch.data[104]).toBe(1);
    expect(f.svm.getBalance(f.sponsor.address)).toBe((before[0] ?? 0n) - 5_000n);
    expect(keys.slice(1).map((key) => f.svm.getBalance(key))).toEqual(before.slice(1));
    expect(await f.relay.dispatch("POST", "/signature", senderRequest)).toEqual({
      verified: true,
    });
  });

  it("binds only to IPv4 loopback and returns JSON through the HTTP handler", async () => {
    const bind = vi.spyOn(Server.prototype, "listen").mockReturnThis();
    try {
      const server = listen(f.relay, 8787);
      expect(bind).toHaveBeenCalledExactlyOnceWith(8787, "127.0.0.1");
      const request = Object.assign(
        Readable.from([JSON.stringify(await f.messageRequest("sender"))]),
        {
          method: "POST",
          url: "/signature",
        },
      );
      const writeHead = vi.fn();
      const json = await new Promise<string>((end) =>
        server.emit("request", request, { writeHead, end }),
      );
      expect(writeHead).toHaveBeenCalledWith(200, { "content-type": "application/json" });
      expect(JSON.parse(json)).toEqual({ verified: true });
    } finally {
      bind.mockRestore();
    }
  });

  it("verifies all four wallet routes during and after submission and sends once", async () => {
    let accept: (() => void) | undefined;
    f.holdAcceptance(
      new Promise<void>((resolve) => {
        accept = resolve;
      }),
    );
    const initialSends = f.submit.mock.calls.length;
    const post = (body: unknown) => f.relay.dispatch("POST", "/signature", body);
    expect(await post(await f.messageRequest("sender"))).toEqual({ verified: true });
    expect(await post(await f.transactionRequest(undefined, f.authorization, "sender"))).toEqual({
      verified: true,
    });
    expect(f.submit).toHaveBeenCalledTimes(initialSends);
    expect(await post(await f.messageRequest("receiver"))).toEqual({ verified: true });
    await vi.waitFor(() => expect(f.submit).toHaveBeenCalledTimes(initialSends + 1));
    const wrongIndex = await f.transactionRequest(f.sender.address);
    expect(await post(wrongIndex)).toEqual({ verified: false, reason: "BAD_SIGNATURE" });
    expect(await f.relay.dispatch("GET", "/outcome")).toMatchObject({
      state: "waiting",
      checks: {
        sender: { message: { verified: true }, transaction: { verified: true } },
        receiver: {
          message: { verified: true },
          transaction: { verified: false, reason: "BAD_SIGNATURE" },
        },
      },
    });
    accept?.();
    await vi.waitFor(async () =>
      expect(await f.relay.dispatch("GET", "/outcome")).toMatchObject({ state: "confirmed" }),
    );
    expect(await post(await f.transactionRequest())).toEqual({ verified: true });
    expect(await f.relay.dispatch("GET", "/outcome")).toMatchObject({
      checks: {
        sender: { message: { verified: true }, transaction: { verified: true } },
        receiver: { message: { verified: true }, transaction: { verified: true } },
      },
    });
    expect(f.submit).toHaveBeenCalledTimes(initialSends + 1);
  });

  it("publishes the signed transaction ID before send and reconciles a lost send response", async () => {
    const send = f.submit.getMockImplementation();
    if (!send) throw new Error("Missing test transport send");
    let observedBeforeSend: unknown;
    f.submit.mockImplementationOnce(async (transaction) => {
      observedBeforeSend = await f.relay.dispatch("GET", "/outcome");
      await send(transaction);
      throw new Error("Send response lost");
    });
    f.signatureStatus.mockRejectedValueOnce(new Error("Status request timed out"));
    f.blockHeight.mockResolvedValueOnce(1000n);
    await f.relay.dispatch("POST", "/signature", await f.messageRequest("sender"));
    await f.relay.dispatch("POST", "/signature", await f.transactionRequest());
    await vi.waitFor(async () => {
      const tx = f.submit.mock.lastCall?.[0];
      if (!tx) throw new Error("Missing transaction");
      const signature = getSignatureFromTransaction(tx);
      expect(observedBeforeSend).toMatchObject({ state: "waiting", signature });
      expect(f.signatureStatus.mock.calls).toEqual([[signature], [signature]]);
      expect(await f.relay.dispatch("GET", "/outcome")).toMatchObject({
        state: "confirmed",
        signature,
      });
    });
  });

  it("reports unknown over HTTP when confirmation and post-expiry status are inconclusive", async () => {
    vi.spyOn(f.transport, "confirm").mockRejectedValueOnce(new Error("Confirmation unavailable"));
    f.signatureStatus.mockResolvedValue(null);
    await f.relay.dispatch("POST", "/signature", await f.messageRequest("sender"));
    await f.relay.dispatch("POST", "/signature", await f.transactionRequest());
    const bind = vi.spyOn(Server.prototype, "listen").mockReturnThis();
    try {
      const server = listen(f.relay, 8787);
      await vi.waitFor(async () => {
        const json = await new Promise<string>((end) =>
          server.emit("request", { method: "GET", url: "/outcome" }, { writeHead: vi.fn(), end }),
        );
        expect(JSON.parse(json)).toMatchObject({
          state: "unknown",
          signature: expect.any(String),
          error: "Confirmation unavailable",
        });
      });
      expect(f.blockHeight).toHaveBeenCalled();
      expect(f.signatureStatus).toHaveBeenCalledTimes(2);
    } finally {
      bind.mockRestore();
    }
  });

  it("reports failed when reconciliation observes a confirmed on-chain error", async () => {
    f.submit.mockRejectedValueOnce(new Error("Send timed out"));
    f.signatureStatus.mockResolvedValue("failed");
    await f.relay.dispatch("POST", "/signature", await f.messageRequest("sender"));
    await f.relay.dispatch("POST", "/signature", await f.transactionRequest());
    await vi.waitFor(async () =>
      expect(await f.relay.dispatch("GET", "/outcome")).toMatchObject({
        state: "failed",
        signature: expect.any(String),
      }),
    );
  });

  it("refreshes expired intent with the current sequence and discards old checks and signatures", async () => {
    const initial = await f.relay.intent("sender");
    if (!("intent" in initial)) throw new Error("Initial intent was refused");
    const oldSignature = await f.messageRequest("sender");
    await f.relay.dispatch("POST", "/signature", oldSignature);
    const batch = f.svm.getAccount(f.state.batch);
    if (!batch.exists) throw new Error("Batch is missing");
    const data = Buffer.from(batch.data);
    data.writeBigUInt64LE(4n, 96);
    f.svm.setAccount({ ...batch, data });
    f.svm.warpToSlot(BigInt(initial.intent.expirySlot));
    expect(await f.relay.intent("sender")).toEqual(initial);
    f.svm.warpToSlot(BigInt(initial.intent.expirySlot) + 1n);
    const [fresh, other] = await Promise.all([
      f.relay.intent("sender"),
      f.relay.intent("receiver"),
    ]);
    if (!("authorizationBase64" in fresh) || !("authorizationBase64" in other))
      throw new Error("Refreshed intent was refused");
    expect(fresh.authorizationBase64).not.toBe(initial.authorizationBase64);
    expect(fresh.authorizationBase64).toBe(other.authorizationBase64);
    expect(fresh.intent).toMatchObject({
      expectedSequence: 4,
      expirySlot: initial.intent.expirySlot + 9001,
    });
    expect(await f.relay.dispatch("GET", "/outcome")).toEqual({
      state: "waiting",
      checks: { sender: {}, receiver: {} },
    });
    const sends = f.submit.mock.calls.length;
    expect(await f.relay.dispatch("POST", "/signature", oldSignature)).toEqual({
      verified: false,
      reason: "BAD_SIGNATURE",
    });
    const receiver = await f.messageRequest(
      "receiver",
      Buffer.from(fresh.authorizationBase64, "base64"),
    );
    expect(await f.relay.dispatch("POST", "/signature", receiver)).toEqual({ verified: true });
    expect(f.submit).toHaveBeenCalledTimes(sends);
  });

  it("refuses to serve intents for an on-chain completed batch", async () => {
    await f.relay.dispatch("POST", "/signature", await f.messageRequest("sender"));
    await f.relay.dispatch("POST", "/signature", await f.transactionRequest());
    await vi.waitFor(async () =>
      expect(await f.relay.dispatch("GET", "/outcome")).toMatchObject({ state: "confirmed" }),
    );
    const restarted = await createRelay(f.transport, f.sponsor, f.state, vi.fn());
    for (const relay of [f.relay, restarted]) {
      expect(await relay.dispatch("GET", "/intent?role=sender")).toMatchObject({
        verified: false,
        reason: "BATCH_COMPLETE",
        message: expect.stringMatching(/run .*setup.*fresh batch/i),
      });
    }
  });

  it("refuses setup and serve on a transport outside devnet before account access", async () => {
    f.getGenesisHash.mockResolvedValue("other-cluster");
    const account = vi.spyOn(f.transport, "getAccount");
    const error = /devnet.*genesis hash/i;
    await expect(
      setup(f.transport, f.sponsor, program, f.sender.address, f.receiver.address),
    ).rejects.toThrow(error);
    await expect(createRelay(f.transport, f.sponsor, f.state)).rejects.toThrow(error);
    expect(account).not.toHaveBeenCalled();
  });

  it("refuses WRONG_ADDRESS", async () => {
    const request = await f.messageRequest("receiver");
    expect(await f.relay.dispatch("POST", "/signature", { ...request, role: "sender" })).toEqual({
      verified: false,
      reason: "WRONG_ADDRESS",
    });
  });

  it("refuses BAD_SIGNATURE when one authorization byte changed", async () => {
    const altered = Buffer.from(f.authorization);
    altered.writeUInt8(altered.readUInt8(altered.length - 1) ^ 1, altered.length - 1);
    expect(
      await f.relay.dispatch("POST", "/signature", await f.messageRequest("sender", altered)),
    ).toEqual({
      verified: false,
      reason: "BAD_SIGNATURE",
    });
  });

  it("refuses a valid signature at the wrong transaction index", async () => {
    expect(
      await f.relay.dispatch("POST", "/signature", await f.transactionRequest(f.sender.address)),
    ).toEqual({
      verified: false,
      reason: "BAD_SIGNATURE",
    });
  });

  it("refuses UNKNOWN_ROLE and leaves the outcome waiting after bad requests", async () => {
    expect(await f.relay.dispatch("GET", "/intent?role=other")).toEqual({
      verified: false,
      reason: "UNKNOWN_ROLE",
    });
    expect(await f.relay.dispatch("POST", "/signature", { role: "other" })).toEqual({
      verified: false,
      reason: "UNKNOWN_ROLE",
    });
    expect(await f.relay.dispatch("GET", "/outcome")).toEqual({
      state: "waiting",
      checks: { sender: {}, receiver: {} },
    });
  });

  it("checks all seven devnet refusal cases against the real programs without changing the stored batch", async () => {
    const before = f.svm.getAccount(f.state.batch);
    const report = vi.fn();
    await runRefusalChecks(f.transport, f.sponsor, f.state, report);
    expect(report.mock.calls.flat()).toEqual([
      "D32-devnet replay: refused (NonceMismatch)",
      "D32-devnet only sender: refused (WrongSigner)",
      "D32-devnet wrong signer: refused (WrongSigner)",
      "D32-devnet altered byte: refused (InvalidSignature)",
      "D32-devnet swapped signatures: refused (InvalidSignature)",
      "D32-devnet expired: refused (Expired)",
      "D32-devnet stale sequence: refused (StaleSequence)",
    ]);
    expect(f.svm.getAccount(f.state.batch)).toEqual(before);
  });
});
