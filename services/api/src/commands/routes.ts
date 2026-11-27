// /v1/commands (live-lending.md §6.5.2). The access routes' bearer auth runs first in ../routes.ts.
import type { SupabaseClient } from "@supabase/supabase-js";
import { rpcChain } from "./chain.ts";
import { ConfigError, DEVNET_GENESIS_HASH, readConfig } from "./config.ts";
import {
  type Caller,
  createCommand,
  getCommand,
  postSignature,
  postTransaction,
  type Relay,
  renewCommand,
  requestTransaction,
} from "./lifecycle.ts";
import { keyFileSponsor, lambdaSponsor } from "./sponsor.ts";
import { RelayError } from "./views.ts";

export type CommandDependencies = Relay;

let configured: Promise<CommandDependencies> | undefined;

/** Read once; a refused value logs CONFIG_INVALID and the routes stay unavailable until restart. */
export function defaultDependencies(): Promise<CommandDependencies> {
  configured ??= (async () => {
    let variable = "THETIS_RPC_URL";
    try {
      const config = readConfig();
      const chain = rpcChain(config.rpcUrl);
      if ((await chain.genesisHash()) !== DEVNET_GENESIS_HASH)
        throw new ConfigError("THETIS_RPC_URL");
      const sponsor =
        config.sponsor.kind === "file"
          ? keyFileSponsor(config.sponsor.path, {
              programId: config.programId,
              protocol: config.protocol,
            })
          : lambdaSponsor(config.sponsor.functionName);
      return {
        network: config.network,
        programId: config.programId,
        protocol: config.protocol,
        chain,
        sponsor,
        sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
        now: () => Date.now(),
      };
    } catch (error) {
      if (error instanceof ConfigError) variable = error.variable;
      console.error(JSON.stringify({ level: "error", code: "CONFIG_INVALID", variable }));
      throw new RelayError("COMMANDS_UNAVAILABLE");
    }
  })();
  return configured;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isCommandPath(path: string): boolean {
  return path === "/v1/commands" || path.startsWith("/v1/commands/");
}

export async function commandRoute(
  method: string,
  path: string,
  body: (fields: readonly string[]) => Record<string, unknown>,
  auth: { userId: string; caller: SupabaseClient; service: SupabaseClient },
  dependencies: () => Promise<CommandDependencies>,
): Promise<{ status: number; data: object }> {
  const parts = path.split("/").slice(3); // ["", "v1", "commands", ...]
  const [id, action, ...rest] = parts;
  if (rest.length > 0) throw new RelayError("NOT_FOUND");
  let route: string;
  if (id === undefined && method === "POST") route = "create";
  else if (id !== undefined && action === undefined && method === "GET") route = "get";
  else if (
    id !== undefined &&
    method === "POST" &&
    ["signatures", "transaction-request", "transaction", "renew"].includes(action ?? "")
  ) {
    route = action as string;
  } else throw new RelayError("NOT_FOUND");
  if (id !== undefined && !UUID.test(id)) throw new RelayError("VALIDATION");
  const relay = await dependencies();
  const context: Caller = auth;
  const commandId = id as string;
  switch (route) {
    case "create":
      return {
        status: 201,
        data: await createCommand(relay, context, body(["kind", "organisationId", "args"])),
      };
    case "get":
      body([]);
      return { status: 200, data: await getCommand(relay, context, commandId) };
    case "signatures":
      return {
        status: 200,
        data: await postSignature(
          relay,
          context,
          commandId,
          body(["role", "wallet", "messageSha256", "signature"]),
        ),
      };
    case "transaction-request":
      return {
        status: 200,
        data: await requestTransaction(relay, context, commandId, body(["wallet"])),
      };
    case "transaction":
      return {
        status: 200,
        data: await postTransaction(relay, context, commandId, body(["transactionBase64"])),
      };
    default:
      body([]);
      return { status: 200, data: await renewCommand(relay, context, commandId) };
  }
}
