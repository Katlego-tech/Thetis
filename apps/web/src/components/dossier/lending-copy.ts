// Live lending labels shared by the dossier, the release page and the queue (live-lending.md §6.9).

import type {
  LiveCommandSummary,
  LiveLoadingIntent,
  LiveLoadingRow,
  LiveLoan,
  LivePaymentState,
  LoadingState,
} from "@/data/live/types";
import type { CommandKind } from "@/lib/commands";
import { formatClockTime, formatDateTime } from "@/lib/format";

export const livePaymentLabels: Record<LivePaymentState, string> = {
  none: "Not confirmed",
  confirmed: "Confirmed by lender",
  mismatch: "Recorded, amount differs from the intent",
  consumed: "Applied by the sale",
  voided: "Voided by lender",
};

export const loanStatusLabels: Record<LiveLoan["status"], string> = {
  Active: "Active",
  Recovery: "In recovery",
  ExternalHandoff: "External hand-off",
  Closed: "Closed",
};

export const RATE_BASIS = "a year, simple, actual/365";

/** The context's identifiers a lending form sends (live-lending.md §6.9.5 "Identifiers"). */
export type LendingActions = {
  /** the context's organisation uuid (`memberships.id`) */
  organisationId: string;
  /** Buyer organisations for the release intent form, by uuid */
  buyers: { value: string; label: string }[];
};

/** Signers per kind, live-lending.md §4.3's Signers column. */
const signerCounts: Record<CommandKind, number> = {
  open_facility: 1,
  set_valuation: 1,
  pledge: 2,
  record_advance: 2,
  confirm_payment: 1,
  correct_payment: 1,
  repay: 1,
  create_release_intent: 1,
  sell_pledged: 1,
  liquidate: 1,
  close_loan: 1,
  deposit: 1,
  withdraw: 1,
  borrow: 1,
  repay_simulated: 1,
  create_loading_intent: 1,
  record_loading: 2,
  accept_loading: 1,
};

// Loading (live-lending.md §6.10.5, verbatim).

export const loadingStateLabels: Record<LoadingState, string> = {
  open: "Open",
  ready: "Ready to record",
  recorded: "Recorded",
  expired: "Expired",
  cancelled: "Cancelled",
  outdated: "Out of date",
};

const noLock = "No loan holds a lock on this position, so no lender needs to accept.";

/** The block's line for its state, from chain rows and the render clock only. */
export function loadingTally(intent: LiveLoadingIntent): string {
  const { accepted, required } = intent;
  switch (intent.state) {
    case "open":
      if (required === null)
        return "Your loan's acceptance is below. Acceptances of other lenders' loans are not visible to you.";
      if (required === 0) return noLock;
      return `Accepted for ${accepted} of ${required} loans on chain. The loading can be recorded once every loan with a lock on this position is accepted.`;
    case "ready":
      // T064b.4 pre-check fold 12: no lock, nothing to accept.
      if (required === 0) return noLock;
      return `Accepted for ${accepted} of ${required} loans on chain. ${intent.terminal.name} and ${intent.owner.name} can now record the loading.`;
    case "recorded":
      return intent.executedAt === null
        ? "Recorded on devnet."
        : `Recorded on devnet ${formatDateTime(intent.executedAt)}.`;
    case "expired":
      return `Expired ${formatDateTime(intent.expiresAt)}. It can no longer be recorded.`;
    case "cancelled":
      return "Cancelled when a shipment of this position was prepared. The Thetis indexer marked this from the chain.";
    case "outdated":
      return "The position changed after this intent was prepared, so it can't be recorded.";
  }
}

/** A recorded intent's outcome lines, from the loan and lot rows (§6.10.5, fold 6). */
export function outcomeLines(intent: LiveLoadingIntent): string[] {
  if (intent.handOffs.length === 0)
    return [intent.lotLoaded ? "Registry retired." : "Position loaded."];
  return intent.handOffs.map(({ loanIndex, lender, status, debtMinor }) => {
    let outcome: string;
    if (status === "ExternalHandoff")
      outcome = `${intent.lotLoaded ? "Registry retired" : "Position loaded"}; debt remains recorded; external hand-off accepted by lender`;
    else if (status !== "Closed" && debtMinor === 0n)
      outcome = "Position loaded. The loan has no debt and is ready to close.";
    else outcome = "Position loaded.";
    return `Loan ${loanIndex.toString()}, ${lender.name}: ${outcome}`;
  });
}

/** The acceptance cell: the row's lender reads its own line, every other viewer the owner's (fold 8). */
export function rowAcceptance(row: LiveLoadingRow, own: boolean): string {
  switch (row.state) {
    case "accepted":
      return row.acceptedAt === null
        ? "Not accepted"
        : `Accepted ${formatDateTime(row.acceptedAt)}`;
    case "stale":
      return own
        ? `Accepted before loan ${row.loanIndex.toString()} changed. Accept again.`
        : `Accepted before the loan changed. ${row.lender.name} needs to accept again.`;
    case "missing":
      return "Not accepted";
    case "recovery":
      return own
        ? "In recovery. The lot can't be loaded until your recovery clears this lock."
        : `In recovery. The lot can't be loaded until ${row.lender.name}'s recovery clears its lock.`;
  }
}

/** §6.9.4's status line for an open command the snapshot read (open statuses only). */
export function summaryLine(command: LiveCommandSummary): string {
  if (command.status === "submitted")
    return "Sent to devnet. Waiting for the network to confirm it.";
  if (command.status === "outcome_unknown")
    return "Thetis can't tell yet whether this transaction landed. Don't start this action again; this page keeps checking.";
  if (command.validUntil !== null) {
    const total = signerCounts[command.kind];
    const expires = new Date(Date.parse(command.validUntil) - 30_000).toISOString();
    return `Waiting for ${command.awaiting.length} of ${total} signatures. The text expires at ${formatClockTime(expires)}.`;
  }
  const [first] = command.awaiting;
  return `Waiting for ${first ? first.organisation.name : "the signer"} to sign the transaction.`;
}
