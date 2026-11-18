import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import * as setup from "../src/setup.ts";

it("starts under Node's native TypeScript loader and prints command usage", () => {
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const directory = mkdtempSync(join(tmpdir(), "thetis-signing-cli-"));
  const stderrPath = join(directory, "stderr");
  // A file works in sandboxes that disallow the socket pair used for child-process pipes.
  const stderr = openSync(stderrPath, "w");
  try {
    const result = spawnSync(process.execPath, [cli], { stdio: ["ignore", "ignore", stderr] });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(readFileSync(stderrPath, "utf8").trim()).toBe(
      "Usage: signing-relay <setup|serve|attacks>",
    );
  } finally {
    closeSync(stderr);
    rmSync(directory, { recursive: true });
  }
});

it("reclaims a setup lock from a dead PID and excludes a concurrent live owner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "thetis-signing-lock-"));
  const lock = join(directory, "setup.lock");
  try {
    await mkdir(lock);
    // The platform cannot allocate this PID to a live process.
    const stale = "2147483647-stale";
    await mkdir(join(lock, stale));
    const release = await setup.acquireSetupLock(lock);
    try {
      const markers = await readdir(lock);
      expect(markers).toHaveLength(1);
      expect(markers[0]).toMatch(new RegExp(`^${process.pid}-`));
      await expect(setup.acquireSetupLock(lock)).rejects.toThrow(/setup.*already running/i);
      expect(await readdir(lock)).toEqual(markers);
    } finally {
      await release();
    }
    expect(await readdir(lock)).toEqual([]);
  } finally {
    await rm(directory, { recursive: true });
  }
});
