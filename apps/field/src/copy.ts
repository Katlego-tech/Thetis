// Visible copy for refusals and failures. Every string here is shown to a person verbatim.

export interface CopyVars {
  org: string;
  owner?: string;
  site?: string;
  quantity?: string;
  to?: string;
  /** The lender of the loan a loading refusal names, when the screen knows it. */
  lender?: string;
  /** Who holds the batch now, for a handover that did not land. */
  holder?: string;
}

const AUTHORITY = "A signer's authority does not allow this action.";
const SIGNATURE = "The signature did not match what Thetis expected.";
const WINDOW = "The signed text was no longer valid when it reached devnet.";
const NO_ACCOUNT =
  "An authority or record this action needs does not exist on this Thetis instance.";
const ANOTHER_HANDOVER =
  "Another handover of this batch was recorded first. Nothing was recorded for this one. Open the batch again to see who holds it.";
const cantHandOver = (code: string) => `This batch can't be handed over now (${code}).`;
const cantRecordLoading = (code: string) => `This loading can't be recorded now (${code}).`;

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
  RecipientNotApproved: (v) => `${v.to} is not the next holder this batch allows.`,
  StaleRevision: () =>
    "Another change reached this record first. Start again from the current state.",
  Anchor3012: () => NO_ACCOUNT,
  ManifestMismatch: (v) => cantHandOver(v.code),
  StageOutOfOrder: (v) => cantHandOver(v.code),
  ShipmentNotOpen: (v) => cantHandOver(v.code),
  ShipmentIncomplete: (v) => cantHandOver(v.code),
  DepartureDocumentInvalid: (v) => cantHandOver(v.code),
  Restricted: (v) => cantHandOver(v.code),
  AcceptanceMissing: (v) => cantRecordLoading(v.code),
  AcceptanceStale: (v) => cantRecordLoading(v.code),
  LoadingExpired: (v) => cantRecordLoading(v.code),
  LoadingNotOpen: (v) => cantRecordLoading(v.code),
  LotNotStored: (v) => cantRecordLoading(v.code),
};

/**
 * Codes that are not Thetis program errors besides Anchor0: the program-error check skips them.
 * Anchor3012 is the framework's own "account not initialized" refusal.
 */
export const LATER_FAILED_CODES: ReadonlySet<string> = new Set<string>(["Anchor3012"]);

/**
 * A handover's own wording, where the shared message would not say who still holds the batch.
 * Anchor0 here means a second handover tried to create a record the first already made.
 */
export const HANDOVER_FAILED_MESSAGES: Record<string, (v: CopyVars & { code: string }) => string> =
  {
    StaleRevision: () => ANOTHER_HANDOVER,
    Anchor0: () => ANOTHER_HANDOVER,
    Anchor3012: (v) => `${NO_ACCOUNT} ${v.holder} still holds the batch.`,
  };

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
 * A loading's own wording: each row says the next step. `lender` names the lender when the screen knows it; the chain's refusal does not say
 * which loan it was, so the rows read without it.
 */
export const LOADING_FAILED_MESSAGES: Record<string, (v: CopyVars & { code: string }) => string> = {
  AcceptanceMissing: (v) =>
    `Not every lender with a lock on this lot has accepted this loading. ${askToAccept(v.lender)} If a loan on this lot is in recovery, the lot can't be loaded until the lender's recovery clears its lock.`,
  LoanNotActive: (v) => inRecovery(v.lender),
};

function askToAccept(lender: string | undefined): string {
  return `Ask ${lender ?? "each lender with a lock on this lot"} to accept the loading in Thetis.`;
}

function inRecovery(lender: string | undefined): string {
  return `${lender ? `${lender}'s loan` : "A loan on this lot"} is in recovery; the lot cannot be loaded until it is settled.`;
}

/** `kind` is the command's kind; a handover's, an observation's or a loading's own rows win over the shared table. */
export function failedCommandCopy(code: string, vars: CopyVars, kind?: string): string {
  const own =
    kind === "handover"
      ? HANDOVER_FAILED_MESSAGES[code]
      : kind === "record_observation"
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
  /** The lender of the loan in an ACCEPTANCE_MISSING or LOAN_NOT_ACTIVE detail. */
  lender?: string;
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
  // The initiator rule is checked at create; at sign it is the not-a-member refusal.
  if (v.kind === "record_loading" && code === "NOT_AUTHORISED" && phase === "create") {
    return `${v.org} is neither the owner nor the terminal of this loading. Nothing was sent.`;
  }
  if (v.kind === "record_observation") {
    if (code === "EVIDENCE_INVALID") {
      return "The photo must be of this batch, taken by your organisation. Retake it and try again. Nothing was sent.";
    }
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
    case "ACCEPTANCE_MISSING":
      return `Not every lender with a lock on this lot has accepted this loading. ${askToAccept(v.lender)} Nothing was sent.`;
    case "LOAN_NOT_ACTIVE":
      return `${inRecovery(v.lender)} Nothing was sent.`;
    case "TOO_MANY_LOANS":
      return "More than four loans hold locks on this lot, and one loading takes at most four. Nothing was sent.";
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

/** The tab bar, the top-bar switcher and the Account tab (navigation.md §9.2). */
export const NAV_COPY = {
  tabHome: "Home",
  tabBatches: "Batches",
  tabLoadings: "Loadings",
  tabAccount: "Account",
  busyHint: "Wait for your wallet to finish.",
  switchLabel: "Switch organisation, now {org}",
  accountTitle: "Account",
  organisationTitle: "Organisation",
  switchOrganisation: "Switch organisation",
  signedInTitle: "Signed in",
  signOut: "Sign out",
  signOutHelp: "Your drafts stay on this phone. Signing in again needs a code from your email.",
  pickerFootnote:
    "Drafts and wallets are kept per organisation. You can switch later from Account.",
} as const;

/** Talk, the voice strip and the voice refusals (voice.md §5.1, §5.2), field strings only. */
export const VOICE_COPY = {
  talk: "Talk",
  connecting: "Connecting",
  end: "End",
  names: {
    talk: "Talk to the Thetis navigator",
    connecting: "Connecting to voice",
    end: "End voice session",
    retry: "Try voice again",
  },
  status: {
    starting: "Starting voice.",
    newSession: "Getting a new voice session.",
    listening: "Listening.",
    speaking: "Speaking.",
    unavailable: "Voice is unavailable. Use the controls below.",
    microphone:
      "Microphone access is off for Thetis field. Allow it in Android settings, then press Talk.",
  },
  refusals: {
    UNKNOWN_SCREEN: "That screen is not in Thetis.",
    BAD_ID: "That is not a lot id. Lot ids look like CR-0001.",
    NOT_ON_PHONE: {
      exceptions: "Exceptions are on the web workbench, not on this phone.",
      lot: "The lot dossier is on the web workbench, not on this phone.",
      release: "Release review is on the web workbench, not on this phone.",
    },
    BUSY: "Your wallet is signing. The screen stays as it is until it finishes.",
  },
} as const;
