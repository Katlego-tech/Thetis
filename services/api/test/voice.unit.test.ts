import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { ElevenLabsClient, getWebrtcToken } = vi.hoisted(() => ({
  ElevenLabsClient: vi.fn(
    class {
      conversationalAi = { conversations: { getWebrtcToken } };
    },
  ),
  getWebrtcToken: vi.fn(),
}));
vi.mock("@elevenlabs/elevenlabs-js", () => ({ ElevenLabsClient }));

const origin = "http://localhost:3100";
const sessionPath = "/v1/conversations/session";
const evidencePath = "/v1/voice/lots/LOT-123/evidence";
const agentId = "test-agent";
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.resetModules();
  getWebrtcToken.mockReset();
  ElevenLabsClient.mockClear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("SUPABASE_URL", "http://127.0.0.1:54321");
  vi.stubEnv("SUPABASE_ANON_KEY", "test-anon");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service");
  vi.stubEnv("SITE_URL", origin);
  vi.stubEnv("CORS_ORIGIN", origin);
  vi.stubEnv("ELEVENLABS_API_KEY", "test-elevenlabs-key");
  vi.stubEnv("ELEVENLABS_AGENT_ID", agentId);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function call(method: string, path: string, token?: string, body?: string) {
  const { handler } = await import("../src/main.ts");
  return handler({
    version: "2.0",
    routeKey: "$default",
    rawPath: path,
    rawQueryString: "",
    headers: { origin, ...(token && { authorization: `Bearer ${token}` }) },
    ...(body !== undefined && { body }),
    isBase64Encoded: false,
    requestContext: {
      accountId: "test",
      apiId: "test",
      domainName: "localhost",
      domainPrefix: "localhost",
      requestId: "voice-unit-test",
      routeKey: "$default",
      stage: "$default",
      time: new Date().toISOString(),
      timeEpoch: Date.now(),
      http: { method, path, protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "vitest" },
    },
  });
}

function authenticate() {
  fetchMock.mockResolvedValueOnce(Response.json({ id: "test-user" }));
}

function expectError(response: Awaited<ReturnType<typeof call>>, status: number, code: string) {
  expect(response.statusCode).toBe(status);
  expect(JSON.parse(response.body ?? "")).toEqual({ error: { code, message: expect.any(String) } });
}

describe("voice session", () => {
  it("issues a fresh token per authenticated request using the configured agent", async () => {
    getWebrtcToken
      .mockResolvedValueOnce({ token: "signed-token-1", conversationId: "conversation-1" })
      .mockResolvedValueOnce({ token: "signed-token-2", conversationId: "conversation-2" });

    for (const index of [1, 2]) {
      authenticate();
      const response = await call("POST", sessionPath, "test-token");
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body ?? "")).toEqual({
        data: {
          conversationToken: `signed-token-${index}`,
          conversationId: `conversation-${index}`,
          agentId,
        },
      });
      expect(getWebrtcToken).toHaveBeenNthCalledWith(index, { agentId });
    }
    expect(ElevenLabsClient).toHaveBeenCalledTimes(2);
    expect(getWebrtcToken).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getWebrtcToken.mock.invocationCallOrder[0]).toBeGreaterThan(
      fetchMock.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it.each([undefined, "invalid-token"])("refuses bearer %s before ElevenLabs", async (token) => {
    if (token) fetchMock.mockResolvedValueOnce(Response.json({}, { status: 401 }));
    expectError(await call("POST", sessionPath, token), 401, "NOT_AUTHENTICATED");
    expect(ElevenLabsClient).not.toHaveBeenCalled();
    expect(getWebrtcToken).not.toHaveBeenCalled();
  });

  it("maps an SDK failure to a 503 without exposing SDK error details", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    authenticate();
    getWebrtcToken.mockRejectedValueOnce(new Error("private SDK detail"));
    const response = await call("POST", sessionPath, "test-token");
    expectError(response, 503, "VOICE_UNAVAILABLE");
    expect(response.body).not.toContain("private SDK detail");
    expect(getWebrtcToken).toHaveBeenCalledExactlyOnceWith({ agentId });
  });

  it.each(["ELEVENLABS_AGENT_ID", "ELEVENLABS_API_KEY"])("returns 503 without %s", async (key) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv(key, undefined);
    authenticate();
    expectError(await call("POST", sessionPath, "test-token"), 503, "VOICE_UNAVAILABLE");
    expect(log).toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain("test-elevenlabs-key");
    expect(ElevenLabsClient).not.toHaveBeenCalled();
    expect(getWebrtcToken).not.toHaveBeenCalled();
    expect((await call("GET", "/health")).statusCode).toBe(200);
  });
});

describe("voice request validation", () => {
  it.each([
    ["POST", sessionPath],
    ["GET", evidencePath],
  ])("rejects unknown body fields on %s %s before downstream calls", async (method, path) => {
    authenticate();
    expectError(await call(method, path, "test-token", '{"unexpected":true}'), 400, "VALIDATION");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ElevenLabsClient).not.toHaveBeenCalled();
  });

  it.each(["lowercase", "LOT_123", "ABCDEFGHIJKLMNOPQ", "LOT%201"])(
    "refuses invalid lot ID %s",
    async (lotId) => {
      authenticate();
      expectError(
        await call("GET", `/v1/voice/lots/${lotId}/evidence`, "test-token"),
        400,
        "VALIDATION",
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("requires authentication before reading lot evidence", async () => {
    expectError(await call("GET", evidencePath), 401, "NOT_AUTHENTICATED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("queries lot evidence with the caller credentials even without voice configuration", async () => {
    vi.stubEnv("ELEVENLABS_AGENT_ID", undefined);
    vi.stubEnv("ELEVENLABS_API_KEY", undefined);
    authenticate();
    fetchMock.mockResolvedValueOnce(Response.json([]));

    expectError(await call("GET", evidencePath, "test-token"), 404, "NOT_FOUND");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, options] = fetchMock.mock.calls[1] ?? [];
    expect(String(url)).toContain("/rest/v1/evidence_objects?");
    const query = new URL(String(url)).searchParams;
    expect(query.get("subject_kind")).toBe("eq.lot");
    expect(query.get("subject_ref")).toBe("eq.LOT-123");
    expect(query.get("select")).toBe(
      "purpose,evidence_versions!inner(version,finalized_at,sha256)",
    );
    expect(query.get("evidence_versions.finalized_at")).toBe("not.is.null");
    expect(query.get("evidence_versions.order")).toBe("version.desc");
    expect(query.get("evidence_versions.limit")).toBe("1");
    const headers = new Headers(options?.headers);
    expect(headers.get("authorization")).toBe("Bearer test-token");
    expect(headers.get("apikey")).toBe("test-anon");
    expect(ElevenLabsClient).not.toHaveBeenCalled();
  });

  it("continues past the Supabase row cap and sorts items across pages", async () => {
    authenticate();
    const version = {
      version: 1,
      finalized_at: "2026-11-22T10:00:00+00:00",
      sha256: "0123456789abcdef".repeat(4),
    };
    fetchMock
      .mockResolvedValueOnce(
        Response.json(Array(1000).fill({ purpose: "transport", evidence_versions: [version] })),
      )
      .mockResolvedValueOnce(Response.json([{ purpose: "assay", evidence_versions: [version] }]));

    const response = await call("GET", evidencePath, "test-token");
    expect(response.statusCode).toBe(200);
    const { data } = JSON.parse(response.body ?? "");
    expect(data.items).toHaveLength(1001);
    expect(data.items[0]).toEqual({
      purpose: "assay",
      version: 1,
      finalizedAt: "2026-11-22T10:00:00.000Z",
      sha256Prefix: "0123456789ab",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const secondPage = new URL(String(fetchMock.mock.calls[2]?.[0]));
    expect(secondPage.searchParams.get("offset")).toBe("1000");
    expect(secondPage.searchParams.get("order")).toBe("id.asc");
  });
});
