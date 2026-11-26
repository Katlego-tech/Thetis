function logHealth() {
  console.log(JSON.stringify({ status: "ok", service: "worker" }));
}

const healthTimer = setInterval(logHealth, 60_000);
const stop = new AbortController();
process.once("SIGTERM", () => {
  clearInterval(healthTimer);
  stop.abort();
});
logHealth();

/** Runs the indexer until shutdown and returns the exit code. Nothing here loads on the health path. */
async function startIndexer(signal: AbortSignal): Promise<number> {
  const { ConfigError } = await import("./indexer/errors.ts");
  try {
    const { parseConfig } = await import("./indexer/config.ts");
    const config = parseConfig(process.env);
    if (config === null) return 0;
    const { runIndexer } = await import("./indexer/loop.ts");
    return await runIndexer(config, signal);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.log(
        JSON.stringify({ level: "error", code: "CONFIG_INVALID", variable: error.variable }),
      );
      return 1;
    }
    console.log(JSON.stringify({ level: "error", code: "INDEXER_FAILED", message: String(error) }));
    return 1;
  }
}

if (process.env.THETIS_INDEXER === "on") {
  const code = await startIndexer(stop.signal);
  clearInterval(healthTimer);
  process.exit(code);
}
