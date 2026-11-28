import { createClient } from "@supabase/supabase-js";

/** The public judge page's read surface, as public.judge_run() returns it (judge-page.md §6.3). */
export type JudgeCheckpoint = {
  status: "backfilling" | "live" | "halted";
  indexedThroughSlot: number | null;
  lastSuccessAt: string | null;
  haltReason: string | null;
  haltedAt: string | null;
};
export type JudgeOrganisation = {
  address: string;
  displayName: string;
  role: string;
  synthetic: boolean | null;
};
export type JudgeEvent = {
  index: number;
  instruction: string;
  event: string;
  data: Record<string, unknown>;
};
export type JudgeTransaction = {
  signature: string;
  slot: number;
  blockTime: string;
  commitment: "confirmed" | "finalized";
  events: JudgeEvent[];
};
export type JudgeBeat = "second_lender" | "refused_driver" | "duplicate_intake";
export type JudgeRefusal = {
  beat: JudgeBeat;
  signature: string;
  slot: number;
  blockTime: string;
  commitment: "confirmed" | "finalized";
  errorName: string;
};
export type ConfiguredJudgeView = {
  configured: true;
  streamMatches: boolean;
  network: "devnet";
  programId: string;
  protocol: string;
  instanceLabel: string;
  expectedTransactions: number;
  expectedRefusals: number;
  checkpoint: JudgeCheckpoint | null;
  organisations: JudgeOrganisation[];
  transactions: JudgeTransaction[];
  refusals: JudgeRefusal[];
};
export type JudgeView = { configured: false } | ConfiguredJudgeView;

export class JudgeReadError extends Error {
  readonly kind: "config" | "read" | "shape";
  constructor(kind: "config" | "read" | "shape", message: string) {
    super(message);
    this.name = "JudgeReadError";
    this.kind = kind;
  }
}

const READ_TIMEOUT_MS = 8000;

/**
 * Reads the configured run with the anon key and no session (never the cookie client), and checks
 * every field. Throws JudgeReadError: `config` without the Supabase URL or key, `read` on an
 * error or timeout, `shape` on a body that is not a JudgeView.
 */
export async function readJudgeView(): Promise<JudgeView> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new JudgeReadError(
      "config",
      "NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY is not set",
    );
  }
  const client = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  let body: unknown;
  try {
    const { data, error } = await client
      .rpc("judge_run")
      .abortSignal(AbortSignal.timeout(READ_TIMEOUT_MS));
    if (error) throw new JudgeReadError("read", `judge_run failed: ${error.message}`);
    body = data;
  } catch (error) {
    if (error instanceof JudgeReadError) throw error;
    throw new JudgeReadError("read", `judge_run failed: ${String(error)}`);
  }
  return parseJudgeView(body);
}

type Json = Record<string, unknown>;

class ShapeError extends Error {}

function fail(path: string): never {
  throw new ShapeError(`judge_run: ${path} has an unexpected value`);
}
function record(value: unknown, path: string): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path);
  return value as Json;
}
function exactKeys(value: Json, keys: readonly string[], path: string): void {
  const have = Object.keys(value).sort();
  const want = [...keys].sort();
  if (have.length !== want.length || have.some((key, i) => key !== want[i])) fail(path);
}
function text(value: unknown, path: string): string {
  if (typeof value !== "string") fail(path);
  return value;
}
function integer(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail(path);
  return value;
}
function nullable<T>(value: unknown, read: (v: unknown, p: string) => T, path: string): T | null {
  return value === null ? null : read(value, path);
}
function list(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path);
  return value;
}
function oneOf<T extends string>(value: unknown, options: readonly T[], path: string): T {
  if (typeof value !== "string" || !(options as readonly string[]).includes(value)) fail(path);
  return value as T;
}
function timestamp(value: unknown, path: string): string {
  const v = text(value, path);
  if (Number.isNaN(Date.parse(v))) fail(path);
  return v;
}

const COMMITMENTS = ["confirmed", "finalized"] as const;
const VIEW_KEYS = [
  "configured",
  "streamMatches",
  "network",
  "programId",
  "protocol",
  "instanceLabel",
  "expectedTransactions",
  "expectedRefusals",
  "checkpoint",
  "organisations",
  "transactions",
  "refusals",
] as const;

/** A JudgeView from the function's body, or JudgeReadError `shape`. */
export function parseJudgeView(body: unknown): JudgeView {
  try {
    const view = record(body, "body");
    if (view.configured === false) {
      exactKeys(view, ["configured"], "body");
      return { configured: false };
    }
    if (view.configured !== true) fail("configured");
    exactKeys(view, VIEW_KEYS, "body");
    if (typeof view.streamMatches !== "boolean") fail("streamMatches");
    return {
      configured: true,
      streamMatches: view.streamMatches,
      network: oneOf(view.network, ["devnet"] as const, "network"),
      programId: text(view.programId, "programId"),
      protocol: text(view.protocol, "protocol"),
      instanceLabel: text(view.instanceLabel, "instanceLabel"),
      expectedTransactions: integer(view.expectedTransactions, "expectedTransactions"),
      expectedRefusals: integer(view.expectedRefusals, "expectedRefusals"),
      checkpoint: nullable(view.checkpoint, checkpoint, "checkpoint"),
      organisations: list(view.organisations, "organisations").map((o, i) =>
        organisation(o, `organisations[${i}]`),
      ),
      transactions: list(view.transactions, "transactions").map((t, i) =>
        transaction(t, `transactions[${i}]`),
      ),
      refusals: list(view.refusals, "refusals").map((r, i) => refusal(r, `refusals[${i}]`)),
    };
  } catch (error) {
    if (error instanceof ShapeError) throw new JudgeReadError("shape", error.message);
    throw error;
  }
}

function checkpoint(value: unknown, path: string): JudgeCheckpoint {
  const c = record(value, path);
  exactKeys(c, ["status", "indexedThroughSlot", "lastSuccessAt", "haltReason", "haltedAt"], path);
  return {
    status: oneOf(c.status, ["backfilling", "live", "halted"] as const, `${path}.status`),
    indexedThroughSlot: nullable(c.indexedThroughSlot, integer, `${path}.indexedThroughSlot`),
    lastSuccessAt: nullable(c.lastSuccessAt, timestamp, `${path}.lastSuccessAt`),
    haltReason: nullable(c.haltReason, text, `${path}.haltReason`),
    haltedAt: nullable(c.haltedAt, timestamp, `${path}.haltedAt`),
  };
}

function organisation(value: unknown, path: string): JudgeOrganisation {
  const o = record(value, path);
  exactKeys(o, ["address", "displayName", "role", "synthetic"], path);
  if (o.synthetic !== null && typeof o.synthetic !== "boolean") fail(`${path}.synthetic`);
  return {
    address: text(o.address, `${path}.address`),
    displayName: text(o.displayName, `${path}.displayName`),
    role: text(o.role, `${path}.role`),
    synthetic: o.synthetic,
  };
}

function transaction(value: unknown, path: string): JudgeTransaction {
  const t = record(value, path);
  exactKeys(t, ["signature", "slot", "blockTime", "commitment", "events"], path);
  // A successful stream transaction always has at least one event; null would mean none were stored.
  const events = list(t.events, `${path}.events`).map((e, i) => event(e, `${path}.events[${i}]`));
  if (events.length === 0) fail(`${path}.events`);
  return {
    signature: text(t.signature, `${path}.signature`),
    slot: integer(t.slot, `${path}.slot`),
    blockTime: timestamp(t.blockTime, `${path}.blockTime`),
    commitment: oneOf(t.commitment, COMMITMENTS, `${path}.commitment`),
    events,
  };
}

function event(value: unknown, path: string): JudgeEvent {
  const e = record(value, path);
  exactKeys(e, ["index", "instruction", "event", "data"], path);
  return {
    index: integer(e.index, `${path}.index`),
    instruction: text(e.instruction, `${path}.instruction`),
    event: text(e.event, `${path}.event`),
    data: record(e.data, `${path}.data`),
  };
}

function refusal(value: unknown, path: string): JudgeRefusal {
  const r = record(value, path);
  exactKeys(r, ["beat", "signature", "slot", "blockTime", "commitment", "errorName"], path);
  return {
    beat: oneOf(
      r.beat,
      ["second_lender", "refused_driver", "duplicate_intake"] as const,
      `${path}.beat`,
    ),
    signature: text(r.signature, `${path}.signature`),
    slot: integer(r.slot, `${path}.slot`),
    blockTime: timestamp(r.blockTime, `${path}.blockTime`),
    commitment: oneOf(r.commitment, COMMITMENTS, `${path}.commitment`),
    errorName: text(r.errorName, `${path}.errorName`),
  };
}
