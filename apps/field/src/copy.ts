// Visible copy for refusals and failures. Every string here is shown to a person verbatim.

export interface CopyVars {
  org: string;
  owner?: string;
  site?: string;
  quantity?: string;
  to?: string;
}

const AUTHORITY = "A signer's authority does not allow this action.";
const SIGNATURE = "The signature did not match what Thetis expected.";
const WINDOW = "The signed text was no longer valid when it reached devnet.";

/** Program errors a failed command can carry, by `error.code`. */
export const FAILED_COMMAND_MESSAGES: Record<string, (v: CopyVars & { code: string }) => string> = {
  OverCapacity: (v) => `${v.quantity} is more than ${v.site} has room for.`,
  RelatedCustodian: (v) =>
    `${v.org} is declared related to ${v.owner}, so it can't hold this lot as an independent custodian.`,
  WrongRole: (v) => `${v.owner} is not accredited as an exporter, so it can't own a new lot.`,
  OriginInvalid: () => "The origin attestation for this intake is missing, revoked or expired.",
  Anchor0: () =>
    "Thetis already has this intake or this lot ID. A second lot for the same intake is refused.",
  AuthorityRevoked: () => AUTHORITY,
  AuthorityExpired: () => AUTHORITY,
  ScopeMissing: () => AUTHORITY,
  WrongOrganisation: () => AUTHORITY,
  WrongSigner: () => AUTHORITY,
  InvalidField: () => "Thetis refused one of the values in this text.",
  ZeroQuantity: () => "The quantity is zero.",
  Paused: () => "This action is paused on this Thetis instance.",
  Expired: () => WINDOW,
  WindowTooLong: () => WINDOW,
  MissingVerification: () => SIGNATURE,
  MalformedVerification: () => SIGNATURE,
  WrongSignatureCount: () => SIGNATURE,
  CrossInstructionReference: () => SIGNATURE,
  MessageMismatch: () => SIGNATURE,
};

/**
 * Codes whose messages belong to the custody screens. They name program errors that are added
 * with those screens, so the program-error check skips them until then. Empty for now.
 */
export const LATER_FAILED_CODES: ReadonlySet<string> = new Set<string>();

/**
 * A border or checkpoint observation's own wording for program errors whose shared message names
 * another action (WrongRole speaks of exporters) or that only observations reach this way.
 */
export const OBSERVATION_FAILED_MESSAGES: Record<
  string,
  (v: CopyVars & { code: string }) => string
> = {
  WrongRole: (v) =>
    `${v.org} can't record this kind of observation. A border crossing is recorded only by a transporter or a terminal.`,
  ShipmentNotOpen: () =>
    "This batch's shipment was cancelled, so no observation can be recorded for it.",
  StaleRevision: () =>
    "Another observation of this batch was recorded first. Prepare the text again.",
};

/**
 * A loading's own wording: a lot whose loan is in Recovery can't be loaded until the lender's
 * recovery clears the lock, and the program refuses it as one of these two codes.
 */
export const LOADING_FAILED_MESSAGES: Record<string, (v: CopyVars & { code: string }) => string> = {
  AcceptanceMissing: () =>
    "Not every lender with a lock on this lot has accepted this loading. If a loan on this lot is in recovery, the lot can't be loaded until the lender's recovery clears its lock.",
  LoanNotActive: () =>
    "A loan on this lot is in recovery, so the lot can't be loaded until the lender's recovery clears its lock.",
};

/** `kind` is the command's kind; an observation's or a loading's own rows win over the shared table. */
export function failedCommandCopy(code: string, vars: CopyVars, kind?: string): string {
  const own =
    kind === "record_observation"
      ? OBSERVATION_FAILED_MESSAGES[code]
      : kind === "record_loading"
        ? LOADING_FAILED_MESSAGES[code]
        : undefined;
  const message = own ?? FAILED_COMMAND_MESSAGES[code];
  return message
    ? message({ ...vars, code })
    : "See the transaction on the explorer for the program's message.";
}

export type RelayPhase = "create" | "renew" | "signatures" | "get";

export interface RelayCopyVars {
  org: string;
  detail?: string | null;
  signBefore?: string;
  siteCode?: string;
  classLabel?: string;
  ownerName?: string;
  /** The command's kind, for the rows one kind words differently. */
  kind?: string;
}

/** These make the app GET the command and map its status; they show no copy. */
export const REFETCH_CODES: ReadonlySet<string> = new Set([
  "COMMAND_STATE",
  "ALREADY_SIGNED",
  "STALE_TEXT",
]);

function accountMissingLabel(detail: string | null | undefined, v: RelayCopyVars): string {
  const key = detail?.split(":")[0]?.trim() ?? "";
  switch (key) {
    case "custodianClass":
      return `Site ${v.siteCode}`;
    case "classPolicy":
      return `Class ${v.classLabel}`;
    case "ownerOrg":
      return `${v.ownerName}`;
    case "custodianOrg":
      return v.org;
    case "origin":
      return "An origin attestation for this intake";
    case "batch":
      return "This batch";
    case "intent":
      return "This loading intent";
    default:
      return detail ?? "An account";
  }
}

/** The relay refused a text too long for one devnet transaction (TRANSACTION_TOO_LARGE). */
export function transactionTooLargeCopy(detail: string | null | undefined): string {
  return `This text is too long for one devnet transaction (${detail ?? "over the limit"}; devnet takes 1,232). Nothing was sent. Shorter organisation names or a shorter lot ID make it smaller.`;
}

/** Copy for a relay error (nothing was sent), or null when the code has none (re-fetch, sign in). */
export function relayErrorCopy(code: string, phase: RelayPhase, v: RelayCopyVars): string | null {
  if (REFETCH_CODES.has(code) || code === "NOT_AUTHENTICATED") return null;
  if (v.kind === "record_loading" && code === "NOT_AUTHORISED") {
    return `${v.org} is neither the owner nor the terminal of this loading. Nothing was sent.`;
  }
  if (v.kind === "record_observation") {
    if (code === "NOT_AUTHORISED") {
      return `${v.org} can't record observations. Only a custodian, a transporter, a terminal or an inspector can. Nothing was sent.`;
    }
    if (code === "VALIDATION" && v.detail === "observedAt") {
      return "This phone's clock is ahead of devnet's. Set the phone's time to automatic, retake the photo, and try again.";
    }
  }
  switch (code) {
    case "WALLET_NOT_LINKED":
      return `This wallet is not linked to you for ${v.org}. Link it on the Wallet screen.`;
    case "AUTHORITY_INVALID":
      return `Thetis did not send this: this wallet has no current authority for ${v.org} that allows this action (${v.detail ?? "authority"}).`;
    case "BAD_SIGNATURE":
      return "Your wallet's signature does not match the exact text. Nothing was sent. Try another wallet and report the wallet name.";
    case "TEXT_EXPIRED":
      return `This text expired at ${v.signBefore}. Nothing was sent.`;
    case "ROLE_INVALID":
      return "This phone's organisation is not a signer of this command.";
    case "ACCOUNT_MISSING":
      return `${accountMissingLabel(v.detail, v)} is not set up on this Thetis instance. Nothing was sent.`;
    case "EVIDENCE_INVALID":
      return "One of the files is not stored for this record. Upload it again.";
    case "CHAIN_UNAVAILABLE":
      return "Thetis can't reach devnet right now. Nothing was sent. Try again.";
    case "SPONSOR_UNAVAILABLE":
      return "The fee sponsor did not answer. Nothing was sent. Try again.";
    case "COMMANDS_UNAVAILABLE":
    case "LOOKUP_TABLE_FULL":
      return `Signing is not available on this Thetis server right now (${code}). Nothing was sent.`;
    case "TRANSACTION_TOO_LARGE":
      return transactionTooLargeCopy(v.detail);
    case "NOT_FOUND":
      return "Thetis can't find this command, or it is not one of yours.";
    case "TOO_MANY_OPEN_COMMANDS":
      return "You have five texts open that nobody finished. Finish one or wait for it to expire, then try again. Nothing was sent.";
  }
  switch (phase) {
    case "create":
    case "renew":
      return `Thetis could not prepare this text (${code}). Nothing was sent. Try again.`;
    case "signatures":
      return `Thetis could not take your signature (${code}). Nothing was sent. Try again.`;
    case "get":
      return `Thetis could not read this command's status (${code}). Nothing changed.`;
  }
}

export const RELAY_TIMEOUT =
  "Thetis did not answer in time. Nothing changed on this phone. Try again.";
