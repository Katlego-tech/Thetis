import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { describe, expect, it } from "vitest";
import { handler } from "../src/main.ts";

function request(method: string, path: string): APIGatewayProxyEventV2 {
  return {
    rawPath: path,
    requestContext: { http: { method, path } },
  } as APIGatewayProxyEventV2;
}

describe("sponsor health", () => {
  it("returns the exact health response on GET /health", async () => {
    expect(await handler(request("GET", "/health"))).toEqual({
      statusCode: 200,
      body: '{"status":"ok","service":"sponsor"}',
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
