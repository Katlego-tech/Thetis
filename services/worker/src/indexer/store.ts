// The read model's store: the one interface the indexer writes and reads through. `supabaseStore`
// calls the database functions (the only write path) and reads with the service role;
// `memoryStore` is the same behaviour in memory, for tests.

import { createClient } from "@supabase/supabase-js";
import { type HaltError, isStoreCode, StoreCodeError } from "./errors.ts";

export type Stream = { network: "devnet"; programId: string; protocol: string };
export type ProjectionTable =
  | "chain_protocols"
  | "chain_class_policies"
  | "chain_organisations"
  | "chain_authorities"
  | "chain_custodian_classes"
  | "chain_documents"
  | "chain_intakes"
  | "chain_lots"
  | "chain_positions";
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
export type Row = Record<string, JsonValue>;
export type Upsert = { table: ProjectionTable; row: Row };
export type ApplyBatch = {
  stream: Stream;
  expectedThroughSlot: number | null;
  throughSlot: number;
  transactions: Row[];
  events: Row[];
  upserts: Upsert[];
};
export type Checkpoint = {
  status: "backfilling" | "live" | "halted";
  indexedThroughSlot: number | null;
  halt: { reason: string; detail: string; signature: string | null } | null;
};
export type CheckpointPatch = Partial<{
  lastPollAt: string;
  lastSuccessAt: string;
  consecutiveRpcErrors: number;
  status: "backfilling" | "live";
}>;
export type HaltRecord = {
  reason: string;
  detail: string;
  signature: string | null;
  haltedAt: string;
};

export interface ReadModelStore {
  checkpoint(stream: Stream): Promise<Checkpoint | null>;
  patchCheckpoint(
    stream: Stream,
    expectedThroughSlot: number | null,
    patch: CheckpointPatch,
  ): Promise<void>;
  storedSignatures(stream: Stream, signatures: string[]): Promise<Set<string>>;
  storedRows(
    stream: Stream,
    table: ProjectionTable,
    addresses: string[],
  ): Promise<Map<string, Row>>;
  organisationSlugs(orgIds: string[]): Promise<Map<string, { slug: string; synthetic: boolean }>>;
  projections(stream: Stream): Promise<Record<ProjectionTable, Map<string, Row>>>;
  confirmedTransactions(
    stream: Stream,
    maxSlot: number,
    limit: number,
  ): Promise<{ signature: string; slot: number; succeeded: boolean }[]>;
  apply(batch: ApplyBatch): Promise<void>;
  halt(stream: Stream, expectedThroughSlot: number | null, halt: HaltError): Promise<HaltRecord>;
  finalize(stream: Stream, expectedThroughSlot: number | null, signatures: string[]): Promise<void>;
  reconcile(
    stream: Stream,
    expectedThroughSlot: number | null,
    upserts: Upsert[],
    organisations: { address: string; slug: string | null; synthetic: boolean | null }[],
  ): Promise<void>;
  reset(stream: Stream): Promise<HaltRecord>;
}

// ------------------------------------------------------------------------------------------------
// Table shapes
// ------------------------------------------------------------------------------------------------

export const PROJECTION_TABLES: readonly ProjectionTable[] = [
  "chain_protocols",
  "chain_class_policies",
  "chain_organisations",
  "chain_authorities",
  "chain_custodian_classes",
  "chain_documents",
  "chain_intakes",
  "chain_lots",
  "chain_positions",
];

/** Columns every projection table starts with and every row carries. */
export const COMMON_COLUMNS = [
  "network",
  "address",
  "protocol",
  "slot",
  "commitment",
  "last_signature",
] as const;

/** The columns read from the account itself: what reconcile compares. */
export const ACCOUNT_COLUMNS: Record<ProjectionTable, readonly string[]> = {
  chain_protocols: ["instance_id_hex", "settlement_mode", "admin", "accreditor", "pause_flags"],
  chain_class_policies: [
    "class_code",
    "version",
    "unit",
    "grades",
    "origin_required",
    "lot_validity_secs",
    "split_inherits_expiry",
  ],
  chain_organisations: ["org_id", "role", "display_name", "admin", "related"],
  chain_authorities: ["organisation", "org_id", "wallet", "scopes", "expires_at", "revoked_at"],
  chain_custodian_classes: [
    "custodian",
    "custodian_org_id",
    "class_policy",
    "site_code",
    "approved_capacity_kg",
    "occupied_kg",
    "reserved_inbound_kg",
  ],
  chain_documents: [
    "kind",
    "subject_hex",
    "version",
    "issuer",
    "issuer_org_id",
    "sha256_hex",
    "valid_until",
    "revoked_at",
  ],
  chain_intakes: ["custodian", "custodian_org_id", "intake_digest_hex", "lot", "retired"],
  chain_lots: [
    "lot_id",
    "class_policy",
    "class_version",
    "grade",
    "custodian_class",
    "custodian",
    "custodian_org_id",
    "intake",
    "parent",
    "root",
    "mint",
    "supply_kg",
    "state",
    "restriction",
    "expires_at",
    "revision",
    "live_children",
  ],
  chain_positions: [
    "lot",
    "owner",
    "owner_org_id",
    "quantity_kg",
    "locked_kg",
    "reserved_kg",
    "revision",
  ],
};

/** Columns that come from events or from Supabase, not from the account read. */
export const EXTRA_COLUMNS: Record<ProjectionTable, readonly string[]> = {
  chain_protocols: [],
  chain_class_policies: [],
  chain_organisations: ["slug", "synthetic"],
  chain_authorities: [],
  chain_custodian_classes: [],
  chain_documents: [],
  chain_intakes: [],
  chain_lots: ["event_revision", "issued_owner", "issued_owner_org_id", "issued_at"],
  chain_positions: [],
};

const TRANSACTION_COLUMNS = [
  "network",
  "program_id",
  "signature",
  "slot",
  "block_time",
  "succeeded",
  "protocol",
  "event_count",
  "other_instance",
];
const EVENT_COLUMNS = [
  "network",
  "program_id",
  "signature",
  "event_index",
  "slot",
  "block_time",
  "protocol",
  "instruction",
  "event",
  "scope",
  "lot",
  "lot_revision",
  "org_id",
  "data",
];

function sameKeys(row: Row, columns: readonly string[]): boolean {
  const keys = Object.keys(row);
  return keys.length === columns.length && columns.every((column) => column in row);
}

// ------------------------------------------------------------------------------------------------
// supabaseStore
// ------------------------------------------------------------------------------------------------

type Failure = { message: string; details?: string | null } | null;

function raise(error: NonNullable<Failure>): never {
  if (isStoreCode(error.message)) throw new StoreCodeError(error.message, error.details ?? null);
  throw new Error(`store request failed: ${error.message}`);
}

function withTimeout(init: RequestInit | undefined): RequestInit {
  const timeout = AbortSignal.timeout(30_000);
  return { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout };
}

function streamJson(stream: Stream): Row {
  return { network: stream.network, programId: stream.programId, protocol: stream.protocol };
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const TIMESTAMP_COLUMNS = ["created_at", "updated_at"];

function stripTimestamps(row: Record<string, unknown>): Row {
  const out: Row = {};
  for (const [name, value] of Object.entries(row)) {
    if (!TIMESTAMP_COLUMNS.includes(name)) out[name] = value as JsonValue;
  }
  return out;
}

export function supabaseStore(url: string, serviceRoleKey: string): ReadModelStore {
  const client = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => globalThis.fetch(input, withTimeout(init)) },
  });

  async function call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const { data, error } = await client.rpc(name, args);
    if (error) raise(error);
    return data;
  }

  /** Reads `.in()` chunks of a key list; every chunk must come back complete. */
  async function readIn(
    table: string,
    column: string,
    keys: string[],
    size: number,
    scope: (query: ReturnType<typeof selectAll>) => ReturnType<typeof selectAll>,
    columns = "*",
  ): Promise<Record<string, unknown>[]> {
    const found: Record<string, unknown>[] = [];
    for (const part of chunks([...new Set(keys)], size)) {
      const { data, error, count } = await scope(selectAll(table, columns)).in(column, part);
      if (error) raise(error);
      if (data === null || count === null || data.length !== count) {
        throw new Error(
          `store read of ${table} returned ${data?.length ?? "no"} rows for count ${count}`,
        );
      }
      found.push(...(data as unknown as Record<string, unknown>[]));
    }
    return found;
  }

  function selectAll(table: string, columns: string) {
    return client.from(table).select(columns, { count: "exact" });
  }

  return {
    async checkpoint(stream) {
      const { data, error } = await client
        .from("indexer_checkpoints")
        .select("status, indexed_through_slot, halt_reason, halt_detail, halted_signature")
        .eq("network", stream.network)
        .eq("program_id", stream.programId)
        .eq("protocol", stream.protocol);
      if (error) raise(error);
      const row = data?.[0];
      if (!row) return null;
      return {
        status: row.status,
        indexedThroughSlot: row.indexed_through_slot,
        halt:
          row.status === "halted"
            ? {
                reason: row.halt_reason as string,
                detail: row.halt_detail as string,
                signature: row.halted_signature,
              }
            : null,
      };
    },

    async patchCheckpoint(stream, expectedThroughSlot, patch) {
      await call("indexer_checkpoint", {
        stream: streamJson(stream),
        expected_through_slot: expectedThroughSlot,
        patch,
      });
    },

    async storedSignatures(stream, signatures) {
      const rows = await readIn(
        "chain_transactions",
        "signature",
        signatures,
        50,
        (query) => query.eq("network", stream.network).eq("program_id", stream.programId),
        "signature",
      );
      return new Set(rows.map((row) => row.signature as string));
    },

    async storedRows(stream, table, addresses) {
      const rows = await readIn(table, "address", addresses, 100, (query) =>
        query.eq("network", stream.network).eq("protocol", stream.protocol),
      );
      return new Map(rows.map((row) => [row.address as string, stripTimestamps(row)]));
    },

    async organisationSlugs(orgIds) {
      const rows = await readIn(
        "organisations",
        "id",
        orgIds,
        100,
        (query) => query,
        "id, slug, synthetic",
      );
      return new Map(
        rows.map((row) => [
          row.id as string,
          { slug: row.slug as string, synthetic: row.synthetic as boolean },
        ]),
      );
    },

    async projections(stream) {
      const result = {} as Record<ProjectionTable, Map<string, Row>>;
      for (const table of PROJECTION_TABLES) {
        const rows = new Map<string, Row>();
        let total: number | null = null;
        let offset = 0;
        while (total === null || offset < total) {
          const { data, error, count } = await selectAll(table, "*")
            .eq("network", stream.network)
            .eq("protocol", stream.protocol)
            .order("address")
            .range(offset, offset + 999);
          if (error) raise(error);
          if (data === null || count === null)
            throw new Error(`store read of ${table} had no count`);
          if (total !== null && count !== total) {
            throw new Error(`store read of ${table} changed size from ${total} to ${count}`);
          }
          total = count;
          const expected = Math.min(1000, total - offset);
          if (data.length !== expected) {
            throw new Error(
              `store read of ${table} returned ${data.length} rows, expected ${expected}`,
            );
          }
          for (const row of data as unknown as Record<string, unknown>[]) {
            rows.set(row.address as string, stripTimestamps(row));
          }
          offset += 1000;
        }
        if (rows.size !== total) throw new Error(`store read of ${table} repeated or lost rows`);
        result[table] = rows;
      }
      return result;
    },

    async confirmedTransactions(stream, maxSlot, limit) {
      const { data, error, count } = await selectAll(
        "chain_transactions",
        "signature, slot, succeeded",
      )
        .eq("network", stream.network)
        .eq("program_id", stream.programId)
        .eq("commitment", "confirmed")
        .lte("slot", maxSlot)
        .order("slot")
        .order("signature")
        .limit(limit);
      if (error) raise(error);
      if (data === null || count === null || data.length !== Math.min(limit, count)) {
        throw new Error(
          `store read of chain_transactions returned ${data?.length ?? "no"} rows for count ${count}`,
        );
      }
      return (data as unknown as { signature: string; slot: number; succeeded: boolean }[]).map(
        (row) => ({ signature: row.signature, slot: row.slot, succeeded: row.succeeded }),
      );
    },

    async apply(batch) {
      await call("indexer_apply", { batch });
    },

    async halt(stream, expectedThroughSlot, halt) {
      const data = await call("indexer_halt", {
        stream: streamJson(stream),
        expected_through_slot: expectedThroughSlot,
        reason: halt.reason,
        detail: halt.detail,
        signature: halt.signature,
      });
      return data as HaltRecord;
    },

    async finalize(stream, expectedThroughSlot, signatures) {
      await call("indexer_finalize", {
        stream: streamJson(stream),
        expected_through_slot: expectedThroughSlot,
        signatures,
      });
    },

    async reconcile(stream, expectedThroughSlot, upserts, organisations) {
      await call("indexer_reconcile", {
        stream: streamJson(stream),
        expected_through_slot: expectedThroughSlot,
        upserts,
        organisations,
      });
    },

    async reset(stream) {
      return (await call("indexer_reset", { stream: streamJson(stream) })) as HaltRecord;
    },
  };
}

// ------------------------------------------------------------------------------------------------
// memoryStore
// ------------------------------------------------------------------------------------------------

type CheckpointRow = {
  network: string;
  program_id: string;
  protocol: string;
  status: "backfilling" | "live" | "halted";
  indexed_through_slot: number | null;
  last_poll_at: string | null;
  last_success_at: string | null;
  consecutive_rpc_errors: number;
  halt_reason: string | null;
  halt_detail: string | null;
  halted_signature: string | null;
  halted_at: string | null;
};

type State = {
  checkpoint: CheckpointRow | null;
  transactions: Map<string, Row>;
  events: Map<string, Row>;
  projections: Map<ProjectionTable, Map<string, Row>>;
};

const PATCH_KEYS = ["lastPollAt", "lastSuccessAt", "consecutiveRpcErrors", "status"];

function isProjectionTable(name: string): name is ProjectionTable {
  return (PROJECTION_TABLES as readonly string[]).includes(name);
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

export function memoryStore(
  organisations: { id: string; slug: string; synthetic: boolean }[] = [],
  clock: () => Date = () => new Date(),
): ReadModelStore & { rows(table: string): Row[]; deleteCheckpoint(): void } {
  const state: State = {
    checkpoint: null,
    transactions: new Map(),
    events: new Map(),
    projections: new Map(PROJECTION_TABLES.map((table) => [table, new Map<string, Row>()])),
  };

  function table(name: ProjectionTable): Map<string, Row> {
    return state.projections.get(name) as Map<string, Row>;
  }

  /** Runs a mutation as one transaction: any error restores the state. */
  function atomically<T>(work: () => T): T {
    const snapshot = structuredClone(state);
    try {
      return work();
    } catch (error) {
      state.checkpoint = snapshot.checkpoint;
      state.transactions = snapshot.transactions;
      state.events = snapshot.events;
      state.projections = snapshot.projections;
      throw error;
    }
  }

  function checkStream(stream: Stream) {
    const shaped =
      typeof stream === "object" &&
      stream !== null &&
      Object.keys(stream).length === 3 &&
      stream.network === "devnet" &&
      typeof stream.programId === "string" &&
      typeof stream.protocol === "string";
    if (!shaped) throw new StoreCodeError("STREAM_INVALID", "the stream has the wrong shape");
    const row = state.checkpoint;
    if (row && (row.program_id !== stream.programId || row.protocol !== stream.protocol)) {
      throw new StoreCodeError("STREAM_INVALID", "the stream is not the stored one");
    }
  }

  /** The cursor guard every worker write starts with. */
  function guard(
    stream: Stream,
    expected: number | null,
    options: { allowHalted?: boolean } = {},
  ): CheckpointRow {
    checkStream(stream);
    const row = state.checkpoint;
    if (!row) throw new StoreCodeError("CURSOR_MOVED", "no checkpoint row");
    if (row.indexed_through_slot !== expected) {
      throw new StoreCodeError(
        "CURSOR_MOVED",
        `cursor is ${row.indexed_through_slot}, expected ${expected}`,
      );
    }
    if (row.status === "halted" && !options.allowHalted) throw new StoreCodeError("INDEXER_HALTED");
    return row;
  }

  function haltRecord(row: CheckpointRow): HaltRecord {
    return {
      reason: row.halt_reason as string,
      detail: row.halt_detail as string,
      signature: row.halted_signature,
      haltedAt: row.halted_at as string,
    };
  }

  function validateEnvelope(batch: ApplyBatch) {
    const wrong = (message: string) => new StoreCodeError("ROW_INVALID", message);
    if (
      !Array.isArray(batch.transactions) ||
      !Array.isArray(batch.events) ||
      !Array.isArray(batch.upserts)
    ) {
      throw wrong("transactions, events and upserts must be lists");
    }
    if (!isInteger(batch.throughSlot) || batch.throughSlot < 0) {
      throw wrong("throughSlot must be a non-negative integer");
    }
    if (batch.expectedThroughSlot !== null && !isInteger(batch.expectedThroughSlot)) {
      throw wrong("expectedThroughSlot must be an integer or null");
    }
  }

  function checkRowStream(row: Row, stream: Stream) {
    if (row.network !== stream.network || row.program_id !== stream.programId) {
      throw new StoreCodeError("STREAM_INVALID", "a row belongs to another stream");
    }
    if (row.protocol !== null && row.protocol !== stream.protocol) {
      throw new StoreCodeError("STREAM_INVALID", "a row belongs to another protocol");
    }
  }

  function upsert(
    entry: Upsert,
    stream: Stream,
    mode: "apply" | "reconcile",
    lastSignature: (existing: Row | undefined, row: Row) => JsonValue,
  ) {
    if (!isProjectionTable(entry.table))
      throw new StoreCodeError("TABLE_INVALID", String(entry.table));
    const columns = [
      ...COMMON_COLUMNS,
      ...ACCOUNT_COLUMNS[entry.table],
      ...EXTRA_COLUMNS[entry.table],
    ];
    const row = entry.row;
    if (!sameKeys(row, columns)) {
      throw new StoreCodeError("ROW_INVALID", `a ${entry.table} row has the wrong columns`);
    }
    if (row.network !== stream.network || row.protocol !== stream.protocol) {
      throw new StoreCodeError("STREAM_INVALID", `a ${entry.table} row belongs to another stream`);
    }
    if (typeof row.address !== "string" || !isInteger(row.slot) || row.slot < 0) {
      throw new StoreCodeError("ROW_INVALID", `a ${entry.table} row has a bad address or slot`);
    }
    const rows = table(entry.table);
    const existing = rows.get(row.address);
    if (!existing) {
      if (mode === "reconcile")
        throw new StoreCodeError("EVENT_GAP", `no ${entry.table} row for ${row.address}`);
      rows.set(
        row.address,
        structuredClone({ ...row, last_signature: lastSignature(undefined, row) }),
      );
    } else {
      const next: Row = { ...existing };
      const newer = (row.slot as number) > (existing.slot as number);
      if (newer) {
        for (const column of ACCOUNT_COLUMNS[entry.table]) next[column] = row[column] as JsonValue;
        next.slot = row.slot as number;
      }
      if (mode === "reconcile") {
        if ((row.slot as number) >= (existing.slot as number)) next.commitment = "finalized";
      } else if (newer) {
        next.commitment = row.commitment as JsonValue;
      } else if (row.slot === existing.slot && row.commitment === "finalized") {
        next.commitment = "finalized";
      }
      next.last_signature = lastSignature(existing, row);
      if (mode === "apply") {
        for (const column of EXTRA_COLUMNS[entry.table]) next[column] = row[column] as JsonValue;
      }
      rows.set(row.address, structuredClone(next));
    }
    if (entry.table === "chain_lots") {
      const lotId = (rows.get(row.address) as Row).lot_id;
      for (const [address, other] of rows) {
        if (address !== row.address && other.lot_id === lotId) {
          throw new StoreCodeError(
            "ROW_INVALID",
            `lot id ${String(lotId)} is already used by ${address}`,
          );
        }
      }
    }
    if (entry.table === "chain_organisations") {
      const orgId = (rows.get(row.address) as Row).org_id;
      for (const [address, other] of rows) {
        if (address !== row.address && other.org_id === orgId) {
          throw new StoreCodeError(
            "ROW_INVALID",
            `organisation ${String(orgId)} is already used by ${address}`,
          );
        }
      }
    }
  }

  function revisionOwner(lot: unknown, revision: unknown): Row | undefined {
    for (const event of state.events.values()) {
      if (event.lot === lot && event.lot_revision === revision) return event;
    }
    return undefined;
  }

  const store: ReadModelStore & { rows(table: string): Row[]; deleteCheckpoint(): void } = {
    async checkpoint(stream) {
      const row = state.checkpoint;
      if (!row || row.program_id !== stream.programId || row.protocol !== stream.protocol)
        return null;
      return {
        status: row.status,
        indexedThroughSlot: row.indexed_through_slot,
        halt:
          row.status === "halted"
            ? {
                reason: row.halt_reason as string,
                detail: row.halt_detail as string,
                signature: row.halted_signature,
              }
            : null,
      };
    },

    async patchCheckpoint(stream, expectedThroughSlot, patch) {
      atomically(() => {
        checkStream(stream);
        if (expectedThroughSlot === null && state.checkpoint === null) {
          state.checkpoint = {
            network: stream.network,
            program_id: stream.programId,
            protocol: stream.protocol,
            status: "backfilling",
            indexed_through_slot: null,
            last_poll_at: null,
            last_success_at: null,
            consecutive_rpc_errors: 0,
            halt_reason: null,
            halt_detail: null,
            halted_signature: null,
            halted_at: null,
          };
        }
        const row = guard(stream, expectedThroughSlot);
        const entries = Object.entries(patch);
        for (const [key, value] of entries) {
          const typed =
            ((key === "lastPollAt" || key === "lastSuccessAt") && typeof value === "string") ||
            (key === "consecutiveRpcErrors" && isInteger(value) && value >= 0) ||
            (key === "status" && (value === "backfilling" || value === "live"));
          if (!PATCH_KEYS.includes(key) || !typed) {
            if (key === "status" && typeof value === "string") {
              throw new StoreCodeError("INDEXER_TRANSITION", `status ${value} cannot be set`);
            }
            throw new StoreCodeError("ROW_INVALID", `the patch key ${key} is not accepted`);
          }
        }
        for (const [key, value] of entries) {
          if (key === "lastPollAt") row.last_poll_at = value as string;
          if (key === "lastSuccessAt") row.last_success_at = value as string;
          if (key === "consecutiveRpcErrors") row.consecutive_rpc_errors = value as number;
          if (key === "status") row.status = value as "backfilling" | "live";
        }
      });
    },

    async storedSignatures(_stream, signatures) {
      return new Set(signatures.filter((signature) => state.transactions.has(signature)));
    },

    async storedRows(_stream, name, addresses) {
      const found = new Map<string, Row>();
      for (const address of new Set(addresses)) {
        const row = table(name).get(address);
        if (row) found.set(address, structuredClone(row));
      }
      return found;
    },

    async organisationSlugs(orgIds) {
      const found = new Map<string, { slug: string; synthetic: boolean }>();
      for (const id of orgIds) {
        const party = organisations.find((candidate) => candidate.id === id);
        if (party) found.set(id, { slug: party.slug, synthetic: party.synthetic });
      }
      return found;
    },

    async projections() {
      return Object.fromEntries(
        PROJECTION_TABLES.map((name) => [name, structuredClone(table(name))]),
      ) as Record<ProjectionTable, Map<string, Row>>;
    },

    async confirmedTransactions(_stream, maxSlot, limit) {
      return [...state.transactions.values()]
        .filter((row) => row.commitment === "confirmed" && (row.slot as number) <= maxSlot)
        .sort(
          (a, b) =>
            (a.slot as number) - (b.slot as number) ||
            ((a.signature as string) < (b.signature as string) ? -1 : 1),
        )
        .slice(0, limit)
        .map((row) => ({
          signature: row.signature as string,
          slot: row.slot as number,
          succeeded: row.succeeded as boolean,
        }));
    },

    async apply(batch) {
      atomically(() => {
        validateEnvelope(batch);
        checkStream(batch.stream);
        const row = guard(batch.stream, batch.expectedThroughSlot);
        const { stream } = batch;
        const wrong = (message: string) => new StoreCodeError("ROW_INVALID", message);

        const signatures = new Set<string>();
        for (const transaction of batch.transactions) {
          if (!sameKeys(transaction, TRANSACTION_COLUMNS))
            throw wrong("a transaction row has the wrong columns");
          checkRowStream(transaction, stream);
          const signature = transaction.signature as string;
          if (signatures.has(signature)) throw wrong(`transaction ${signature} is repeated`);
          signatures.add(signature);
        }
        const eventKeys = new Set<string>();
        for (const event of batch.events) {
          if (!sameKeys(event, EVENT_COLUMNS)) throw wrong("an event row has the wrong columns");
          checkRowStream(event, stream);
          const key = `${event.signature}:${event.event_index}`;
          if (eventKeys.has(key)) throw wrong(`event ${key} is repeated`);
          eventKeys.add(key);
        }
        const upsertKeys = new Set<string>();
        for (const entry of batch.upserts) {
          const key = `${entry.table}:${String(entry.row.address)}`;
          if (upsertKeys.has(key)) throw wrong(`${key} is repeated`);
          upsertKeys.add(key);
        }

        const stored = batch.transactions.filter((transaction) =>
          state.transactions.has(transaction.signature as string),
        ).length;
        if (
          batch.transactions.length === 0 &&
          (batch.events.length > 0 || batch.upserts.length > 0)
        ) {
          throw wrong("events or upserts without transactions");
        }
        if (stored > 0 && stored === batch.transactions.length) return; // a replay changes nothing
        if (stored > 0) throw wrong("a batch mixes stored and new transactions");

        if (batch.expectedThroughSlot !== null && batch.throughSlot < batch.expectedThroughSlot) {
          throw wrong("throughSlot is below the cursor");
        }
        const inRange = (slot: unknown) =>
          isInteger(slot) &&
          slot <= batch.throughSlot &&
          (batch.expectedThroughSlot === null || slot > batch.expectedThroughSlot);
        for (const transaction of batch.transactions) {
          if (!inRange(transaction.slot))
            throw wrong("a transaction slot is outside the batch range");
          if (transaction.protocol === null && Number(transaction.event_count) > 0) {
            throw wrong("a transaction without a protocol has events");
          }
          if (typeof transaction.other_instance !== "boolean") {
            throw wrong("a transaction's other_instance must be a boolean");
          }
          if (
            transaction.other_instance &&
            (transaction.succeeded !== true ||
              transaction.protocol !== null ||
              transaction.event_count !== 0)
          ) {
            throw wrong("an other-instance transaction must succeed, without protocol or events");
          }
        }
        const bySignature = new Map(batch.transactions.map((t) => [t.signature as string, t]));
        const counts = new Map<string, number>();
        for (const event of batch.events) {
          const owner = bySignature.get(event.signature as string);
          if (!owner) throw wrong("an event names a transaction that is not in the batch");
          if (owner.slot !== event.slot || owner.block_time !== event.block_time) {
            throw wrong("an event disagrees with its transaction on slot or block time");
          }
          if (!inRange(event.slot)) throw wrong("an event slot is outside the batch range");
          if (event.protocol !== stream.protocol)
            throw new StoreCodeError("STREAM_INVALID", "an event belongs to another protocol");
          counts.set(owner.signature as string, (counts.get(owner.signature as string) ?? 0) + 1);
        }
        for (const transaction of batch.transactions) {
          if (transaction.event_count !== (counts.get(transaction.signature as string) ?? 0)) {
            throw wrong(`transaction ${String(transaction.signature)} has the wrong event_count`);
          }
        }

        for (const transaction of batch.transactions) {
          state.transactions.set(transaction.signature as string, {
            ...structuredClone(transaction),
            commitment: "confirmed",
          });
        }
        for (const event of batch.events) {
          const key = `${event.signature}:${event.event_index}`;
          if (state.events.has(key)) continue;
          if (event.lot !== null) {
            const owner = revisionOwner(event.lot, event.lot_revision);
            if (owner) {
              throw new StoreCodeError(
                "REVISION_SEQUENCE",
                `lot ${String(event.lot)} revision ${String(event.lot_revision)} is stored under ${String(owner.signature)}, batch has ${String(event.signature)}`,
              );
            }
          }
          state.events.set(key, { ...structuredClone(event), commitment: "confirmed" });
        }
        for (const entry of batch.upserts) {
          upsert(entry, stream, "apply", (existing, incoming) =>
            !existing || (incoming.slot as number) > (existing.slot as number)
              ? (incoming.last_signature ?? null)
              : ((existing.last_signature ?? null) as JsonValue),
          );
        }
        row.indexed_through_slot = batch.throughSlot;
      });
    },

    async halt(stream, expectedThroughSlot, halt) {
      return atomically(() => {
        const row = guard(stream, expectedThroughSlot, { allowHalted: true });
        if (row.status !== "halted") {
          row.status = "halted";
          row.halt_reason = halt.reason;
          row.halt_detail = halt.detail;
          row.halted_signature = halt.signature;
          row.halted_at = clock().toISOString();
        }
        return haltRecord(row);
      });
    },

    async finalize(stream, expectedThroughSlot, signatures) {
      atomically(() => {
        guard(stream, expectedThroughSlot);
        const wanted = new Set(signatures);
        for (const transaction of state.transactions.values()) {
          if (wanted.has(transaction.signature as string)) transaction.commitment = "finalized";
        }
        for (const event of state.events.values()) {
          if (wanted.has(event.signature as string)) event.commitment = "finalized";
        }
      });
    },

    async reconcile(stream, expectedThroughSlot, upserts, entries) {
      atomically(() => {
        guard(stream, expectedThroughSlot);
        const keys = new Set<string>();
        for (const entry of upserts) {
          const key = `${entry.table}:${String(entry.row.address)}`;
          if (keys.has(key)) throw new StoreCodeError("ROW_INVALID", `${key} is repeated`);
          keys.add(key);
          upsert(entry, stream, "reconcile", (existing, incoming) =>
            existing && (incoming.slot as number) >= (existing.slot as number)
              ? null
              : ((existing?.last_signature ?? null) as JsonValue),
          );
        }
        const seen = new Set<string>();
        for (const entry of entries) {
          if (
            !sameKeys(entry as unknown as Row, ["address", "slug", "synthetic"]) ||
            typeof entry.address !== "string" ||
            (entry.slug !== null && typeof entry.slug !== "string") ||
            (entry.synthetic !== null && typeof entry.synthetic !== "boolean") ||
            seen.has(entry.address)
          ) {
            throw new StoreCodeError("ROW_INVALID", "an organisations entry is malformed");
          }
          seen.add(entry.address);
          const row = table("chain_organisations").get(entry.address);
          if (!row)
            throw new StoreCodeError("EVENT_GAP", `no organisation row for ${entry.address}`);
          row.slug = entry.slug;
          row.synthetic = entry.synthetic;
        }
      });
    },

    async reset(stream) {
      return atomically(() => {
        checkStream(stream);
        const row = state.checkpoint;
        if (row?.status !== "halted") {
          throw new StoreCodeError("INDEXER_TRANSITION", "only a halted stream can be reset");
        }
        const cleared = haltRecord(row);
        for (const name of PROJECTION_TABLES) table(name).clear();
        state.events.clear();
        state.transactions.clear();
        row.indexed_through_slot = null;
        row.last_poll_at = null;
        row.last_success_at = null;
        row.consecutive_rpc_errors = 0;
        row.status = "backfilling";
        row.halt_reason = null;
        row.halt_detail = null;
        row.halted_signature = null;
        row.halted_at = null;
        return cleared;
      });
    },

    rows(name) {
      if (name === "indexer_checkpoints") {
        return state.checkpoint ? [structuredClone(state.checkpoint) as unknown as Row] : [];
      }
      if (name === "chain_transactions")
        return [...state.transactions.values()].map((r) => structuredClone(r));
      if (name === "chain_events") return [...state.events.values()].map((r) => structuredClone(r));
      if (isProjectionTable(name)) return [...table(name).values()].map((r) => structuredClone(r));
      throw new Error(`memoryStore has no table ${name}`);
    },

    deleteCheckpoint() {
      state.checkpoint = null;
    },
  };
  return store;
}
