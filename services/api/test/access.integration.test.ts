import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { localSupabaseEnv } from "../src/local.ts";

const origin = "http://localhost:3100";
const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
const namespace = randomUUID();
const password = "Thetis-local-integration-password";
const clientOptions = { auth: { autoRefreshToken: false, persistSession: false } };

interface Account {
  id: string;
  email: string;
  token: string;
  client: SupabaseClient;
}

let service: SupabaseClient;
let admin: Account;
let member: Account;
let reader: Account;
let outsider: Account;
let organisationId: string;
let readerOrgId: string;
let authUrl: string;
let anonKey: string;
let handler: typeof import("../src/main.ts").handler;

function mustSucceed<T>(result: { data: T; error: { message: string } | null }): NonNullable<T> {
  if (result.error) throw new Error(result.error.message);
  if (result.data == null) throw new Error("Supabase returned no data");
  return result.data;
}

async function createAccount(name: string): Promise<Account> {
  const email = `${name}-${namespace}@example.com`;
  const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) throw created.error;
  const { user } = created.data;
  const client = createClient(authUrl, anonKey, clientOptions);
  const signedIn = await client.auth.signInWithPassword({ email, password });
  if (signedIn.error) throw signedIn.error;
  const { session } = signedIn.data;
  return { id: user.id, email, token: session.access_token, client };
}

beforeAll(async () => {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = localSupabaseEnv();
  // Fixture setup uses the local database even when the connection variables are supplied.
  const hostname = new URL(API_URL).hostname;
  if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "[::1]") {
    throw new Error("API integration tests require a local Supabase API_URL");
  }
  authUrl = API_URL;
  anonKey = ANON_KEY;
  vi.stubEnv("SUPABASE_URL", API_URL);
  vi.stubEnv("SUPABASE_ANON_KEY", ANON_KEY);
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);
  vi.stubEnv("SITE_URL", origin);
  vi.stubEnv("CORS_ORIGIN", origin);
  ({ handler } = await import("../src/main.ts"));

  service = createClient(API_URL, SERVICE_ROLE_KEY, clientOptions);
  try {
    [admin, member, reader, outsider] = await Promise.all([
      createAccount("admin"),
      createAccount("member"),
      createAccount("reader"),
      createAccount("outsider"),
    ]);
  } catch (error) {
    throw new Error(
      "Could not create integration users. Start the local Supabase stack and check its keys.",
      { cause: error },
    );
  }

  organisationId = randomUUID();
  readerOrgId = randomUUID();
  // Production grants forbid membership inserts, including by service_role.
  // Bootstrap memberships directly in the local database; all route calls use user JWTs.
  execFileSync(
    "supabase",
    [
      "db",
      "query",
      "--local",
      `
    with orgs as (
      insert into public.organisations (id, slug, name, kind, synthetic) values
        ('${organisationId}', 'owner-${namespace}', 'Integration owner', 'exporter', true),
        ('${readerOrgId}', 'reader-${namespace}', 'Integration reader', 'lender', true)
      returning id
    )
    insert into public.memberships (organisation_id, user_id, member_role)
    select id, '${admin.id}'::uuid, 'admin'::public.member_role from orgs where id = '${organisationId}'
    union all
    select id, '${member.id}'::uuid, 'member'::public.member_role from orgs where id = '${organisationId}'
    union all
    select id, '${reader.id}'::uuid, 'member'::public.member_role from orgs where id = '${readerOrgId}'
  `,
    ],
    { cwd: projectRoot, timeout: 15_000 },
  );
}, 30_000);

function call(method: string, path: string, token?: string, body?: object) {
  return handler({
    version: "2.0",
    routeKey: "$default",
    rawPath: path,
    rawQueryString: "",
    headers: { origin, ...(token && { authorization: `Bearer ${token}` }) },
    ...(body && { body: JSON.stringify(body) }),
    isBase64Encoded: false,
    requestContext: {
      accountId: "test",
      apiId: "test",
      domainName: "localhost",
      domainPrefix: "localhost",
      requestId: randomUUID(),
      routeKey: "$default",
      stage: "$default",
      time: new Date().toISOString(),
      timeEpoch: Date.now(),
      http: { method, path, protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "vitest" },
    },
  });
}

function responseData<T>(response: Awaited<ReturnType<typeof call>>): T {
  expect(response.statusCode).toBe(200);
  return JSON.parse(response.body ?? "").data;
}

function expectError(response: Awaited<ReturnType<typeof call>>, status: number, code: string) {
  expect(response.statusCode).toBe(status);
  expect(JSON.parse(response.body ?? "")).toEqual({ error: { code, message: expect.any(String) } });
}

const mailpitUrl = process.env.MAILPIT_URL ?? "http://127.0.0.1:54324";

async function mailedCode(email: string): Promise<string> {
  const search = `${mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`;
  for (let attempt = 0; attempt < 20; attempt++) {
    const found = await fetch(search);
    if (!found.ok) throw new Error(`Mailpit search failed with ${found.status}`);
    const { messages } = (await found.json()) as { messages?: { ID: string }[] };
    const latest = messages?.[0];
    if (latest) {
      const response = await fetch(`${mailpitUrl}/api/v1/message/${latest.ID}`);
      if (!response.ok) throw new Error(`Mailpit message fetch failed with ${response.status}`);
      const message = (await response.json()) as { Text?: string; HTML?: string };
      const code =
        /\b(\d{6})\b/.exec(message.Text ?? "")?.[1] ?? /\b(\d{6})\b/.exec(message.HTML ?? "")?.[1];
      if (!code) throw new Error(`Mailpit message to ${email} contains no 6-digit code`);
      return code;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`No Mailpit message arrived for ${email} within 10 seconds`);
}

describe("invitations", () => {
  function invite(actor: Account, email: string) {
    return call("POST", "/v1/invitations", actor.token, { organisationId, email, role: "member" });
  }

  it("returns a token the invitee can accept and the database expiry", async () => {
    const invitee = await createAccount("accept");
    const { inviteUrl, expiresAt } = responseData<{ inviteUrl: string; expiresAt: string }>(
      await invite(admin, invitee.email),
    );
    const url = new URL(inviteUrl);
    expect(url.origin).toBe(origin);
    expect(url.pathname).toBe("/invite");
    const token = url.searchParams.get("token");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const invitation = mustSucceed(
      await admin.client
        .from("invitations")
        .select("expires_at")
        .eq("organisation_id", organisationId)
        .eq("email", invitee.email)
        .single(),
    );
    expect(expiresAt).toBe(invitation.expires_at);
    const membershipId = mustSucceed(await invitee.client.rpc("accept_invitation", { token }));
    const membership = mustSucceed(
      await invitee.client
        .from("memberships")
        .select("user_id, organisation_id, member_role")
        .eq("id", membershipId)
        .single(),
    );
    expect(membership).toEqual({
      user_id: invitee.id,
      organisation_id: organisationId,
      member_role: "member",
    });
  });

  it("rejects a member's invitation", async () => {
    expectError(await invite(member, `forbidden-${namespace}@example.com`), 403, "NOT_AUTHORISED");
  });

  it("rejects a duplicate", async () => {
    const email = `duplicate-${namespace}@example.com`;
    responseData(await invite(admin, email));
    expectError(await invite(admin, email), 409, "INVITATION_EXISTS");
  });

  it("creates a confirmed account with no password for a new invitee", async () => {
    const email = `new-${namespace}@example.com`;
    async function matchingUsers() {
      const users = [];
      for (let page = 1; ; page++) {
        const { data, error } = await service.auth.admin.listUsers({ page, perPage: 100 });
        if (error) throw error;
        users.push(...data.users.filter((user) => user.email === email));
        if (data.users.length < 100) return users;
      }
    }
    expect(await matchingUsers()).toHaveLength(0);
    responseData(await invite(admin, email));
    const created = await matchingUsers();
    expect(created).toHaveLength(1);
    expect(created[0]?.email_confirmed_at).toBeTruthy();
    const attempt = await createClient(authUrl, anonKey, clientOptions).auth.signInWithPassword({
      email,
      password,
    });
    expect(attempt.error).not.toBeNull();
    expect(attempt.data.session).toBeNull();
  });

  it("sends an invitee a 6-digit code and gives a session only for that code", async () => {
    const email = `code-${namespace}@example.com`;
    const { inviteUrl } = responseData<{ inviteUrl: string }>(await invite(admin, email));
    const token = new URL(inviteUrl).searchParams.get("token");
    const client = createClient(authUrl, anonKey, clientOptions);
    const sent = await client.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
    expect(sent.error).toBeNull();
    const code = await mailedCode(email);
    expect(code).toMatch(/^\d{6}$/);

    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, "0");
    const refused = await client.auth.verifyOtp({ email, token: wrong, type: "email" });
    expect(refused.error).not.toBeNull();
    expect(refused.data.session).toBeNull();

    const verified = await client.auth.verifyOtp({ email, token: code, type: "email" });
    expect(verified.error).toBeNull();
    expect(verified.data.session).not.toBeNull();

    const membershipId = mustSucceed(await client.rpc("accept_invitation", { token }));
    expect(membershipId).toEqual(expect.any(String));
  });

  it("refuses an invitation to a signed-in user whose email does not match", async () => {
    const email = `mismatch-${namespace}@example.com`;
    const { inviteUrl } = responseData<{ inviteUrl: string }>(await invite(admin, email));
    const token = new URL(inviteUrl).searchParams.get("token");
    const refused = await outsider.client.rpc("accept_invitation", { token });
    expect(refused.error?.message).toBe("INVITATION_INVALID");
    const invitation = mustSucceed(
      await service.from("invitations").select("accepted_at").eq("email", email).single(),
    );
    expect(invitation.accepted_at).toBeNull();
  });
});

const base58Alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function encodeBase58(bytes: Buffer): string {
  let value = BigInt(`0x${bytes.toString("hex")}`);
  let digits = "";
  while (value > 0n) {
    digits = base58Alphabet.charAt(Number(value % 58n)) + digits;
    value /= 58n;
  }
  const leadingZeroes = bytes.findIndex((byte) => byte !== 0);
  return "1".repeat(leadingZeroes === -1 ? bytes.length : leadingZeroes) + digits;
}

function walletKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const wallet = encodeBase58(publicKey.export({ format: "der", type: "spki" }).subarray(-32));
  return { wallet, sign: (bytes: Buffer) => encodeBase58(sign(null, bytes, privateKey)) };
}

async function issueChallenge(wallet: string) {
  return responseData<{ challengeId: string; message: string; expiresAt: string }>(
    await call("POST", "/v1/wallet-links/challenges", admin.token, { organisationId, wallet }),
  );
}

function completeLink(actor: Account, challengeId: string, signatureBase58: string) {
  return call("POST", "/v1/wallet-links", actor.token, { challengeId, signatureBase58 });
}

describe("wallet links", () => {
  it("links a wallet with an Ed25519 signature over the exact message", async () => {
    const key = walletKeypair();
    const challenge = await issueChallenge(key.wallet);
    expect(challenge.message).toContain(
      "localhost:3100 wants you to link a Solana wallet to Thetis.",
    );
    const result = responseData<{ linkId: string; wallet: string; organisationId: string }>(
      await completeLink(
        admin,
        challenge.challengeId,
        key.sign(Buffer.from(challenge.message, "utf8")),
      ),
    );
    expect(result).toEqual({ linkId: expect.any(String), organisationId, wallet: key.wallet });
    const row = mustSucceed(
      await admin.client
        .from("signer_links")
        .select("challenge_id, user_id, wallet, organisation_id")
        .eq("id", result.linkId)
        .single(),
    );
    expect(row).toEqual({
      challenge_id: challenge.challengeId,
      user_id: admin.id,
      wallet: key.wallet,
      organisation_id: organisationId,
    });
  });

  it("rejects a signature over a message with one changed byte and leaves the challenge unconsumed", async () => {
    const key = walletKeypair();
    const challenge = await issueChallenge(key.wallet);
    const altered = Buffer.from(challenge.message, "utf8");
    altered.write("L", 0);
    expectError(
      await completeLink(admin, challenge.challengeId, key.sign(altered)),
      422,
      "BAD_SIGNATURE",
    );
    const row = mustSucceed(
      await admin.client
        .from("wallet_link_challenges")
        .select("consumed_at")
        .eq("id", challenge.challengeId)
        .single(),
    );
    expect(row.consumed_at).toBeNull();
  });

  it("rejects replay of a consumed challenge", async () => {
    const key = walletKeypair();
    const challenge = await issueChallenge(key.wallet);
    const signature = key.sign(Buffer.from(challenge.message, "utf8"));
    responseData(await completeLink(admin, challenge.challengeId, signature));
    expectError(
      await completeLink(admin, challenge.challengeId, signature),
      409,
      "CHALLENGE_INVALID",
    );
  });

  it("rejects another user's challenge even with a valid signature", async () => {
    const key = walletKeypair();
    const challenge = await issueChallenge(key.wallet);
    const signature = key.sign(Buffer.from(challenge.message, "utf8"));
    expectError(
      await completeLink(member, challenge.challengeId, signature),
      409,
      "CHALLENGE_INVALID",
    );
  });

  it("rejects linking the same wallet through a new challenge", async () => {
    const key = walletKeypair();
    const first = await issueChallenge(key.wallet);
    responseData(
      await completeLink(admin, first.challengeId, key.sign(Buffer.from(first.message, "utf8"))),
    );
    const second = await issueChallenge(key.wallet);
    expectError(
      await completeLink(admin, second.challengeId, key.sign(Buffer.from(second.message, "utf8"))),
      409,
      "WALLET_ALREADY_LINKED",
    );
  });
});

const original = Buffer.from("%PDF-1.4\nThetis integration evidence\n%%EOF\n");
const mime = "application/pdf";

async function uploadEvidence() {
  const { id: objectId } = mustSucceed(
    await admin.client
      .from("evidence_objects")
      .insert({
        owner_organisation_id: organisationId,
        subject_kind: "lot",
        subject_ref: namespace,
        purpose: "other",
        created_by: admin.id,
      })
      .select("id")
      .single(),
  );
  const storagePath = `${organisationId}/${objectId}/1`;
  const { id: versionId } = mustSucceed(
    await admin.client
      .from("evidence_versions")
      .insert({
        object_id: objectId,
        version: 1,
        storage_path: storagePath,
        mime,
        uploaded_by: admin.id,
      })
      .select("id")
      .single(),
  );
  mustSucceed(
    await admin.client.storage
      .from("originals")
      .upload(storagePath, original, { contentType: mime }),
  );
  return { objectId, versionId };
}

function finalize(token: string, versionId: string) {
  return call("POST", `/v1/evidence/${versionId}/finalize`, token);
}

function downloadUrl(token: string, versionId: string) {
  return call("GET", `/v1/evidence/${versionId}/download-url`, token);
}

describe("evidence", () => {
  it("finalizes the uploaded bytes once and persists their digest and size", async () => {
    const { versionId } = await uploadEvidence();
    const digest = createHash("sha256").update(original).digest("hex");
    expect(responseData(await finalize(admin.token, versionId))).toEqual({
      versionId,
      sha256: digest,
      sizeBytes: original.length,
    });
    const version = mustSucceed(
      await admin.client
        .from("evidence_versions")
        .select("sha256, size_bytes, finalized_at")
        .eq("id", versionId)
        .single(),
    );
    expect(version).toEqual({
      sha256: digest,
      size_bytes: original.length,
      finalized_at: expect.any(String),
    });
    const second = await finalize(admin.token, versionId);
    expect([409, 404]).toContain(second.statusCode);
  });

  it("refuses a member who can see the pending version but did not upload it", async () => {
    const { versionId } = await uploadEvidence();
    const result = await finalize(member.token, versionId);
    expect([403, 404]).toContain(result.statusCode);
    if (result.statusCode === 403) expectError(result, 403, "NOT_AUTHORISED");
    else expectError(result, 404, "NOT_FOUND");
  });

  it("issues a working 60-second download URL to a reader with an explicit grant", async () => {
    const { objectId, versionId } = await uploadEvidence();
    responseData(await finalize(admin.token, versionId));
    const { error } = await admin.client.from("evidence_access").insert({
      object_id: objectId,
      organisation_id: readerOrgId,
      granted_by: admin.id,
    });
    expect(error).toBeNull();
    const result = responseData<{ url: string; expiresInSeconds: number }>(
      await downloadUrl(reader.token, versionId),
    );
    expect(result.expiresInSeconds).toBe(60);
    const downloaded = await fetch(result.url);
    expect(downloaded.status).toBe(200);
    expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(original);
  });

  it("hides a finalized version from a non-reader", async () => {
    const { versionId } = await uploadEvidence();
    responseData(await finalize(admin.token, versionId));
    expectError(await downloadUrl(outsider.token, versionId), 404, "NOT_FOUND");
  });
});

describe("request handling", () => {
  it.each([undefined, "garbage"])("rejects bearer %s", async (token) => {
    expectError(await call("POST", "/v1/invitations", token), 401, "NOT_AUTHENTICATED");
  });

  it("rejects an unknown body field", async () => {
    expectError(
      await call("POST", "/v1/invitations", admin.token, {
        organisationId,
        email: `invalid-${namespace}@example.com`,
        role: "member",
        userId: member.id,
      }),
      400,
      "VALIDATION",
    );
  });

  it("answers preflight with the configured CORS headers", async () => {
    const response = await call("OPTIONS", "/v1/invitations");
    expect(response.statusCode).toBe(204);
    expect(response.headers).toMatchObject({
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "authorization, content-type",
    });
  });
});
