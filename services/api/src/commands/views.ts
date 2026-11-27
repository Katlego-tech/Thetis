// What the API returns for a command (live-lending.md §6.5.4), the stored row it is built from,
// and the relay's own error codes (§6.5.2). apps/web/src/lib/commands.ts declares the same view.

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
  | "repay_simulated";
export type CommandStatus =
  | "awaiting_signatures"
  | "submitted"
  | "confirmed"
  | "failed"
  | "outcome_unknown"
  | "expired";
export type SignerRole = "borrower" | "lender" | "seller" | "buyer" | "depositor" | "payer";

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
  } | null;
  signers: {
    role: SignerRole;
    organisationId: string;
    method: "text" | "transaction";
    signed: { wallet: string; signedAt: string } | null;
  }[];
  transaction: { signature: string; sends: number; explorerUrl: string } | null;
  confirmedSlot: string | null;
  confirmedCommitment: "confirmed" | "finalized" | null;
  outcome: {
    event: string;
    slot: string;
    commitment: "confirmed" | "finalized";
    data: Record<string, unknown>;
  } | null;
  error: { code: string; detail: string | null } | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoredSigner {
  role: SignerRole;
  organisationId: string;
  method: "text" | "transaction";
  scope: string;
}

export interface StoredSignature {
  role: SignerRole;
  wallet: string;
  signature: string;
  signedAt: string;
}

/** A public.commands row as the service client reads it. */
export interface CommandRow {
  id: string;
  network: "devnet";
  program_id: string;
  protocol: string;
  kind: CommandKind;
  status: CommandStatus;
  created_by: string;
  initiator_org: string;
  parties: string[];
  lot: string | null;
  facility: string | null;
  loan: string | null;
  intent: string | null;
  payment: string | null;
  args: Record<string, string>;
  plan: Record<string, string>;
  fields: { label: string; value: string }[];
  text_version: number;
  message_base64: string | null;
  message_sha256: string | null;
  valid_until: string | null;
  signers: StoredSigner[];
  signatures: StoredSignature[];
  pending_message_base64: string | null;
  pending_wallet: string | null;
  pending_last_valid_block_height: string | null;
  transaction_base64: string | null;
  transaction_signature: string | null;
  last_valid_block_height: string | null;
  sends: number;
  error_code: string | null;
  error_detail: string | null;
  outcome: { event: string; slot: string; data: Record<string, unknown> } | null;
  confirmed_slot: number | string | null;
  confirmed_commitment: "confirmed" | "finalized" | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

export const RELAY_ERRORS = {
  WRONG_SETTLEMENT_MODE: [409, "This action is not available in this instance's settlement mode."],
  ACCOUNT_MISSING: [409, "A chain account this action needs does not exist."],
  PAYMENT_ALREADY_RECORDED: [
    409,
    "A payment with this bank reference is already recorded on chain.",
  ],
  PAYMENT_NOT_CONFIRMED: [
    409,
    "No confirmed payment of the release amount exists for this intent.",
  ],
  EVIDENCE_INVALID: [409, "The evidence file is not a finalized bank record of this lender."],
  WALLET_NOT_LINKED: [409, "The wallet is not linked to your account for this organisation."],
  AUTHORITY_INVALID: [409, "The wallet has no current on-chain authority for this action."],
  ALREADY_SIGNED: [409, "This role has already signed."],
  COMMAND_STATE: [409, "The command cannot do that in its current state."],
  STALE_TEXT: [409, "The signature is for an earlier text."],
  TEXT_EXPIRED: [409, "The text expired before it was submitted."],
  BLOCKHASH_EXPIRED: [409, "The transaction is too old. Request a new one."],
  TOKEN_ACCOUNT_MISSING: [409, "The wallet has no token account for the pool's test token."],
  ROLE_INVALID: [422, "That role is not a signer of this command."],
  TRANSACTION_MISMATCH: [422, "The signed transaction is not the one Thetis issued."],
  TOO_MANY_OPEN_COMMANDS: [
    429,
    "You have five open commands. Finish or let one end before starting another.",
  ],
  COMMANDS_UNAVAILABLE: [503, "Signing is not configured on this server."],
  CHAIN_UNAVAILABLE: [503, "Thetis could not reach devnet. Nothing was changed."],
  SPONSOR_UNAVAILABLE: [503, "The fee sponsor did not answer. Nothing was sent."],
  LOOKUP_TABLE_FULL: [503, "The instance's address table is full."],
} as const;

export type RelayErrorCode =
  | keyof typeof RELAY_ERRORS
  | "VALIDATION"
  | "NOT_AUTHORISED"
  | "NOT_FOUND"
  | "BAD_SIGNATURE"
  | "INTERNAL";

export class RelayError extends Error {
  readonly code: RelayErrorCode;
  readonly detail: string | undefined;

  constructor(code: RelayErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "RelayError";
    this.code = code;
    this.detail = detail;
  }
}

function iso(unix: string): string {
  return new Date(Number(BigInt(unix) * 1000n)).toISOString();
}

export function explorerUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}

export function toView(row: CommandRow, validUntilText: (unix: bigint) => string): CommandView {
  const signedAt = new Map(row.signatures.map((s) => [s.role, s]));
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    network: "devnet",
    programId: row.program_id,
    protocol: row.protocol,
    initiatorOrganisationId: row.initiator_org,
    parties: row.parties,
    lot: row.lot,
    facility: row.facility,
    loan: row.loan,
    intent: row.intent,
    payment: row.payment,
    args: row.args,
    fields: row.fields,
    text:
      row.message_base64 && row.message_sha256 && row.valid_until
        ? {
            version: row.text_version,
            messageBase64: row.message_base64,
            messageSha256: row.message_sha256,
            validUntil: iso(row.valid_until),
            validUntilText: validUntilText(BigInt(row.valid_until)),
          }
        : null,
    signers: row.signers.map((signer) => {
      const signature = signedAt.get(signer.role);
      return {
        role: signer.role,
        organisationId: signer.organisationId,
        method: signer.method,
        signed: signature ? { wallet: signature.wallet, signedAt: signature.signedAt } : null,
      };
    }),
    transaction: row.transaction_signature
      ? {
          signature: row.transaction_signature,
          sends: row.sends,
          explorerUrl: explorerUrl(row.transaction_signature),
        }
      : null,
    confirmedSlot: row.confirmed_slot === null ? null : String(row.confirmed_slot),
    confirmedCommitment: row.confirmed_commitment,
    outcome:
      row.outcome && row.confirmed_commitment
        ? { ...row.outcome, commitment: row.confirmed_commitment }
        : null,
    error: row.error_code ? { code: row.error_code, detail: row.error_detail } : null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}
