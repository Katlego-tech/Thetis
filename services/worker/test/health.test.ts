import { spawn } from "node:child_process";
import { once } from "node:events";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const health = JSON.stringify({ status: "ok", service: "worker" });

function startWorker(nodeArgs: string[] = []) {
  const directory = mkdtempSync(join(tmpdir(), "thetis-worker-"));
  const logPath = join(directory, "stdout");
  const stdout = openSync(logPath, "w");
  const child = spawn(process.execPath, [...nodeArgs, entry], {
    stdio: ["ignore", stdout, "inherit"],
  });
  closeSync(stdout);
  const closed = once(child, "close");

  return {
    child,
    lines: () => readFileSync(logPath, "utf8").trim().split("\n"),
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

it("logs health at startup and each minute, then exits cleanly on SIGTERM", async () => {
  const setup = `
    import { mock } from "node:test";
    // Mock timers do not keep the process alive between signals.
    const keepAlive = setTimeout(() => {}, 60_000);
    process.once("SIGTERM", () => clearTimeout(keepAlive));
    mock.timers.enable({ apis: ["setInterval"] });
    process.on("SIGUSR2", () => mock.timers.tick(60_000));
  `;
  const worker = startWorker(["--import", `data:text/javascript,${encodeURIComponent(setup)}`]);
  try {
    await expect.poll(worker.lines).toEqual([health]);
    expect(worker.child.kill("SIGUSR2")).toBe(true);
    await expect.poll(worker.lines).toEqual([health, health]);
    expect(worker.child.kill("SIGTERM")).toBe(true);
    await expect.poll(() => worker.child.exitCode ?? worker.child.signalCode).toBe(0);
  } finally {
    await worker.close();
  }
});

it("stops the live health timer and exits with code zero on SIGTERM", async () => {
  const worker = startWorker();
  try {
    await expect.poll(worker.lines).toEqual([health]);
    expect(worker.child.kill("SIGTERM")).toBe(true);
    await expect.poll(() => worker.child.exitCode ?? worker.child.signalCode).toBe(0);
  } finally {
    await worker.close();
  }
});
