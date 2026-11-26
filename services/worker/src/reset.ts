// `pnpm --filter @thetis/worker indexer:reset`: the operator's one recovery path after a halt.
// It deletes the stream's transactions, events and projections, keeps one cleared checkpoint row
// and prints the halt it cleared. It ignores THETIS_INDEXER and needs no RPC endpoint.

import { parseResetConfig } from "./indexer/config.ts";
import { ConfigError, StoreCodeError } from "./indexer/errors.ts";
import { type Stream, supabaseStore } from "./indexer/store.ts";

try {
  const config = parseResetConfig(process.env);
  const stream: Stream = {
    network: config.network,
    programId: config.programId,
    protocol: config.protocol,
  };
  const cleared = await supabaseStore(config.supabaseUrl, config.serviceRoleKey).reset(stream);
  console.log(JSON.stringify({ level: "info", code: "INDEXER_RESET", cleared }));
} catch (error) {
  if (error instanceof ConfigError) {
    console.log(
      JSON.stringify({ level: "error", code: "CONFIG_INVALID", variable: error.variable }),
    );
  } else if (error instanceof StoreCodeError) {
    console.log(
      JSON.stringify({ level: "error", code: "INDEXER_RESET_REFUSED", sqlMessage: error.code }),
    );
  } else {
    console.log(
      JSON.stringify({ level: "error", code: "INDEXER_RESET_FAILED", message: String(error) }),
    );
  }
  process.exitCode = 1;
}
