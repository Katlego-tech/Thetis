// The indexer loop: one poll lists the program's new transactions, applies them one slot at a
// time, promotes finalized ones, reconciles when due and records its health. `createIndexer` is
// the poll and its in-memory state; `runIndexer` adds the real sources, the timers and shutdown.

import type { IndexerConfig } from "./config.ts";
import { DEVNET_GENESIS_HASH } from "./config.ts";
import { decodeTransaction } from "./decode.ts";
import { ConfigError, HaltError, StoreCodeError } from "./errors.ts";
import { projectSlot, type SlotTransaction } from "./project.ts";
import { reconcile } from "./reconcile.ts";
import {
  type ChainSource,
  kitChainSource,
  RpcShapeError,
  type SignatureEntry,
  UnsupportedVersionError,
} from "./rpc.ts";
import { type ReadModelStore, type Stream, supabaseStore } from "./store.ts";

export type IndexerDeps = {
  chain: ChainSource;
  store: ReadModelStore;
  config: IndexerConfig;
  now: () => Date;
  log: (line: object) => void;
  /** Aborted on shutdown: in-flight RPC calls stop and no new store write starts. */
  signal?: AbortSignal;
};

export type PollResult = "ok" | "failed" | "halted" | "reloaded";

export type Indexer = {
  runPoll(): Promise<PollResult>;
  /** The delay before the next poll, given the result of the last one. */
  nextDelayMs(): number;
};

/** A store code that means the worker has a bug: the process exits and the platform restarts it. */
export class IndexerBugError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`indexer bug: ${code}`);
    this.name = "IndexerBugError";
    this.code = code;
  }
}

class InconsistentReadError extends Error {
  constructor(message: string) {
    super(`inconsistent read: ${message}`);
    this.name = "InconsistentReadError";
  }
}

class StoppedError extends Error {
  constructor() {
    super("the indexer is stopping");
    this.name = "StoppedError";
  }
}

const BACKFILL_ENTRIES = 1000;
const FINALIZE_BATCH = 256;
const HALTED_WAIT_MS = 60_000;
const RPC_TIMEOUT_MS = 30_000;

const sortText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function listingHalt(message: string): HaltError {
  return new HaltError("HISTORY_INCOMPLETE", `listing: ${message}`, null);
}

type Pending = { error: HaltError; cursor: number | null };

export function createIndexer(deps: IndexerDeps): Indexer {
  const { chain, store, config, log } = deps;
  const stream: Stream = {
    network: config.network,
    programId: config.programId,
    protocol: config.protocol,
  };

  // In-memory state, kept across polls.
  let errors = 0;
  let reconcileDue = true;
  let lastReconcileAt: number | null = null;
  let lastResult: PollResult | null = null;
  let pending: Pending | null = null;
  let wasHalted = false;
  let known: { status: string | null; cursor: number | null } = { status: null, cursor: null };
  let cursor: number | null = null;
  let cursorKnown = false;

  const rpcSignal = () =>
    deps.signal
      ? AbortSignal.any([AbortSignal.timeout(RPC_TIMEOUT_MS), deps.signal])
      : AbortSignal.timeout(RPC_TIMEOUT_MS);

  /** Every store write goes through here, so none starts after shutdown. */
  async function write<T>(work: () => Promise<T>): Promise<T> {
    if (deps.signal?.aborted) throw new StoppedError();
    return work();
  }

  function clearState() {
    pending = null;
    reconcileDue = true;
    lastReconcileAt = null;
    wasHalted = false;
    known = { status: null, cursor: null };
    cursor = null;
    cursorKnown = false;
  }

  // ---- listing -------------------------------------------------------------------------------

  async function listSignatures(head: number): Promise<SignatureEntry[]> {
    const used = new Set<string | null>();
    const all = new Map<string, SignatureEntry>();
    let before: string | null = null;
    let previousOldest: number | null = null;
    for (;;) {
      if (used.has(before)) throw new InconsistentReadError("a paging token was used twice");
      used.add(before);
      const page = await chain.getSignatures(before, head, rpcSignal());
      if (page.length === 0) {
        if (cursor !== null) {
          throw listingHalt(`the listing ends before reaching the cursor ${cursor}`);
        }
        break;
      }
      const newest = Math.max(...page.map((entry) => entry.slot));
      const oldest = Math.min(...page.map((entry) => entry.slot));
      if (previousOldest !== null && newest > previousOldest) {
        throw new InconsistentReadError("a page is newer than the one before it");
      }
      previousOldest = oldest;
      for (const entry of page) {
        const seen = all.get(entry.signature);
        if (!seen) {
          all.set(entry.signature, entry);
          continue;
        }
        if (
          seen.slot !== entry.slot ||
          seen.failed !== entry.failed ||
          (seen.blockTime !== null &&
            entry.blockTime !== null &&
            seen.blockTime !== entry.blockTime)
        ) {
          throw new InconsistentReadError(
            `signature ${entry.signature} is listed twice with different values`,
          );
        }
        if (seen.blockTime === null && entry.blockTime !== null) all.set(entry.signature, entry);
      }
      const reached = cursor;
      if (reached !== null && page.some((entry) => entry.slot <= reached)) break;
      before = (page.at(-1) as SignatureEntry).signature;
    }
    if (cursor === null) {
      const entries = [...all.values()];
      const oldest = entries.length === 0 ? null : Math.min(...entries.map((entry) => entry.slot));
      const atOldest = entries.filter((entry) => entry.slot === oldest);
      if (!atOldest.some((entry) => entry.signature === config.firstSignature)) {
        throw listingHalt(
          `the oldest listed slot ${oldest ?? "(none)"} does not hold the first signature ${config.firstSignature}`,
        );
      }
    }
    return [...all.values()].filter(
      (entry) => entry.slot <= head && (cursor === null || entry.slot > cursor),
    );
  }

  // ---- one slot ------------------------------------------------------------------------------

  async function slotTransactions(
    slot: number,
    entries: SignatureEntry[],
  ): Promise<SlotTransaction[]> {
    const present = await store.storedSignatures(
      stream,
      entries.map((entry) => entry.signature),
    );
    const fresh = entries
      .filter((entry) => !present.has(entry.signature))
      .sort((a, b) => sortText(a.signature, b.signature));
    const transactions: SlotTransaction[] = [];
    for (const entry of fresh) {
      if (entry.failed) {
        const blockTime = entry.blockTime ?? (await chain.getBlockTime(slot, rpcSignal()));
        if (blockTime === null) throw new Error(`no block time for slot ${slot}`);
        transactions.push({
          signature: entry.signature,
          slot,
          blockTime,
          succeeded: false,
          decoded: null,
        });
        continue;
      }
      let raw: Awaited<ReturnType<ChainSource["getTransaction"]>>;
      try {
        raw = await chain.getTransaction(entry.signature, rpcSignal());
      } catch (error) {
        if (error instanceof UnsupportedVersionError) {
          throw new HaltError(
            "TRANSACTION_UNREADABLE",
            `decode: the node cannot read the message version; transaction ${entry.signature}`,
            entry.signature,
          );
        }
        throw error;
      }
      if (raw === null) throw new Error(`getTransaction returned nothing for ${entry.signature}`);
      if (raw.slot !== slot) {
        throw new InconsistentReadError(
          `${entry.signature} is in slot ${raw.slot}, listed in ${slot}`,
        );
      }
      if (raw.meta && raw.meta.err !== null && raw.meta.err !== undefined) {
        throw new InconsistentReadError(`${entry.signature} failed, listed as succeeded`);
      }
      const decoded = decodeTransaction(raw, entry.signature, { protocol: config.protocol });
      const blockTime =
        raw.blockTime ?? entry.blockTime ?? (await chain.getBlockTime(slot, rpcSignal()));
      if (blockTime === null) throw new Error(`no block time for ${entry.signature}`);
      transactions.push({ signature: entry.signature, slot, blockTime, succeeded: true, decoded });
    }
    return transactions;
  }

  // ---- finalization --------------------------------------------------------------------------

  async function finalize(head: number) {
    const finalized = await chain.getSlot("finalized", rpcSignal());
    const bound = Math.min(finalized, head);
    const rows = await store.confirmedTransactions(stream, bound, FINALIZE_BATCH);
    if (rows.length === 0) return;
    const statuses = await chain.getSignatureStatuses(
      rows.map((row) => row.signature),
      rpcSignal(),
    );
    if (statuses.length !== rows.length) {
      throw new RpcShapeError(
        `getSignatureStatuses answered ${statuses.length} for ${rows.length}`,
      );
    }
    const dropped: string[] = [];
    const promoted: string[] = [];
    for (const [index, row] of rows.entries()) {
      const status = statuses[index];
      if (!status || status.slot !== row.slot || !status.failed !== row.succeeded) {
        dropped.push(row.signature);
      } else if (status.confirmationStatus === "finalized") {
        promoted.push(row.signature);
      }
    }
    if (dropped.length > 0) {
      throw new HaltError(
        "CONFIRMED_DROPPED",
        `finalize: confirmed transactions that the chain no longer shows as they were: ${dropped.sort(sortText).join(", ")}`,
        null,
      );
    }
    if (promoted.length > 0) {
      await write(() => store.finalize(stream, cursor, promoted));
    }
  }

  // ---- the poll ------------------------------------------------------------------------------

  async function persistHalt(error: HaltError): Promise<PollResult> {
    try {
      const record = await write(() => store.halt(stream, cursor, error));
      pending = null;
      wasHalted = true;
      known = { status: "halted", cursor };
      log({
        level: "error",
        code: "INDEXER_HALTED",
        reason: record.reason,
        signature: record.signature,
        detail: record.detail,
      });
      return "halted";
    } catch (failure) {
      if (failure instanceof StoreCodeError && failure.code === "CURSOR_MOVED") {
        return reload("CURSOR_MOVED");
      }
      if (failure instanceof StoppedError) throw failure;
      pending = { error, cursor };
      throw failure;
    }
  }

  function reload(code: string): PollResult {
    log({ level: "error", code: "STREAM_RELOAD", sqlMessage: code });
    clearState();
    return "reloaded";
  }

  async function poll(
    startedAt: Date,
    progress: { applied: number },
  ): Promise<PollResult | "waiting"> {
    cursorKnown = false;
    if (pending) {
      const retry = pending;
      cursor = retry.cursor;
      cursorKnown = true;
      return persistHalt(retry.error);
    }

    let checkpoint: Awaited<ReturnType<ReadModelStore["checkpoint"]>>;
    try {
      checkpoint = await store.checkpoint(stream);
    } catch (error) {
      // A halted worker only watches the row: a failed read is tried again a minute later.
      if (wasHalted && !deps.signal?.aborted) return "waiting";
      throw error;
    }
    if (checkpoint === null) {
      await write(() => store.patchCheckpoint(stream, null, {}));
      checkpoint = await store.checkpoint(stream);
      if (checkpoint === null) throw new Error("the checkpoint row is missing after creating it");
    }
    cursor = checkpoint.indexedThroughSlot;
    cursorKnown = true;
    known = { status: checkpoint.status, cursor };
    if (checkpoint.status === "halted") {
      wasHalted = true;
      const halt = checkpoint.halt;
      log({
        level: "error",
        code: "INDEXER_HALTED",
        reason: halt?.reason ?? null,
        signature: halt?.signature ?? null,
        detail: halt?.detail ?? null,
      });
      return "waiting";
    }
    if (wasHalted) {
      wasHalted = false;
      reconcileDue = true;
      lastReconcileAt = null;
    }

    const head = await chain.getSlot("confirmed", rpcSignal());
    if (cursor !== null && head < cursor) {
      throw new InconsistentReadError(`the head ${head} is below the cursor ${cursor}`);
    }
    const kept = await listSignatures(head);

    const bySlot = new Map<number, SignatureEntry[]>();
    for (const entry of kept) bySlot.set(entry.slot, [...(bySlot.get(entry.slot) ?? []), entry]);
    for (const slot of [...bySlot.keys()].sort((a, b) => a - b)) {
      const transactions = await slotTransactions(slot, bySlot.get(slot) as SignatureEntry[]);
      if (transactions.length === 0) continue;
      const rows = await projectSlot(
        { chain, store, stream, signal: rpcSignal },
        slot,
        transactions,
      );
      await write(() =>
        store.apply({
          stream,
          expectedThroughSlot: cursor,
          throughSlot: slot,
          transactions: rows.transactions,
          events: rows.events,
          upserts: rows.upserts,
        }),
      );
      cursor = slot;
      known = { status: known.status, cursor };
      progress.applied += rows.transactions.length;
    }
    if (cursor !== head) {
      await write(() =>
        store.apply({
          stream,
          expectedThroughSlot: cursor,
          throughSlot: head,
          transactions: [],
          events: [],
          upserts: [],
        }),
      );
      cursor = head;
      known = { status: known.status, cursor };
    }

    await finalize(head);

    const status = kept.length >= BACKFILL_ENTRIES ? "backfilling" : "live";
    const nowMs = deps.now().getTime();
    const due =
      reconcileDue || lastReconcileAt === null || nowMs - lastReconcileAt >= config.reconcileMs;
    if (status === "live" && due) {
      try {
        const outcome = await reconcile({ chain, store, stream, signal: rpcSignal }, cursor);
        if (outcome === "done") {
          reconcileDue = false;
          lastReconcileAt = deps.now().getTime();
        }
      } catch (error) {
        if (error instanceof HaltError || error instanceof StoreCodeError || deps.signal?.aborted) {
          throw reconcileFailure(error);
        }
        log({ level: "warn", code: "RECONCILE_RETRY" });
      }
    }

    await write(() =>
      store.patchCheckpoint(stream, cursor, {
        lastPollAt: startedAt.toISOString(),
        lastSuccessAt: deps.now().toISOString(),
        consecutiveRpcErrors: 0,
        status,
      }),
    );
    errors = 0;
    known = { status, cursor };
    return "ok";
  }

  /** A named code from reconcile is labelled with its step before it reaches the halt handler. */
  function reconcileFailure(error: unknown): unknown {
    if (error instanceof StoreCodeError && error.code === "EVENT_GAP") {
      return new HaltError("EVENT_GAP", `reconcile: ${error.detail ?? "a row is missing"}`, null);
    }
    return error;
  }

  async function failure(error: unknown): Promise<PollResult> {
    if (deps.signal?.aborted) return "failed";
    if (error instanceof HaltError) return persistHalt(error);
    if (error instanceof StoreCodeError) {
      if (error.code === "CURSOR_MOVED" || error.code === "INDEXER_HALTED")
        return reload(error.code);
      if (error.code === "REVISION_SEQUENCE") {
        return persistHalt(
          new HaltError(
            "REVISION_SEQUENCE",
            `sequence: ${error.detail ?? "a lot revision repeats"}`,
            null,
          ),
        );
      }
      if (error.code === "EVENT_GAP") {
        return persistHalt(
          new HaltError("EVENT_GAP", `reconcile: ${error.detail ?? "a row is missing"}`, null),
        );
      }
      log({ level: "error", code: "INDEXER_BUG", sqlMessage: error.code });
      throw new IndexerBugError(error.code);
    }
    errors += 1;
    log({
      level: "warn",
      code: "INDEXER_RETRY",
      message: error instanceof Error ? error.message : String(error),
    });
    if (cursorKnown) {
      try {
        await write(() =>
          store.patchCheckpoint(stream, cursor, {
            lastPollAt: deps.now().toISOString(),
            consecutiveRpcErrors: errors,
          }),
        );
      } catch (writeError) {
        if (
          writeError instanceof StoreCodeError &&
          (writeError.code === "CURSOR_MOVED" || writeError.code === "INDEXER_HALTED")
        ) {
          return reload(writeError.code);
        }
      }
    }
    return "failed";
  }

  return {
    async runPoll() {
      const startedAt = deps.now();
      const progress = { applied: 0 };
      let result: PollResult;
      let attempted = true;
      try {
        const outcome = await poll(startedAt, progress);
        if (outcome === "waiting") {
          attempted = false;
          result = "halted";
        } else {
          result = outcome;
        }
      } catch (error) {
        result = await failure(error).catch((again: unknown) => {
          if (again instanceof IndexerBugError) throw again;
          errors += 1;
          return "failed" as const;
        });
      }
      lastResult = result;
      if (attempted) {
        log({
          level: "info",
          code: "INDEXER_POLL",
          status: known.status,
          indexedThroughSlot: known.cursor,
          applied: progress.applied,
        });
      }
      return result;
    },

    nextDelayMs() {
      switch (lastResult) {
        case "ok":
          return config.pollMs;
        case "failed":
          return Math.min(5_000 * 2 ** Math.max(errors - 1, 0), 60_000);
        case "halted":
          return HALTED_WAIT_MS;
        default:
          return 0;
      }
    },
  };
}

// ------------------------------------------------------------------------------------------------
// The running worker
// ------------------------------------------------------------------------------------------------

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

const SHUTDOWN_WAIT_MS = 10_000;
const STOP = Symbol("stop");

function stopped(signal: AbortSignal): Promise<typeof STOP> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve(STOP);
    else signal.addEventListener("abort", () => resolve(STOP), { once: true });
  });
}

/**
 * Runs the indexer until `signal` aborts. Resolves with the exit code: 0 after a shutdown, 1
 * after a worker bug. Throws ConfigError when the RPC endpoint is not devnet.
 */
export async function runIndexer(config: IndexerConfig, signal: AbortSignal): Promise<number> {
  const chain = kitChainSource(config.rpcUrl);

  // The network check: nothing is written before it passes.
  for (let attempt = 1; ; attempt += 1) {
    try {
      const genesis = await chain.getGenesisHash(
        AbortSignal.any([signal, AbortSignal.timeout(RPC_TIMEOUT_MS)]),
      );
      if (genesis !== DEVNET_GENESIS_HASH) throw new ConfigError("THETIS_RPC_URL");
      break;
    } catch (error) {
      if (error instanceof ConfigError) throw error;
      if (signal.aborted) return 0;
      await pause(Math.min(5_000 * 2 ** (attempt - 1), 60_000), signal);
      if (signal.aborted) return 0;
    }
  }

  const store = supabaseStore(config.supabaseUrl, config.serviceRoleKey);
  const indexer = createIndexer({
    chain,
    store,
    config,
    now: () => new Date(),
    log: (line) => console.log(JSON.stringify(line)),
    signal,
  });

  while (!signal.aborted) {
    const polling = indexer.runPoll().then(
      () => null,
      (error: unknown) => error ?? new Error("the poll failed without an error"),
    );
    const outcome = await Promise.race([polling, stopped(signal)]);
    if (outcome === STOP) {
      // The call in flight gets a short grace period to finish its write.
      const grace = new AbortController();
      await Promise.race([polling, pause(SHUTDOWN_WAIT_MS, grace.signal)]);
      grace.abort();
      return 0;
    }
    if (outcome instanceof IndexerBugError) return 1;
    if (outcome !== null) {
      console.log(
        JSON.stringify({ level: "error", code: "INDEXER_FAILED", message: String(outcome) }),
      );
      return 1;
    }
    await pause(indexer.nextDelayMs(), signal);
  }
  return 0;
}
