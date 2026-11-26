import { Warning } from "@phosphor-icons/react/ssr";
import type { Freshness, HaltReason } from "@/data/live/types";
import { formatClockTime, formatDateTime, formatSlot } from "@/lib/format";

const haltReasonGroups: [string, HaltReason[]][] = [
  [
    "the program sent something this version of Thetis does not recognise",
    ["UNKNOWN_INSTRUCTION", "UNKNOWN_EVENT", "UNKNOWN_ENUM", "EVENT_MISMATCH", "MIXED_INSTANCE"],
  ],
  [
    "a program record could not be read",
    ["EVENT_DECODE_FAILED", "ACCOUNT_DECODE_FAILED", "TRANSACTION_UNREADABLE"],
  ],
  [
    "the indexed history does not match the chain",
    ["REVISION_SEQUENCE", "EVENT_GAP", "ACCOUNT_VANISHED", "HISTORY_INCOMPLETE"],
  ],
  ["the network did not confirm a recorded transaction", ["CONFIRMED_DROPPED"]],
];
const haltReasons = Object.fromEntries(
  haltReasonGroups.flatMap(([text, reasons]) => reasons.map((reason) => [reason, text])),
) as Record<HaltReason, string>;

function freshnessLine({
  state,
  indexedThroughSlot,
  lastSuccessAt,
  haltReason,
  haltedAt,
}: Freshness): string {
  const slot = indexedThroughSlot === null ? "none" : formatSlot(indexedThroughSlot);
  if (state === "halted" && haltReason !== null && haltedAt !== null) {
    return `Indexing stopped ${formatDateTime(haltedAt)}: ${haltReasons[haltReason]}. What you see may be out of date; the chain itself is unaffected.`;
  }
  if (state === "stalled" || lastSuccessAt === null) {
    return lastSuccessAt === null
      ? "The indexer has not reported yet. Nothing here is current."
      : `The indexer last reported ${formatDateTime(lastSuccessAt)}. What you see may be out of date.`;
  }
  const clock = formatClockTime(lastSuccessAt);
  return state === "behind"
    ? `Catching up with devnet. Indexed through slot ${slot}, last reported ${clock}. Recent changes may not show yet.`
    : `Live from devnet. Indexed through slot ${slot}, last reported ${clock}.`;
}

export function LiveBanner({ freshness }: { freshness: Freshness }) {
  const warn = freshness.state === "stalled" || freshness.state === "halted";
  return (
    <div className="reference-banner flex flex-wrap items-center justify-between gap-x-6 gap-y-0.5">
      <span>
        <strong>Devnet test environment.</strong>{" "}
        <span>
          Synthetic organisations. Records are read from the Thetis program on Solana devnet.
        </span>
      </span>
      <span
        role="status"
        className={warn ? "inline-flex items-center gap-1.5 font-semibold" : undefined}
      >
        {warn && <Warning aria-hidden="true" size={14} weight="regular" className="shrink-0" />}
        {freshnessLine(freshness)}
      </span>
    </div>
  );
}
