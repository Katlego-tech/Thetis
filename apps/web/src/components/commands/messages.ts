// The API's error messages, held verbatim (services/api routes.ts and commands/views.ts; live-lending.md
// §6.5.2 and T064b.3 fold 8), so a failed call shows the same words the API returns.

import type { ApiErrorCode } from "@/lib/api";
import type { CommandKind } from "@/lib/commands";
import { supabaseBrowser } from "@/lib/supabase-browser";

export const apiMessages: Record<ApiErrorCode | "NETWORK", string> = {
  VALIDATION: "Invalid request body or path.",
  NOT_AUTHENTICATED: "A valid bearer token is required.",
  NOT_AUTHORISED: "The caller is not authorised for this action.",
  NOT_FOUND: "The resource was not found.",
  INVITATION_EXISTS: "An open invitation already exists.",
  CHALLENGE_INVALID: "The wallet link challenge is unavailable, expired, or consumed.",
  WALLET_ALREADY_LINKED: "The wallet already has an active link.",
  EVIDENCE_VERSION_INVALID: "The evidence version cannot be finalized.",
  MEMBERSHIP_INVALID: "The membership is invalid.",
  LINK_INVALID: "The wallet link is invalid.",
  BAD_SIGNATURE: "The signature does not match the wallet link challenge.",
  WALLET_INVALID: "The wallet must be a base58-encoded Solana public key.",
  INTERNAL: "An internal error occurred.",
  WRONG_SETTLEMENT_MODE: "This action is not available in this instance's settlement mode.",
  ACCOUNT_MISSING: "A chain account this action needs does not exist.",
  PAYMENT_ALREADY_RECORDED: "A payment with this bank reference is already recorded on chain.",
  PAYMENT_NOT_CONFIRMED: "No confirmed payment of the release amount exists for this intent.",
  EVIDENCE_INVALID: "The evidence file is not a finalized bank record of this lender.",
  WALLET_NOT_LINKED: "The wallet is not linked to your account for this organisation.",
  AUTHORITY_INVALID: "The wallet has no current on-chain authority for this action.",
  ALREADY_SIGNED: "This role has already signed.",
  COMMAND_STATE: "The command cannot do that in its current state.",
  STALE_TEXT: "The signature is for an earlier text.",
  TEXT_EXPIRED: "The text expired before it was submitted.",
  BLOCKHASH_EXPIRED: "The transaction is too old. Request a new one.",
  TOKEN_ACCOUNT_MISSING: "The wallet has no token account for the pool's test token.",
  ROLE_INVALID: "That role is not a signer of this command.",
  TRANSACTION_TOO_LARGE:
    "The transaction for this command is larger than devnet's 1,232 bytes. Nothing was sent.",
  TRANSACTION_MISMATCH: "The signed transaction is not the one Thetis issued.",
  TOO_MANY_OPEN_COMMANDS:
    "You have five open commands. Finish or let one end before starting another.",
  COMMANDS_UNAVAILABLE: "Signing is not configured on this server.",
  CHAIN_UNAVAILABLE: "Thetis could not reach devnet. Nothing was changed.",
  SPONSOR_UNAVAILABLE: "The fee sponsor did not answer. Nothing was sent.",
  LOOKUP_TABLE_FULL: "The instance's address table is full.",
  ACCEPTANCE_MISSING: "A lender with a lock on this lot has not accepted this loading.",
  LOAN_NOT_ACTIVE: "A loan with a lock on this lot is not active, so the lot can't be loaded.",
  LOADING_NOT_OPEN: "This loading intent is no longer open.",
  LOADING_EXPIRED: "This loading intent has expired.",
  TOO_MANY_LOANS: "More than four loans hold locks on this lot; one loading takes at most four.",
  LOADING_SUPERSEDED:
    "The position changed after this loading intent was created. Create a new loading intent.",
  LOAN_UNDER_EXCEPTION: "A payment correction is open on this loan, so it can't accept a loading.",
  NETWORK: "Thetis could not reach its API. Nothing was changed.",
};

/** The message for a failed call, with the API's `detail` after it when there is one. */
export function failureMessage(result: {
  code: ApiErrorCode | "NETWORK";
  detail?: string;
}): string {
  const message = apiMessages[result.code];
  return result.detail ? `${message} ${result.detail}` : message;
}

/** The names a loading refusal reads: each visible loan's lender and index, and the intent's owner. */
export type FailureNames = {
  lenders?: Record<string, { name: string; index: string }>;
  owner?: string;
};

/**
 * live-lending.md §6.10.6's relay refusals at create for the loading kinds, naming the lender of the
 * detail's `loan: <address>` (for accept_loading, of `args.loan`, T064b.4 pre-check fold 3); every
 * other kind and code reads failureMessage.
 */
export function commandFailureMessage(
  kind: CommandKind,
  result: { code: ApiErrorCode | "NETWORK"; detail?: string },
  names: FailureNames,
  args: Record<string, string> = {},
): string {
  const sent = "Nothing was sent.";
  const detailLoan = /^loan: (\S+)$/.exec(result.detail ?? "")?.[1];
  const named = (loan: string | undefined) =>
    loan === undefined ? undefined : names.lenders?.[loan];
  if (kind === "record_loading") {
    const lender = named(detailLoan);
    if (result.code === "ACCEPTANCE_MISSING")
      return `Not every lender with a lock on this lot has accepted this loading. Ask ${lender ? lender.name : "each lender with a lock on this lot"} to accept the loading in Thetis. ${sent}`;
    if (result.code === "LOAN_NOT_ACTIVE")
      return `${lender ? `${lender.name}'s loan on this lot is` : "A loan on this lot is"} in recovery, so the lot can't be loaded until the recovery is settled. ${sent}`;
    if (result.code === "TOO_MANY_LOANS")
      return `More than four loans hold locks on this lot, and one loading takes at most four. Repay and close a loan first. ${sent}`;
  }
  if (kind === "accept_loading") {
    const index = named(args.loan)?.index;
    const loan = index === undefined ? "This loan" : `Loan ${index}`;
    if (result.code === "LOAN_NOT_ACTIVE")
      return `${loan} is not active, so it can't accept a loading. ${sent}`;
    if (result.code === "LOADING_NOT_OPEN")
      return `This loading intent is no longer open, so there is nothing to accept. ${sent}`;
    if (result.code === "LOADING_EXPIRED")
      return `This loading intent has expired. Ask ${names.owner ?? "the owner"} to create a new one. ${sent}`;
    // T056r driver decisions 2: the chain's StaleRevision and LoanUnderException, refused at create.
    if (result.code === "LOADING_SUPERSEDED")
      return `The position changed after this loading intent was created, so it can't be accepted. Ask ${names.owner ?? "the owner"} to create a new one. ${sent}`;
    if (result.code === "LOAN_UNDER_EXCEPTION")
      return `A payment correction is open on ${index === undefined ? "this loan" : `loan ${index}`}, so it can't accept a loading until the correction is settled. ${sent}`;
    if (result.code === "VALIDATION" && result.detail === "args.loan")
      return `${loan} has no lock on the position this intent loads, so it has nothing to accept. ${sent}`;
  }
  if (kind === "create_loading_intent" && result.code === "EVIDENCE_INVALID")
    return `The loading document is not stored for this lot. Upload it again. ${sent}`;
  return failureMessage(result);
}

/** The browser session's access token and user id; null when there is none. */
export async function browserSession(): Promise<{ token: string; userId: string } | null> {
  const { data, error } = await supabaseBrowser().auth.getSession();
  const session = error ? null : data.session;
  return session ? { token: session.access_token, userId: session.user.id } : null;
}
