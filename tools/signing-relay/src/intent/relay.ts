import { createPublicKey, verify } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import {
  getBase58Encoder,
  getSignatureFromTransaction,
  type KeyPairSigner,
  type Signature,
} from "@solana/kit";
import {
  BlockhashExpiredError,
  ChainTransactionError,
  type ChainTransport,
  errorMessage,
  prepareTransaction,
  reconcileSignature,
  requireDevnet,
  SendPreflightError,
} from "../transport.ts";
import { keyBytes, type Role, sha256 } from "../wire.ts";
import { formatSast, handoverMessage } from "./message.ts";
import { readIntentBatch, readIntentParty } from "./setup.ts";
import type { IntentState } from "./state.ts";
import {
  type BatchAccount,
  CUSTODY_WINDOW_SECS,
  ed25519VerifyInstruction,
  handoverInstruction,
  ISSUE_MARGIN_SECS,
} from "./wire.ts";

type Refusal =
  | "UNKNOWN_ROLE"
  | "ALREADY_SUBMITTED"
  | "STALE_INTENT"
  | "WRONG_ADDRESS"
  | "BAD_SIGNATURE"
  | "BATCH_COMPLETE";
type Check = { verified: true } | { verified: false; reason: "WRONG_ADDRESS" | "BAD_SIGNATURE" };
type Submission = {
  state: "waiting" | "submitted" | "confirmed" | "failed" | "unknown";
  signature?: Signature;
  error?: string;
  sizeBytes?: number;
  submittedMessageSha256?: string;
};

function isRole(value: unknown): value is Role {
  return value === "sender" || value === "receiver";
}

function refuse<T extends Refusal>(reason: T) {
  return { verified: false, reason } as const;
}

export async function createIntentRelay(
  transport: ChainTransport,
  sponsor: KeyPairSigner,
  state: IntentState,
  log: (line: string) => void = console.log,
) {
  await requireDevnet(transport);
  if (!state.complete) throw new Error("Run signing-relay intent-setup first");
  const [sender, receiver] = await Promise.all([
    readIntentParty(transport, state, "sender"),
    readIntentParty(transport, state, "receiver"),
  ]);
  if (!sender || !receiver) throw new Error("Missing registered intent Party");
  const from = sender.displayName;
  const to = receiver.displayName;
  const publicKeys = {
    sender: createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, keyBytes(sender.wallet)]),
      format: "der",
      type: "spki",
    }),
    receiver: createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, keyBytes(receiver.wallet)]),
      format: "der",
      type: "spki",
    }),
  };

  function issue(batch: BatchAccount, now: bigint) {
    const validUntil = now + CUSTODY_WINDOW_SECS - ISSUE_MARGIN_SECS;
    const message = Buffer.from(
      handoverMessage({
        program: state.program,
        lotId: batch.lotId,
        batchId: batch.id,
        quantityKg: batch.quantityKg,
        from,
        to,
        sequence: batch.sequence,
        validUntil,
      }),
    );
    return {
      batch,
      validUntil,
      message,
      digest: sha256(message).toString("hex"),
      checks: {} as Partial<Record<Role, Check>>,
      signatures: {} as Partial<Record<Role, Uint8Array>>,
    };
  }

  let active: ReturnType<typeof issue> | undefined;
  let submission: Submission = { state: "waiting" };
  let sending = false;
  let tail = Promise.resolve();

  function serialize<T>(action: () => Promise<T>) {
    const result = tail.then(action);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function loadBatch() {
    const batch = await readIntentBatch(transport, state);
    if (!batch) throw new Error("Missing intent Batch");
    return batch;
  }

  function intent(role: Role) {
    return serialize(async () => {
      const batch = await loadBatch();
      if (batch.handedOver) return refuse("BATCH_COMPLETE");
      if (!active || submission.state === "waiting") {
        const now = await transport.getChainTime();
        if (!active || now > active.validUntil - ISSUE_MARGIN_SECS) active = issue(batch, now);
      }
      return {
        role,
        expectedAddress: state[role].wallet,
        messageText: active.message.toString("utf8"),
        messageBase64: active.message.toString("base64"),
        messageSha256: active.digest,
        validUntil: active.validUntil.toString(),
        validUntilText: formatSast(active.validUntil),
        expectedSequence: active.batch.sequence.toString(),
        network: "devnet" as const,
      };
    });
  }

  async function submit(
    issued: ReturnType<typeof issue>,
    senderSignature: Uint8Array,
    receiverSignature: Uint8Array,
  ) {
    const { batch, message, validUntil } = issued;
    try {
      const instructions = [
        ed25519VerifyInstruction(
          [
            { publicKey: state.sender.wallet, signature: senderSignature },
            { publicKey: state.receiver.wallet, signature: receiverSignature },
          ],
          message,
        ),
        handoverInstruction(
          state.program,
          batch.id,
          batch.sender,
          batch.receiver,
          batch.quantityKg,
          validUntil,
          batch.sequence,
        ),
      ];

      for (let attempt = 1; attempt <= 3; attempt++) {
        const { transaction, lifetime, sizeBytes } = await prepareTransaction(
          transport,
          sponsor,
          instructions,
          { version: "legacy" },
        );
        if (attempt > 1 && (await transport.getChainTime()) > validUntil) {
          throw new Error("Intent expired before the transaction could be retried");
        }
        const signature = getSignatureFromTransaction(transaction);
        if (signature === submission.signature) {
          throw new Error("RPC returned the expired blockhash for the retry");
        }
        const pending = {
          state: "submitted",
          signature,
          sizeBytes,
          submittedMessageSha256: issued.digest,
        } as const;
        submission = pending;
        log(`Signed intent relay size: ${sizeBytes} bytes`);
        log(`Devnet signature: ${signature}`);
        try {
          await transport.send(transaction);
          await transport.confirm(signature, lifetime);
          submission = { ...pending, state: "confirmed" };
          return;
        } catch (error) {
          const expired =
            error instanceof BlockhashExpiredError ||
            (error instanceof SendPreflightError && /blockhash not found/i.test(error.message));
          if (error instanceof ChainTransactionError && !expired) throw error;

          const unknown = { ...pending, state: "unknown", error: errorMessage(error) } as const;
          submission = unknown;
          const status = await reconcileSignature(transport, signature, lifetime, () => {
            submission = unknown;
          });
          if (status === "confirmed") {
            submission = { ...pending, state: "confirmed" };
            return;
          }
          if (status === "failed") throw new Error(`Transaction ${signature} failed on chain`);
          if (!expired) return;

          // A failed history lookup inside reconciliation can also yield null. Require a
          // successful lookup after expiry before replacing a possibly broadcast transaction.
          const history = await transport.getSignatureStatus(signature).catch(() => undefined);
          if (history === "confirmed") {
            submission = { ...pending, state: "confirmed" };
            return;
          }
          if (history === "failed") throw new Error(`Transaction ${signature} failed on chain`);
          if (history === undefined) return;
          if (attempt === 3) throw error;
          const now = await transport.getChainTime().catch(() => null);
          if (now === null) return;
          if (now > validUntil) throw error;
        }
      }
    } catch (error) {
      submission = { ...submission, state: "failed", error: errorMessage(error) };
    }
  }

  function verifyRequest(body: unknown) {
    return serialize(async () => {
      const request =
        body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
      const { role, address, messageSha256, signatureBase58 } = request;
      if (!isRole(role)) return refuse("UNKNOWN_ROLE");
      if (submission.state !== "waiting") return refuse("ALREADY_SUBMITTED");
      if (!active || active.digest !== messageSha256) return refuse("STALE_INTENT");
      const now = await transport.getChainTime();
      if (now > active.validUntil - ISSUE_MARGIN_SECS) {
        const batch = await loadBatch();
        active = batch.handedOver ? undefined : issue(batch, now);
        return refuse("STALE_INTENT");
      }
      const issued = active;
      const record = (check: Check) => {
        if (!issued.signatures[role]) issued.checks[role] = check;
        return check;
      };
      if (address !== state[role].wallet) return record(refuse("WRONG_ADDRESS"));
      let signature: Uint8Array;
      try {
        if (typeof signatureBase58 !== "string" || signatureBase58.length > 88) {
          return record(refuse("BAD_SIGNATURE"));
        }
        const decoded = Buffer.from(getBase58Encoder().encode(signatureBase58));
        if (decoded.length !== 64 || !verify(null, issued.message, publicKeys[role], decoded)) {
          return record(refuse("BAD_SIGNATURE"));
        }
        signature = decoded;
      } catch {
        return record(refuse("BAD_SIGNATURE"));
      }
      record({ verified: true });
      issued.signatures[role] ??= signature;
      const { sender, receiver } = issued.signatures;
      if (sender && receiver) {
        submission = { state: "submitted", submittedMessageSha256: issued.digest };
        sending = true;
        void submit(issued, sender, receiver).finally(() => {
          sending = false;
        });
      }
      return { verified: true } as const;
    });
  }

  function outcome() {
    return {
      ...submission,
      // No text has a digest until the relay issues it.
      activeMessageSha256: active?.digest ?? "",
      checks: { ...active?.checks },
    };
  }

  async function refreshOutcome() {
    const pending = submission;
    if (!sending && pending.state === "unknown" && pending.signature) {
      const status = await transport.getSignatureStatus(pending.signature).catch(() => null);
      if (status && submission === pending) {
        const { error, ...known } = pending;
        submission =
          status === "confirmed"
            ? { ...known, state: "confirmed" }
            : { ...known, state: "failed", error: error ?? "Transaction failed on chain" };
      }
    }
    return outcome();
  }

  function dispatch(method: string | undefined, target: string, body?: unknown) {
    const url = new URL(target, "http://127.0.0.1");
    if (method === "GET" && url.pathname === "/intent") {
      const role = url.searchParams.get("role");
      return isRole(role) ? intent(role) : refuse("UNKNOWN_ROLE");
    }
    if (method === "POST" && url.pathname === "/signature") return verifyRequest(body);
    if (method === "GET" && url.pathname === "/outcome") return refreshOutcome();
    return null;
  }

  return { intent, outcome, dispatch };
}

// DER SubjectPublicKeyInfo header for a raw 32-byte Ed25519 key (RFC 8410).
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

class BodyTooLargeError extends Error {}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 8192) throw new BodyTooLargeError();
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function listenIntent(relay: Awaited<ReturnType<typeof createIntentRelay>>, port: number) {
  const server = createServer(async (request, response) => {
    const target = request.url ?? "/";
    const reply = (status: number, body: unknown, headers = {}) => {
      response.writeHead(status, { "content-type": "application/json", ...headers });
      response.end(JSON.stringify(body));
    };
    let pathname: string;
    let body: unknown;
    try {
      pathname = new URL(target, "http://127.0.0.1").pathname;
      if (request.method === "POST" && pathname === "/signature") body = await readJson(request);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        reply(413, { verified: false, reason: "BODY_TOO_LARGE" }, { connection: "close" });
      } else {
        reply(400, refuse("BAD_SIGNATURE"));
      }
      return;
    }

    try {
      const result = await relay.dispatch(request.method, target, body);
      if (result === null) {
        reply(404, null);
      } else if (request.method === "GET" && pathname === "/intent" && "reason" in result) {
        reply(result.reason === "BATCH_COMPLETE" ? 409 : 400, result);
      } else {
        reply(200, result);
      }
    } catch {
      reply(503, { verified: false, reason: "CHAIN_UNAVAILABLE" });
    }
  });
  return server.listen(port, "127.0.0.1");
}
