import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { localSupabaseEnv } from "../src/local.ts";

const { getWebrtcToken } = vi.hoisted(() => ({ getWebrtcToken: vi.fn() }));
vi.mock("@elevenlabs/elevenlabs-js", () => ({
  ElevenLabsClient: class {
    conversationalAi = { conversations: { getWebrtcToken } };
  },
}));

const agentId = "integration-agent";
const sessionPath = "/v1/conversations/session";
const origin = "http://localhost:3100";
const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
const namespace = randomUUID();
const password = "Thetis-local-integration-password";
const clientOptions = { auth: { autoRefreshToken: false, persistSession: false } };

interface Account {
  id: string;
  token: string;
  client: SupabaseClient;
}

let service: SupabaseClient;
let admin: Account;
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
  return { id: user.id, token: session.access_token, client };
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
  vi.stubEnv("ELEVENLABS_API_KEY", "integration-elevenlabs-key");
  vi.stubEnv("ELEVENLABS_AGENT_ID", agentId);
  ({ handler } = await import("../src/main.ts"));

  service = createClient(API_URL, SERVICE_ROLE_KEY, clientOptions);
  try {
    [admin, reader, outsider] = await Promise.all([
      createAccount("admin"),
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
    select id, '${reader.id}'::uuid, 'member'::public.member_role from orgs where id = '${readerOrgId}'
  `,
    ],
    { cwd: projectRoot, timeout: 15_000 },
  );
}, 30_000);

function call(method: string, path: string, token?: string) {
  return handler({
    version: "2.0",
    routeKey: "$default",
    rawPath: path,
    rawQueryString: "",
    headers: { origin, ...(token && { authorization: `Bearer ${token}` }) },
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

function expectError(response: Awaited<ReturnType<typeof call>>, status: number, code: string) {
  expect(response.statusCode).toBe(status);
  expect(JSON.parse(response.body ?? "")).toEqual({ error: { code, message: expect.any(String) } });
}

afterAll(() => {
  vi.unstubAllEnvs();
});

function newLotId() {
  return randomUUID().replaceAll("-", "").slice(0, 16).toUpperCase();
}

function evidence(lotId: string, actor: Account) {
  return call("GET", `/v1/voice/lots/${lotId}/evidence`, actor.token);
}

async function createEvidenceObject(lotId: string, purpose: string, kind = "lot") {
  const { id } = mustSucceed(
    await admin.client
      .from("evidence_objects")
      .insert({
        owner_organisation_id: organisationId,
        subject_kind: kind,
        subject_ref: lotId,
        purpose,
        created_by: admin.id,
      })
      .select("id")
      .single(),
  );
  return id;
}

async function createEvidenceVersion(objectId: string, version: number) {
  const mime = "application/pdf";
  const storagePath = `${organisationId}/${objectId}/${version}`;
  const filename = `private-original-${version}.pdf`;
  const original = Buffer.from(`%PDF-1.4\nThetis evidence ${filename}\n%%EOF\n`);
  const { id } = mustSucceed(
    await admin.client
      .from("evidence_versions")
      .insert({
        object_id: objectId,
        version,
        storage_path: storagePath,
        mime,
        uploaded_by: admin.id,
      })
      .select("id")
      .single(),
  );

  return {
    storagePath,
    filename,
    async finalize(purpose: string) {
      mustSucceed(
        await admin.client.storage.from("originals").upload(storagePath, original, {
          contentType: mime,
          metadata: { filename },
        }),
      );
      expect((await call("POST", `/v1/evidence/${id}/finalize`, admin.token)).statusCode).toBe(200);
      const row = mustSucceed(
        await admin.client.from("evidence_versions").select("finalized_at").eq("id", id).single(),
      );
      return {
        purpose,
        version,
        finalizedAt: new Date(row.finalized_at).toISOString(),
        sha256Prefix: createHash("sha256").update(original).digest("hex").slice(0, 12),
      };
    },
  };
}

describe("voice session with Supabase Auth", () => {
  it("issues a token to a signed-in caller", async () => {
    getWebrtcToken.mockReset().mockResolvedValueOnce({
      token: "integration-signed-token",
      conversationId: "integration-conversation",
    });
    const result = await call("POST", sessionPath, admin.token);
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body ?? "")).toEqual({
      data: {
        conversationToken: "integration-signed-token",
        conversationId: "integration-conversation",
        agentId,
      },
    });
    expect(getWebrtcToken).toHaveBeenCalledExactlyOnceWith({ agentId });
  });

  it.each([undefined, "invalid-token"])(
    "refuses bearer %s without calling ElevenLabs",
    async (token) => {
      getWebrtcToken.mockReset();
      expectError(await call("POST", sessionPath, token), 401, "NOT_AUTHENTICATED");
      expect(getWebrtcToken).not.toHaveBeenCalled();
    },
  );

  it("returns 503 when ElevenLabs fails", async () => {
    getWebrtcToken.mockReset().mockRejectedValueOnce(new Error("private SDK detail"));
    expectError(await call("POST", sessionPath, admin.token), 503, "VOICE_UNAVAILABLE");
    expect(getWebrtcToken).toHaveBeenCalledExactlyOnceWith({ agentId });
  });
});

describe("lot evidence visibility", () => {
  it("returns only the latest finalized version of each matching object in disclosure order", async () => {
    const lotId = newLotId();
    const transport = await createEvidenceObject(lotId, "transport");
    const assay = await createEvidenceObject(lotId, "assay");
    const laterAssay = await createEvidenceObject(lotId, "assay");
    const draft = await createEvidenceObject(lotId, "other");
    const batch = await createEvidenceObject(lotId, "bank", "batch");
    const differentLot = await createEvidenceObject(newLotId(), "bank");
    const transportVersion = await createEvidenceVersion(transport, 1);
    const transportItem = await transportVersion.finalize("transport");
    const firstAssay = await createEvidenceVersion(assay, 1);
    const latestAssay = await createEvidenceVersion(assay, 2);
    await createEvidenceVersion(assay, 3);
    await createEvidenceVersion(draft, 1);
    const assayItem = await latestAssay.finalize("assay");
    // Finalize the lower version afterwards to distinguish version order from timestamp order.
    await firstAssay.finalize("assay");
    const laterAssayItem = await (await createEvidenceVersion(laterAssay, 1)).finalize("assay");
    await (await createEvidenceVersion(batch, 1)).finalize("bank");
    await (await createEvidenceVersion(differentLot, 1)).finalize("bank");

    const before = Date.now();
    const result = await evidence(lotId, admin);
    const after = Date.now();

    expect(result.statusCode).toBe(200);
    const payload = JSON.parse(result.body ?? "");
    expect(payload).toEqual({
      data: {
        lotId,
        items: [assayItem, laterAssayItem, transportItem],
        observedAt: expect.any(String),
      },
    });
    const observedAt = new Date(payload.data.observedAt);
    expect(observedAt.toISOString()).toBe(payload.data.observedAt);
    expect(observedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(observedAt.getTime()).toBeLessThanOrEqual(after);
    for (const value of [latestAssay.filename, latestAssay.storagePath, admin.id]) {
      expect(result.body).not.toContain(value);
    }
  }, 15_000);

  it("returns byte-identical 404s for hidden, missing, and draft-only lot evidence", async () => {
    const hiddenLot = newLotId();
    const hidden = await createEvidenceObject(hiddenLot, "assay");
    await (await createEvidenceVersion(hidden, 1)).finalize("assay");
    const draftLot = newLotId();
    const draft = await createEvidenceObject(draftLot, "assay");
    await createEvidenceVersion(draft, 1);

    const hiddenResult = await evidence(hiddenLot, outsider);
    const missingResult = await evidence(newLotId(), admin);
    const draftResult = await evidence(draftLot, admin);
    for (const result of [hiddenResult, missingResult, draftResult]) {
      expectError(result, 404, "NOT_FOUND");
      expect(result.body).toBe(missingResult.body);
    }
  });

  it("shows only the granted object to a reader organisation and hides it upon revocation", async () => {
    const lotId = newLotId();
    const shared = await createEvidenceObject(lotId, "assay");
    const unshared = await createEvidenceObject(lotId, "origin");
    const sharedItem = await (await createEvidenceVersion(shared, 1)).finalize("assay");
    await (await createEvidenceVersion(unshared, 1)).finalize("origin");

    const before = await evidence(lotId, reader);
    expectError(before, 404, "NOT_FOUND");
    const { error: grantError } = await admin.client.from("evidence_access").insert({
      object_id: shared,
      organisation_id: readerOrgId,
      granted_by: admin.id,
    });
    expect(grantError).toBeNull();

    const visible = await evidence(lotId, reader);
    expect(visible.statusCode).toBe(200);
    expect(JSON.parse(visible.body ?? "")).toEqual({
      data: { lotId, items: [sharedItem], observedAt: expect.any(String) },
    });

    const { error: revokeError } = await admin.client
      .from("evidence_access")
      .update({ revoked_at: new Date().toISOString() })
      .eq("object_id", shared)
      .eq("organisation_id", readerOrgId)
      .is("revoked_at", null);
    expect(revokeError).toBeNull();
    const revoked = await evidence(lotId, reader);
    expectError(revoked, 404, "NOT_FOUND");
    expect(revoked.body).toBe(before.body);
  });

  it("rejects a malformed lot ID", async () => {
    expectError(await evidence("invalid_lot", admin), 400, "VALIDATION");
  });
});
