import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { apiPost } from "@/lib/api";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("NEXT_PUBLIC_API_URL", "http://127.0.0.1:3200");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("apiPost sends JSON with the bearer token and returns data", async () => {
  fetchMock.mockResolvedValue(jsonResponse(200, { data: { challengeId: "c" } }));
  const body = { organisationId: "lender-one", wallet: "Solflare" };

  const result = await apiPost("/v1/wallet-links/challenges", body, "tok");

  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("http://127.0.0.1:3200/v1/wallet-links/challenges");
  expect(init.method).toBe("POST");
  const headers = new Headers(init.headers);
  expect(headers.get("authorization")).toBe("Bearer tok");
  expect(headers.get("content-type")).toBe("application/json");
  expect(init.body).toBe(JSON.stringify(body));
  expect(result).toEqual({ ok: true, data: { challengeId: "c" } });
});

test("apiPost returns the API error code and status", async () => {
  fetchMock.mockResolvedValue(
    jsonResponse(422, { error: { code: "BAD_SIGNATURE", message: "x" } }),
  );

  const result = await apiPost("/v1/wallet-links", {}, "tok");

  expect(result).toEqual({ ok: false, code: "BAD_SIGNATURE", status: 422 });
});

test("apiPost maps an unreadable or unknown error body to INTERNAL", async () => {
  fetchMock.mockResolvedValueOnce(new Response("<html>", { status: 502 }));
  expect(await apiPost("/v1/wallet-links", {}, "tok")).toEqual({
    ok: false,
    code: "INTERNAL",
    status: 502,
  });

  fetchMock.mockResolvedValueOnce(jsonResponse(409, { error: { code: "SOMETHING_NEW" } }));
  expect(await apiPost("/v1/wallet-links", {}, "tok")).toEqual({
    ok: false,
    code: "INTERNAL",
    status: 409,
  });
});

test("apiPost reports NETWORK when fetch rejects", async () => {
  fetchMock.mockRejectedValue(new TypeError("fetch failed"));

  const result = await apiPost("/v1/wallet-links", {}, "tok");

  expect(result).toEqual({ ok: false, code: "NETWORK", status: 0 });
});

test("apiPost strips the base URL's trailing slash and requires a data key", async () => {
  vi.stubEnv("NEXT_PUBLIC_API_URL", "http://127.0.0.1:3200/");
  fetchMock.mockResolvedValue(jsonResponse(200, {}));
  expect(await apiPost("/v1/wallet-links", {}, "tok")).toEqual({
    ok: false,
    code: "INTERNAL",
    status: 200,
  });
  expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:3200/v1/wallet-links");
});

test("apiPost names the missing base URL variable", async () => {
  vi.stubEnv("NEXT_PUBLIC_API_URL", "");
  await expect(apiPost("/v1/wallet-links", {}, "tok")).rejects.toThrow(
    "NEXT_PUBLIC_API_URL is not set",
  );
  expect(fetchMock).not.toHaveBeenCalled();
});
