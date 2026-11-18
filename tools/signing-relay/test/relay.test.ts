import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
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
import { requireCompleteState } from "../src/state.ts";
import { ChainTransactionError, type ChainTransport, rpcTransport } from "../src/transport.ts";
import { SLOT_HASHES } from "../src/wire.ts";

// Route the promise-based delay through the global timer so Vitest can advance it.
vi.mock("node:timers/promises", () => ({
  setTimeout: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
}));

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

  async function messageRequest(
    role: "sender" | "receiver",
    bytes = authorization,
    digest = bytes,
  ) {
    const signer = role === "sender" ? sender : receiver;
    return {
      role,
      route: "message",
      authorizationSha256: createHash("sha256").update(digest).digest("hex"),
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
      authorizationSha256: createHash("sha256").update(bytes).digest("hex"),
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

  it("checkpoints batch, nonce and table confirmations and resumes setup from disk after interruption", async () => {
    const directory = await mkdtemp(join(tmpdir(), "thetis-signing-setup-"));
    const path = join(directory, "state.json");
    const readCheckpoint = async () => JSON.parse(await readFile(path, "utf8"));
    const run = () =>
      setup(f.transport, f.sponsor, program, f.sender.address, f.receiver.address, [], path);
    const sends = f.submit.mock.calls.length;
    const rent = vi.spyOn(f.transport, "getRent");
    const getAccount = f.transport.getAccount;
    const account = vi.spyOn(f.transport, "getAccount");
    try {
      rent.mockRejectedValueOnce(new Error("Rent unavailable"));
      await expect(run()).rejects.toThrow("Rent unavailable");
      const batchCheckpoint = await readCheckpoint();
      expect(batchCheckpoint).toMatchObject({
        complete: false,
        batch: expect.any(String),
        sender: f.state.sender,
        receiver: f.state.receiver,
      });
      expect(batchCheckpoint).not.toHaveProperty("nonce");
      expect(batchCheckpoint).not.toHaveProperty("pending");
      expect(f.submit).toHaveBeenCalledTimes(sends + 1);

      account.mockImplementation(async (key) => {
        if (key === SLOT_HASHES) throw new Error("Slot hashes unavailable");
        return getAccount(key);
      });
      await expect(run()).rejects.toThrow("Slot hashes unavailable");
      const nonceCheckpoint = await readCheckpoint();
      expect(nonceCheckpoint).toMatchObject({ ...batchCheckpoint, nonce: expect.any(String) });
      expect(nonceCheckpoint).not.toHaveProperty("lookupTable");
      expect(nonceCheckpoint).not.toHaveProperty("pending");
      expect(f.submit).toHaveBeenCalledTimes(sends + 2);
      expect(account).toHaveBeenCalledWith(batchCheckpoint.batch);
      account.mockImplementation(getAccount);

      const wait = vi
        .spyOn(f.transport, "waitForSlot")
        .mockRejectedValueOnce(new Error("Slot unavailable"));
      await expect(run()).rejects.toThrow("Slot unavailable");
      const tableCheckpoint = await readCheckpoint();
      expect(tableCheckpoint).toMatchObject({
        ...nonceCheckpoint,
        lookupTable: expect.any(String),
      });
      expect(tableCheckpoint).not.toHaveProperty("pending");
      expect(f.submit).toHaveBeenCalledTimes(sends + 3);
      expect(account).toHaveBeenCalledWith(batchCheckpoint.batch);
      await expect(requireCompleteState(path)).rejects.toThrow(/setup to complete/);

      account.mockClear();
      const state = await run();
      expect(account).toHaveBeenCalledWith(tableCheckpoint.nonce);
      expect(account).toHaveBeenCalledWith(tableCheckpoint.lookupTable);
      expect(wait).toHaveBeenCalledTimes(2);
      expect(f.submit).toHaveBeenCalledTimes(sends + 3);
      expect(state).toMatchObject({
        batch: batchCheckpoint.batch,
        nonce: tableCheckpoint.nonce,
        lookupTable: tableCheckpoint.lookupTable,
      });
      expect(await readCheckpoint()).toMatchObject({ ...state, complete: true });
      await expect(requireCompleteState(path)).resolves.toMatchObject(state);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reconciles an on-chain nonce when its setup confirmation response is lost", async () => {
    const directory = await mkdtemp(join(tmpdir(), "thetis-signing-nonce-"));
    const path = join(directory, "state.json");
    const run = () =>
      setup(f.transport, f.sponsor, program, f.sender.address, f.receiver.address, [], path);
    const sends = f.submit.mock.calls.length;
    const originalConfirm = f.transport.confirm;
    vi.spyOn(f.transport, "confirm")
      .mockImplementationOnce(originalConfirm)
      .mockRejectedValueOnce(new Error("Confirmation lost"));
    try {
      await expect(run()).rejects.toThrow("Confirmation lost");
      const checkpoint = JSON.parse(await readFile(path, "utf8"));
      expect(checkpoint).toMatchObject({
        complete: false,
        nonce: expect.any(String),
        pending: { signature: expect.any(String) },
      });
      expect(f.svm.getAccount(checkpoint.nonce).exists).toBe(true);
      const state = await run();
      expect(state.nonce).toBe(checkpoint.nonce);
      expect(f.submit).toHaveBeenCalledTimes(sends + 3);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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
    const senderRequest = await f.messageRequest("sender");
    const authorizationSha256 = senderRequest.authorizationSha256;
    expect(await f.relay.dispatch("GET", "/outcome")).toEqual({
      state: "waiting",
      activeAuthorizationSha256: authorizationSha256,
      checks: { sender: {}, receiver: {} },
    });
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
      authorizationSha256,
      activeAuthorizationSha256: authorizationSha256,
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
        authorizationSha256,
        activeAuthorizationSha256: authorizationSha256,
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

  it("responds with JSON 413 BODY_TOO_LARGE before closing an unfinished request", async () => {
    const bind = vi.spyOn(Server.prototype, "listen").mockReturnThis();
    const request = Object.assign(new PassThrough(), { method: "POST", url: "/signature" });
    const dispatch = vi.spyOn(f.relay, "dispatch");
    try {
      const server = listen(f.relay, 8787);
      const writeHead = vi.fn();
      const json = new Promise<string>((end) =>
        server.emit("request", request, { writeHead, end }),
      );
      request.write(Buffer.alloc(8193));
      expect(JSON.parse(await json)).toEqual({ verified: false, reason: "BODY_TOO_LARGE" });
      expect(writeHead).toHaveBeenCalledExactlyOnceWith(413, {
        "content-type": "application/json",
        connection: "close",
      });
      expect(request.destroyed).toBe(false);
      expect(request.readableEnded).toBe(false);
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      request.destroy();
      bind.mockRestore();
    }
  });

  it("returns HTTP 503 CHAIN_UNAVAILABLE when POST /signature cannot read the slot", async () => {
    const slot = vi.spyOn(f.transport, "getSlot").mockRejectedValueOnce(new Error("Slot timed out"));
    const signature = await f.messageRequest("sender");
    const bind = vi.spyOn(Server.prototype, "listen").mockReturnThis();
    try {
      const server = listen(f.relay, 8787);
      async function post(body: string) {
        const request = Object.assign(Readable.from([body]), {
          method: "POST",
          url: "/signature",
        });
        const writeHead = vi.fn();
        const json = await new Promise<string>((end) =>
          server.emit("request", request, { writeHead, end }),
        );
        return { status: writeHead.mock.lastCall?.[0], body: JSON.parse(json) };
      }

      expect(await post("{")).toEqual({
        status: 400,
        body: { verified: false, reason: "BAD_SIGNATURE" },
      });
      expect(slot).not.toHaveBeenCalled();
      expect(await post(JSON.stringify(signature))).toEqual({
        status: 503,
        body: { verified: false, reason: "CHAIN_UNAVAILABLE" },
      });
      expect(await f.relay.dispatch("GET", "/outcome")).toEqual({
        state: "waiting",
        activeAuthorizationSha256: signature.authorizationSha256,
        checks: { sender: {}, receiver: {} },
      });
      expect(await post(JSON.stringify(signature))).toEqual({
        status: 200,
        body: { verified: true },
      });
    } finally {
      bind.mockRestore();
    }
  });

  it.each([false, true])(
    "matches the active outcome digest to /intent before and after submission (refresh: %s)",
    async (refresh) => {
      const initial = await f.relay.intent("sender");
      if (!("intent" in initial)) throw new Error("Initial intent was refused");
      if (refresh) f.svm.warpToSlot(BigInt(initial.intent.expirySlot) + 1n);
      const current = await f.relay.intent("sender");
      if (!("authorizationBase64" in current) || current.authorizationBase64 === undefined) {
        throw new Error("Current intent was refused");
      }
      const bytes = Buffer.from(current.authorizationBase64, "base64");
      const authorizationSha256 = createHash("sha256").update(bytes).digest("hex");
      if (refresh) expect(authorizationSha256).not.toBe(initial.authorizationSha256);

      const bind = vi.spyOn(Server.prototype, "listen").mockReturnThis();
      try {
        const server = listen(f.relay, 8787);
        async function getOutcome() {
          const json = await new Promise<string>((end) =>
            server.emit("request", { method: "GET", url: "/outcome" }, { writeHead: vi.fn(), end }),
          );
          return JSON.parse(json);
        }

        expect(await getOutcome()).toHaveProperty("activeAuthorizationSha256", authorizationSha256);
        expect(await getOutcome()).not.toHaveProperty("authorizationSha256");
        expect(
          await f.relay.dispatch("POST", "/signature", await f.messageRequest("sender", bytes)),
        ).toEqual({ verified: true });
        expect(await getOutcome()).not.toHaveProperty("authorizationSha256");
        expect(
          await f.relay.dispatch("POST", "/signature", await f.transactionRequest(undefined, bytes)),
        ).toEqual({ verified: true });
        expect(await getOutcome()).toHaveProperty("authorizationSha256", authorizationSha256);
        await vi.waitFor(async () =>
          expect(await getOutcome()).toMatchObject({
            state: "confirmed",
            activeAuthorizationSha256: authorizationSha256,
            authorizationSha256,
          }),
        );
      } finally {
        bind.mockRestore();
      }
    },
  );

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

  it("verifies and records routes for the submitted digest past its expiry slot", async () => {
    const intent = await f.relay.intent("sender");
    if (!("intent" in intent)) throw new Error("Initial intent was refused");
    const sends = f.submit.mock.calls.length;
    const post = (body: unknown) => f.relay.dispatch("POST", "/signature", body);
    await post(await f.messageRequest("sender"));
    await post(await f.transactionRequest());
    await vi.waitFor(async () =>
      expect(await f.relay.dispatch("GET", "/outcome")).toMatchObject({ state: "confirmed" }),
    );
    f.svm.warpToSlot(BigInt(intent.intent.expirySlot) + 1n);
    const receiver = await f.messageRequest("receiver");
    expect(await post({ ...receiver, signatureBase58: "!" })).toEqual({
      verified: false,
      reason: "BAD_SIGNATURE",
    });
    expect(await f.relay.dispatch("GET", "/outcome")).toMatchObject({
      checks: { receiver: { message: { verified: false, reason: "BAD_SIGNATURE" } } },
    });
    const slot = vi.spyOn(f.transport, "getSlot").mockRejectedValue(new Error("RPC unavailable"));
    expect(await post(receiver)).toEqual({ verified: true });
    expect(slot).not.toHaveBeenCalled();
    expect(await f.relay.dispatch("GET", "/outcome")).toMatchObject({
      state: "confirmed",
      authorizationSha256: intent.authorizationSha256,
      checks: { receiver: { message: { verified: true }, transaction: { verified: true } } },
    });
    expect(f.submit).toHaveBeenCalledTimes(sends + 1);
  });

  it("retains both signatures after a blockhash timeout and retries on the next verified POST", async () => {
    const blockhash = vi
      .spyOn(f.transport, "getLatestBlockhash")
      .mockRejectedValueOnce(new Error("Blockhash request timed out"));
    const initialSends = f.submit.mock.calls.length;
    const post = (body: unknown) => f.relay.dispatch("POST", "/signature", body);
    const sender = await f.messageRequest("sender");
    const receiver = await f.transactionRequest();
    expect(await post(sender)).toEqual({ verified: true });
    expect(await post(receiver)).toEqual({ verified: true });
    await vi.waitFor(async () =>
      expect(await f.relay.dispatch("GET", "/outcome")).toMatchObject({
        state: "waiting",
        error: "Blockhash request timed out",
        checks: {
          sender: { message: { verified: true } },
          receiver: { transaction: { verified: true } },
        },
      }),
    );
    expect(f.submit).toHaveBeenCalledTimes(initialSends);
    expect(await post({ ...receiver, signedTransactionBase64: "!" })).toEqual({
      verified: false,
      reason: "BAD_SIGNATURE",
    });
    expect(blockhash).toHaveBeenCalledTimes(1);

    expect(await post(receiver)).toEqual({ verified: true });
    await vi.waitFor(async () => {
      const outcome = await f.relay.dispatch("GET", "/outcome");
      expect(outcome).toMatchObject({ state: "confirmed" });
      expect(outcome).not.toHaveProperty("error");
    });
    expect(blockhash).toHaveBeenCalledTimes(2);
    expect(f.submit).toHaveBeenCalledTimes(initialSends + 1);
  });

  it.each([false, true])(
    "releases the latch on an RPC preflight rejection (expires before retry: %s)",
    async (expires) => {
      const getIntent = () => f.relay.intent("sender");
      const initial = await getIntent();
      if (!("intent" in initial)) throw new Error("Initial intent was refused");
      const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
        const { id, method } = JSON.parse(String(init?.body));
        expect(method).toBe("sendTransaction");
        return Response.json({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32002,
            message: "Transaction simulation failed: Blockhash not found",
            data: { err: "BlockhashNotFound", logs: [] },
          },
        });
      });
      const sends = f.submit.mock.calls.length;
      f.submit.mockImplementationOnce(rpcTransport("http://127.0.0.1:8899").send);
      const post = (body: unknown) => f.relay.dispatch("POST", "/signature", body);
      const receiver = await f.transactionRequest();
      try {
        await post(await f.messageRequest("sender"));
        await post(receiver);
        await vi.waitFor(async () =>
          expect(await f.relay.dispatch("GET", "/outcome")).toMatchObject({
            state: "waiting",
            error: expect.stringMatching(/blockhash not found/i),
            checks: {
              sender: { message: { verified: true } },
              receiver: { transaction: { verified: true } },
            },
          }),
        );
        expect(fetch).toHaveBeenCalledOnce();
        expect(f.signatureStatus).not.toHaveBeenCalled();
      } finally {
        fetch.mockRestore();
      }
      if (expires) {
        f.svm.warpToSlot(BigInt(initial.intent.expirySlot) + 1n);
        const fresh = await getIntent();
        if (!("intent" in fresh)) throw new Error("Refreshed intent was refused");
        expect(fresh).not.toHaveProperty("authorizationSha256", initial.authorizationSha256);
        expect(await f.relay.dispatch("GET", "/outcome")).toEqual({
          state: "waiting",
          activeAuthorizationSha256: fresh.authorizationSha256,
          checks: { sender: {}, receiver: {} },
        });
        expect(f.submit).toHaveBeenCalledTimes(sends + 1);
      } else {
        expect(await post(receiver)).toEqual({ verified: true });
        await vi.waitFor(async () =>
          expect(await f.relay.dispatch("GET", "/outcome")).toMatchObject({ state: "confirmed" }),
        );
        expect(f.submit).toHaveBeenCalledTimes(sends + 2);
      }
    },
  );

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

  it("reconciles a lost send response after 180 seconds while the blockhash is still valid", async () => {
    f.submit.mockRejectedValueOnce(new Error("Send timed out"));
    f.signatureStatus.mockResolvedValueOnce(null).mockResolvedValueOnce("confirmed");
    const now = vi.spyOn(performance, "now");
    f.blockHeight.mockImplementationOnce(async () => {
      now.mockReturnValue(180_001);
      return 1000n;
    });
    try {
      now.mockReturnValue(0);
      await f.relay.dispatch("POST", "/signature", await f.messageRequest("sender"));
      await f.relay.dispatch("POST", "/signature", await f.transactionRequest());
      await vi.waitFor(async () =>
        expect(await f.relay.dispatch("GET", "/outcome")).toMatchObject({ state: "confirmed" }),
      );
      expect(f.signatureStatus).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });

  it.each(["confirmed", null] as const)(
    "keeps polling the original signature with backoff after RPC failures (final status: %s)",
    async (status) => {
      const initialSends = f.submit.mock.calls.length;
      const error = new Error("RPC unavailable");
      const sender = await f.messageRequest("sender");
      const receiver = await f.transactionRequest();
      f.submit.mockRejectedValueOnce(error);
      f.signatureStatus.mockRejectedValue(error);
      f.blockHeight.mockRejectedValue(error);
      vi.useFakeTimers();
      try {
        await f.relay.dispatch("POST", "/signature", sender);
        await f.relay.dispatch("POST", "/signature", receiver);
        await vi.waitFor(
          async () =>
            expect(await f.relay.dispatch("GET", "/outcome")).toMatchObject({
              state: "unknown",
              signature: expect.any(String),
              error: "RPC unavailable",
            }),
          { timeout: 3000 },
        );
        expect(f.signatureStatus).toHaveBeenCalledTimes(5);
        expect(f.blockHeight).toHaveBeenCalledTimes(5);
        await vi.advanceTimersByTimeAsync(500);
        expect(f.signatureStatus).toHaveBeenCalledTimes(5);

        const tx = f.submit.mock.lastCall?.[0];
        if (!tx) throw new Error("Missing transaction");
        const signature = getSignatureFromTransaction(tx);
        f.signatureStatus.mockResolvedValueOnce(null).mockResolvedValue(status);
        f.blockHeight.mockResolvedValue(1001n);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(f.blockHeight).toHaveBeenCalledTimes(6);
        expect(f.signatureStatus.mock.calls).toEqual(Array.from({ length: 7 }, () => [signature]));
        const outcome = await f.relay.dispatch("GET", "/outcome");
        expect(outcome).toMatchObject({ state: status ?? "unknown", signature });
        if (status) expect(outcome).not.toHaveProperty("error");
        const blockhash = vi.spyOn(f.transport, "getLatestBlockhash");
        expect(await f.relay.dispatch("POST", "/signature", sender)).toEqual({ verified: true });
        expect(blockhash).not.toHaveBeenCalled();
        expect(f.submit).toHaveBeenCalledTimes(initialSends + 1);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("refuses a late signature over HTTP and lets both wallets sign refreshed intent", async () => {
    const initial = await f.relay.intent("sender");
    if (!("intent" in initial)) throw new Error("Initial intent was refused");
    const sends = f.submit.mock.calls.length;
    f.svm.warpToSlot(BigInt(initial.intent.expirySlot));
    const senderAtExpiry = await f.messageRequest("sender");
    expect(await f.relay.dispatch("POST", "/signature", senderAtExpiry)).toEqual({ verified: true });
    f.svm.warpToSlot(BigInt(initial.intent.expirySlot) + 1n);
    const lateSignature = await f.transactionRequest();
    const bind = vi.spyOn(Server.prototype, "listen").mockReturnThis();
    try {
      const server = listen(f.relay, 8787);
      const request = Object.assign(Readable.from([JSON.stringify(lateSignature)]), {
        method: "POST",
        url: "/signature",
      });
      const writeHead = vi.fn();
      const json = await new Promise<string>((end) =>
        server.emit("request", request, { writeHead, end }),
      );
      expect(writeHead).toHaveBeenCalledWith(200, { "content-type": "application/json" });
      expect(JSON.parse(json)).toEqual({ verified: false, reason: "INTENT_EXPIRED" });
    } finally {
      bind.mockRestore();
    }
    expect(f.submit).toHaveBeenCalledTimes(sends);
    expect(await f.relay.dispatch("GET", "/outcome")).toEqual({
      state: "waiting",
      activeAuthorizationSha256: initial.authorizationSha256,
      checks: { sender: { message: { verified: true } }, receiver: {} },
    });
    const [sender, receiver] = await Promise.all([
      f.relay.intent("sender"),
      f.relay.intent("receiver"),
    ]);
    if (!("authorizationBase64" in sender) || !("authorizationBase64" in receiver)) {
      throw new Error("Refreshed intent was refused");
    }
    expect(sender.authorizationBase64).not.toBe(initial.authorizationBase64);
    expect(sender.authorizationBase64).toBe(receiver.authorizationBase64);
    const fresh = Buffer.from(sender.authorizationBase64, "base64");
    const freshSenderSignature = await f.messageRequest("sender", fresh);
    const freshReceiverSignature = await f.transactionRequest(undefined, fresh);
    expect(await f.relay.dispatch("POST", "/signature", freshSenderSignature)).toEqual({
      verified: true,
    });
    expect(await f.relay.dispatch("POST", "/signature", freshReceiverSignature)).toEqual({
      verified: true,
    });
    await vi.waitFor(async () =>
      expect(await f.relay.dispatch("GET", "/outcome")).toMatchObject({ state: "confirmed" }),
    );
    expect(f.submit).toHaveBeenCalledTimes(sends + 1);
  });

  it("returns STALE_INTENT over HTTP without overwriting a check for the current authorization", async () => {
    const initial = await f.relay.intent("sender");
    if (!("intent" in initial)) throw new Error("Initial intent was refused");
    const stale = await f.messageRequest("sender");
    f.svm.warpToSlot(BigInt(initial.intent.expirySlot) + 1n);
    const fresh = await f.relay.intent("sender");
    if (!("authorizationBase64" in fresh)) throw new Error("Refreshed intent was refused");
    const current = await f.messageRequest(
      "sender",
      Buffer.from(fresh.authorizationBase64, "base64"),
    );
    await f.relay.dispatch("POST", "/signature", current);
    const before = await f.relay.dispatch("GET", "/outcome");
    const bind = vi.spyOn(Server.prototype, "listen").mockReturnThis();
    const slot = vi.spyOn(f.transport, "getSlot");
    try {
      const server = listen(f.relay, 8787);
      for (const body of [stale, { ...current, authorizationSha256: undefined }]) {
        const request = Object.assign(Readable.from([JSON.stringify(body)]), {
          method: "POST",
          url: "/signature",
        });
        const writeHead = vi.fn();
        const json = await new Promise<string>((end) =>
          server.emit("request", request, { writeHead, end }),
        );
        expect(writeHead).toHaveBeenCalledWith(200, { "content-type": "application/json" });
        expect(JSON.parse(json)).toEqual({ verified: false, reason: "STALE_INTENT" });
        expect(await f.relay.dispatch("GET", "/outcome")).toEqual(before);
      }
      expect(slot).not.toHaveBeenCalled();
    } finally {
      bind.mockRestore();
    }
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
      activeAuthorizationSha256: fresh.authorizationSha256,
      checks: { sender: {}, receiver: {} },
    });
    const sends = f.submit.mock.calls.length;
    expect(await f.relay.dispatch("POST", "/signature", oldSignature)).toEqual({
      verified: false,
      reason: "STALE_INTENT",
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
      await f.relay.dispatch(
        "POST",
        "/signature",
        await f.messageRequest("sender", altered, f.authorization),
      ),
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
      activeAuthorizationSha256: createHash("sha256").update(f.authorization).digest("hex"),
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

  it("waits past a repeated blockhash before sending the nonce replay to the Executor", async () => {
    const firstSend = f.submit.mock.calls.length;
    const latestBlockhash = f.transport.getLatestBlockhash;
    const repeated = vi.fn(() => ({
      blockhash: f.svm.latestBlockhash(),
      lastValidBlockHeight: 1000n,
    }));
    vi.spyOn(f.transport, "getLatestBlockhash").mockImplementation(async () => {
      // Scratch setup sends three transactions and the original handover sends one more.
      if (f.submit.mock.calls.length === firstSend + 4 && repeated.mock.calls.length === 0) {
        return repeated();
      }
      return latestBlockhash();
    });
    const report = vi.fn();
    await runRefusalChecks(f.transport, f.sponsor, f.state, report);
    expect(repeated).toHaveBeenCalledOnce();
    const [original, replay] = f.submit.mock.calls.slice(firstSend + 3).map(([tx]) => tx);
    if (!original || !replay) throw new Error("Missing original or replay transaction");
    expect(getSignatureFromTransaction(replay)).not.toBe(getSignatureFromTransaction(original));
    expect(report).toHaveBeenCalledWith("D32-devnet replay: refused (NonceMismatch)");
  });
});
