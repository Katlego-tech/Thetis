import { createPublicKey, verify } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import {
  type Address,
  getBase58Encoder,
  getTransactionDecoder,
  type KeyPairSigner,
  type Signature,
} from "@solana/kit";
import { readBatch, readLookupTable, readNonce } from "./setup.ts";
import { type ChainTransport, errorMessage, prepareTransaction } from "./transport.ts";
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

type Refusal = "WRONG_ADDRESS" | "BAD_SIGNATURE" | "UNKNOWN_ROLE" | "ALREADY_SUBMITTED";
interface Outcome {
  state: "waiting" | "submitted" | "confirmed" | "failed";
  signature?: Signature;
  error?: string;
  sizeBytes?: number;
}

const refuse = (reason: Refusal) => ({ verified: false, reason });
const isRole = (role: unknown): role is Role => role === "sender" || role === "receiver";

export async function createRelay(
  transport: ChainTransport,
  sponsor: KeyPairSigner,
  state: RelayState,
  log: (line: string) => void = console.log,
) {
  const [slot, batch, nonce, table] = await Promise.all([
    transport.getSlot(),
    readBatch(transport, state),
    readNonce(transport, state.nonce, sponsor.address),
    readLookupTable(transport, state.lookupTable),
  ]);
  const expiry = slot + EXPIRY_SLOTS;
  const authorization = authorize(sponsor.address, state, nonce, expiry, batch.sequence);
  const authorizationBase64 = authorization.bytes.toString("base64");
  const authorizationSha256 = sha256(authorization.bytes).toString("hex");
  const decodedIntent = {
    text: `Hand over 2,000.000 t of CR-0001 from ${FROM} to ${TO}. Expires at slot ${expiry}. Synthetic test data.`,
    batchId: state.batchId,
    quantityKg: "2000000",
    from: FROM,
    to: TO,
    expirySlot: Number(expiry),
    expectedSequence: Number(batch.sequence),
  };

  const signatures = new Map<Address, Buffer>();
  let submissionStarted = false;
  let outcome: Outcome = { state: "waiting" };

  function intent(role: Role) {
    return {
      role,
      expectedAddress: state[role].wallet,
      authorizationBase64,
      authorizationSha256,
      intent: decodedIntent,
      network: "devnet",
    };
  }

  async function submit() {
    try {
      const { transaction, lifetime, sizeBytes } = await prepareTransaction(
        transport,
        sponsor,
        [submitInstruction(authorization, signatures)],
        { tables: { [state.lookupTable]: table.addresses } },
      );
      log(`Signed relay size: ${sizeBytes} bytes`);
      const signature = await transport.send(transaction);
      outcome = { state: "submitted", signature, sizeBytes };
      log(`Devnet signature: ${signature}`);
      await transport.confirm(signature, lifetime);
      outcome = { ...outcome, state: "confirmed" };
    } catch (error) {
      outcome = { ...outcome, state: "failed", error: errorMessage(error) };
    }
  }

  function verifyRequest(body: unknown) {
    const request =
      typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    if (!isRole(request.role)) return refuse("UNKNOWN_ROLE");
    if (submissionStarted) return refuse("ALREADY_SUBMITTED");
    const expected = state[request.role].wallet;
    if (request.address !== expected) return refuse("WRONG_ADDRESS");
    let signature: Buffer;
    try {
      if (request.route === "message" && typeof request.signatureBase58 === "string") {
        signature = Buffer.from(getBase58Encoder().encode(request.signatureBase58));
      } else if (
        request.route === "transaction" &&
        typeof request.signedTransactionBase64 === "string"
      ) {
        const wire = Buffer.from(request.signedTransactionBase64, "base64");
        if (wire.toString("base64") !== request.signedTransactionBase64)
          return refuse("BAD_SIGNATURE");
        const transaction = getTransactionDecoder().decode(wire);
        if (!authorization.bytes.equals(Buffer.from(transaction.messageBytes)))
          return refuse("BAD_SIGNATURE");
        // Kit maps signature slots to the signers in the decoded message's account-key order.
        const indexedSignature = transaction.signatures[expected];
        if (!indexedSignature) return refuse("BAD_SIGNATURE");
        signature = Buffer.from(indexedSignature);
      } else {
        return refuse("BAD_SIGNATURE");
      }
      const publicKey = createPublicKey({
        key: Buffer.concat([ED25519_SPKI, keyBytes(expected)]),
        format: "der",
        type: "spki",
      });
      if (signature.length !== 64 || !verify(null, authorization.bytes, publicKey, signature)) {
        return refuse("BAD_SIGNATURE");
      }
    } catch {
      return refuse("BAD_SIGNATURE");
    }

    if (!signatures.has(expected)) signatures.set(expected, signature);
    if (signatures.size === 2) {
      submissionStarted = true;
      void submit();
    }
    return { verified: true };
  }

  function dispatch(method: string | undefined, target: string, body?: unknown) {
    const url = new URL(target, "http://127.0.0.1");
    if (method === "GET" && url.pathname === "/intent") {
      const role = url.searchParams.get("role");
      return isRole(role) ? intent(role) : refuse("UNKNOWN_ROLE");
    }
    if (method === "POST" && url.pathname === "/signature") return verifyRequest(body);
    if (method === "GET" && url.pathname === "/outcome") return outcome;
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
    try {
      const target = request.url ?? "/";
      const url = new URL(target, "http://127.0.0.1");
      const body =
        request.method === "POST" && url.pathname === "/signature"
          ? await readJson(request)
          : undefined;
      const result = relay.dispatch(request.method, target, body);
      response.writeHead(result === null ? 404 : 200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
    } catch {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify(refuse("BAD_SIGNATURE")));
    }
  });
  return server.listen(port, "127.0.0.1");
}
