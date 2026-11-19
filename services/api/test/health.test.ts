import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let handler: typeof import("../src/main.ts").handler;

beforeAll(async () => {
  vi.stubEnv("SUPABASE_URL", "http://127.0.0.1:54321");
  vi.stubEnv("SUPABASE_ANON_KEY", "test-anon");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service");
  vi.stubEnv("SITE_URL", "http://localhost:3100");
  vi.stubEnv("CORS_ORIGIN", "http://localhost:3100");
  ({ handler } = await import("../src/main.ts"));
});

afterAll(() => vi.unstubAllEnvs());

function request(method: string, path: string): APIGatewayProxyEventV2 {
  return {
    rawPath: path,
    requestContext: { http: { method, path } },
  } as APIGatewayProxyEventV2;
}

describe("api health", () => {
  it("returns the exact health response on GET /health", async () => {
    expect(await handler(request("GET", "/health"))).toEqual({
      statusCode: 200,
      body: '{"status":"ok","service":"api"}',
    });
  });

  it.each([
    ["POST", "/health"],
    ["HEAD", "/health"],
    ["GET", "/"],
    ["GET", "/health/"],
  ])("returns 404 on %s %s", async (method, path) => {
    expect(await handler(request(method, path))).toMatchObject({ statusCode: 404 });
  });
});
