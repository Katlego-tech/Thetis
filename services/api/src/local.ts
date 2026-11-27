import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { APIGatewayProxyEventV2 } from "aws-lambda";

const host = "127.0.0.1";
const port = 3200;
const siteOrigin = "http://localhost:3100";
const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
const envNames = ["API_URL", "ANON_KEY", "SERVICE_ROLE_KEY"] as const;

export function localSupabaseEnv() {
  let status = "";
  if (envNames.some((name) => !process.env[name])) {
    const result = spawnSync("supabase", ["status", "-o", "env"], {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 15_000,
    });
    if (result.status !== 0) {
      throw new Error(
        "Could not read local Supabase credentials. Start Supabase and check that supabase status -o env works.",
        {
          cause: result.error,
        },
      );
    }
    status = result.stdout;
  }

  function value(name: (typeof envNames)[number]): string {
    const env = process.env[name];
    if (env) return env;
    const current = status.split(/\r?\n/).find((line) => line.startsWith(`${name}=`));
    const reported = current?.slice(name.length + 1).replace(/^(["'])(.*)\1$/, "$2");
    if (!reported) throw new Error(`Missing ${name} in supabase status -o env`);
    return reported;
  }

  return {
    API_URL: value("API_URL"),
    ANON_KEY: value("ANON_KEY"),
    SERVICE_ROLE_KEY: value("SERVICE_ROLE_KEY"),
  };
}

async function gatewayEvent(
  request: IncomingMessage,
  requestId: string,
): Promise<APIGatewayProxyEventV2> {
  const target = new URL(request.url ?? "/", `http://${host}:${port}`);
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const headers = Object.fromEntries(
    Object.entries(request.headers).map(([name, value]) => [
      name,
      Array.isArray(value) ? value.join(",") : value,
    ]),
  );
  const now = Date.now();
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: target.pathname,
    rawQueryString: target.search.slice(1),
    headers,
    requestContext: {
      accountId: "local",
      apiId: "local",
      domainName: host,
      domainPrefix: "local",
      http: {
        method: request.method ?? "GET",
        path: target.pathname,
        protocol: `HTTP/${request.httpVersion}`,
        sourceIp: request.socket.remoteAddress ?? host,
        userAgent: headers["user-agent"] ?? "",
      },
      requestId,
      routeKey: "$default",
      stage: "$default",
      time: new Date(now).toISOString(),
      timeEpoch: now,
    },
    ...(chunks.length && { body: Buffer.concat(chunks).toString("utf8") }),
    isBase64Encoded: false,
  };
}

async function listen() {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = localSupabaseEnv();
  process.env.SUPABASE_URL = API_URL;
  process.env.SUPABASE_ANON_KEY = ANON_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY;
  process.env.SITE_URL ??= siteOrigin;
  process.env.CORS_ORIGIN ??= process.env.SITE_URL;
  // The relay signs in-process from a key file outside the repository on local runs only.
  process.env.THETIS_LOCAL = "1";
  const keysDir = process.env.THETIS_KEYS_DIR ?? join(homedir(), ".config/thetis/devnet");
  process.env.THETIS_SPONSOR ??= `file:${join(keysDir, "sponsor.json")}`;

  const { handler } = await import("./main.ts");
  createServer(async (request, response) => {
    const requestId = randomUUID();
    try {
      const result = await handler(await gatewayEvent(request, requestId));
      response.statusCode = result.statusCode ?? 200;
      for (const [name, value] of Object.entries(result.headers ?? {})) {
        if (value !== undefined) response.setHeader(name, String(value));
      }
      response.end(result.body);
    } catch {
      console.error("INTERNAL", { requestId });
      response.writeHead(500, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ error: { code: "INTERNAL", message: "An internal error occurred." } }),
      );
    }
  }).listen(port, host, () => {
    console.info(`Thetis API listening on http://${host}:${port}`);
  });
}

if (import.meta.main) await listen();
