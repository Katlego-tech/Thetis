#!/usr/bin/env node
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { address, createKeyPairSignerFromBytes } from "@solana/kit";
import { runRefusalChecks } from "./attacks.ts";
import { runIntentRefusals } from "./intent/refusals.ts";
import { createIntentRelay, listenIntent } from "./intent/relay.ts";
import { setupIntent } from "./intent/setup.ts";
import { readIntentState } from "./intent/state.ts";
import { INTENT_PROGRAM_KEY } from "./intent/wire.ts";
import { createRelay, listen } from "./relay.ts";
import { acquireSetupLock, setup } from "./setup.ts";
import { errorMessage, intentRpcTransport, requireDevnet, rpcTransport } from "./transport.ts";
import { readState, requireCompleteState } from "./state.ts";

const configDir = join(homedir(), ".config", "thetis");
const statePath = join(configDir, "signing-spike-state.json");

const intentStatePath = join(configDir, "intent-spike-state.json");

async function programAddress(programKey = "signing_spike") {
  const anchor = await readFile(new URL("../../../Anchor.toml", import.meta.url), "utf8");
  const sections = anchor.split(/^\[/m);
  for (const cluster of ["devnet", "localnet"]) {
    const section = sections.find((value) => value.startsWith(`programs.${cluster}]`));
    const key = section?.match(new RegExp(`^\\s*${programKey}\\s*=\\s*"([^"]+)"`, "m"))?.[1];
    if (key) return address(key);
  }
  throw new Error(`Anchor.toml is missing the ${programKey} program address`);
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

async function intentCommand(command: "intent-setup" | "intent-serve" | "intent-refusals") {
  const transport = intentRpcTransport(
    process.env.THETIS_RPC_URL ?? "https://api.devnet.solana.com",
  );
  await requireDevnet(transport);
  const program = await programAddress(INTENT_PROGRAM_KEY);
  const sponsor = await readSponsor();
  if (command === "intent-setup") {
    await setupIntent(
      transport,
      sponsor,
      program,
      configuredWallet("THETIS_SENDER"),
      configuredWallet("THETIS_RECEIVER"),
      intentStatePath,
    );
    console.log(`Intent relay state saved to ${intentStatePath}`);
    return;
  }
  if (command === "intent-refusals") {
    await runIntentRefusals(transport, sponsor, program);
    return;
  }

  const state = await readIntentState(intentStatePath);
  if (!state?.complete)
    throw new Error(`Run signing-relay intent-setup to complete ${intentStatePath}`);
  if (state.program !== program)
    throw new Error("Intent relay state program does not match Anchor.toml");
  const port = Number(process.env.THETIS_PORT ?? "8787");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Invalid THETIS_PORT");
  const relay = await createIntentRelay(transport, sponsor, state);
  const server = listenIntent(relay, port);
  server.once("listening", () => console.log(`Intent relay listening on http://127.0.0.1:${port}`));
  server.on("error", reportError);
}

async function main() {
  const command = process.argv[2];
  if (command === "intent-setup" || command === "intent-serve" || command === "intent-refusals") {
    await intentCommand(command);
    return;
  }
  if (command === "--help") {
    console.log(
      "Usage: signing-relay <setup|serve|attacks|intent-setup|intent-serve|intent-refusals>",
    );
    return;
  }
  if (command !== "setup" && command !== "serve" && command !== "attacks") {
    throw new Error("Usage: signing-relay <setup|serve|attacks>");
  }
  const transport = rpcTransport(process.env.THETIS_RPC_URL ?? "https://api.devnet.solana.com");
  await requireDevnet(transport);
  if (command === "setup") {
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    const releaseLock = await acquireSetupLock(`${statePath}.lock`);
    try {
      if ((await readState(statePath))?.complete) {
        console.log(`Reusing existing signing relay state at ${statePath}`);
        return;
      }
      await setup(
        transport,
        await readSponsor(),
        await programAddress(),
        configuredWallet("THETIS_SENDER"),
        configuredWallet("THETIS_RECEIVER"),
        [],
        statePath,
      );
      console.log(`Signing relay state saved to ${statePath}`);
    } finally {
      await releaseLock();
    }
    return;
  }
  const existing = await requireCompleteState(statePath);
  const sponsor = await readSponsor();
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
