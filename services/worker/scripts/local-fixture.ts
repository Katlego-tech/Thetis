// `pnpm --filter @thetis/worker local-fixture`: loads the synthetic lot history, cut after the
// issue of lot CR-0001, into the LOCAL Supabase through the real indexer and store. The confirmed
// head is the issue's slot and the finalized head the slot before it, so the lot stays Confirmed.
// Every key, signature and slot here is synthetic (see test/fixtures/synthetic.ts).

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseConfig } from "../src/indexer/config.ts";
import { createIndexer } from "../src/indexer/loop.ts";
import { type Stream, supabaseStore } from "../src/indexer/store.ts";
import { fakeChain, fixture, lotHistory, PROGRAM } from "../test/fixtures/synthetic.ts";

const LOCAL_URL = "http://127.0.0.1:54321";
const ISSUE_SLOT = 12_000;
const FINALIZED_SLOT = 11_000;
const MAX_POLLS = 10;
const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));

function serviceRoleKey(): string {
  const fromEnvironment = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (fromEnvironment) return fromEnvironment;
  const result = spawnSync("supabase", ["status", "-o", "env"], {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 15_000,
  });
  if (result.status !== 0) {
    throw new Error("Could not read local Supabase credentials: start Supabase (supabase start).");
  }
  const line = result.stdout.split(/\r?\n/).find((entry) => entry.startsWith("SERVICE_ROLE_KEY="));
  const key = line?.slice("SERVICE_ROLE_KEY=".length).replace(/^(["'])(.*)\1$/, "$2");
  if (!key) throw new Error("Missing SERVICE_ROLE_KEY in supabase status -o env");
  return key;
}

async function main(): Promise<number> {
  const url = process.env.SUPABASE_URL ?? LOCAL_URL;
  if (url !== LOCAL_URL) {
    console.error(`refusing SUPABASE_URL ${url}: this script only writes to ${LOCAL_URL}`);
    return 1;
  }
  const f = await fixture();
  const config = parseConfig({
    THETIS_INDEXER: "on",
    THETIS_NETWORK: "devnet",
    THETIS_RPC_URL: "https://rpc.synthetic.invalid",
    THETIS_PROGRAM_ID: PROGRAM,
    THETIS_PROTOCOL: f.protocol,
    THETIS_FIRST_SIGNATURE: f.seedSignatures.deploy,
    SUPABASE_URL: url,
    SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey(),
  });
  if (!config) throw new Error("the indexer configuration is switched off");

  const chain = fakeChain((await lotHistory()).filter((entry) => entry.slot <= ISSUE_SLOT));
  chain.setConfirmedSlot(ISSUE_SLOT);
  chain.setFinalizedSlot(FINALIZED_SLOT);
  const store = supabaseStore(config.supabaseUrl, config.serviceRoleKey);
  const stream: Stream = { network: "devnet", programId: PROGRAM, protocol: f.protocol };
  const indexer = createIndexer({
    chain,
    store,
    config,
    now: () => new Date(),
    log: (line) => console.log(JSON.stringify(line)),
  });

  for (let poll = 1; poll <= MAX_POLLS; poll += 1) {
    const result = await indexer.runPoll();
    if (result === "halted") {
      console.error("the indexer halted");
      return 1;
    }
    const checkpoint = await store.checkpoint(stream);
    if (result === "ok" && checkpoint?.status === "live") {
      console.log(
        JSON.stringify({ status: "live", indexedThroughSlot: checkpoint.indexedThroughSlot }),
      );
      return 0;
    }
  }
  console.error(`the stream was not live after ${MAX_POLLS} polls`);
  return 1;
}

process.exit(await main());
