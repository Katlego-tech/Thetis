import { createPublicKey, verify } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import {
  type Address,
  getBase58Encoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  type KeyPairSigner,
  type Signature,
} from "@solana/kit";
import { readBatch, readLookupTable, readNonce } from "./setup.ts";
import {
  ChainTransactionError,
  type ChainTransport,
  errorMessage,
  prepareTransaction,
  reconcileSignature,
  requireDevnet,
} from "./transport.ts";
import {
  authorize,
  keyBytes,
  type RelayState,
  type Role,
  sha256,
  submitInstruction,
} from "./wire.ts";

const FROM = "Kopano Stockyard Custody";
const TO = "Mosela Haulage";
const EXPIRY_SLOTS = 9_000n;
const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");

type Refusal =
  | "WRONG_ADDRESS"
  | "BAD_SIGNATURE"
  | "UNKNOWN_ROLE"
  | "BATCH_COMPLETE"
  | "INTENT_EXPIRED"
  | "CHAIN_UNAVAILABLE";
type Route = "message" | "transaction";
type Check = { verified: true } | { verified: false; reason: Refusal };
type Checks = Record<Role, Partial<Record<Route, Check>>>;

interface Outcome {
  state: "waiting" | "submitted" | "confirmed" | "failed" | "unknown";
  signature?: Signature;
  error?: string;
  sizeBytes?: number;
  authorizationSha256?: string;
}

const refuse = (reason: Refusal) => ({ verified: false as const, reason });
const isRole = (role: unknown): role is Role => role === "sender" || role === "receiver";

export async function createRelay(
  transport: ChainTransport,
  sponsor: KeyPairSigner,
  state: RelayState,
  log: (line: string) => void = console.log,
) {
  await requireDevnet(transport);
  const [slot, batch, nonce, table] = await Promise.all([
    transport.getSlot(),
    readBatch(transport, state),
    readNonce(transport, state.nonce, sponsor.address),
    readLookupTable(transport, state.lookupTable),
  ]);
  function issueAuthorization(slot: bigint, sequence: bigint, nonce: Buffer) {
    const expiry = slot + EXPIRY_SLOTS;
    const authorization = authorize(sponsor.address, state, nonce, expiry, sequence);
    return {
      authorization,
      expiry,
      sequence,
      authorizationBase64: authorization.bytes.toString("base64"),
      authorizationSha256: sha256(authorization.bytes).toString("hex"),
    };
  }

  let issued = issueAuthorization(slot, batch.sequence, nonce);
  const signatures = new Map<Address, Buffer>();
  let checks: Checks = { sender: {}, receiver: {} };
  let submissionStarted = false;
  let outcome: Outcome = { state: "waiting" };

  async function intent(role: Role) {
    const [currentBatch, currentSlot] = await Promise.all([
      readBatch(transport, state),
      transport.getSlot(),
    ]);
    if (currentBatch.handedOver) {
      return {
        ...refuse("BATCH_COMPLETE"),
        message:
          "Move the existing signing relay state file aside and run signing-relay setup for a fresh batch.",
      };
    }
    if (currentSlot > issued.expiry) {
      if (submissionStarted) return refuse("INTENT_EXPIRED");
      const currentNonce = await readNonce(transport, state.nonce, sponsor.address);
      if (currentSlot > issued.expiry) {
        if (submissionStarted) return refuse("INTENT_EXPIRED");
        issued = issueAuthorization(currentSlot, currentBatch.sequence, currentNonce);
        signatures.clear();
        checks = { sender: {}, receiver: {} };
        outcome = { state: "waiting" };
      }
    }
    const { expiry, sequence, authorizationBase64, authorizationSha256 } = issued;
    return {
      role,
      expectedAddress: state[role].wallet,
      authorizationBase64,
      authorizationSha256,
      intent: {
        text: `Hand over 2,000.000 t of CR-0001 from ${FROM} to ${TO}. Expires at slot ${expiry}. Synthetic test data.`,
        batchId: state.batchId,
        quantityKg: "2000000",
        from: FROM,
        to: TO,
        expirySlot: Number(expiry),
        expectedSequence: Number(sequence),
      },
      network: "devnet",
    };
  }

  async function submit() {
    const { authorization, authorizationSha256 } = issued;
    outcome = { state: "waiting", authorizationSha256 };
    let sendStarted = false;
    try {
      const { transaction, lifetime, sizeBytes } = await prepareTransaction(
        transport,
        sponsor,
        [submitInstruction(authorization, signatures)],
        { tables: { [state.lookupTable]: table.addresses } },
      );
      const signature = getSignatureFromTransaction(transaction);
      outcome = { ...outcome, signature, sizeBytes };
      log(`Signed relay size: ${sizeBytes} bytes`);
      log(`Devnet signature: ${signature}`);
      try {
        sendStarted = true;
        await transport.send(transaction);
        outcome = { ...outcome, state: "submitted" };
        await transport.confirm(signature, lifetime);
        outcome = { ...outcome, state: "confirmed" };
      } catch (error) {
        if (error instanceof ChainTransactionError) throw error;
        const status = await reconcileSignature(transport, signature, lifetime);
        if (status === "failed") throw new Error(`Transaction ${signature} failed on chain`);
        outcome =
          status === "confirmed"
            ? { ...outcome, state: "confirmed" }
            : { ...outcome, state: "unknown", error: errorMessage(error) };
      }
    } catch (error) {
      if (sendStarted) {
        outcome = { ...outcome, state: "failed", error: errorMessage(error) };
      } else {
        outcome = { state: "waiting", error: errorMessage(error) };
        submissionStarted = false;
      }
    }
  }

  function verifiedSignature(request: Record<string, unknown>, expected: Address): Buffer | null {
    const { bytes } = issued.authorization;
    let signature: Buffer;
    try {
      if (request.route === "message" && typeof request.signatureBase58 === "string") {
        signature = Buffer.from(getBase58Encoder().encode(request.signatureBase58));
      } else if (
        request.route === "transaction" &&
        typeof request.signedTransactionBase64 === "string"
      ) {
        const wire = Buffer.from(request.signedTransactionBase64, "base64");
        if (wire.toString("base64") !== request.signedTransactionBase64) return null;
        const transaction = getTransactionDecoder().decode(wire);
        if (!bytes.equals(Buffer.from(transaction.messageBytes))) return null;
        // Kit maps signature slots to the signers in the decoded message's account-key order.
        const indexedSignature = transaction.signatures[expected];
        if (!indexedSignature) return null;
        signature = Buffer.from(indexedSignature);
      } else {
        return null;
      }
      const publicKey = createPublicKey({
        key: Buffer.concat([ED25519_SPKI, keyBytes(expected)]),
        format: "der",
        type: "spki",
      });
      if (signature.length !== 64 || !verify(null, bytes, publicKey, signature)) {
        return null;
      }
    } catch {
      return null;
    }

    return signature;
  }

  async function verifyRequest(body: unknown): Promise<Check> {
    const request =
      typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    if (!isRole(request.role)) return refuse("UNKNOWN_ROLE");
    // Keep the expiry check and signature collection in the same synchronous step.
    const currentSlot = await transport.getSlot();
    if (currentSlot > issued.expiry) return refuse("INTENT_EXPIRED");
    const expected = state[request.role].wallet;
    const addressMatches = request.address === expected;
    const signature = addressMatches ? verifiedSignature(request, expected) : null;
    const result: Check = signature
      ? { verified: true }
      : refuse(addressMatches ? "BAD_SIGNATURE" : "WRONG_ADDRESS");
    if (request.route === "message" || request.route === "transaction") {
      checks[request.role][request.route] = result;
    }
    if (signature && !submissionStarted) {
      if (!signatures.has(expected)) signatures.set(expected, signature);
      if (signatures.size === 2) {
        submissionStarted = true;
        void submit();
      }
    }
    return result;
  }

  function dispatch(method: string | undefined, target: string, body?: unknown) {
    const url = new URL(target, "http://127.0.0.1");
    if (method === "GET" && url.pathname === "/intent") {
      const role = url.searchParams.get("role");
      return isRole(role) ? intent(role) : refuse("UNKNOWN_ROLE");
    }
    if (method === "POST" && url.pathname === "/signature") return verifyRequest(body);
    if (method === "GET" && url.pathname === "/outcome") {
      return {
        ...outcome,
        checks: { sender: { ...checks.sender }, receiver: { ...checks.receiver } },
      };
    }
    return null;
  }

  return { intent, dispatch };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 8_192) throw new Error("Signature request is too large");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function listen(relay: Awaited<ReturnType<typeof createRelay>>, port: number) {
  const server = createServer(async (request, response) => {
    const target = request.url ?? "/";
    let body: unknown;
    try {
      const url = new URL(target, "http://127.0.0.1");
      if (request.method === "POST" && url.pathname === "/signature") {
        body = await readJson(request);
      }
    } catch {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify(refuse("BAD_SIGNATURE")));
      return;
    }
    let result;
    try {
      result = await relay.dispatch(request.method, target, body);
    } catch {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify(refuse("CHAIN_UNAVAILABLE")));
      return;
    }
    response.writeHead(result === null ? 404 : 200, { "content-type": "application/json" });
    response.end(JSON.stringify(result));
  });
  return server.listen(port, "127.0.0.1");
}
