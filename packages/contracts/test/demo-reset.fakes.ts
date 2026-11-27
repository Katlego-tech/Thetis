// Shared fakes for the demo-reset suites: an in-memory local Supabase, a throwaway keys
// directory and a cast file of throwaway wallets. Nothing here reaches a network or a database.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSigner } from "@solana/kit";
import { afterAll } from "vitest";
import {
  type DemoCast,
  type LocalStack,
  localStack,
  WALLET_KEYS,
} from "../../../scripts/demo-reset.ts";
import { loadOrCreateKey, parseSeedOrganisations } from "../../../scripts/seed-demo.ts";
import { DO_BLOCK, insertTag, rowsOutput } from "./fixtures/supabase-db-query-2.122.1.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, "../../..");
export const seedSql = readFileSync(join(repoRoot, "supabase/seed.sql"), "utf8");
export const organisations = parseSeedOrganisations(seedSql);

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/**
 * The local stack with an in-memory database behind the real `localStack(...).query`: the fake
 * plays the Supabase CLI and prints exactly what 2.122.1 prints (fixtures/supabase-db-query-2.122.1.ts),
 * so a write without RETURNING yields a bare command tag, not JSON.
 */
export function fakeStack(
  options: {
    apiUrl?: string;
    listening?: number[];
    marker?: string | null;
    /** Seconds since the one indexer checkpoint was polled; undefined means no checkpoint row. */
    checkpointAge?: number | null;
    checkpointProtocol?: string;
  } = {},
) {
  const calls: string[] = [];
  let marker = options.marker ?? null;
  const users = new Map<string, string>();
  const memberships = new Set<string>();
  let resets = 0;
  const writeOutput = (sql: string, rows: Record<string, unknown>[]): string =>
    /\breturning\b/i.test(sql) ? rowsOutput(rows) : insertTag(rows.length);
  const cli = (args: string[]): string => {
    const sql = args.at(-1) as string;
    if (args[0] !== "db" || args[1] !== "query")
      throw new Error(`the fake CLI only runs db query, not ${args.join(" ")}`);
    if (/^\s*do\b/i.test(sql)) return DO_BLOCK;
    if (/from private\.settings/.test(sql))
      return rowsOutput(marker === null ? [] : [{ value: marker }]);
    if (/insert into private\.settings/.test(sql)) {
      marker = /'(fiat-[a-z]+-run-\d\d)'/.exec(sql)?.[1] ?? null;
      return writeOutput(sql, marker === null ? [] : [{ key: "demo_run", value: marker }]);
    }
    if (/from public\.indexer_checkpoints/.test(sql)) {
      if (options.checkpointAge === undefined) return rowsOutput([]);
      return rowsOutput([
        {
          age: options.checkpointAge,
          protocol: options.checkpointProtocol ?? "G9GNDdbYKQY14xv1xgNw1D6EY8SFnZxgHrDBdEbHsoo3",
        },
      ]);
    }
    const email = /lower\('([^']+)'\)/.exec(sql)?.[1];
    if (/from auth\.users/.test(sql) && email !== undefined) {
      const id = users.get(email);
      return rowsOutput(id === undefined ? [] : [{ id }]);
    }
    if (/insert into public\.memberships/.test(sql)) {
      const inserted: Record<string, unknown>[] = [];
      for (const match of sql.matchAll(/\('([0-9a-f-]{36})', '([0-9a-f-]{36})'/g)) {
        const key = `${match[1]} ${match[2]}`;
        if (memberships.has(key)) continue;
        memberships.add(key);
        inserted.push({ organisation_id: match[1], user_id: match[2] });
      }
      return writeOutput(sql, inserted);
    }
    throw new Error(`the fake CLI has no answer for: ${sql}`);
  };
  const real = localStack(repoRoot, cli);
  const stack: LocalStack & {
    calls: string[];
    resets: () => number;
    users: Map<string, string>;
    memberships: Set<string>;
    marker: () => string | null;
  } = {
    calls,
    resets: () => resets,
    users,
    memberships,
    marker: () => marker,
    status: async () => ({
      apiUrl: options.apiUrl ?? "http://127.0.0.1:54321",
      serviceRoleKey: "service-role-key-for-tests",
    }),
    listening: async (port: number) => (options.listening ?? []).includes(port),
    resetDatabase: async () => {
      resets += 1;
      marker = null;
      users.clear();
      memberships.clear();
      calls.push("reset");
    },
    createUser: async (email: string) => {
      calls.push(`createUser ${email}`);
      if (users.has(email)) return "exists";
      const id = `00000000-0000-4000-8000-${String(users.size + 1).padStart(12, "0")}`;
      users.set(email, id);
      return id;
    },
    query: async (sql: string) => {
      calls.push(sql);
      return real.query(sql);
    },
  };
  return stack;
}

export async function keysDir(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "thetis-demo-keys-"));
  temps.push(dir);
  for (const role of ["deployer", "admin", "accreditor"] as const) await loadOrCreateKey(dir, role);
  for (const organisation of organisations) await loadOrCreateKey(dir, `org-${organisation.slug}`);
  return dir;
}

export const USERS: DemoCast["users"] = [
  { email: "phone1@thetis-demo.test", organisations: ["kopano", "port-t1"] },
  { email: "phone2@thetis-demo.test", organisations: ["mosela"] },
  { email: "khunou@thetis-demo.test", organisations: ["khunou"] },
  { email: "lender-one@thetis-demo.test", organisations: ["lender-one"] },
  { email: "lender-two@thetis-demo.test", organisations: ["lender-two"] },
  { email: "buyer@thetis-demo.test", organisations: ["buyer-smelter"] },
];

export async function castFile(dir: string, edit?: (cast: DemoCast) => void): Promise<DemoCast> {
  const wallets = {} as Record<(typeof WALLET_KEYS)[number], string>;
  for (const key of WALLET_KEYS) wallets[key] = (await generateKeyPairSigner()).address;
  const cast: DemoCast = { wallets, users: USERS.map((user) => ({ ...user })) };
  edit?.(cast);
  writeFileSync(join(dir, "demo-cast.json"), JSON.stringify(cast));
  return cast;
}
