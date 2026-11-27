// A real `next dev` server over the app: the status codes and redirects a browser gets, which the
// page and proxy unit tests cannot show (a page that throws after its loading skeleton has been sent
// still answers 200, and a proxy that passes a request through shows the page's own failure).

import { type ChildProcessByStdio, spawn } from "node:child_process";
import { createServer } from "node:net";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { PROGRAM_ID, PROTOCOL } from "./snapshot";

const SUPABASE = {
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "synthetic-anon-key",
};
const CHAIN = {
  THETIS_NETWORK: "devnet",
  THETIS_PROGRAM_ID: PROGRAM_ID,
  THETIS_PROTOCOL: PROTOCOL,
};
const appDir = fileURLToPath(new URL("../..", import.meta.url));
const nextBin = fileURLToPath(new URL("../../node_modules/next/dist/bin/next", import.meta.url));

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
}

function started(child: ChildProcessByStdio<null, Readable, Readable>): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("Ready in")) resolve();
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code) => reject(new Error(`next dev exited ${code}: ${output}`)));
  });
}

/** Runs `check` against a dev server that sees exactly `variables` of the Thetis configuration. */
async function withServer(
  variables: Record<string, string>,
  check: (
    get: (path: string) => Promise<{ status: number; location: string | null; body: string }>,
  ) => Promise<void>,
) {
  const env = { ...process.env, NODE_ENV: "development" } satisfies NodeJS.ProcessEnv;
  for (const name of Object.keys(env)) {
    if (name.startsWith("THETIS_") || name.startsWith("NEXT_PUBLIC_SUPABASE_")) {
      delete (env as NodeJS.ProcessEnv)[name];
    }
  }
  const port = await freePort();
  const child = spawn(process.execPath, [nextBin, "dev", "--port", String(port)], {
    cwd: appDir,
    env: { ...env, ...variables },
    stdio: ["ignore", "pipe", "pipe"] as const,
  });
  try {
    await started(child);
    await check(async (path) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { redirect: "manual" });
      return {
        status: response.status,
        location: response.headers.get("location"),
        body: await response.text(),
      };
    });
  } finally {
    child.removeAllListeners("exit");
    child.kill("SIGTERM");
  }
}

const signedOut = [
  ["/khunou/queue", "/login?next=%2Fkhunou%2Fqueue"],
  ["/khunou/queue?filter=overdue", "/login?next=%2Fkhunou%2Fqueue%3Ffilter%3Doverdue"],
  ["/khunou/exceptions", "/login?next=%2Fkhunou%2Fexceptions"],
  ["/khunou/lots/CR-0001", "/login?next=%2Fkhunou%2Flots%2FCR-0001"],
  ["/", "/login?next=%2F"],
] as const;

describe("routes on a running server", () => {
  test("a signed-out visitor is redirected to sign in, whether or not the chain variables are set", async () => {
    for (const variables of [
      { THETIS_DATA_SOURCE: "live", ...SUPABASE },
      { THETIS_DATA_SOURCE: "live", ...SUPABASE, ...CHAIN },
      { THETIS_DATA_SOURCE: "live", ...SUPABASE, ...CHAIN, THETIS_PROTOCOL: "not-base58" },
    ]) {
      await withServer(variables, async (get) => {
        for (const [path, location] of signedOut) {
          const response = await get(path);
          expect([path, response.status, response.location]).toEqual([path, 307, location]);
          expect(response.body).not.toContain("could not be read");
        }
      });
    }
  }, 120_000);

  test("the release route in live mode sends a signed-out visitor to sign in", async () => {
    for (const variables of [
      { THETIS_DATA_SOURCE: "live", ...SUPABASE, ...CHAIN },
      { THETIS_DATA_SOURCE: "live", ...SUPABASE },
    ]) {
      await withServer(variables, async (get) => {
        const response = await get("/khunou/releases/R-0001");
        expect([variables, response.status, response.location]).toEqual([
          variables,
          307,
          "/login?next=%2Fkhunou%2Freleases%2FR-0001",
        ]);
      });
    }
  }, 120_000);

  test("reference mode serves the fixture pages", async () => {
    for (const variables of [{ THETIS_DATA_SOURCE: "reference" }, {}]) {
      await withServer(variables, async (get) => {
        for (const path of ["/khunou/queue", "/lender-one/releases/rel-0001"]) {
          const response = await get(path);
          expect([path, response.status]).toEqual([path, 200]);
        }
      });
    }
  }, 120_000);
});
