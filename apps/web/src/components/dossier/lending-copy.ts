// Live lending labels shared by the dossier, the release page and the queue (live-lending.md §6.9).

import type { LiveCommandSummary, LiveLoan, LivePaymentState } from "@/data/live/types";
import type { CommandKind } from "@/lib/commands";
import { formatClockTime } from "@/lib/format";

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
};

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
