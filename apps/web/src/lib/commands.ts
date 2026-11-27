// The relay's commands as the web reads and signs them (live-lending.md §6.5, §6.8, §6.9.4).
// Client and server. The types are services/api's §6.5.4 view, declared here verbatim.

import { type ApiResult, apiGet, apiPost } from "./api";

export type CommandKind =
  | "open_facility"
  | "set_valuation"
  | "pledge"
  | "record_advance"
  | "confirm_payment"
  | "correct_payment"
  | "repay"
  | "create_release_intent"
  | "sell_pledged"
  | "liquidate"
  | "close_loan"
  | "deposit"
  | "withdraw"
  | "borrow"
  | "repay_simulated"
  | "create_loading_intent"
  | "record_loading"
  | "accept_loading";
export type CommandStatus =
  | "awaiting_signatures"
  | "submitted"
  | "confirmed"
  | "failed"
  | "outcome_unknown"
  | "expired";
export type SignerRole =
  | "borrower"
  | "lender"
  | "seller"
  | "buyer"
  | "depositor"
  | "payer"
  | "owner"
  | "terminal";
export interface CommandView {
  id: string;
  kind: CommandKind;
  status: CommandStatus;
  network: "devnet";
  programId: string;
  protocol: string;
  initiatorOrganisationId: string;
  parties: string[];
  lot: string | null;
  facility: string | null;
  loan: string | null;
  intent: string | null;
  payment: string | null;
  args: Record<string, string>;
  fields: { label: string; value: string }[];
  text: {
    version: number;
    messageBase64: string;
    messageSha256: string;
    validUntil: string;
    validUntilText: string;
  } | null; // validUntilText = formatSast(validUntil)
  signers: {
    role: SignerRole;
    organisationId: string;
    method: "text" | "transaction";
    signed: { wallet: string; signedAt: string } | null;
  }[];
  transaction: {
    signature: string;
    sends: number;
    explorerUrl: string;
  } | null; // https://explorer.solana.com/tx/<sig>?cluster=devnet
  confirmedSlot: string | null;
  confirmedCommitment: "confirmed" | "finalized" | null; // the row's columns
  outcome: {
    event: string;
    slot: string;
    commitment: "confirmed" | "finalized";
    data: Record<string, unknown>;
  } | null; // indexer.md §3 JSON rule
  error: { code: string; detail: string | null } | null;
  createdAt: string;
  updatedAt: string;
}

const base = (id: string) => `/v1/commands/${encodeURIComponent(id)}`;

export function createCommand(
  body: { kind: CommandKind; organisationId: string; args: Record<string, string> },
  accessToken: string,
): Promise<ApiResult<CommandView>> {
  return apiPost<CommandView>("/v1/commands", body, accessToken);
}

export function getCommand(id: string, accessToken: string): Promise<ApiResult<CommandView>> {
  return apiGet<CommandView>(base(id), accessToken);
}

export function postCommandSignature(
  id: string,
  body: { role: SignerRole; wallet: string; messageSha256: string; signature: string },
  accessToken: string,
): Promise<ApiResult<CommandView>> {
  return apiPost<CommandView>(`${base(id)}/signatures`, body, accessToken);
}

export function requestCommandTransaction(
  id: string,
  wallet: string,
  accessToken: string,
): Promise<ApiResult<{ transactionBase64: string; lastValidBlockHeight: string }>> {
  return apiPost(`${base(id)}/transaction-request`, { wallet }, accessToken);
}

export function postCommandTransaction(
  id: string,
  transactionBase64: string,
  accessToken: string,
): Promise<ApiResult<CommandView>> {
  return apiPost<CommandView>(`${base(id)}/transaction`, { transactionBase64 }, accessToken);
}

export function renewCommand(id: string, accessToken: string): Promise<ApiResult<CommandView>> {
  return apiPost<CommandView>(`${base(id)}/renew`, {}, accessToken);
}

export const kindTitles: Record<CommandKind, string> = {
  open_facility: "Open facility",
  set_valuation: "Set valuation",
  pledge: "Pledge receipts",
  record_advance: "Record advance",
  confirm_payment: "Confirm payment",
  correct_payment: "Correct payment",
  repay: "Apply repayment",
  create_release_intent: "Create release intent",
  sell_pledged: "Buy pledged receipts",
  liquidate: "Move to recovery",
  close_loan: "Close loan",
  deposit: "Deposit test tokens",
  withdraw: "Withdraw test tokens",
  borrow: "Borrow test tokens",
  repay_simulated: "Repay with test tokens",
  create_loading_intent: "Create loading intent",
  record_loading: "Record loading",
  accept_loading: "Accept loading",
};

export const roleLabels: Record<SignerRole, string> = {
  borrower: "Borrower",
  lender: "Lender",
  seller: "Seller",
  buyer: "Buyer",
  depositor: "Depositor",
  payer: "Payer",
  owner: "Owner",
  terminal: "Terminal",
};

const authority = "A signer's authority does not allow this action.";
const outOfTime = "The signed text was no longer valid when it reached the chain.";
const explanations: Record<string, string> = {
  StaleRevision: "The lot or loan changed after this was prepared. Start the action again.",
  InsufficientAvailable:
    "Those units are not available: they are already pledged, reserved or sold.",
  OverLimit: "The advance would take the debt above the loan-to-value limit.",
  ValuationStale: "The valuation has expired. Set a new one first.",
  ValuationMismatch:
    "There is no valuation for this lot's class, grade and site under this facility.",
  ResidualOverLimit:
    "The debt left after this sale would be above the limit. The seller needs to add a top-up.",
  LoanNotActive: "The loan is not active.",
  LoanHealthy: "The loan is within its limit, so it can't move to recovery.",
  DebtOutstanding: "The loan still has debt, so it can't close.",
  LiveObligation: "A payment correction is open on this loan, so it can't close or release.",
  LoanUnderException: "A payment correction is open on this loan, so it can't close or release.",
  PaymentConsumed: "That payment has already been applied or voided.",
  PaymentNotBound: "That payment does not belong to this loan, purpose and amount.",
  IntentExpired: "The release intent has expired.",
  IntentNotOpen: "The release has already happened.",
  CurrencyMismatch: "The currency differs from the facility's.",
  Paused: "This action is paused on the instance.",
  AuthorityRevoked: authority,
  AuthorityExpired: authority,
  ScopeMissing: authority,
  WrongOrganisation: authority,
  WrongRole: authority,
  WrongSigner: authority,
  Expired: outOfTime,
  WindowTooLong: outOfTime,
};

// live-lending.md §6.10.6: the chain's refusals of the three loading kinds, preferred for them.
const loadingKinds: readonly CommandKind[] = [
  "create_loading_intent",
  "record_loading",
  "accept_loading",
];
const loadingExplanations: Record<string, string> = {
  AcceptanceMissing:
    "Not every lender with a lock on this lot had accepted when the transaction reached devnet. Ask each lender to accept, then record the loading again.",
  AcceptanceStale:
    "A loan changed after its lender accepted. Ask that lender to accept again, then record the loading again.",
  LoanNotActive:
    "A loan on this lot is in recovery, so the lot can't be loaded until the recovery is settled.",
  LoadingExpired: "The loading intent expired. Create a new loading intent.",
  LoadingNotOpen: "The loading intent is no longer open.",
  LotNotStored: "The lot is not stored at the terminal, so it can't be loaded.",
  Restricted: "The lot is restricted, so it can't be loaded until the restriction is lifted.",
  StaleRevision:
    "The position or loan changed after this was prepared. Create a new loading intent, or accept again.",
};
const notATerminal = "The lot's custodian is not a terminal, so the lot can't be loaded there.";

export function failureExplanation(code: string, kind?: CommandKind): string {
  if (kind !== undefined && loadingKinds.includes(kind)) {
    if (code === "WrongRole" && kind === "create_loading_intent") return notATerminal;
    if (Object.hasOwn(loadingExplanations, code)) return loadingExplanations[code] as string;
  }
  return Object.hasOwn(explanations, code)
    ? (explanations[code] as string)
    : "See the transaction on the explorer for the program's message.";
}
