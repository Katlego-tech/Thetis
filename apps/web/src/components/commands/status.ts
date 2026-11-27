// The command page's verbatim copy (live-lending.md §5 and §6.9.4).

import type { RegistryStatus } from "@/data/types";
import { type CommandView, failureExplanation } from "@/lib/commands";
import { formatClockTime, formatSlot } from "@/lib/format";

export const OPEN_STATUSES: readonly CommandView["status"][] = [
  "awaiting_signatures",
  "submitted",
  "outcome_unknown",
];

/** §5: a command's status as a registry mark. */
export function commandRegistry(view: CommandView): RegistryStatus {
  switch (view.status) {
    case "confirmed":
      return view.confirmedCommitment ?? "confirmed";
    case "expired":
      return "not_submitted";
    default:
      return view.status;
  }
}

export function statusLine(view: CommandView, organisationName: (id: string) => string): string {
  switch (view.status) {
    case "awaiting_signatures": {
      if (view.text) {
        const signed = view.signers.filter(({ signed }) => signed !== null).length;
        const expires = new Date(Date.parse(view.text.validUntil) - 30_000).toISOString();
        return `Waiting for ${view.signers.length - signed} of ${view.signers.length} signatures. The text expires at ${formatClockTime(expires)}.`;
      }
      const waiting = view.signers.find(({ signed }) => signed === null) ?? view.signers[0];
      const name = waiting ? organisationName(waiting.organisationId) : "the signer";
      return `Waiting for ${name} to sign the transaction.`;
    }
    case "submitted":
      return "Sent to devnet. Waiting for the network to confirm it.";
    case "confirmed":
      return `Confirmed on devnet in slot ${view.confirmedSlot === null ? "unknown" : formatSlot(BigInt(view.confirmedSlot))}. The lot's figures update once the indexer reads this transaction.`;
    case "failed":
      return view.error
        ? `Devnet refused this transaction: ${view.error.code}. ${failureExplanation(view.error.code)} The program made no change.`
        : `Devnet refused this transaction. ${failureExplanation("")} The program made no change.`;
    case "outcome_unknown":
      return "Thetis can't tell yet whether this transaction landed. Don't start this action again; this page keeps checking.";
    case "expired":
      return "The text expired before everyone signed. Nothing was sent.";
  }
}

/** Decision 3: the fields' heading follows the outcome. */
export function recordedHeading(status: CommandView["status"]): string {
  if (status === "confirmed") return "What was recorded";
  if (status === "failed" || status === "expired") return "What this command would have recorded";
  return "What will be recorded";
}

export function shortened(value: string, each: number): string {
  return value.length <= each * 2 + 1 ? value : `${value.slice(0, each)}…${value.slice(-each)}`;
}
