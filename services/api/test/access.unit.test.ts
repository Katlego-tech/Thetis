import { generateKeyPairSync, sign } from "node:crypto";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeBase58, verifyEd25519 } from "../src/ed25519.ts";
import { databaseErrorCode } from "../src/routes.ts";

const origin = "http://localhost:3100";
const organisationId = "b1930ef0-7812-46cf-9fdc-663acc67daa1";
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.resetModules();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("SUPABASE_URL", "http://127.0.0.1:54321");
  vi.stubEnv("SUPABASE_ANON_KEY", "test-anon");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service");
  vi.stubEnv("SITE_URL", origin);
  vi.stubEnv("CORS_ORIGIN", origin);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function request(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): APIGatewayProxyEventV2 {
  return {
    rawPath: path,
    headers,
    body,
    requestContext: { requestId: "unit-test", http: { method, path } },
  } as APIGatewayProxyEventV2;
}

describe("wallet signature primitives", () => {
  it.each([
    ["", []],
    ["1", [0]],
    ["112", [0, 0, 1]],
    ["21", [58]],
    ["JxF12TrwUP45BMd", [...Buffer.from("Hello World")]],
  ])("decodes %j", (encoded, bytes) => {
    expect(decodeBase58(encoded)).toEqual(Buffer.from(bytes));
  });

  it.each(["0", "O", "I", "l", "+", "2 ", "2\n"])("rejects %j", (encoded) => {
    expect(decodeBase58(encoded)).toBeNull();
  });

  it("verifies exact UTF-8 bytes and rejects a changed byte, wrong key, and wrong sizes", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const otherKey = generateKeyPairSync("ed25519").publicKey;
    const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
    const other = otherKey.export({ format: "der", type: "spki" }).subarray(-32);
    const message = Buffer.from("Thetis\nOrganisation: Mérwe\nAction: link_wallet", "utf8");
    const signature = sign(null, message, privateKey);
    const changed = Buffer.from(message);
    changed.write("t", 0);

    expect(verifyEd25519(raw, message, signature)).toBe(true);
    expect(verifyEd25519(raw, changed, signature)).toBe(false);
    expect(verifyEd25519(other, message, signature)).toBe(false);
    expect(verifyEd25519(raw.subarray(1), message, signature)).toBe(false);
    expect(verifyEd25519(raw, message, signature.subarray(1))).toBe(false);
  });
});

describe("database errors", () => {
  it.each([
    "VALIDATION",
    "NOT_AUTHENTICATED",
    "NOT_AUTHORISED",
    "NOT_FOUND",
    "INVITATION_EXISTS",
    "CHALLENGE_INVALID",
    "WALLET_ALREADY_LINKED",
    "EVIDENCE_VERSION_INVALID",
    "MEMBERSHIP_INVALID",
    "LINK_INVALID",
    "BAD_SIGNATURE",
    "WALLET_INVALID",
    "INTERNAL",
  ])("maps P0001 %s", (code) => {
    expect(databaseErrorCode({ code: "P0001", message: code })).toBe(code);
  });

  it.each([
    { code: "P0001", message: "sql with sensitive details" },
    { code: "23505", message: "INVITATION_EXISTS" },
    { code: "P0001", message: "constructor" },
  ])("maps unrecognised database errors to INTERNAL", (error) => {
    expect(databaseErrorCode(error)).toBe("INTERNAL");
  });

  it.each([
    ["VALIDATION", 400],
    ["NOT_AUTHENTICATED", 401],
    ["NOT_AUTHORISED", 403],
    ["NOT_FOUND", 404],
    ["INVITATION_EXISTS", 409],
    ["CHALLENGE_INVALID", 409],
    ["WALLET_ALREADY_LINKED", 409],
    ["EVIDENCE_VERSION_INVALID", 409],
    ["MEMBERSHIP_INVALID", 409],
    ["LINK_INVALID", 409],
    ["BAD_SIGNATURE", 422],
    ["WALLET_INVALID", 422],
  ])("returns HTTP %s with the contract status", async (code, status) => {
    const { handler } = await import("../src/main.ts");
    fetchMock
      .mockResolvedValueOnce(Response.json({ id: organisationId }))
      .mockResolvedValueOnce(Response.json({ code: "P0001", message: code }, { status: 400 }));
    const result = await handler(
      request(
        "POST",
        "/v1/invitations",
        {
          Authorization: "Bearer test-token",
        },
        JSON.stringify({ organisationId, email: "test@example.com", role: "member" }),
      ),
    );
    expect(result.statusCode).toBe(status);
    expect(JSON.parse(result.body ?? "")).toMatchObject({ error: { code } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("logs unexpected database failures by request ID and returns a safe 500", async () => {
    const { handler } = await import("../src/main.ts");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      fetchMock
        .mockResolvedValueOnce(Response.json({ id: organisationId }))
        .mockResolvedValueOnce(
          Response.json({ code: "23505", message: "private SQL detail" }, { status: 400 }),
        );
      const result = await handler(
        request(
          "POST",
          "/v1/invitations",
          { authorization: "Bearer test-token" },
          JSON.stringify({ organisationId, email: "test@example.com", role: "member" }),
        ),
      );
      expect(result.statusCode).toBe(500);
      expect(JSON.parse(result.body ?? "")).toEqual({
        error: { code: "INTERNAL", message: "An internal error occurred." },
      });
      expect(log).toHaveBeenCalledExactlyOnceWith("INTERNAL", { requestId: "unit-test" });
    } finally {
      log.mockRestore();
    }
  });
});

describe("request handling", () => {
  it("fails on cold start and names the missing configuration variable", async () => {
    vi.stubEnv("SUPABASE_ANON_KEY", undefined);
    await expect(import("../src/main.ts")).rejects.toThrow("SUPABASE_ANON_KEY");
  });

  it("rejects a missing bearer without calling Supabase", async () => {
    const { handler } = await import("../src/main.ts");
    const response = await handler(request("POST", "/v1/invitations"));
    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body ?? "")).toMatchObject({ error: { code: "NOT_AUTHENTICATED" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["/v1/invitations", { organisationId, email: "test@example.com", role: "member" }],
    ["/v1/wallet-links/challenges", { organisationId, wallet: "1".repeat(32) }],
    ["/v1/wallet-links", { challengeId: organisationId, signatureBase58: "1".repeat(64) }],
    [`/v1/evidence/${organisationId}/finalize`, {}],
  ])("rejects unknown fields for %s", async (path, body) => {
    const { handler } = await import("../src/main.ts");
    fetchMock.mockResolvedValueOnce(Response.json({ id: organisationId }));
    const response = await handler(
      request(
        "POST",
        path,
        { authorization: "Bearer test-token" },
        JSON.stringify({ ...body, userId: organisationId }),
      ),
    );
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body ?? "")).toMatchObject({ error: { code: "VALIDATION" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("serves allowed preflights without authentication", async () => {
    const { handler } = await import("../src/main.ts");
    const response = await handler(request("OPTIONS", "/v1/invitations", { Origin: origin }));
    expect(response.statusCode).toBe(204);
    expect(response.body).toBeUndefined();
    expect(response.headers).toMatchObject({
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "authorization, content-type",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("omits allow-origin for other origins", async () => {
    const { handler } = await import("../src/main.ts");
    const response = await handler(
      request("OPTIONS", "/v1/invitations", { origin: "https://example.com" }),
    );
    expect(response.statusCode).toBe(204);
    expect(response.headers).not.toHaveProperty("access-control-allow-origin");
  });
});
