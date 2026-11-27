// Relay configuration (live-lending.md §6.5.1), read on the first /v1/commands request.
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { type Address, isAddress } from "@solana/kit";
import { THETIS_PROGRAM_ADDRESS } from "@thetis/contracts";

export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

export type SponsorSetting =
  | { kind: "file"; path: string }
  | { kind: "lambda"; functionName: string };

export interface RelayConfig {
  network: "devnet";
  programId: Address;
  protocol: Address;
  rpcUrl: string;
  sponsor: SponsorSetting;
}

/** A refused or missing variable; every /v1/commands request is COMMANDS_UNAVAILABLE. */
export class ConfigError extends Error {
  readonly variable: string;

  constructor(variable: string) {
    super(`CONFIG_INVALID ${variable}`);
    this.name = "ConfigError";
    this.variable = variable;
  }
}

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

function inside(child: string, parent: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

/** The key file must be outside the repository and hold a JSON array of 64 numbers. */
export function readKeyFile(path: string): Uint8Array {
  if (!isAbsolute(path)) throw new ConfigError("THETIS_SPONSOR");
  let real: string;
  let value: unknown;
  try {
    real = realpathSync(path);
    value = JSON.parse(readFileSync(real, "utf8"));
  } catch {
    throw new ConfigError("THETIS_SPONSOR");
  }
  if (inside(real, realpathSync(repoRoot))) throw new ConfigError("THETIS_SPONSOR");
  if (
    !Array.isArray(value) ||
    value.length !== 64 ||
    !value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
  ) {
    throw new ConfigError("THETIS_SPONSOR");
  }
  return Uint8Array.from(value as number[]);
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  if (env.THETIS_NETWORK !== "devnet") throw new ConfigError("THETIS_NETWORK");
  if (env.THETIS_PROGRAM_ID !== THETIS_PROGRAM_ADDRESS) throw new ConfigError("THETIS_PROGRAM_ID");
  const protocol = env.THETIS_PROTOCOL ?? "";
  if (!isAddress(protocol)) throw new ConfigError("THETIS_PROTOCOL");
  const rpcUrl = env.THETIS_RPC_URL ?? "";
  let parsed: URL;
  try {
    parsed = new URL(rpcUrl);
  } catch {
    throw new ConfigError("THETIS_RPC_URL");
  }
  if (parsed.protocol !== "https:") throw new ConfigError("THETIS_RPC_URL");
  const sponsor = env.THETIS_SPONSOR ?? "";
  let setting: SponsorSetting;
  if (sponsor.startsWith("file:")) {
    if (env.THETIS_LOCAL !== "1") throw new ConfigError("THETIS_SPONSOR");
    const path = sponsor.slice("file:".length);
    readKeyFile(path);
    setting = { kind: "file", path };
  } else if (/^lambda:thetis-[a-z-]+-sponsor$/.test(sponsor)) {
    setting = { kind: "lambda", functionName: sponsor.slice("lambda:".length) };
  } else {
    throw new ConfigError("THETIS_SPONSOR");
  }
  return {
    network: "devnet",
    programId: THETIS_PROGRAM_ADDRESS,
    protocol,
    rpcUrl,
    sponsor: setting,
  };
}
