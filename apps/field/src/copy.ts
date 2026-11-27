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

export function failedCommandCopy(code: string, vars: CopyVars): string {
  const message = FAILED_COMMAND_MESSAGES[code];
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

/** Copy for a relay error (nothing was sent), or null when the code has none (re-fetch, sign in). */
export function relayErrorCopy(code: string, phase: RelayPhase, v: RelayCopyVars): string | null {
  if (REFETCH_CODES.has(code) || code === "NOT_AUTHENTICATED") return null;
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
