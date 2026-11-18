import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

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
