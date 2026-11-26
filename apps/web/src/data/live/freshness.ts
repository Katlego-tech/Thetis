import type { CheckpointRow } from "./rows";
import type { Freshness, FreshnessState } from "./types";

const BEHIND_AFTER_MS = 30_000;
const STALLED_AFTER_MS = 120_000;

export function freshnessOf(checkpoint: CheckpointRow | null, now: Date): Freshness {
  const lastSuccessAt = checkpoint?.last_success_at ?? null;
  const age = lastSuccessAt === null ? null : now.getTime() - Date.parse(lastSuccessAt);
  let state: FreshnessState;
  if (checkpoint?.status === "halted") state = "halted";
  else if (checkpoint === null || age === null || age > STALLED_AFTER_MS) state = "stalled";
  else if (checkpoint.status === "backfilling" || age > BEHIND_AFTER_MS) state = "behind";
  else state = "current";

  const slot = checkpoint?.indexed_through_slot ?? null;
  return {
    state,
    indexedThroughSlot: slot === null ? null : BigInt(slot),
    lastSuccessAt,
    haltReason: checkpoint?.halt_reason ?? null,
    haltedAt: checkpoint?.halted_at ?? null,
    checkedAt: now.toISOString(),
  };
}
