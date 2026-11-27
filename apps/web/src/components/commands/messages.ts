// The API's error messages, held verbatim (services/api routes.ts and commands/views.ts; live-lending.md
// §6.5.2 and T064b.3 fold 8), so a failed call shows the same words the API returns.

import type { ApiErrorCode } from "@/lib/api";
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

/** The browser session's access token and user id; null when there is none. */
export async function browserSession(): Promise<{ token: string; userId: string } | null> {
  const { data, error } = await supabaseBrowser().auth.getSession();
  const session = error ? null : data.session;
  return session ? { token: session.access_token, userId: session.user.id } : null;
}
