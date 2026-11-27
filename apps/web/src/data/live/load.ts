// Server-only: reads the indexed read model as the signed-in user, so RLS scopes every row.

import type { SupabaseClient } from "@supabase/supabase-js";
import bs58 from "bs58";
import {
  COMMAND_KINDS,
  checkRow,
  type LiveSnapshot,
  OPEN_COMMAND_STATUSES,
  type RowField,
  SNAPSHOT_TABLES,
} from "./rows";
import { LiveDataError } from "./types";

const THETIS_PROGRAM_ID = "jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3";
const PAGE_END = 999;

function config(variable: string, message: string): LiveDataError {
  return new LiveDataError("CONFIG", variable, message);
}

function decodesTo32Bytes(text: string): boolean {
  try {
    return bs58.decode(text).length === 32;
  } catch {
    return false;
  }
}

/** The live configuration, checked in a fixed order; the first wrong variable is named. */
export function liveEnv(): LiveSnapshot["env"] {
  const network = process.env.THETIS_NETWORK;
  if (network !== "devnet") throw config("THETIS_NETWORK", "must be devnet");
  const programId = process.env.THETIS_PROGRAM_ID;
  if (programId !== THETIS_PROGRAM_ID)
    throw config("THETIS_PROGRAM_ID", "must be the Thetis devnet program");
  const protocol = process.env.THETIS_PROTOCOL;
  if (!protocol || !decodesTo32Bytes(protocol))
    throw config("THETIS_PROTOCOL", "must be a 32-byte base58 address");
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) throw config("NEXT_PUBLIC_SUPABASE_URL", "is not set");
  if (!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
    throw config("NEXT_PUBLIC_SUPABASE_ANON_KEY", "is not set");
  return { network, programId, protocol };
}

// The second read batch: fifteen fields, read together once the checkpoint allows it.
type Fifteen = [
  unknown[],
  unknown[],
  unknown[],
  unknown[],
  unknown[],
  unknown[],
  unknown[],
  unknown[],
  unknown[],
  unknown[],
  unknown[],
  unknown[],
  unknown[],
  unknown[],
  unknown[],
];

/** What a failed read said, for the server log only: the error's message and its code or status. */
function causeOf(error: unknown): string {
  if (typeof error !== "object" || error === null) return String(error);
  const { message, code, status } = error as Record<string, unknown>;
  const text = typeof message === "string" && message !== "" ? message : String(error);
  const tag = [code, status].filter(
    (value) => typeof value === "string" || typeof value === "number",
  );
  return tag.length > 0 ? `${text} (${tag.join(", ")})` : text;
}

/**
 * Resolves when the client has a signed-in user. A missing session is NO_SESSION at "auth.getUser",
 * a rejected one (status 401 or 403) NO_SESSION at "auth.getUser:rejected", anything else READ_FAILED.
 */
export async function requireUser(supabase: SupabaseClient): Promise<void> {
  let result: Awaited<ReturnType<SupabaseClient["auth"]["getUser"]>>;
  try {
    result = await supabase.auth.getUser();
  } catch (error) {
    throw new LiveDataError("READ_FAILED", "auth.getUser", String(error), causeOf(error));
  }
  const { data, error } = result;
  if (error) {
    if (error.name === "AuthSessionMissingError")
      throw new LiveDataError("NO_SESSION", "auth.getUser");
    if (error.status === 401 || error.status === 403) {
      throw new LiveDataError("NO_SESSION", "auth.getUser:rejected");
    }
    throw new LiveDataError("READ_FAILED", "auth.getUser", error.message, causeOf(error));
  }
  if (!data.user) throw new LiveDataError("NO_SESSION", "auth.getUser");
}

type Response = { data: unknown; error: unknown; count?: number | null };

/** One complete read of a snapshot field: every row, or an error that says why not. */
async function read(
  supabase: SupabaseClient,
  field: RowField,
  env: LiveSnapshot["env"],
): Promise<unknown[]> {
  const spec = SNAPSHOT_TABLES[field];
  let response: Response;
  try {
    let query = supabase
      .from(spec.table)
      .select(Object.keys(spec.columns).join(","), { count: "exact" });
    if (spec.filter === "events") query = query.eq("event", "LotIssued");
    if (spec.filter !== "none") query = query.eq("network", env.network);
    if (spec.filter === "events" || spec.filter === "checkpoint" || spec.filter === "commands")
      query = query.eq("program_id", env.programId);
    if (spec.filter !== "none") query = query.eq("protocol", env.protocol);
    if (spec.filter === "commands") {
      // Open commands of the lending kinds only (live-lending.md T064b.3 fold 1).
      query = query.in("status", [...OPEN_COMMAND_STATUSES]).in("kind", [...COMMAND_KINDS]);
    }
    for (const column of spec.key) query = query.order(column, { ascending: true });
    response = await query.range(0, PAGE_END);
  } catch (error) {
    throw new LiveDataError("READ_FAILED", field, String(error), causeOf(error));
  }
  const { data, error, count } = response;
  if (error) {
    throw new LiveDataError("READ_FAILED", field, "the read returned an error", causeOf(error));
  }
  if (!Array.isArray(data))
    throw new LiveDataError("READ_FAILED", field, "the read returned no rows");
  if (typeof count !== "number" || !Number.isInteger(count) || count < data.length) {
    throw new LiveDataError("READ_FAILED", field, "the read returned no usable count");
  }
  if (count > data.length) {
    throw new LiveDataError("TOO_MANY_ROWS", field, `${count} rows, ${data.length} read`);
  }
  return data;
}

function single(field: RowField, rows: unknown[]): unknown {
  if (rows.length > 1) throw new LiveDataError("BAD_ROW", field, "more than one row");
  return rows[0] ?? null;
}

/** Throws the first failure in the order given, after every read has settled. */
async function settled<T extends unknown[]>(reads: { [K in keyof T]: Promise<T[K]> }): Promise<T> {
  const results = await Promise.allSettled(reads);
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
  return results.map((result) => (result as PromiseFulfilledResult<unknown>).value) as T;
}

async function readCheckpoint(supabase: SupabaseClient, env: LiveSnapshot["env"]) {
  const row = single("checkpoint", await read(supabase, "checkpoint", env));
  if (row === null) return null;
  checkRow("checkpoint", row, "checkpoint", env);
  return row as LiveSnapshot["checkpoint"];
}

const reported = (checkpoint: LiveSnapshot["checkpoint"]) =>
  checkpoint !== null && checkpoint.last_success_at !== null;

export async function loadLiveSnapshot(
  supabase: SupabaseClient,
  env: LiveSnapshot["env"],
): Promise<LiveSnapshot> {
  // Commands are relay bookkeeping, not indexed rows: they are read whatever the checkpoint says.
  const [memberships, first, commands] = await settled<
    [unknown[], LiveSnapshot["checkpoint"], unknown[]]
  >([
    read(supabase, "memberships", env),
    readCheckpoint(supabase, env),
    read(supabase, "commands", env),
  ]);
  const empty = (checkpoint: LiveSnapshot["checkpoint"]): LiveSnapshot => ({
    env,
    memberships: memberships as LiveSnapshot["memberships"],
    organisations: [],
    protocol: null,
    classPolicies: [],
    custodianClasses: [],
    lots: [],
    positions: [],
    intakes: [],
    documents: [],
    facilities: [],
    valuations: [],
    loans: [],
    locks: [],
    payments: [],
    intents: [],
    commands: commands as LiveSnapshot["commands"],
    intakeEvents: [],
    checkpoint,
  });
  // Until the indexer reports its first successful poll the rows may be partial, so none are read.
  if (!reported(first)) return empty(first);

  const [
    organisations,
    protocol,
    classPolicies,
    custodianClasses,
    lots,
    positions,
    intakes,
    documents,
    facilities,
    valuations,
    loans,
    locks,
    payments,
    intents,
    intakeEvents,
  ] = await settled<Fifteen>([
    read(supabase, "organisations", env),
    read(supabase, "protocol", env),
    read(supabase, "classPolicies", env),
    read(supabase, "custodianClasses", env),
    read(supabase, "lots", env),
    read(supabase, "positions", env),
    read(supabase, "intakes", env),
    read(supabase, "documents", env),
    read(supabase, "facilities", env),
    read(supabase, "valuations", env),
    read(supabase, "loans", env),
    read(supabase, "locks", env),
    read(supabase, "payments", env),
    read(supabase, "intents", env),
    read(supabase, "intakeEvents", env),
  ]);
  // Read last: a reset that began while the rows were read empties the snapshot.
  const checkpoint = await readCheckpoint(supabase, env);
  if (!reported(checkpoint)) return empty(checkpoint);

  return {
    env,
    memberships: memberships as LiveSnapshot["memberships"],
    organisations: organisations as LiveSnapshot["organisations"],
    protocol: single("protocol", protocol) as LiveSnapshot["protocol"],
    classPolicies: classPolicies as LiveSnapshot["classPolicies"],
    custodianClasses: custodianClasses as LiveSnapshot["custodianClasses"],
    lots: lots as LiveSnapshot["lots"],
    positions: positions as LiveSnapshot["positions"],
    intakes: intakes as LiveSnapshot["intakes"],
    documents: documents as LiveSnapshot["documents"],
    facilities: facilities as LiveSnapshot["facilities"],
    valuations: valuations as LiveSnapshot["valuations"],
    loans: loans as LiveSnapshot["loans"],
    locks: locks as LiveSnapshot["locks"],
    payments: payments as LiveSnapshot["payments"],
    intents: intents as LiveSnapshot["intents"],
    commands: commands as LiveSnapshot["commands"],
    intakeEvents: intakeEvents as LiveSnapshot["intakeEvents"],
    checkpoint,
  };
}
