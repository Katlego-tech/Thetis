// Worker configuration for the indexer (environment variables, validated once at start).

import { isAddress } from "@solana/kit";
import { THETIS_PROGRAM_ADDRESS } from "@thetis/contracts";
import { ConfigError } from "./errors.ts";

export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

export type Env = Record<string, string | undefined>;

export type IndexerConfig = {
  network: "devnet";
  rpcUrl: string;
  programId: string;
  protocol: string;
  firstSignature: string;
  supabaseUrl: string;
  serviceRoleKey: string;
  pollMs: number;
  reconcileMs: number;
};

/** What `indexer:reset` needs: the stream and the database, no RPC. */
export type ResetConfig = Pick<
  IndexerConfig,
  "network" | "programId" | "protocol" | "supabaseUrl" | "serviceRoleKey"
>;

const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const DECIMAL = /^[1-9][0-9]*$/;

function required(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") throw new ConfigError(name);
  return value;
}

function interval(env: Env, name: string, fallback: number, min: number, max: number): number {
  const text = env[name];
  if (text === undefined || text === "") return fallback;
  if (!DECIMAL.test(text)) throw new ConfigError(name);
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new ConfigError(name);
  return value;
}

function stream(env: Env): Pick<IndexerConfig, "network" | "programId" | "protocol"> {
  if (required(env, "THETIS_NETWORK") !== "devnet") throw new ConfigError("THETIS_NETWORK");
  const programId = required(env, "THETIS_PROGRAM_ID");
  if (programId !== (THETIS_PROGRAM_ADDRESS as string)) throw new ConfigError("THETIS_PROGRAM_ID");
  const protocol = required(env, "THETIS_PROTOCOL");
  if (!isAddress(protocol)) throw new ConfigError("THETIS_PROTOCOL");
  return { network: "devnet", programId, protocol };
}

/** The configuration of `indexer:reset`, which ignores THETIS_INDEXER. */
export function parseResetConfig(env: Env): ResetConfig {
  return {
    ...stream(env),
    supabaseUrl: required(env, "SUPABASE_URL"),
    serviceRoleKey: required(env, "SUPABASE_SERVICE_ROLE_KEY"),
  };
}

/** Null unless THETIS_INDEXER=on. A refused variable throws ConfigError. */
export function parseConfig(env: Env): IndexerConfig | null {
  if (env.THETIS_INDEXER !== "on") return null;
  const base = stream(env);
  const rpcUrl = required(env, "THETIS_RPC_URL");
  let parsed: URL;
  try {
    parsed = new URL(rpcUrl);
  } catch {
    throw new ConfigError("THETIS_RPC_URL");
  }
  if (parsed.protocol !== "https:") throw new ConfigError("THETIS_RPC_URL");
  const firstSignature = required(env, "THETIS_FIRST_SIGNATURE");
  if (!SIGNATURE.test(firstSignature)) throw new ConfigError("THETIS_FIRST_SIGNATURE");
  return {
    ...base,
    rpcUrl,
    firstSignature,
    supabaseUrl: required(env, "SUPABASE_URL"),
    serviceRoleKey: required(env, "SUPABASE_SERVICE_ROLE_KEY"),
    pollMs: interval(env, "INDEXER_POLL_MS", 5_000, 1_000, 60_000),
    reconcileMs: interval(env, "INDEXER_RECONCILE_MS", 600_000, 60_000, 3_600_000),
  };
}
