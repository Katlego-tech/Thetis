import { NextRequest } from "next/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PROGRAM_ID, PROTOCOL } from "./snapshot";

type CookieList = { name: string; value: string; options: Record<string, unknown> }[];
type Methods = {
  getAll: () => { name: string; value: string }[];
  setAll: (cookies: CookieList, headers: Record<string, string>) => void;
};
const ssr = vi.hoisted(() => ({
  created: [] as { url: string; key: string; cookies: Methods }[],
  getUser: null as null | ((cookies: Methods) => Promise<unknown>),
}));
vi.mock("@supabase/ssr", () => ({
  createServerClient: (url: string, key: string, options: { cookies: Methods }) => {
    ssr.created.push({ url, key, cookies: options.cookies });
    return {
      auth: {
        getUser: () => {
          if (!ssr.getUser) throw new Error("getUser was not set up");
          return ssr.getUser(options.cookies);
        },
      },
    };
  },
}));

const { config, proxy } = await import("@/proxy");

function liveEnvironment() {
  vi.stubEnv("THETIS_DATA_SOURCE", "live");
  vi.stubEnv("THETIS_NETWORK", "devnet");
  vi.stubEnv("THETIS_PROGRAM_ID", PROGRAM_ID);
  vi.stubEnv("THETIS_PROTOCOL", PROTOCOL);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "synthetic-anon-key");
}

function request(path: string) {
  return new NextRequest(new URL(path, "http://localhost:3100"), {
    headers: { cookie: "sb-127-auth-token=old" },
  });
}

const refreshed = (cookies: Methods) => {
  cookies.setAll(
    [
      { name: "sb-127-auth-token", value: "stale", options: { path: "/" } },
      { name: "sb-127-auth-token", value: "fresh", options: { path: "/", httpOnly: true } },
      { name: "sb-127-auth-token.1", value: "second", options: { path: "/" } },
    ],
    { "Cache-Control": "private, no-cache, no-store, must-revalidate, max-age=0" },
  );
};

beforeEach(() => {
  ssr.created = [];
  ssr.getUser = null;
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const passesThrough = (response: Response) =>
  expect(response.headers.get("x-middleware-next")).toBe("1");

test("the proxy redirects to /login with path and query when there is no session, passes through in reference mode and on bad config, and carries refreshed cookies", async () => {
  expect(config.matcher).toEqual([
    "/((?!_next/|reference(?:/|$)|login(?:/|$)|invite(?:/|$)|account(?:/|$)|terms(?:/|$)|privacy(?:/|$)|favicon\\.ico$|.*\\..*).*)",
  ]);

  // Reference mode, unset or explicit: no Supabase client at all.
  passesThrough(await proxy(request("/khunou/queue")));
  vi.stubEnv("THETIS_DATA_SOURCE", "reference");
  passesThrough(await proxy(request("/khunou/queue")));
  expect(ssr.created).toHaveLength(0);

  // An invalid source, or no Supabase URL or key, passes through so the page can report CONFIG.
  vi.stubEnv("THETIS_DATA_SOURCE", "staging");
  passesThrough(await proxy(request("/khunou/queue")));
  liveEnvironment();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
  passesThrough(await proxy(request("/khunou/queue")));
  liveEnvironment();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
  passesThrough(await proxy(request("/khunou/queue")));
  expect(ssr.created).toHaveLength(0);

  // The release route is a live page like the others: its session is checked, and reference mode
  // leaves it alone.
  vi.stubEnv("THETIS_DATA_SOURCE", "reference");
  passesThrough(await proxy(request("/khunou/releases/R-0001")));
  expect(ssr.created).toHaveLength(0);
  liveEnvironment();
  ssr.getUser = async () => ({
    data: { user: null },
    error: { name: "AuthSessionMissingError", status: 400 },
  });
  expect((await proxy(request("/lender-one/releases/rel-0001"))).headers.get("location")).toBe(
    "http://localhost:3100/login?next=%2Flender-one%2Freleases%2Frel-0001",
  );
  ssr.created = [];

  // A chain variable that is missing or wrong is the page's to report: a signed-out visitor is
  // still sent to sign in, never shown the read failure.
  liveEnvironment();
  vi.stubEnv("THETIS_PROTOCOL", "not-base58");
  ssr.getUser = async () => ({
    data: { user: null },
    error: { name: "AuthSessionMissingError", status: 400 },
  });
  expect((await proxy(request("/khunou/queue"))).headers.get("location")).toBe(
    "http://localhost:3100/login?next=%2Fkhunou%2Fqueue",
  );
  ssr.getUser = async () => ({
    data: { user: { id: "21000000-0000-4000-8000-000000000001" } },
    error: null,
  });
  passesThrough(await proxy(request("/khunou/queue")));
  ssr.created = [];

  // No session: redirect with the path and query, carrying the cookies the client wrote.
  liveEnvironment();
  let before: unknown = null;
  ssr.getUser = async (cookies) => {
    before = cookies.getAll();
    refreshed(cookies);
    return { data: { user: null }, error: { name: "AuthSessionMissingError", status: 400 } };
  };
  const missing = await proxy(request("/khunou/lots/CR-0001?tab=custody"));
  expect(missing.status).toBe(307);
  expect(missing.headers.get("location")).toBe(
    "http://localhost:3100/login?next=%2Fkhunou%2Flots%2FCR-0001%3Ftab%3Dcustody",
  );
  expect(missing.cookies.get("sb-127-auth-token")?.value).toBe("fresh");
  expect(missing.cookies.get("sb-127-auth-token.1")?.value).toBe("second");
  expect(missing.headers.get("cache-control")).toContain("no-store");
  expect(ssr.created[0]).toMatchObject({
    url: "http://127.0.0.1:54321",
    key: "synthetic-anon-key",
  });
  expect(before).toEqual([{ name: "sb-127-auth-token", value: "old" }]);
  // The client reads the request's cookies, which now hold what it wrote.
  expect(ssr.created[0]?.cookies.getAll()).toEqual([
    { name: "sb-127-auth-token", value: "fresh" },
    { name: "sb-127-auth-token.1", value: "second" },
  ]);

  ssr.getUser = async () => ({ data: { user: null }, error: null });
  expect((await proxy(request("/"))).headers.get("location")).toBe(
    "http://localhost:3100/login?next=%2F",
  );

  // A rejected session adds reason=expired.
  for (const status of [401, 403]) {
    ssr.getUser = async () => ({ data: { user: null }, error: { name: "AuthApiError", status } });
    const rejected = await proxy(request("/khunou/queue?filter=overdue"));
    expect(rejected.headers.get("location")).toBe(
      "http://localhost:3100/login?next=%2Fkhunou%2Fqueue%3Ffilter%3Doverdue&reason=expired",
    );
  }

  // Signed in: the request goes on, with the refreshed cookies on the response and the request.
  ssr.getUser = async (cookies) => {
    refreshed(cookies);
    return { data: { user: { id: "21000000-0000-4000-8000-000000000001" } }, error: null };
  };
  const signedIn = await proxy(request("/khunou/queue"));
  passesThrough(signedIn);
  expect(signedIn.cookies.get("sb-127-auth-token")?.value).toBe("fresh");
  expect(signedIn.cookies.get("sb-127-auth-token")).toMatchObject({ httpOnly: true, path: "/" });
  expect(signedIn.cookies.get("sb-127-auth-token.1")?.value).toBe("second");
  expect(signedIn.headers.get("x-middleware-request-cookie")).toContain("sb-127-auth-token=fresh");
  expect(signedIn.headers.get("cache-control")).toContain("no-store");

  // A failed auth read passes through, still carrying any refreshed cookies.
  ssr.getUser = async (cookies) => {
    refreshed(cookies);
    return { data: { user: null }, error: { name: "AuthUnknownError", status: 502 } };
  };
  const failed = await proxy(request("/khunou/queue"));
  passesThrough(failed);
  expect(failed.cookies.get("sb-127-auth-token")?.value).toBe("fresh");
  ssr.getUser = () => Promise.reject(new TypeError("fetch failed"));
  passesThrough(await proxy(request("/khunou/queue")));
});
