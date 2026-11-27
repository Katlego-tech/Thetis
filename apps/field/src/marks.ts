// Registry marks: the only place a registry state is stated.
import type { CommandStatus } from "./api/commands";

export type RegistryMark =
  | "Not on chain"
  | "Draft"
  | "Awaiting signatures"
  | "Submitted, unconfirmed"
  | "Confirmed"
  | "Finalized"
  | "Failed"
  | "Outcome unknown";

export function markFor(
  status: CommandStatus,
  commitment: "confirmed" | "finalized" | null,
): RegistryMark {
  switch (status) {
    case "awaiting_signatures":
      return "Awaiting signatures";
    case "submitted":
      return "Submitted, unconfirmed";
    case "confirmed":
      return commitment === "finalized" ? "Finalized" : "Confirmed";
    case "failed":
      return "Failed";
    case "outcome_unknown":
      return "Outcome unknown";
    case "expired":
      return "Not on chain";
  }
}
