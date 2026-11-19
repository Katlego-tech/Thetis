import { mkdtemp, rm, stat } from "node:fs/promises";
import { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  address,
  generateKeyPairSigner,
  getBase58Decoder,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  lamports,
  type Address,
  type Signature,
  signBytes,
} from "@solana/kit";
import { FailedTransactionMetadata, LiteSVM } from "litesvm";
import { expect, it, vi } from "vitest";
import { formatSast, formatTonnes, handoverMessage } from "../src/intent/message.ts";
import { createIntentRelay, listenIntent } from "../src/intent/relay.ts";
import { runIntentRefusals } from "../src/intent/refusals.ts";
import { setupIntent } from "../src/intent/setup.ts";
import { readIntentState } from "../src/intent/state.ts";
import { decodeBatch, ed25519VerifyInstruction } from "../src/intent/wire.ts";
import {
  BlockhashExpiredError,
  ChainTransactionError,
  type ChainTransport,
} from "../src/transport.ts";
import { sha256 } from "../src/wire.ts";

const program = address("3LfZrLC2R3AdjAQgdoEjdC3YZpbHLaJGy446H74cPEyH");
const vectorA = `Thetis authorisation v1
Network: devnet
Program: 3LfZrLC2R3AdjAQgdoEjdC3YZpbHLaJGy446H74cPEyH
Action: Hand over custody
Lot: CR-0001
Batch: 00112233445566778899aabbccddeeff
Quantity: 2,000.000 t
From: Kopano Stockyard Custody
To: Mosela Haulage
Sequence: 0
Valid until: 2026-11-19 16:32:05 SAST
Test network only. Synthetic data.`;
const fields = {
  program,
  lotId: "CR-0001",
  batchId: Buffer.from("00112233445566778899aabbccddeeff", "hex"),
  quantityKg: 2_000_000n,
  from: "Kopano Stockyard Custody",
  to: "Mosela Haulage",
  sequence: 0n,
  validUntil: 1_795_098_725n,
};

it.each([
  [1n, "0.001 t"],
  [999n, "0.999 t"],
  [1000n, "1.000 t"],
  [2_000_000n, "2,000.000 t"],
  [1_234_567_890n, "1,234,567.890 t"],
  [18_446_744_073_709_551_615n, "18,446,744,073,709,551.615 t"],
])("formats %s kg", (kg, expected) => expect(formatTonnes(kg)).toBe(expected));

it.each([
  [0n, "1970-01-01 02:00:00 SAST"],
  [951_782_400n, "2000-02-29 02:00:00 SAST"],
  [1_795_098_725n, "2026-11-19 16:32:05 SAST"],
  [1_795_105_799n, "2026-11-19 18:29:59 SAST"],
  [4_102_444_799n, "2100-01-01 01:59:59 SAST"],
])("formats %s in SAST", (unix, expected) => expect(formatSast(unix)).toBe(expected));

it("reproduces vectors A and B byte for byte", () => {
  const a = handoverMessage(fields);
  expect(Buffer.from(a)).toEqual(Buffer.from(vectorA));
  expect(a).toHaveLength(329);
  expect(sha256(a).toString("hex")).toBe(
    "496a14a54f2fcce926d23c22594cc08de8388af8ef9e876a44b6bd14ad3ac569",
  );
  const b = handoverMessage({
    ...fields,
    lotId: "MN-0042",
    quantityKg: 1n,
    sequence: 7n,
    validUntil: 4_102_444_799n,
  });
  expect(Buffer.from(b)).toEqual(
    Buffer.from(
      vectorA
        .replace("CR-0001", "MN-0042")
        .replace("2,000.000 t", "0.001 t")
        .replace("Sequence: 0", "Sequence: 7")
        .replace("2026-11-19 16:32:05", "2100-01-01 01:59:59"),
    ),
  );
  expect(b).toHaveLength(325);
  expect(sha256(b).toString("hex")).toBe(
    "dbb342e075310715ba4e8cd78cb2eaa0fcbf9996dc129c4a893bfdb9560f538b",
  );
});

it("builds the two-entry Ed25519 instruction with one shared message", () => {
  const first = Buffer.alloc(32, 2);
  const second = Buffer.alloc(32, 3);
  const sender = Buffer.alloc(64, 4);
  const receiver = Buffer.alloc(64, 5);
  const message = Buffer.from("Shared");
  const ix = ed25519VerifyInstruction(
    [
      { publicKey: address(getBase58Decoder().decode(first)), signature: sender },
      { publicKey: address(getBase58Decoder().decode(second)), signature: receiver },
    ],
    message,
  );
  const offsets = Buffer.from(
    "02003e00ffff1e00ffffde000600ffff9e00ffff7e00ffffde000600ffff",
    "hex",
  );
  expect(ix.programAddress).toBe("Ed25519SigVerify111111111111111111111111111");
  expect(ix.accounts ?? []).toEqual([]);
  expect(Buffer.from(ix.data ?? [])).toEqual(
    Buffer.concat([offsets, first, sender, second, receiver, message]),
  );
});

async function fixture(path?: string) {
  const svm = new LiteSVM().withPrecompiles();
  svm.addProgramFromFile(
    program,
    new URL("../../../target/deploy/intent_spike.so", import.meta.url).pathname,
  );
  function setTime(unix: bigint) {
    const clock = svm.getClock();
    clock.unixTimestamp = unix;
    svm.setClock(clock);
  }
  setTime(fields.validUntil - 570n);
  const sponsor = await generateKeyPairSigner();
  const wallets = {
    sender: await generateKeyPairSigner(),
    receiver: await generateKeyPairSigner(),
  };
  svm.airdrop(sponsor.address, lamports(1_000_000_000n));
  for (const wallet of Object.values(wallets)) svm.airdrop(wallet.address, lamports(1_000_000n));
  const sent = new Set<Signature>();
  const transport: ChainTransport = {
    async getGenesisHash() {
      return "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
    },
    async getSlot() {
      return svm.getClock().slot;
    },
    async getChainTime() {
      return svm.getClock().unixTimestamp;
    },
    async getBlockHeight() {
      return 1001n;
    },
    async getSignatureStatus(signature) {
      return sent.has(signature) ? "confirmed" : null;
    },
    async waitForSlot(slot) {
      svm.warpToSlot(slot + 1n);
    },
    async getAccount(key) {
      const account = svm.getAccount(key);
      return account.exists
        ? { owner: account.programAddress, data: Buffer.from(account.data) }
        : null;
    },
    async getRent(space) {
      return svm.minimumBalanceForRentExemption(BigInt(space));
    },
    async getLatestBlockhash() {
      svm.expireBlockhash();
      return { blockhash: svm.latestBlockhash(), lastValidBlockHeight: 1000n };
    },
    async send(transaction) {
      const result = svm.sendTransaction(transaction);
      if (result instanceof FailedTransactionMetadata) {
        throw new ChainTransactionError(result.err().toString(), result.meta().logs());
      }
      const signature = getSignatureFromTransaction(transaction);
      sent.add(signature);
      return signature;
    },
    async confirm(signature) {
      if (!sent.has(signature)) throw new Error("Signature missing from LiteSVM");
    },
  };
  const send = vi.spyOn(transport, "send");
  const setup = () =>
    setupIntent(
      transport,
      sponsor,
      program,
      wallets.sender.address,
      wallets.receiver.address,
      path,
    );
  const state = await setup();
  const relay = await createIntentRelay(transport, sponsor, state, vi.fn());
  async function load(role: keyof typeof wallets) {
    const intent = await relay.intent(role);
    if (!("messageBase64" in intent)) throw new Error("Expected issued intent");
    return intent;
  }
  async function request(
    intent: Awaited<ReturnType<typeof load>>,
    bytes = Buffer.from(intent.messageBase64, "base64"),
  ) {
    const wallet = wallets[intent.role];
    return {
      role: intent.role,
      address: wallet.address,
      messageSha256: intent.messageSha256,
      signatureBase58: getBase58Decoder().decode(await signBytes(wallet.keyPair.privateKey, bytes)),
    };
  }
  function balance(key: Address) {
    return svm.getBalance(key);
  }
  return {
    transport,
    state,
    setup,
    relay,
    load,
    request,
    setTime,
    send,
    balance,
    sponsor,
    wallets,
  };
}

it("opens and reuses a private checkpoint and confirms one sponsor-only handover", async () => {
  const directory = await mkdtemp(join(tmpdir(), "thetis-intent-"));
  try {
    const path = join(directory, "state.json");
    const f = await fixture(path);
    expect(await readIntentState(path)).toEqual(f.state);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const setupSends = f.send.mock.calls.length;
    expect(await f.setup()).toEqual(f.state);
    expect(f.send).toHaveBeenCalledTimes(setupSends);
    const [sender, receiver] = await Promise.all([f.load("sender"), f.load("receiver")]);
    const expectedText = vectorA.replace("00112233445566778899aabbccddeeff", f.state.batchId);
    expect(sender.messageText).toBe(expectedText);
    expect(Buffer.from(sender.messageBase64, "base64").toString("utf8")).toBe(expectedText);
    expect(sender.messageBase64).toBe(receiver.messageBase64);
    expect(sender.validUntil).toBe(fields.validUntil.toString());
    expect(sender.expectedSequence).toBe("0");
    const keys = [f.sponsor.address, f.wallets.sender.address, f.wallets.receiver.address];
    const before = keys.map(f.balance);
    const senderSignature = await f.request(sender);
    const receiverSignature = await f.request(receiver);
    expect(await f.relay.dispatch("POST", "/signature", senderSignature)).toEqual({
      verified: true,
    });
    expect(await f.relay.dispatch("POST", "/signature", receiverSignature)).toEqual({
      verified: true,
    });
    expect(
      await f.relay.dispatch("POST", "/signature", { ...receiverSignature, messageSha256: "" }),
    ).toEqual({
      verified: false,
      reason: "ALREADY_SUBMITTED",
    });
    await vi.waitFor(() =>
      expect(f.relay.outcome()).toMatchObject({
        state: "confirmed",
        submittedMessageSha256: sender.messageSha256,
        checks: { sender: { verified: true }, receiver: { verified: true } },
      }),
    );
    expect(f.relay.outcome().sizeBytes).toBeLessThanOrEqual(1232);
    console.log(`Confirmed handover size: ${f.relay.outcome().sizeBytes} bytes`);
    expect(f.send).toHaveBeenCalledTimes(setupSends + 1);
    const transaction = f.send.mock.lastCall?.[0];
    if (!transaction) throw new Error("Expected handover transaction");
    const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
    expect(message.version).toBe("legacy");
    expect(Object.keys(transaction.signatures)).toEqual([f.sponsor.address]);
    const batch = await f.transport.getAccount(f.state.batch);
    if (!batch) throw new Error("Missing batch");
    expect(decodeBatch(batch.data)).toMatchObject({ sequence: 1n, handedOver: true });
    const after = keys.map(f.balance);
    expect(after[0]).toBeLessThan(before[0] ?? 0n);
    expect(after.slice(1)).toEqual(before.slice(1));
    expect(await f.relay.intent("sender")).toEqual({ verified: false, reason: "BATCH_COMPLETE" });
    const restarted = await createIntentRelay(f.transport, f.sponsor, f.state);
    expect(await restarted.intent("receiver")).toEqual({
      verified: false,
      reason: "BATCH_COMPLETE",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("refuses wrong addresses, changed bytes and stale signatures, and reissues after the margin", async () => {
  const f = await fixture();
  const initial = await f.load("sender");
  const sender = await f.request(initial);
  const receiver = await f.request(await f.load("receiver"));
  const post = (body: unknown) => f.relay.dispatch("POST", "/signature", body);
  expect(await post({ ...sender, role: "other" })).toEqual({
    verified: false,
    reason: "UNKNOWN_ROLE",
  });
  expect(await post({ ...sender, address: receiver.address })).toEqual({
    verified: false,
    reason: "WRONG_ADDRESS",
  });
  const changed = Buffer.from(initial.messageBase64, "base64");
  changed[0] = changed[0]! ^ 1;
  expect(await post(await f.request(initial, changed))).toEqual({
    verified: false,
    reason: "BAD_SIGNATURE",
  });
  expect(await post(sender)).toEqual({ verified: true });
  f.setTime(BigInt(initial.validUntil) - 30n);
  expect(await f.load("sender")).toEqual(initial);
  f.setTime(BigInt(initial.validUntil) - 29n);
  const fresh = await f.load("receiver");
  expect(BigInt(fresh.validUntil)).toBeGreaterThan(BigInt(initial.validUntil));
  expect(f.relay.outcome().checks).toEqual({});
  expect(await post(receiver)).toEqual({ verified: false, reason: "STALE_INTENT" });
  expect(await post(await f.request(fresh))).toEqual({ verified: true });
  expect(f.relay.outcome().state).toBe("waiting");
});

it("returns loopback JSON and the documented intent refusal statuses", async () => {
  const f = await fixture();
  const bind = vi.spyOn(Server.prototype, "listen").mockReturnThis();
  try {
    const server = listenIntent(f.relay, 8787);
    expect(bind).toHaveBeenCalledWith(8787, "127.0.0.1");
    async function get(path: string, status: number) {
      const writeHead = vi.fn();
      const body = await new Promise<string>((end) => {
        server.emit("request", { method: "GET", url: path }, { writeHead, end });
      });
      expect(writeHead).toHaveBeenCalledWith(status, { "content-type": "application/json" });
      return JSON.parse(body);
    }
    expect(await get("/outcome", 200)).toEqual({
      state: "waiting",
      activeMessageSha256: "",
      checks: {},
    });
    expect(await get("/intent?role=other", 400)).toEqual({
      verified: false,
      reason: "UNKNOWN_ROLE",
    });
    expect(await get("/intent?role=sender", 200)).toEqual(await f.load("sender"));
    for (const role of ["sender", "receiver"] as const) {
      await f.relay.dispatch("POST", "/signature", await f.request(await f.load(role)));
    }
    await vi.waitFor(() => expect(f.relay.outcome().state).toBe("confirmed"));
    expect(await get("/intent?role=receiver", 409)).toEqual({
      verified: false,
      reason: "BATCH_COMPLETE",
    });
  } finally {
    bind.mockRestore();
  }
});

it("retries a proved blockhash expiry with the same instructions and fresh transaction ID", async () => {
  const f = await fixture();
  const initialSends = f.send.mock.calls.length;
  f.send.mockRejectedValueOnce(new BlockhashExpiredError("Blockhash expired"));
  for (const role of ["sender", "receiver"] as const) {
    await f.relay.dispatch("POST", "/signature", await f.request(await f.load(role)));
  }
  await vi.waitFor(() => expect(f.relay.outcome().state).toBe("confirmed"));
  expect(f.send).toHaveBeenCalledTimes(initialSends + 2);
  const first = f.send.mock.calls[initialSends]?.[0];
  const second = f.send.mock.calls[initialSends + 1]?.[0];
  if (!first || !second) throw new Error("Expected two transactions");
  const decoder = getCompiledTransactionMessageDecoder();
  const firstMessage = decoder.decode(first.messageBytes);
  const secondMessage = decoder.decode(second.messageBytes);
  if (firstMessage.version !== "legacy" || secondMessage.version !== "legacy") {
    throw new Error("Expected legacy handover messages");
  }
  expect(firstMessage.instructions).toEqual(secondMessage.instructions);
  expect(getSignatureFromTransaction(first)).not.toBe(getSignatureFromTransaction(second));
  expect(f.relay.outcome().signature).toBe(getSignatureFromTransaction(second));
});

it("limits submissions to three sends when each blockhash provably expires", async () => {
  const f = await fixture();
  const initialSends = f.send.mock.calls.length;
  f.send.mockRejectedValue(new BlockhashExpiredError("Blockhash expired"));
  for (const role of ["sender", "receiver"] as const) {
    await f.relay.dispatch("POST", "/signature", await f.request(await f.load(role)));
  }
  await vi.waitFor(() => expect(f.relay.outcome().state).toBe("failed"));
  expect(f.send).toHaveBeenCalledTimes(initialSends + 3);
});

it.each([false, true])(
  "holds the original signature when history is inconclusive (expiry: %s)",
  async (expiry) => {
    const f = await fixture();
    const initialSends = f.send.mock.calls.length;
    f.send.mockRejectedValueOnce(
      expiry ? new BlockhashExpiredError("Blockhash expired") : new Error("Send timed out"),
    );
    const status = vi
      .spyOn(f.transport, "getSignatureStatus")
      .mockRejectedValue(new Error("History unavailable"));
    const sender = await f.request(await f.load("sender"));
    const receiver = await f.request(await f.load("receiver"));
    await Promise.all(
      [sender, receiver].map((request) => f.relay.dispatch("POST", "/signature", request)),
    );
    await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(expiry ? 3 : 2));
    expect(f.relay.outcome()).toMatchObject({ state: "unknown", signature: expect.any(String) });
    expect(await f.relay.dispatch("POST", "/signature", receiver)).toEqual({
      verified: false,
      reason: "ALREADY_SUBMITTED",
    });
    expect(f.send).toHaveBeenCalledTimes(initialSends + 1);
    status.mockResolvedValue("confirmed");
    await vi.waitFor(async () =>
      expect(await f.relay.dispatch("GET", "/outcome")).toMatchObject({ state: "confirmed" }),
    );
    expect(f.send).toHaveBeenCalledTimes(initialSends + 1);
  },
);

it("runs the devnet refusal command against the program in LiteSVM", async () => {
  const f = await fixture();
  const report = vi.fn();
  await runIntentRefusals(f.transport, f.sponsor, program, report);
  expect(report.mock.calls.flat()).toEqual([
    "D32-inhouse-devnet no verify instruction: refused (MissingVerification)",
    "D32-inhouse-devnet swapped signers: refused (WrongSigner)",
    "D32-inhouse-devnet another receiver signer: refused (WrongSigner)",
    "D32-inhouse-devnet another quantity in signed text: refused (MessageMismatch)",
    "D32-inhouse-devnet window 601 seconds: refused (WindowTooLong)",
    "D32-inhouse-devnet replay: refused (StaleSequence)",
  ]);
});
