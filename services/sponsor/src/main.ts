import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import {
  type Address,
  createKeyPairFromBytes,
  getAddressFromPublicKey,
  isAddress,
} from "@solana/kit";
import { THETIS_PROGRAM_ADDRESS } from "@thetis/contracts";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { SponsorRefusedError } from "./allowlist.ts";
import { signAsSponsor } from "./sign.ts";

type DirectRequest =
  | { op: "address" }
  | { op: "sign"; transactionBase64: string; lookupTable: string | null };

let keys:
  | Promise<{ keyPair: Awaited<ReturnType<typeof createKeyPairFromBytes>>; address: Address }>
  | undefined;

/** The key is read once from Secrets Manager: a JSON array of 64 numbers. */
function sponsorKeys() {
  keys ??= (async () => {
    const secretId = process.env.SPONSOR_KEY_SECRET_ARN;
    if (!secretId) throw new Error("SPONSOR_KEY_SECRET_ARN is not set");
    const { SecretString } = await new SecretsManagerClient({}).send(
      new GetSecretValueCommand({ SecretId: secretId }),
    );
    const bytes = JSON.parse(SecretString ?? "null");
    if (
      !Array.isArray(bytes) ||
      bytes.length !== 64 ||
      !bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)
    ) {
      throw new Error("the sponsor key secret is not a JSON array of 64 numbers");
    }
    const keyPair = await createKeyPairFromBytes(Uint8Array.from(bytes));
    return { keyPair, address: await getAddressFromPublicKey(keyPair.publicKey) };
  })();
  return keys;
}

function context(sponsor: Address, lookupTable: string | null) {
  const protocol = process.env.THETIS_PROTOCOL ?? "";
  if (process.env.THETIS_PROGRAM_ID !== THETIS_PROGRAM_ADDRESS || !isAddress(protocol)) {
    throw new Error("THETIS_PROGRAM_ID or THETIS_PROTOCOL is invalid");
  }
  if (lookupTable !== null && !isAddress(lookupTable)) {
    throw new SponsorRefusedError("the lookup table is not an address");
  }
  return { sponsor, programId: THETIS_PROGRAM_ADDRESS, protocol, lookupTable };
}

async function direct(request: DirectRequest) {
  const { keyPair, address } = await sponsorKeys();
  if (request.op === "address") return { address };
  try {
    const transactionBase64 = await signAsSponsor(
      keyPair,
      request.transactionBase64,
      context(address, request.lookupTable),
    );
    return { transactionBase64 };
  } catch (error) {
    if (error instanceof SponsorRefusedError) return { error: "NOT_ALLOWED", detail: error.detail };
    throw error;
  }
}

/** API Gateway events (they carry requestContext) get the unchanged health handler; a direct
 * invocation `{op: "address"}` or `{op: "sign", transactionBase64, lookupTable}` signs. */
export async function handler(
  event: APIGatewayProxyEventV2 | DirectRequest,
): Promise<APIGatewayProxyStructuredResultV2 | Record<string, unknown>> {
  if (!("requestContext" in event)) return direct(event);
  if (event.requestContext.http.method !== "GET" || event.rawPath !== "/health") {
    return { statusCode: 404 };
  }
  return { statusCode: 200, body: JSON.stringify({ status: "ok", service: "sponsor" }) };
}
