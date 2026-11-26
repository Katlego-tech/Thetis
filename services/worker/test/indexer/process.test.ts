// Tests 29 and 30 run the real entry point as a child process. A --import preload replaces
// globalThis.fetch, the transport of both @solana/kit and supabase-js, so no network is used:
// every request is answered (or held) by the preload and written to a marker file.

import { spawn } from "node:child_process";
import { once } from "node:events";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { indexerEnv } from "../fixtures/harness.ts";

const entry = fileURLToPath(new URL("../../src/main.ts", import.meta.url));
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

// mode "genesis": answer getGenesisHash with `genesis`; mode "hang": hold every request until it
// is aborted. Each request is recorded as "FETCH <url> <method>", each abort as "ABORT <url>".
const preload = `
  import { appendFileSync } from "node:fs";
  const marker = process.env.FAKE_FETCH_MARKER;
  const mode = process.env.FAKE_FETCH_MODE;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    let method = "";
    try { method = JSON.parse(String(init.body ?? "{}")).method ?? ""; } catch {}
    appendFileSync(marker, "FETCH " + url + " " + method + "\\n");
    if (mode === "genesis" && method === "getGenesisHash") {
      const id = JSON.parse(String(init.body)).id;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: process.env.FAKE_GENESIS }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    return new Promise((_, reject) => {
      const signal = init.signal;
      if (!signal) return;
      signal.addEventListener("abort", () => {
        appendFileSync(marker, "ABORT " + url + "\\n");
        reject(signal.reason);
      }, { once: true });
    });
  };
`;

function startWorker(env: Record<string, string | undefined>, fake: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "thetis-indexer-"));
  const logPath = join(directory, "stdout");
  const markerPath = join(directory, "fetch");
  writeFileSync(markerPath, "");
  const stdout = openSync(logPath, "w");
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/^(THETIS_|SUPABASE_|INDEXER_|FAKE_)/.test(name),
    ),
  );
  const child = spawn(
    process.execPath,
    ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, entry],
    {
      stdio: ["ignore", stdout, "inherit"],
      env: { ...inherited, ...env, FAKE_FETCH_MARKER: markerPath, ...fake },
    },
  );
  closeSync(stdout);
  const closed = once(child, "close");
  return {
    child,
    lines: () =>
      readFileSync(logPath, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    fetches: () => readFileSync(markerPath, "utf8").split("\n").filter(Boolean),
    exit: () => child.exitCode ?? child.signalCode,
    async close() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      try {
        await closed;
      } finally {
        rmSync(directory, { recursive: true });
      }
    },
  };
}

function configInvalid(variable: string) {
  return { level: "error", code: "CONFIG_INVALID", variable };
}

describe("worker process", () => {
  it("refuses a wrong THETIS_PROGRAM_ID, a missing THETIS_FIRST_SIGNATURE and a non-devnet genesis", async () => {
    const cases: {
      env: Record<string, string | undefined>;
      variable: string;
      fake?: Record<string, string>;
    }[] = [
      {
        env: await indexerEnv({ THETIS_PROGRAM_ID: "11111111111111111111111111111111" }),
        variable: "THETIS_PROGRAM_ID",
      },
      {
        env: await indexerEnv({ THETIS_FIRST_SIGNATURE: undefined }),
        variable: "THETIS_FIRST_SIGNATURE",
      },
      {
        env: await indexerEnv(),
        variable: "THETIS_RPC_URL",
        fake: { FAKE_FETCH_MODE: "genesis", FAKE_GENESIS: MAINNET_GENESIS },
      },
    ];
    for (const item of cases) {
      const env = Object.fromEntries(
        Object.entries(item.env).filter(([, value]) => value !== undefined),
      );
      const worker = startWorker(env, item.fake);
      try {
        await expect.poll(worker.exit, { timeout: 10_000 }).toBe(1);
        expect(worker.lines()).toContainEqual(configInvalid(item.variable));
        // Nothing is written before the configuration and the network are checked.
        expect(worker.fetches().filter((line) => line.includes("127.0.0.1:54321"))).toEqual([]);
        if (item.fake) {
          expect(worker.fetches()).toContainEqual(expect.stringMatching(/getGenesisHash$/));
        }
      } finally {
        await worker.close();
      }
    }
  }, 40_000);

  it("SIGTERM stops polling and exits 0", async () => {
    const env = await indexerEnv();
    const worker = startWorker(env, { FAKE_FETCH_MODE: "hang" });
    try {
      await expect
        .poll(
          () => worker.fetches().some((line) => line.startsWith(`FETCH ${env.THETIS_RPC_URL}`)),
          {
            timeout: 10_000,
          },
        )
        .toBe(true);
      const started = worker.fetches().filter((line) => line.startsWith("FETCH")).length;
      expect(worker.child.kill("SIGTERM")).toBe(true);
      await expect.poll(worker.exit, { timeout: 12_000 }).toBe(0);
      // The RPC call in flight was aborted, and no request started after the signal.
      expect(worker.fetches().some((line) => line.startsWith(`ABORT ${env.THETIS_RPC_URL}`))).toBe(
        true,
      );
      expect(worker.fetches().filter((line) => line.startsWith("FETCH")).length).toBe(started);
      expect(worker.lines()).toContainEqual({ status: "ok", service: "worker" });
    } finally {
      await worker.close();
    }
  }, 30_000);
});
