// Shared fakes for the demo-reset suites: an in-memory local Supabase, a throwaway keys
// directory and a cast file of throwaway wallets. Nothing here reaches a network or a database.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSigner } from "@solana/kit";
import { afterAll } from "vitest";
import { type DemoCast, type LocalStack, WALLET_KEYS } from "../../../scripts/demo-reset.ts";
import { loadOrCreateKey, parseSeedOrganisations } from "../../../scripts/seed-demo.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, "../../..");
export const seedSql = readFileSync(join(repoRoot, "supabase/seed.sql"), "utf8");
export const organisations = parseSeedOrganisations(seedSql);

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

export function fakeStack(options: { apiUrl?: string; listening?: number[]; marker?: string | null } = {}) {
  const calls: string[] = [];
  let marker = options.marker ?? null;
  const users = new Map<string, string>();
  const memberships = new Set<string>();
  let resets = 0;
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
      if (/from private\.settings/.test(sql)) return marker === null ? [] : [{ value: marker }];
      if (/insert into private\.settings/.test(sql)) {
        marker = /'(fiat-[a-z]+-run-\d\d)'/.exec(sql)?.[1] ?? null;
        return [];
      }
      if (/from public\.indexer_checkpoints/.test(sql)) return [];
      const email = /lower\('([^']+)'\)/.exec(sql)?.[1];
      if (/from auth\.users/.test(sql) && email !== undefined) {
        const id = users.get(email);
        return id === undefined ? [] : [{ id }];
      }
      if (/insert into public\.memberships/.test(sql)) {
        for (const match of sql.matchAll(/\('([0-9a-f-]{36})', '([0-9a-f-]{36})'/g)) {
          memberships.add(`${match[1]} ${match[2]}`);
        }
        return [];
      }
      return [];
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
