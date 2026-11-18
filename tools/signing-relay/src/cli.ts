#!/usr/bin/env node
import { link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type Address, address, createKeyPairSignerFromBytes } from "@solana/kit";
import { runRefusalChecks } from "./attacks.ts";
import { createRelay, listen } from "./relay.ts";
import { setup } from "./setup.ts";
import { errorMessage, rpcTransport } from "./transport.ts";
import type { Party, RelayState } from "./wire.ts";

const configDir = join(homedir(), ".config", "thetis");
const statePath = join(configDir, "signing-spike-state.json");

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid signing relay state");
  }
  return value as Record<string, unknown>;
}

function readAddress(value: unknown): Address {
  if (typeof value !== "string") throw new Error("Missing signing relay address");
  return address(value);
}

function readParty(value: unknown): Party {
  const party = object(value);
  return {
    wallet: readAddress(party.wallet),
    party: readAddress(party.party),
    signer: readAddress(party.signer),
  };
}

function missingFile(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function readState(): Promise<RelayState | null> {
  let contents: string;
  try {
    contents = await readFile(statePath, "utf8");
  } catch (error) {
    if (missingFile(error)) return null;
    throw error;
  }
  const state = object(JSON.parse(contents));
  if (typeof state.batchId !== "string" || !/^[0-9a-f]{32}$/.test(state.batchId)) {
    throw new Error("Invalid batch ID in signing relay state");
  }
  return {
    program: readAddress(state.program),
    batchId: state.batchId,
    batch: readAddress(state.batch),
    sender: readParty(state.sender),
    receiver: readParty(state.receiver),
    nonce: readAddress(state.nonce),
    lookupTable: readAddress(state.lookupTable),
  };
}

async function writeState(state: RelayState) {
  const temporaryDirectory = await mkdtemp(join(dirname(statePath), ".signing-spike-"));
  try {
    const temporaryFile = join(temporaryDirectory, "state.json");
    await writeFile(temporaryFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    // Publish a complete file in one operation. link refuses an existing destination.
    await link(temporaryFile, statePath);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function programAddress() {
  const anchor = await readFile(new URL("../../../Anchor.toml", import.meta.url), "utf8");
  const sections = anchor.split(/^\[/m);
  for (const cluster of ["devnet", "localnet"]) {
    const section = sections.find((value) => value.startsWith(`programs.${cluster}]`));
    const key = section?.match(/^\s*signing_spike\s*=\s*"([^"]+)"/m)?.[1];
    if (key) return address(key);
  }
  throw new Error("Anchor.toml is missing the signing_spike program address");
}

async function readSponsor() {
  const override = process.env.THETIS_SPONSOR_KEYPAIR;
  const path = override?.startsWith("~/")
    ? join(homedir(), override.slice(2))
    : (override ?? join(configDir, "devnet-sponsor.json"));
  const contents = await readFile(path, "utf8");
  let bytes: unknown;
  try {
    bytes = JSON.parse(contents);
  } catch {
    throw new Error("Sponsor keypair file must contain a JSON array of 64 bytes");
  }
  if (
    !Array.isArray(bytes) ||
    bytes.length !== 64 ||
    !bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
  ) {
    throw new Error("Sponsor keypair file must contain a JSON array of 64 bytes");
  }
  return createKeyPairSignerFromBytes(Uint8Array.from(bytes));
}

function configuredWallet(name: "THETIS_SENDER" | "THETIS_RECEIVER") {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} to the intended devnet wallet address`);
  return address(value);
}

async function main() {
  const command = process.argv[2];
  if (command !== "setup" && command !== "serve" && command !== "attacks") {
    throw new Error("Usage: signing-relay <setup|serve|attacks>");
  }
  const existing = await readState();
  if (command === "setup" && existing) {
    console.log(`Reusing existing signing relay state at ${statePath}`);
    return;
  }
  if (command !== "setup" && !existing) {
    throw new Error(`Run signing-relay setup to create ${statePath}`);
  }

  const sponsor = await readSponsor();
  const transport = rpcTransport(process.env.THETIS_RPC_URL ?? "https://api.devnet.solana.com");
  if (command === "setup") {
    const sender = configuredWallet("THETIS_SENDER");
    const receiver = configuredWallet("THETIS_RECEIVER");
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    const lock = `${statePath}.lock`;
    await mkdir(lock, { mode: 0o700 });
    try {
      if (await readState()) {
        console.log(`Reusing existing signing relay state at ${statePath}`);
        return;
      }
      const state = await setup(transport, sponsor, await programAddress(), sender, receiver);
      await writeState(state);
      console.log(`Signing relay state saved to ${statePath}`);
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
    return;
  }
  if (!existing) throw new Error("Signing relay state is missing");
  if (command === "attacks") {
    await runRefusalChecks(transport, sponsor, existing);
    return;
  }
  const port = Number(process.env.THETIS_PORT ?? "8787");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Invalid THETIS_PORT");
  const relay = await createRelay(transport, sponsor, existing);
  const server = listen(relay, port);
  server.once("listening", () =>
    console.log(`Signing relay listening on http://127.0.0.1:${port}`),
  );
  server.on("error", reportError);
}

function reportError(error: unknown) {
  console.error(errorMessage(error));
  process.exitCode = 1;
}

void main().catch(reportError);
