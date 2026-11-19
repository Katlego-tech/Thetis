import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { decodeBase58, verifyEd25519 } from "./ed25519.ts";
import type { AccessClients } from "./supabase.ts";

const errors = {
  VALIDATION: [400, "Invalid request body or path."],
  NOT_AUTHENTICATED: [401, "A valid bearer token is required."],
  NOT_AUTHORISED: [403, "The caller is not authorised for this action."],
  NOT_FOUND: [404, "The resource was not found."],
  INVITATION_EXISTS: [409, "An open invitation already exists."],
  CHALLENGE_INVALID: [409, "The wallet link challenge is unavailable, expired, or consumed."],
  WALLET_ALREADY_LINKED: [409, "The wallet already has an active link."],
  EVIDENCE_VERSION_INVALID: [409, "The evidence version cannot be finalized."],
  MEMBERSHIP_INVALID: [409, "The membership is invalid."],
  LINK_INVALID: [409, "The wallet link is invalid."],
  BAD_SIGNATURE: [422, "The signature does not match the wallet link challenge."],
  WALLET_INVALID: [422, "The wallet must be a base58-encoded Solana public key."],
  INTERNAL: [500, "An internal error occurred."],
} as const;

type ErrorCode = keyof typeof errors;

class RouteError extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
  }
}

export function databaseErrorCode(error: { code: string; message: string }): ErrorCode {
  if (error.code === "P0001" && Object.hasOwn(errors, error.message)) {
    return error.message as ErrorCode;
  }
  return "INTERNAL";
}

function databaseData<T>(result: { data: T; error: { code: string; message: string } | null }): T {
  if (result.error) throw new RouteError(databaseErrorCode(result.error));
  return result.data;
}

function json(statusCode: number, payload: object, cors: Record<string, string>) {
  return {
    statusCode,
    headers: { ...cors, "content-type": "application/json" },
    body: JSON.stringify(payload),
  };
}

function header(event: APIGatewayProxyEventV2, name: string): string | undefined {
  return Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1];
}

function requestBody(event: APIGatewayProxyEventV2, fields: readonly string[]) {
  const encoded = event.body ?? "";
  const raw = event.isBase64Encoded ? Buffer.from(encoded, "base64").toString("utf8") : encoded;
  if (!raw && fields.length === 0) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new RouteError("VALIDATION");
  }

  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== fields.length ||
    !fields.every((field) => Object.hasOwn(value, field))
  ) {
    throw new RouteError("VALIDATION");
  }
  return value as Record<string, unknown>;
}

function uuid(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length !== 36 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new RouteError("VALIDATION");
  }
  return value;
}

async function createInvitation(
  event: APIGatewayProxyEventV2,
  caller: SupabaseClient,
  clients: AccessClients,
) {
  const { organisationId, email, role } = requestBody(event, ["organisationId", "email", "role"]);
  const org = uuid(organisationId);
  if (typeof email !== "string" || (role !== "admin" && role !== "member")) {
    throw new RouteError("VALIDATION");
  }

  const token = databaseData(await caller.rpc("create_invitation", { org, email, role }));
  const { error } = await clients.service.auth.admin.createUser({ email, email_confirm: false });
  if (error && error.code !== "email_exists" && error.code !== "user_already_exists") {
    throw new RouteError("INTERNAL");
  }

  const tokenDigest = createHash("sha256").update(token).digest("hex");
  const invitation = databaseData(
    await caller
      .from("invitations")
      .select("expires_at")
      .eq("token_sha256", `\\x${tokenDigest}`)
      .maybeSingle(),
  );
  if (!invitation) throw new RouteError("NOT_FOUND");
  return {
    inviteUrl: `${clients.siteUrl}/invite?token=${token}`,
    expiresAt: invitation.expires_at,
  };
}

function walletBytes(wallet: string): Buffer | null {
  if (wallet.length < 32 || wallet.length > 44) return null;
  const decoded = decodeBase58(wallet);
  return decoded?.length === 32 ? decoded : null;
}

async function issueWalletLinkChallenge(event: APIGatewayProxyEventV2, caller: SupabaseClient) {
  const { organisationId, wallet } = requestBody(event, ["organisationId", "wallet"]);
  const org = uuid(organisationId);
  if (typeof wallet !== "string") throw new RouteError("VALIDATION");
  if (!walletBytes(wallet)) throw new RouteError("WALLET_INVALID");

  const challenge = databaseData(
    await caller.rpc("issue_wallet_link_challenge", { org, wallet }).single<{
      challenge_id: string;
      message: string;
      expires_at: string;
    }>(),
  );
  if (!challenge) throw new RouteError("INTERNAL");
  return {
    challengeId: challenge.challenge_id,
    message: challenge.message,
    expiresAt: challenge.expires_at,
  };
}

async function completeWalletLink(
  event: APIGatewayProxyEventV2,
  caller: SupabaseClient,
  service: SupabaseClient,
) {
  const { challengeId, signatureBase58 } = requestBody(event, ["challengeId", "signatureBase58"]);
  const id = uuid(challengeId);
  if (typeof signatureBase58 !== "string" || signatureBase58.length > 88) {
    throw new RouteError("VALIDATION");
  }

  const challenge = databaseData(
    await caller
      .from("wallet_link_challenges")
      .select("id, wallet, message, expires_at, consumed_at")
      .eq("id", id)
      .maybeSingle(),
  );
  if (
    !challenge ||
    challenge.consumed_at !== null ||
    Date.parse(challenge.expires_at) <= Date.now()
  ) {
    throw new RouteError("CHALLENGE_INVALID");
  }

  const signature = decodeBase58(signatureBase58);
  const wallet = walletBytes(challenge.wallet);
  if (
    !signature ||
    !wallet ||
    !verifyEd25519(wallet, Buffer.from(challenge.message, "utf8"), signature)
  ) {
    throw new RouteError("BAD_SIGNATURE");
  }

  const linkId = databaseData(
    await service.rpc("complete_wallet_link", { challenge_id: challenge.id }),
  );
  const link = databaseData(
    await caller.from("signer_links").select("organisation_id").eq("id", linkId).single(),
  );
  if (!link) throw new RouteError("INTERNAL");
  return { linkId, wallet: challenge.wallet, organisationId: link.organisation_id };
}

async function finalizeEvidence(
  caller: SupabaseClient,
  service: SupabaseClient,
  userId: string,
  versionId: string,
) {
  const version = databaseData(
    await caller
      .from("evidence_versions")
      .select("storage_path, uploaded_by, finalized_at")
      .eq("id", versionId)
      .maybeSingle(),
  );
  if (!version || version.finalized_at !== null) throw new RouteError("NOT_FOUND");
  if (version.uploaded_by !== userId) throw new RouteError("NOT_AUTHORISED");

  const { data: original, error } = await service.storage
    .from("originals")
    .download(version.storage_path);
  if (error || !original) throw new RouteError("INTERNAL");
  const bytes = Buffer.from(await original.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const sizeBytes = bytes.length;
  databaseData(
    await service.rpc("finalize_evidence_version", {
      version_id: versionId,
      sha256,
      size_bytes: sizeBytes,
    }),
  );
  return { versionId, sha256, sizeBytes };
}

async function evidenceDownloadUrl(
  caller: SupabaseClient,
  service: SupabaseClient,
  versionId: string,
) {
  const version = databaseData(
    await caller
      .from("evidence_versions")
      .select("storage_path, finalized_at")
      .eq("id", versionId)
      .maybeSingle(),
  );
  if (!version || version.finalized_at === null) throw new RouteError("NOT_FOUND");

  const expiresInSeconds = 60;
  const { data, error } = await service.storage
    .from("originals")
    .createSignedUrl(version.storage_path, expiresInSeconds);
  if (error || !data) throw new RouteError("INTERNAL");
  return { url: data.signedUrl, expiresInSeconds };
}

export async function route(
  event: APIGatewayProxyEventV2,
  clients: AccessClients,
): Promise<APIGatewayProxyStructuredResultV2> {
  const { rawPath, requestContext } = event;
  const { method } = requestContext.http;
  const allowedOrigin = header(event, "origin") === clients.corsOrigin;
  const cors: Record<string, string> = {
    vary: "Origin",
    ...(allowedOrigin && { "access-control-allow-origin": clients.corsOrigin }),
  };
  if (method === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        ...cors,
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "authorization, content-type",
      },
    };
  }
  if (method === "GET" && rawPath === "/health") {
    const health = { statusCode: 200, body: JSON.stringify({ status: "ok", service: "api" }) };
    return header(event, "origin") === undefined ? health : { ...health, headers: cors };
  }

  try {
    const isInvitation = method === "POST" && rawPath === "/v1/invitations";
    const isChallenge = method === "POST" && rawPath === "/v1/wallet-links/challenges";
    const isComplete = method === "POST" && rawPath === "/v1/wallet-links";
    const isFinalize = method === "POST" && /^\/v1\/evidence\/[^/]+\/finalize$/.test(rawPath);
    const isDownload = method === "GET" && /^\/v1\/evidence\/[^/]+\/download-url$/.test(rawPath);
    if (!isInvitation && !isChallenge && !isComplete && !isFinalize && !isDownload) {
      throw new RouteError("NOT_FOUND");
    }

    const token = /^Bearer ([^\s,]+)$/i.exec(header(event, "authorization") ?? "")?.[1];
    if (!token) throw new RouteError("NOT_AUTHENTICATED");
    const {
      data: { user },
      error,
    } = await clients.service.auth.getUser(token);
    if (error && error.status !== 400 && error.status !== 401 && error.status !== 403) {
      throw new RouteError("INTERNAL");
    }
    if (error || !user) throw new RouteError("NOT_AUTHENTICATED");
    const caller = clients.caller(token);

    let data: object;
    if (isInvitation) {
      data = await createInvitation(event, caller, clients);
    } else if (isChallenge) {
      data = await issueWalletLinkChallenge(event, caller);
    } else if (isComplete) {
      data = await completeWalletLink(event, caller, clients.service);
    } else {
      const versionId = uuid(rawPath.split("/")[3]);
      requestBody(event, []);
      data = isFinalize
        ? await finalizeEvidence(caller, clients.service, user.id, versionId)
        : await evidenceDownloadUrl(caller, clients.service, versionId);
    }
    return json(200, { data }, cors);
  } catch (error) {
    const code = error instanceof RouteError ? error.code : "INTERNAL";
    if (code === "INTERNAL") console.error("INTERNAL", { requestId: requestContext.requestId });
    const [status, message] = errors[code];
    return json(status, { error: { code, message } }, cors);
  }
}
