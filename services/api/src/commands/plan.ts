// Each command kind: who may start it, who signs, what the API reads from the chain to prepare
// it, the text or fields a person reads, and the Thetis instruction it builds
// (live-lending.md §4.3, §6.5.6). Nothing here is authority: the program checks every value.
import { randomBytes } from "node:crypto";
import {
  AccountRole,
  type Address,
  createNoopSigner,
  getAddressDecoder,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Instruction,
  type MaybeEncodedAccount,
} from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
  DOCUMENT_ATTESTATION_DISCRIMINATOR,
  type DocumentAttestation,
  DocumentKind,
  decodeClassPolicy,
  decodeCustodianClass,
  decodeDocumentAttestation,
  decodeFacility,
  decodeHandoffAcceptance,
  decodeLoadingIntent,
  decodeLoan,
  decodeLockAllocation,
  decodeLot,
  decodeManifestBatch,
  decodeOrganisation,
  decodePaymentAttestation,
  decodePoolShare,
  decodePosition,
  decodeProtocol,
  decodeReleaseIntent,
  decodeShipment,
  decodeSimulationPool,
  decodeValuation,
  type Facility,
  findAcceptancePda,
  findAuthorityPda,
  findFacilityPda,
  findHandoverPda,
  findIntakePda,
  findIntentPda,
  findLoadingIntentPda,
  findLoanPda,
  findLockPda,
  findMintAuthorityPda,
  findMintPda,
  findOrganisationPda,
  findPaymentPda,
  findPoolAuthorityPda,
  findPoolPda,
  findPositionPda,
  findSharePda,
  findVaultAuthorityPda,
  getAcceptLoadingInstruction,
  getBorrowInstruction,
  getCloseLoanInstruction,
  getConfirmPaymentInstruction,
  getCreateLoadingIntentInstruction,
  getCreateReleaseIntentInstruction,
  getDepositInstruction,
  getHandoverInstruction,
  getIssueLotInstruction,
  getLiquidateInstruction,
  getLockAllocationSize,
  getOpenFacilityInstruction,
  getPledgeInstruction,
  getRecordAdvanceInstruction,
  getRecordLoadingInstruction,
  getRecordObservationInstruction,
  getRepayInstruction,
  getSellPledgedInstruction,
  getSetValuationInstruction,
  getWithdrawInstruction,
  type HandoffAcceptance,
  LOCK_ALLOCATION_DISCRIMINATOR,
  type LoadingIntent,
  LoadingStatus,
  type Loan,
  LoanStatus,
  type LockAllocation,
  type ManifestBatch,
  ObservationKind,
  type Organisation,
  PaymentPurpose,
  PaymentStatus,
  Role,
  SettlementMode,
  type Shipment,
  THETIS_PROGRAM_ADDRESS,
  U64_MAX,
} from "@thetis/contracts";
import type { ChainPort } from "./chain.ts";
import {
  advanceMessage,
  borrowMessage,
  buyPledgedMessage,
  correctionPaymentId,
  custodyHandoverMessage,
  formatBps,
  formatMoney,
  formatSast,
  formatTonnes,
  handoverStage,
  intakeDigest,
  issueLotMessage,
  loadingIntentMessage,
  normaliseTicket,
  type ObservationKindName,
  observationMessage,
  paymentId,
  pledgeMessage,
  recordLoadingMessage,
  releaseIntentMessage,
  sourceDigest,
  termsDigest,
  textFields,
} from "./texts.ts";
import { type CommandKind, RelayError, type SignerRole, type StoredSigner } from "./views.ts";

// LockAllocation (state.rs): 8 discriminator + protocol 32 + loan 32, then the position
// (field-app.md T067r.3 fold 43).
const LOCK_POSITION_OFFSET = 72;
const LOCK_DISCRIMINATOR = Buffer.from(LOCK_ALLOCATION_DISCRIMINATOR);
/** state.rs MAX_LOADING_LOANS: the triples one record_loading takes (driver decision D3). */
const MAX_LOADING_LOANS = 4;

// DocumentAttestation (state.rs): 8 discriminator + protocol 32 + kind 1, then the subject.
const DOCUMENT_SUBJECT_OFFSET = 41;
const DOCUMENT_ATTESTATION_SIZE = 159;
const DOCUMENT_DISCRIMINATOR = Buffer.from(DOCUMENT_ATTESTATION_DISCRIMINATOR);

export const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;
export const TEXT_WINDOW_SECS = 270n;
/** Custody texts (signing-inhouse.md §6.3): the program's 600 s ceiling less the 30 s margin. */
export const CUSTODY_TEXT_WINDOW_SECS = 570n;
const DAY = 86_400n;
const HOUR = 3_600n;

// state.rs `scope`; field-app.md fold 18 adds the field kinds' scopes as their kinds land.
const SCOPES = {
  ISSUE: 1 << 0,
  PLEDGE: 1 << 5,
  CARRY: 1 << 10,
  OBSERVE: 1 << 11,
  BUY: 1 << 6,
  LEND: 1 << 7,
  POOL: 1 << 8,
  SHIP: 1 << 9,
  LOAD: 1 << 12,
} as const;
type ScopeName = keyof typeof SCOPES;

export interface SignerSpec {
  role: SignerRole;
  method: "text" | "transaction";
  scope: ScopeName | null;
  /** live-lending.md "T064b pre-check folds" item 1: false skips only the Authority check, so a
   * signer without one is refused on chain. Every lending role keeps it, except repay_simulated's
   * payer, which names no scope and whose instruction reads no Authority. */
  preCheckAuthority: boolean;
}

export interface KindSpec {
  mode: "fiat" | "simulation" | "both";
  args: readonly string[];
  signers: readonly SignerSpec[];
  event: string;
  /** An event the instruction emits once per item after `event` (field-app.md T067r.3 fold 42):
   * record_loading's LoanHandedOff, one per triple. */
  trailingEvent?: string;
  /** validUntil = chainTime + this (field-app.md fold 17); unused by kinds without a text. */
  textWindowSecs: bigint;
  /** Plan keys of program-signer PDAs that never hold an account (field-app.md fold 25): they
   * may enter the lookup table although they don't exist on chain. Derived from the plan, never
   * from a signer's wallet. */
  tableSigners?: readonly ProgramSignerKey[];
  /** Plan keys of the PDAs the instruction creates, which the relay appends to the lookup table
   * before it sends (program-custody.md §4.6 and §11.1 item 3): handover's HandoverRecord
   * `["handover", batch, sequence]`. Each is derived from the plan's seeds, never from a wallet,
   * and the transaction is built only once every text signature is in. */
  tableCreated?: readonly CreatedPdaKey[];
  /** Fields of `event` that must equal the plan's value under the same key, else the outcome is
   * unreadable (T056r R6, PR #80 review): accept_loading's LoadingAccepted.intent and .loan. */
  outcomeBinds?: readonly string[];
}

/** The plan keys a kind may name in `tableSigners` (field-app.md PR #69 fold 27): typed, so a
 * misspelt key does not compile. */
export type ProgramSignerKey = "mintAuthority" | "vaultAuthority";

/** The plan keys a kind may name in `tableCreated` (program-custody.md §4.6): typed as
 * `tableSigners` is. An `attest_shortfall` kind would add its Incident here. */
export type CreatedPdaKey = "handover";

const tx = (role: SignerRole, scope: ScopeName | null, preCheckAuthority = true): SignerSpec => ({
  role,
  method: "transaction",
  scope,
  preCheckAuthority,
});
const text = (role: SignerRole, scope: ScopeName, preCheckAuthority = true): SignerSpec => ({
  role,
  method: "text",
  scope,
  preCheckAuthority,
});

export const KIND_SPECS: Record<CommandKind, KindSpec> = {
  open_facility: {
    mode: "both",
    args: ["borrower", "currency", "currencyDecimals", "termsVersion", "rateBps", "maxLtvBps"],
    signers: [tx("lender", "LEND")],
    event: "FacilityOpened",
    textWindowSecs: TEXT_WINDOW_SECS,
  },
  set_valuation: {
    mode: "both",
    args: [
      "facility",
      "custodianClass",
      "grade",
      "valuePerKgMinor",
      "haircutBps",
      "validForDays",
      "sourceNote",
    ],
    signers: [tx("lender", "LEND")],
    event: "ValuationSet",
    textWindowSecs: TEXT_WINDOW_SECS,
  },
  pledge: {
    mode: "both",
    args: ["facility", "lot", "quantityKg"],
    signers: [text("borrower", "PLEDGE"), text("lender", "LEND")],
    event: "Pledged",
    textWindowSecs: TEXT_WINDOW_SECS,
  },
  record_advance: {
    mode: "fiat",
    args: ["loan", "amountMinor"],
    signers: [text("borrower", "PLEDGE"), tx("lender", "LEND")],
    event: "AdvanceRecorded",
    textWindowSecs: TEXT_WINDOW_SECS,
  },
  confirm_payment: {
    mode: "fiat",
    args: [
      "loan",
      "purpose",
      "intent",
      "amountMinor",
      "bankReference",
      "observedAt",
      "evidenceVersionId",
    ],
    signers: [tx("lender", "LEND")],
    event: "PaymentConfirmed",
    textWindowSecs: TEXT_WINDOW_SECS,
  },
  correct_payment: {
    mode: "fiat",
    args: ["target", "correctionReference", "evidenceVersionId"],
    signers: [tx("lender", "LEND")],
    event: "PaymentCorrected",
    textWindowSecs: TEXT_WINDOW_SECS,
  },
  repay: {
    mode: "fiat",
    args: ["payment"],
    signers: [tx("lender", "LEND")],
    event: "Repaid",
    textWindowSecs: TEXT_WINDOW_SECS,
  },
  create_release_intent: {
    mode: "fiat",
    args: ["loan", "buyer", "quantityKg", "priceMinor", "topUpMinor", "expiresInHours"],
    signers: [text("seller", "PLEDGE")],
    event: "ReleaseIntentCreated",
    textWindowSecs: TEXT_WINDOW_SECS,
  },
  sell_pledged: {
    mode: "fiat",
    args: ["intent"],
    signers: [text("buyer", "BUY")],
    event: "PledgedSold",
    textWindowSecs: TEXT_WINDOW_SECS,
  },
  liquidate: {
    mode: "both",
    args: ["loan"],
    signers: [tx("lender", "LEND")],
    event: "Liquidated",
    textWindowSecs: TEXT_WINDOW_SECS,
  },
  close_loan: {
    mode: "both",
    args: ["loan"],
    signers: [tx("lender", "LEND")],
    event: "LoanClosed",
    textWindowSecs: TEXT_WINDOW_SECS,
  },
  deposit: {
    mode: "simulation",
    args: ["amountMinor"],
    signers: [tx("depositor", "POOL")],
    event: "Deposited",
    textWindowSecs: TEXT_WINDOW_SECS,
  },
  withdraw: {
    mode: "simulation",
    args: ["amountMinor"],
    signers: [tx("depositor", "POOL")],
    event: "Withdrawn",
    textWindowSecs: TEXT_WINDOW_SECS,
  },
  borrow: {
    mode: "simulation",
    args: ["loan", "amountMinor", "wallet"],
    signers: [text("borrower", "PLEDGE")],
    event: "Borrowed",
    textWindowSecs: TEXT_WINDOW_SECS,
  },
  repay_simulated: {
    mode: "simulation",
    args: ["loan", "amountMinor"],
    signers: [tx("payer", null, false)],
    event: "Repaid",
    textWindowSecs: TEXT_WINDOW_SECS,
  },
  issue_lot: {
    mode: "both",
    args: ["custodianClass", "owner", "lotId", "grade", "quantityKg", "weighbridgeTicket"],
    signers: [text("custodian", "ISSUE")],
    event: "LotIssued",
    textWindowSecs: CUSTODY_TEXT_WINDOW_SECS,
    // Program-signer PDAs that never hold an account go into the table (fold 25; sizes, fold 28).
    tableSigners: ["mintAuthority", "vaultAuthority"],
  },
  handover: {
    mode: "both",
    args: ["batch", "to"],
    // Owner, 27 Nov (field-app.md §11): a next holder without an Authority is refused on chain.
    signers: [text("holder", "CARRY"), text("next_holder", "CARRY", false)],
    event: "CustodyHandedOver",
    textWindowSecs: CUSTODY_TEXT_WINDOW_SECS,
    // program-custody.md §4.6: the HandoverRecord enters the table before the handover is sent.
    tableCreated: ["handover"],
  },
  record_observation: {
    mode: "both",
    args: ["batch", "kind", "locationCode", "evidenceVersionId", "observedAt"],
    // field-app.md §4.3: every field role but handover's next_holder keeps the relay pre-check.
    signers: [text("observer", "OBSERVE")],
    event: "ObservationRecorded",
    textWindowSecs: CUSTODY_TEXT_WINDOW_SECS,
  },
  create_loading_intent: {
    mode: "both",
    args: ["lot", "evidenceVersionId", "expiresInHours"],
    // field-app.md T067r.3 fold 41: the owner's Prepare loading, signed on the web.
    signers: [text("owner", "SHIP")],
    event: "LoadingIntentCreated",
    textWindowSecs: CUSTODY_TEXT_WINDOW_SECS,
  },
  accept_loading: {
    mode: "both",
    args: ["intent", "loan"],
    // field-app.md owner decision 1 (27 Nov): a transaction kind as confirm_payment, the sponsor
    // as `payer`; the lender's LEND is pre-checked.
    signers: [tx("lender", "LEND")],
    event: "LoadingAccepted",
    outcomeBinds: ["intent", "loan"],
    textWindowSecs: TEXT_WINDOW_SECS,
  },
  record_loading: {
    mode: "both",
    args: ["intent"],
    // Fold 46: the terminal keeps the relay pre-check (only handover's next_holder skips it).
    signers: [text("owner", "SHIP"), text("terminal", "LOAD")],
    event: "LoadingRecorded",
    trailingEvent: "LoanHandedOff",
    textWindowSecs: CUSTODY_TEXT_WINDOW_SECS,
  },
};

/** The addresses of a kind's program-signer PDAs, read from its plan (fold 25). */
export function tableSignerAddresses(
  kind: CommandKind,
  plan: Readonly<Record<string, string>>,
): Set<Address> {
  return new Set(
    (KIND_SPECS[kind].tableSigners ?? []).map((key) => {
      const value = plan[key];
      if (!value) throw new RelayError("INTERNAL", `plan has no ${key}`);
      return value as Address;
    }),
  );
}

/** The addresses of the PDAs a kind's instruction creates, read from its plan (§4.6). */
export function createdTableAddresses(
  kind: CommandKind,
  plan: Readonly<Record<string, string>>,
): Set<Address> {
  return new Set(
    (KIND_SPECS[kind].tableCreated ?? []).map((key) => {
      const value = plan[key];
      if (!value) throw new RelayError("INTERNAL", `plan has no ${key}`);
      return value as Address;
    }),
  );
}

export function scopeBit(scope: string): number | null {
  return scope in SCOPES ? SCOPES[scope as ScopeName] : null;
}

// ---------------------------------------------------------------- args (§6.5.3)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CANONICAL = /^(0|[1-9][0-9]*)$/;

function canonical(value: string, min: bigint, max: bigint): boolean {
  return CANONICAL.test(value) && BigInt(value) >= min && BigInt(value) <= max;
}

function isBase58Address(value: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  try {
    return getAddressEncoder().encode(value as Address).length === 32;
  } catch {
    return false;
  }
}

const ARG_RULES: Record<string, (value: string) => boolean> = {
  borrower: (v) => UUID.test(v),
  owner: (v) => UUID.test(v),
  to: (v) => UUID.test(v),
  batch: isBase58Address,
  lotId: (v) => /^[A-Z0-9-]{1,16}$/.test(v),
  kind: (v) => v === "Border" || v === "Checkpoint",
  locationCode: (v) => /^[A-Z0-9-]{1,16}$/.test(v),
  weighbridgeTicket: (v) =>
    Buffer.byteLength(v) >= 1 &&
    Buffer.byteLength(v) <= 64 &&
    /^[\x20-\x7e]*$/.test(v) &&
    normaliseTicket(v) !== null,
  buyer: (v) => UUID.test(v),
  evidenceVersionId: (v) => UUID.test(v),
  facility: isBase58Address,
  lot: isBase58Address,
  loan: isBase58Address,
  intent: isBase58Address,
  payment: isBase58Address,
  target: isBase58Address,
  custodianClass: isBase58Address,
  wallet: isBase58Address,
  currency: (v) => /^[A-Z]{3}$/.test(v),
  currencyDecimals: (v) => /^[0-9]$/.test(v),
  termsVersion: (v) => canonical(v, 1n, 4_294_967_295n),
  rateBps: (v) => canonical(v, 0n, 10_000n),
  haircutBps: (v) => canonical(v, 0n, 10_000n),
  maxLtvBps: (v) => canonical(v, 1n, 10_000n),
  grade: (v) => /^[A-Z0-9-]{1,8}$/.test(v),
  valuePerKgMinor: (v) => canonical(v, 1n, U64_MAX),
  quantityKg: (v) => canonical(v, 1n, U64_MAX),
  amountMinor: (v) => canonical(v, 1n, U64_MAX),
  priceMinor: (v) => canonical(v, 1n, U64_MAX),
  topUpMinor: (v) => canonical(v, 0n, U64_MAX),
  validForDays: (v) => canonical(v, 1n, 365n),
  expiresInHours: (v) => canonical(v, 1n, 720n),
  sourceNote: (v) =>
    Buffer.byteLength(v) >= 1 &&
    Buffer.byteLength(v) <= 200 &&
    /^[\x20-\x7e]*$/.test(v) &&
    !v.startsWith(" ") &&
    !v.endsWith(" "),
  bankReference: (v) => /^[A-Z0-9][A-Z0-9-]{0,63}$/.test(v),
  correctionReference: (v) => /^[A-Z0-9][A-Z0-9-]{0,63}$/.test(v),
  observedAt: (v) => canonical(v, 0n, 9_223_372_036_854_775_807n),
  purpose: (v) => v === "Repayment" || v === "Release",
};

/** Exact keys per kind, strings only; `intent` present exactly when the purpose is Release. */
export function validateArgs(kind: CommandKind, args: unknown): Record<string, string> {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new RelayError("VALIDATION");
  const record = args as Record<string, unknown>;
  const expected = new Set(KIND_SPECS[kind].args);
  if (kind === "confirm_payment" && record.purpose !== "Release") expected.delete("intent");
  const keys = Object.keys(record);
  if (keys.length !== expected.size || !keys.every((key) => expected.has(key))) {
    throw new RelayError("VALIDATION", `args for ${kind} are ${[...expected].join(", ")}`);
  }
  for (const key of keys) {
    const value = record[key];
    const rule = ARG_RULES[key];
    if (typeof value !== "string" || !rule || !rule(value))
      throw new RelayError("VALIDATION", `args.${key}`);
  }
  return record as Record<string, string>;
}

// ---------------------------------------------------------------- chain reads

export interface Organisationish {
  address: Address;
  uuid: string;
  name: string;
  role: number;
}

export function uuidOf(bytes: Uint8Array | ReadonlyUint8Array): string {
  const h = Buffer.from(bytes).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function uuidBytes(uuid: string): Uint8Array {
  return Uint8Array.from(Buffer.from(uuid.replaceAll("-", ""), "hex"));
}

type ReadonlyUint8Array = { readonly [n: number]: number; readonly length: number };

function ascii(bytes: ReadonlyUint8Array): string {
  return Buffer.from(Uint8Array.from(bytes as ArrayLike<number>)).toString("ascii");
}

function hex(bytes: ReadonlyUint8Array): string {
  return Buffer.from(Uint8Array.from(bytes as ArrayLike<number>)).toString("hex");
}

type Decoder<T> = (account: MaybeEncodedAccount) => { exists: boolean; data?: T };

/** Reads accounts fresh at `confirmed`; a missing, foreign-owned or wrong account is
 * ACCOUNT_MISSING. */
export class Reader {
  readonly chain: ChainPort;
  readonly protocol: Address;
  private cache = new Map<string, MaybeEncodedAccount>();

  constructor(chain: ChainPort, protocol: Address) {
    this.chain = chain;
    this.protocol = protocol;
  }

  async raw(address: Address): Promise<MaybeEncodedAccount> {
    const cached = this.cache.get(address);
    if (cached) return cached;
    const [account] = await this.chain.accounts([address]);
    if (!account) throw new RelayError("ACCOUNT_MISSING", `account: ${address}`);
    this.cache.set(address, account);
    return account;
  }

  async exists(address: Address): Promise<boolean> {
    return (await this.raw(address)).exists;
  }

  async read<T>(role: string, address: Address, decode: Decoder<T>, kindName: string): Promise<T> {
    const account = await this.raw(address);
    if (!account.exists) throw new RelayError("ACCOUNT_MISSING", `${role}: ${address}`);
    // PR #69 fold 29: the owner is checked here, whatever the decoder checks.
    if (account.programAddress !== THETIS_PROGRAM_ADDRESS) {
      throw new RelayError("ACCOUNT_MISSING", `${address}: not a ${kindName}`);
    }
    let decoded: { exists: boolean; data?: T };
    try {
      decoded = decode(account);
    } catch {
      throw new RelayError("ACCOUNT_MISSING", `${address}: not a ${kindName}`);
    }
    if (!decoded.data) throw new RelayError("ACCOUNT_MISSING", `${address}: not a ${kindName}`);
    const data = decoded.data as T & { protocol?: Address };
    if ("protocol" in data && data.protocol !== undefined && data.protocol !== this.protocol) {
      throw new RelayError("ACCOUNT_MISSING", `${address}: not a ${kindName} of this instance`);
    }
    return data;
  }

  async organisation(role: string, address: Address): Promise<Organisationish> {
    const org = await this.read<Organisation>(
      role,
      address,
      decodeOrganisation as never,
      "Organisation",
    );
    return { address, uuid: uuidOf(org.orgId), name: org.displayName, role: org.role };
  }

  async organisationByUuid(role: string, uuid: string): Promise<Organisationish> {
    const [address] = await findOrganisationPda({
      protocol: this.protocol,
      orgId: uuidBytes(uuid),
    });
    return this.organisation(role, address);
  }
}

export async function valuationPda(
  facility: Address,
  classPolicy: Address,
  grade: string,
  custodianClass: Address,
) {
  const encoder = getAddressEncoder();
  const [found] = await getProgramDerivedAddress({
    programAddress: THETIS_PROGRAM_ADDRESS,
    seeds: [
      "valuation",
      encoder.encode(facility),
      encoder.encode(classPolicy),
      grade,
      encoder.encode(custodianClass),
    ],
  });
  return found;
}

async function lotVault(position: Address, mint: Address) {
  const [vaultAuthority] = await findVaultAuthorityPda({ position });
  const [vault] = await findAssociatedTokenPda({
    owner: vaultAuthority,
    mint,
    tokenProgram: TOKEN_2022,
  });
  return { vaultAuthority, vault };
}

export async function poolToken(owner: Address, mint: Address) {
  const [found] = await findAssociatedTokenPda({
    owner,
    mint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  return found;
}

// ---------------------------------------------------------------- preparing a command

export interface PrepareContext {
  reader: Reader;
  programId: Address;
  protocol: Address;
  instanceId: Uint8Array;
  settlementMode: number;
  chainTime: bigint;
  /** The caller's organisation (body organisationId). */
  initiator: Organisationish;
  args: Record<string, string>;
  /** EVIDENCE_INVALID checks with the caller's client (§6.5.5); returns the sha256 hex. */
  evidenceDigest(versionId: string, expected: EvidenceExpectation): Promise<string>;
  /** WALLET_NOT_LINKED unless `wallet` is one of the caller's active links for the org. */
  callerLinks(organisationId: string): Promise<string[]>;
}

/** What a finalized evidence version must be for a kind (field-app.md T067r.2 fold 32): the
 * owner organisation, the purpose and, for custody evidence, the subject. */
export interface EvidenceExpectation {
  ownerOrgId: string;
  purpose: "bank" | "transport" | "loading";
  subject?: { kind: "batch" | "lot"; ref: string };
  /** The EVIDENCE_INVALID detail; the lending kinds send none. */
  detail?: string;
}

export interface Prepared {
  plan: Record<string, string>;
  fields: { label: string; value: string }[];
  text: Uint8Array | null;
  validUntil: bigint | null;
  signers: StoredSigner[];
  lot: string | null;
  facility: string | null;
  loan: string | null;
  intent: string | null;
  payment: string | null;
}

function notAuthorised(detail: string): never {
  throw new RelayError("NOT_AUTHORISED", detail);
}

function requireInitiator(context: PrepareContext, ...allowed: Address[]) {
  if (!allowed.includes(context.initiator.address)) {
    notAuthorised("the organisation is not this action's initiator");
  }
}

function stored(kind: CommandKind, organisations: Organisationish[]): StoredSigner[] {
  return KIND_SPECS[kind].signers.map((spec, index) => {
    const org = organisations[index];
    if (!org) throw new Error(`no organisation for ${kind} signer ${index}`);
    return {
      role: spec.role,
      organisationId: org.uuid,
      method: spec.method,
      scope: spec.scope ?? "",
    };
  });
}

interface FacilityRead {
  address: Address;
  data: Facility;
  lender: Organisationish;
  borrower: Organisationish;
  currency: string;
  idHex: string;
}

async function readFacility(context: PrepareContext, address: Address): Promise<FacilityRead> {
  const data = await context.reader.read<Facility>(
    "facility",
    address,
    decodeFacility as never,
    "Facility",
  );
  return {
    address,
    data,
    lender: await context.reader.organisation("lender", data.lender),
    borrower: await context.reader.organisation("borrower", data.borrower),
    currency: ascii(data.currency),
    idHex: hex(data.facilityId),
  };
}

async function readLoan(context: PrepareContext, address: Address) {
  const loan = await context.reader.read<Loan>("loan", address, decodeLoan as never, "Loan");
  const facility = await readFacility(context, loan.facility);
  const [lock] = await findLockPda({ loan: address });
  return { address, loan, facility, lock };
}

async function readLot(context: PrepareContext, address: Address) {
  return context.reader.read("lot", address, decodeLot as never, "Lot") as Promise<{
    lotId: string;
    classPolicy: Address;
    grade: string;
    custodianClass: Address;
    mint: Address;
  }>;
}

function money(f: FacilityRead, minor: bigint) {
  return formatMoney(minor, f.data.currencyDecimals, f.currency);
}

function loanLabel(f: FacilityRead, index: number) {
  return `${f.idHex} loan ${index}`;
}

async function requireValuation(
  context: PrepareContext,
  facility: Address,
  lot: Awaited<ReturnType<typeof readLot>>,
) {
  const valuation = await valuationPda(facility, lot.classPolicy, lot.grade, lot.custodianClass);
  await context.reader.read("valuation", valuation, decodeValuation as never, "Valuation");
  return valuation;
}

async function checkNotRecorded(context: PrepareContext, payment: Address) {
  if (await context.reader.exists(payment))
    throw new RelayError("PAYMENT_ALREADY_RECORDED", payment);
}

function validUntil(context: PrepareContext, kind: CommandKind) {
  return context.chainTime + KIND_SPECS[kind].textWindowSecs;
}

async function readPool(context: PrepareContext) {
  const [pool] = await findPoolPda({ protocol: context.protocol });
  const data = (await context.reader.read(
    "pool",
    pool,
    decodeSimulationPool as never,
    "SimulationPool",
  )) as {
    mint: Address;
    vault: Address;
    currency: ReadonlyUint8Array;
    currencyDecimals: number;
  };
  const [poolAuthority] = await findPoolAuthorityPda({ pool });
  return { pool, poolAuthority, ...data, currencyText: ascii(data.currency) };
}

type Preparer = (context: PrepareContext) => Promise<Prepared>;

/** field-app.md fold 21: the highest-version Origin attestation of this instance for the intake
 * digest that is unrevoked and unexpired at chain time. */
async function readOrigin(context: PrepareContext, subject: Uint8Array) {
  const found = await context.reader.chain.programAccounts({
    memcmp: { offset: DOCUMENT_SUBJECT_OFFSET, bytes: getAddressDecoder().decode(subject) },
    dataSize: DOCUMENT_ATTESTATION_SIZE,
  });
  let best: { address: Address; sha256: Uint8Array; version: number; issuer: Address } | null =
    null;
  for (const account of found) {
    if (!Buffer.from(account.data.subarray(0, 8)).equals(DOCUMENT_DISCRIMINATOR)) continue;
    let document: DocumentAttestation;
    try {
      document = decodeDocumentAttestation(account).data;
    } catch {
      continue;
    }
    if (
      document.protocol !== context.protocol ||
      document.kind !== DocumentKind.Origin ||
      !Buffer.from(Uint8Array.from(document.subject)).equals(Buffer.from(subject)) ||
      document.revokedAt.__option !== "None" ||
      document.validUntil <= context.chainTime
    ) {
      continue;
    }
    if (!best || document.version > best.version) {
      best = {
        address: account.address,
        sha256: Uint8Array.from(document.sha256),
        version: document.version,
        issuer: document.issuer,
      };
    }
  }
  if (!best) throw new RelayError("ACCOUNT_MISSING", "origin: none valid");
  return best;
}

const BATCH_STAGES = ["AtSource", "InTransit", "Arrived"] as const;

/** Chain roles that can hold OBSERVE (setup.rs role scopes): exactly the Checkpoint set. Any
 * other caller is refused before a text exists (field-app.md T067r.2 fold 31); the Border arm of
 * the role rule stays the program's (WrongRole on chain). */
const OBSERVER_ROLES: readonly number[] = [
  Role.Custodian,
  Role.Transporter,
  Role.Terminal,
  Role.Inspector,
];

/** field-app.md T067r.3 fold 43, amended by the driver's PR #76 decisions D1–D3: one
 * (acceptance, loan, lock) triple per positive lock of the position, ascending by the raw loan
 * key. More than MAX_LOADING_LOANS positive locks is TOO_MANY_LOANS (D3). Each acceptance is read
 * and decoded, and must name this intent, the lock's loan and the lock (D1): lamports at the PDA
 * are not an acceptance. A lock without one is ACCEPTANCE_MISSING, and an accepted loan that is
 * not Active is LOAN_NOT_ACTIVE (D2), both before any text exists. The chain's AcceptanceMissing
 * and LoanNotActive stay the backstops for a change between create and send. */
async function readTriples(context: PrepareContext, intent: Address, position: Address) {
  const found = await context.reader.chain.programAccounts({
    memcmp: { offset: LOCK_POSITION_OFFSET, bytes: position },
    dataSize: getLockAllocationSize(),
  });
  const encoder = getAddressEncoder();
  const locks: { loan: Address; lock: Address }[] = [];
  for (const account of found) {
    if (account.programAddress !== THETIS_PROGRAM_ADDRESS) continue;
    if (!Buffer.from(account.data.subarray(0, 8)).equals(LOCK_DISCRIMINATOR)) continue;
    let lock: LockAllocation;
    try {
      lock = decodeLockAllocation(account).data;
    } catch {
      continue;
    }
    if (lock.protocol !== context.protocol || lock.position !== position || lock.quantityKg === 0n)
      continue;
    locks.push({ loan: lock.loan, lock: account.address });
  }
  if (locks.length > MAX_LOADING_LOANS) {
    throw new RelayError(
      "TOO_MANY_LOANS",
      `${locks.length} locked loans; a loading takes at most ${MAX_LOADING_LOANS}`,
    );
  }
  locks.sort((left, right) =>
    Buffer.compare(Buffer.from(encoder.encode(left.loan)), Buffer.from(encoder.encode(right.loan))),
  );
  const triples: { acceptance: Address; loan: Address; lock: Address }[] = [];
  for (const { loan, lock } of locks) {
    const [acceptance] = await findAcceptancePda({ intent, loan });
    if (!(await acceptanceOf(context, acceptance, intent, loan, lock))) {
      throw new RelayError("ACCEPTANCE_MISSING", `loan: ${loan}`);
    }
    const held = (await context.reader.read("loan", loan, decodeLoan as never, "Loan")) as Loan;
    if (held.status !== LoanStatus.Active) throw new RelayError("LOAN_NOT_ACTIVE", `loan: ${loan}`);
    triples.push({ acceptance, loan, lock });
  }
  return triples;
}

/** D1: true only for a decoded HandoffAcceptance of this instance naming this intent, loan and
 * lock. A missing, foreign-owned or undecodable account is no acceptance. */
async function acceptanceOf(
  context: PrepareContext,
  address: Address,
  intent: Address,
  loan: Address,
  lock: Address,
): Promise<boolean> {
  if (!(await context.reader.exists(address))) return false;
  let accepted: HandoffAcceptance;
  try {
    accepted = (await context.reader.read(
      "acceptance",
      address,
      decodeHandoffAcceptance as never,
      "HandoffAcceptance",
    )) as HandoffAcceptance;
  } catch (error) {
    if (error instanceof RelayError && error.code === "ACCOUNT_MISSING") return false;
    throw error;
  }
  return accepted.intent === intent && accepted.loan === loan && accepted.lock === lock;
}

const PREPARE: Record<CommandKind, Preparer> = {
  async create_loading_intent(context) {
    const { args } = context;
    const lotAddress = args.lot as Address;
    const lot = (await context.reader.read("lot", lotAddress, decodeLot as never, "Lot")) as {
      lotId: string;
      custodianClass: Address;
    };
    // Fold 41: the initiator must hold a position of the lot (the position is its PDA).
    const owner = context.initiator;
    const [position] = await findPositionPda({ lot: lotAddress, owner: owner.address });
    if (!(await context.reader.exists(position))) {
      notAuthorised("the organisation holds no position in this lot");
    }
    const held = (await context.reader.read(
      "position",
      position,
      decodePosition as never,
      "Position",
    )) as { quantityKg: bigint; revision: bigint };
    const site = (await context.reader.read(
      "custodianClass",
      lot.custodianClass,
      decodeCustodianClass as never,
      "CustodianClass",
    )) as { custodian: Address; siteCode: string };
    const terminal = await context.reader.organisation("terminalOrg", site.custodian);
    const digestHex = await context.evidenceDigest(args.evidenceVersionId as string, {
      ownerOrgId: owner.uuid,
      purpose: "loading",
      subject: { kind: "lot", ref: lotAddress },
      detail: "loading document of this lot",
    });
    const nonce = new DataView(new Uint8Array(randomBytes(8)).buffer).getBigUint64(0, true);
    const [intent] = await findLoadingIntentPda({ position, nonce });
    const expiresAt = context.chainTime + BigInt(args.expiresInHours as string) * HOUR;
    const until = validUntil(context, "create_loading_intent");
    const message = loadingIntentMessage(
      context.programId,
      context.instanceId,
      lot.lotId,
      held.quantityKg,
      owner.name,
      terminal.name,
      site.siteCode,
      Uint8Array.from(Buffer.from(digestHex, "hex")),
      nonce,
      expiresAt,
      held.revision,
      until,
    );
    return {
      plan: {
        lot: lotAddress,
        position,
        ownerOrg: owner.address,
        custodianClass: lot.custodianClass,
        terminalOrg: site.custodian,
        intent,
        nonce: String(nonce),
        documentSha256: digestHex,
        expiresAt: String(expiresAt),
        expectedRevision: String(held.revision),
        validUntil: String(until),
      },
      fields: textFields(message),
      text: message,
      validUntil: until,
      signers: stored("create_loading_intent", [owner]),
      lot: lotAddress,
      facility: null,
      loan: null,
      intent,
      payment: null,
    };
  },

  /** field-app.md T067r.4 pre-check folds 52–55: the lender of the loan's facility accepts the
   * hand-off of one open loading intent; every value is read from the chain. */
  async accept_loading(context) {
    const { args } = context;
    const intentAddress = args.intent as Address;
    const { address, loan, facility: f, lock } = await readLoan(context, args.loan as Address);
    requireInitiator(context, f.data.lender);
    const intent = (await context.reader.read(
      "intent",
      intentAddress,
      decodeLoadingIntent as never,
      "LoadingIntent",
    )) as LoadingIntent;
    // Fold 53: what the program would refuse and the relay can know, refused before any signing.
    if (intent.status !== LoadingStatus.Open) {
      throw new RelayError("LOADING_NOT_OPEN", `intent: ${intentAddress}`);
    }
    if (context.chainTime >= intent.expiresAt) {
      throw new RelayError("LOADING_EXPIRED", `intent: ${intentAddress}`);
    }
    if (loan.position !== intent.position) throw new RelayError("VALIDATION", "args.loan");
    // T056r R5: the program's StaleRevision on a superseded intent and LoanUnderException,
    // refused here so the sponsor pays no fee for a transaction that must fail.
    const position = (await context.reader.read(
      "position",
      intent.position,
      decodePosition as never,
      "Position",
    )) as { revision: bigint };
    if (intent.positionRevision !== position.revision) {
      throw new RelayError("LOADING_SUPERSEDED", `intent: ${intentAddress}`);
    }
    if (loan.status !== LoanStatus.Active)
      throw new RelayError("LOAN_NOT_ACTIVE", `loan: ${address}`);
    if (loan.openExceptions !== 0) {
      throw new RelayError("LOAN_UNDER_EXCEPTION", `loan: ${address}`);
    }
    const locked = (await context.reader.read(
      "lock",
      lock,
      decodeLockAllocation as never,
      "LockAllocation",
    )) as LockAllocation;
    if (locked.loan !== address || locked.quantityKg === 0n) {
      throw new RelayError("VALIDATION", "args.loan");
    }
    const lot = await readLot(context, loan.lot);
    const terminal = await context.reader.organisation("terminalOrg", intent.terminal);
    const [acceptance] = await findAcceptancePda({ intent: intentAddress, loan: address });
    return {
      plan: {
        lenderOrg: f.data.lender,
        facility: f.address,
        loan: address,
        lock,
        lot: loan.lot,
        position: loan.position,
        intent: intentAddress,
        acceptance,
        expectedRevision: String(loan.revision),
      },
      fields: [
        { label: "Lender", value: f.lender.name },
        { label: "Lot", value: lot.lotId },
        { label: "Loan", value: loanLabel(f, loan.index) },
        { label: "Locked", value: formatTonnes(locked.quantityKg) },
        { label: "Terminal", value: terminal.name },
        { label: "Intent", value: String(intent.nonce) },
        { label: "Expires", value: formatSast(intent.expiresAt) },
        { label: "Revision", value: String(loan.revision) },
      ],
      text: null,
      validUntil: null,
      signers: stored("accept_loading", [f.lender]),
      lot: loan.lot,
      facility: f.address,
      loan: address,
      intent: intentAddress,
      payment: null,
    };
  },

  async record_loading(context) {
    const intentAddress = context.args.intent as Address;
    const intent = (await context.reader.read(
      "intent",
      intentAddress,
      decodeLoadingIntent as never,
      "LoadingIntent",
    )) as LoadingIntent;
    requireInitiator(context, intent.terminal, intent.owner);
    const position = (await context.reader.read(
      "position",
      intent.position,
      decodePosition as never,
      "Position",
    )) as { revision: bigint };
    const lot = (await context.reader.read("lot", intent.lot, decodeLot as never, "Lot")) as {
      lotId: string;
      intake: Address;
      mint: Address;
      parent: { __option: "Some"; value: Address } | { __option: "None" };
      root: Address;
    };
    await context.reader.read(
      "custodianClass",
      intent.custodianClass,
      decodeCustodianClass as never,
      "CustodianClass",
    );
    const owner = await context.reader.organisation("ownerOrg", intent.owner);
    const terminal = await context.reader.organisation("terminalOrg", intent.terminal);
    const root = lot.parent.__option === "Some" ? lot.root : null;
    if (root) await context.reader.read("root", root, decodeLot as never, "Lot");
    const { vaultAuthority, vault } = await lotVault(intent.position, lot.mint);
    const triples = await readTriples(context, intentAddress, intent.position);
    const until = validUntil(context, "record_loading");
    const message = recordLoadingMessage(
      context.programId,
      context.instanceId,
      lot.lotId,
      intent.quantityKg,
      owner.name,
      terminal.name,
      Uint8Array.from(intent.documentSha256 as ArrayLike<number>),
      intent.nonce,
      intent.lockedKg,
      triples.length,
      position.revision,
      until,
    );
    return {
      plan: {
        intent: intentAddress,
        lot: intent.lot,
        position: intent.position,
        custodianClass: intent.custodianClass,
        ownerOrg: intent.owner,
        terminalOrg: intent.terminal,
        ...(root ? { root } : {}),
        intake: lot.intake,
        mint: lot.mint,
        vaultAuthority,
        vault,
        expectedRevision: String(position.revision),
        validUntil: String(until),
        k: String(triples.length),
        triples: triples.flatMap((t) => [t.acceptance, t.loan, t.lock]).join(","),
      },
      fields: textFields(message),
      text: message,
      validUntil: until,
      signers: stored("record_loading", [owner, terminal]),
      lot: intent.lot,
      facility: null,
      loan: null,
      intent: intentAddress,
      payment: null,
    };
  },

  async handover(context) {
    const { args } = context;
    const batchAddress = args.batch as Address;
    const batch = (await context.reader.read(
      "batch",
      batchAddress,
      decodeManifestBatch as never,
      "ManifestBatch",
    )) as ManifestBatch;
    requireInitiator(context, batch.holder);
    const shipment = (await context.reader.read(
      "shipment",
      batch.shipment,
      decodeShipment as never,
      "Shipment",
    )) as Shipment;
    const lot = await readLot(context, shipment.lot);
    const holder = await context.reader.organisation("holderOrg", batch.holder);
    const to = await context.reader.organisationByUuid("to", args.to as string);
    const batchStage = BATCH_STAGES[batch.stage];
    if (!batchStage)
      throw new RelayError("ACCOUNT_MISSING", `${batchAddress}: not a ManifestBatch`);
    const stage = handoverStage({
      batchStage,
      to: to.address,
      destinationCustodian: shipment.destinationCustodian,
    });
    const [handover] = await findHandoverPda({
      batch: batchAddress,
      expectedSequence: batch.sequence,
    });
    const until = validUntil(context, "handover");
    const manifest = Uint8Array.from(batch.manifestDigest as ArrayLike<number>);
    const message = custodyHandoverMessage(
      context.programId,
      context.instanceId,
      lot.lotId,
      Uint8Array.from(shipment.shipmentId as ArrayLike<number>),
      batch.index + 1,
      batch.batchCount,
      batch.quantityKg,
      holder.name,
      to.name,
      stage,
      manifest,
      batch.sequence,
      until,
    );
    return {
      plan: {
        shipment: batch.shipment,
        batch: batchAddress,
        lot: shipment.lot,
        fromOrg: batch.holder,
        toOrg: to.address,
        sourceClass: shipment.source,
        destinationClass: shipment.destination,
        ...(stage === "Departure" ? { departureDocument: shipment.departureDocument } : {}),
        handover,
        stage,
        manifestDigest: hex(manifest),
        expectedSequence: String(batch.sequence),
        validUntil: String(until),
      },
      fields: textFields(message),
      text: message,
      validUntil: until,
      signers: stored("handover", [holder, to]),
      lot: shipment.lot,
      facility: null,
      loan: null,
      intent: null,
      payment: null,
    };
  },

  async record_observation(context) {
    const { args } = context;
    if (!OBSERVER_ROLES.includes(context.initiator.role)) {
      notAuthorised("only a custodian, transporter, terminal or inspector records an observation");
    }
    const batchAddress = args.batch as Address;
    const batch = (await context.reader.read(
      "batch",
      batchAddress,
      decodeManifestBatch as never,
      "ManifestBatch",
    )) as ManifestBatch;
    const shipment = (await context.reader.read(
      "shipment",
      batch.shipment,
      decodeShipment as never,
      "Shipment",
    )) as Shipment;
    const lot = await readLot(context, shipment.lot);
    const holder = await context.reader.organisation("holderOrg", batch.holder);
    const observer = context.initiator;
    const observedAt = BigInt(args.observedAt as string);
    if (observedAt > context.chainTime) throw new RelayError("VALIDATION", "observedAt");
    const digestHex = await context.evidenceDigest(args.evidenceVersionId as string, {
      ownerOrgId: observer.uuid,
      purpose: "transport",
      subject: { kind: "batch", ref: batchAddress },
      detail: "transport evidence of this batch",
    });
    const kind = args.kind as ObservationKindName;
    const locationCode = args.locationCode as string;
    const until = validUntil(context, "record_observation");
    const message = observationMessage(
      context.programId,
      context.instanceId,
      lot.lotId,
      Uint8Array.from(shipment.shipmentId as ArrayLike<number>),
      batch.index + 1,
      batch.batchCount,
      holder.name,
      observer.name,
      kind,
      locationCode,
      Uint8Array.from(Buffer.from(digestHex, "hex")),
      observedAt,
      batch.observationCount,
      until,
    );
    return {
      plan: {
        shipment: batch.shipment,
        batch: batchAddress,
        lot: shipment.lot,
        holderOrg: batch.holder,
        observerOrg: observer.address,
        observationKind: kind,
        locationCode,
        evidenceDigest: digestHex,
        observedAt: String(observedAt),
        expectedObservation: String(batch.observationCount),
        validUntil: String(until),
      },
      fields: textFields(message),
      text: message,
      validUntil: until,
      signers: stored("record_observation", [observer]),
      lot: shipment.lot,
      facility: null,
      loan: null,
      intent: null,
      payment: null,
    };
  },

  async issue_lot(context) {
    const { args } = context;
    const custodianClass = args.custodianClass as Address;
    const site = (await context.reader.read(
      "custodianClass",
      custodianClass,
      decodeCustodianClass as never,
      "CustodianClass",
    )) as { custodian: Address; classPolicy: Address; siteCode: string };
    requireInitiator(context, site.custodian);
    const policy = (await context.reader.read(
      "classPolicy",
      site.classPolicy,
      decodeClassPolicy as never,
      "ClassPolicy",
    )) as { classCode: string; version: number; originRequired: boolean };
    const owner = await context.reader.organisationByUuid("ownerOrg", args.owner as string);
    const custodian = await context.reader.organisation("custodianOrg", site.custodian);
    const ticket = normaliseTicket(args.weighbridgeTicket as string);
    if (ticket === null) throw new RelayError("VALIDATION", "args.weighbridgeTicket");
    const digestHex = intakeDigest(site.siteCode, ticket);
    const digest = Uint8Array.from(Buffer.from(digestHex, "hex"));
    const origin = policy.originRequired ? await readOrigin(context, digest) : null;
    const lotId = args.lotId as string;
    const [intake] = await findIntakePda({
      protocol: context.protocol,
      custodian: site.custodian,
      intakeDigest: digest,
    });
    const [lot] = await getProgramDerivedAddress({
      programAddress: THETIS_PROGRAM_ADDRESS,
      seeds: ["lot", getAddressEncoder().encode(context.protocol), lotId],
    });
    const [mint] = await findMintPda({ lot });
    const [mintAuthority] = await findMintAuthorityPda({ mint });
    const [position] = await findPositionPda({ lot, owner: owner.address });
    const { vaultAuthority, vault } = await lotVault(position, mint);
    const quantityKg = BigInt(args.quantityKg as string);
    const until = validUntil(context, "issue_lot");
    const message = issueLotMessage(
      context.programId,
      context.instanceId,
      lotId,
      policy.classCode,
      policy.version,
      args.grade as string,
      quantityKg,
      owner.name,
      custodian.name,
      site.siteCode,
      digest,
      origin,
      until,
    );
    return {
      plan: {
        classPolicy: site.classPolicy,
        custodianClass,
        ownerOrg: owner.address,
        custodianOrg: site.custodian,
        ...(origin ? { origin: origin.address, originIssuer: origin.issuer } : {}),
        intake,
        lot,
        mint,
        mintAuthority,
        position,
        vaultAuthority,
        vault,
        lotId,
        grade: args.grade as string,
        quantityKg: String(quantityKg),
        ticket,
        intakeDigest: digestHex,
        validUntil: String(until),
      },
      fields: textFields(message),
      text: message,
      validUntil: until,
      signers: stored("issue_lot", [custodian]),
      lot,
      facility: null,
      loan: null,
      intent: null,
      payment: null,
    };
  },

  async open_facility(context) {
    const { args } = context;
    if (context.initiator.role !== Role.Lender) notAuthorised("only a lender opens a facility");
    const borrower = await context.reader.organisationByUuid("borrower", args.borrower as string);
    const facilityId = new Uint8Array(randomBytes(16));
    const [facility] = await findFacilityPda({
      protocol: context.protocol,
      lenderOrg: context.initiator.address,
      facilityId,
    });
    const plan: Record<string, string> = {
      lenderOrg: context.initiator.address,
      borrowerOrg: borrower.address,
      facility,
      facilityId: Buffer.from(facilityId).toString("hex"),
      currency: args.currency as string,
      currencyDecimals: args.currencyDecimals as string,
      termsVersion: args.termsVersion as string,
      rateBps: args.rateBps as string,
      maxLtvBps: args.maxLtvBps as string,
      termsDigest: Buffer.from(
        termsDigest({
          lenderOrgId: context.initiator.uuid,
          borrowerOrgId: borrower.uuid,
          currency: args.currency as string,
          currencyDecimals: Number(args.currencyDecimals),
          termsVersion: BigInt(args.termsVersion as string),
          rateBps: BigInt(args.rateBps as string),
          maxLtvBps: BigInt(args.maxLtvBps as string),
        }),
      ).toString("hex"),
    };
    if (context.settlementMode === SettlementMode.DevnetTokenSimulation) {
      plan.pool = (await readPool(context)).pool;
    }
    return {
      plan,
      fields: [
        { label: "Lender", value: context.initiator.name },
        { label: "Borrower", value: borrower.name },
        { label: "Facility", value: plan.facilityId as string },
        { label: "Currency", value: args.currency as string },
        {
          label: "Rate",
          value: `${formatBps(BigInt(args.rateBps as string))} a year, simple, actual/365`,
        },
        { label: "Max LTV", value: formatBps(BigInt(args.maxLtvBps as string)) },
        { label: "Terms", value: `v${args.termsVersion}` },
      ],
      text: null,
      validUntil: null,
      signers: stored("open_facility", [context.initiator]),
      lot: null,
      facility,
      loan: null,
      intent: null,
      payment: null,
    };
  },

  async set_valuation(context) {
    const { args } = context;
    const f = await readFacility(context, args.facility as Address);
    requireInitiator(context, f.data.lender);
    const custodianClass = args.custodianClass as Address;
    const site = (await context.reader.read(
      "custodianClass",
      custodianClass,
      decodeCustodianClass as never,
      "CustodianClass",
    )) as {
      classPolicy: Address;
      siteCode: string;
    };
    const policy = (await context.reader.read(
      "classPolicy",
      site.classPolicy,
      decodeClassPolicy as never,
      "ClassPolicy",
    )) as {
      classCode: string;
      version: number;
    };
    const grade = args.grade as string;
    const valuation = await valuationPda(f.address, site.classPolicy, grade, custodianClass);
    const valid = context.chainTime + BigInt(args.validForDays as string) * DAY;
    const value = BigInt(args.valuePerKgMinor as string);
    return {
      plan: {
        lenderOrg: f.data.lender,
        facility: f.address,
        classPolicy: site.classPolicy,
        custodianClass,
        valuation,
        grade,
        valuePerKg: String(value),
        haircutBps: args.haircutBps as string,
        validUntil: String(valid),
        sourceDigest: Buffer.from(sourceDigest(args.sourceNote as string)).toString("hex"),
      },
      fields: [
        { label: "Lender", value: f.lender.name },
        { label: "Facility", value: f.idHex },
        { label: "Class", value: `${policy.classCode} v${policy.version}` },
        { label: "Grade", value: grade },
        { label: "Site", value: site.siteCode },
        { label: "Value", value: `${money(f, value)} per kg` },
        { label: "Haircut", value: formatBps(BigInt(args.haircutBps as string)) },
        { label: "Valid until", value: formatSast(valid) },
        { label: "Source", value: args.sourceNote as string },
      ],
      text: null,
      validUntil: null,
      signers: stored("set_valuation", [f.lender]),
      lot: null,
      facility: f.address,
      loan: null,
      intent: null,
      payment: null,
    };
  },

  async pledge(context) {
    const { args } = context;
    const f = await readFacility(context, args.facility as Address);
    requireInitiator(context, f.data.borrower, f.data.lender);
    const lotAddress = args.lot as Address;
    const lot = await readLot(context, lotAddress);
    const [position] = await findPositionPda({ lot: lotAddress, owner: f.data.borrower });
    const held = (await context.reader.read(
      "position",
      position,
      decodePosition as never,
      "Position",
    )) as {
      revision: bigint;
    };
    const loanIndex = f.data.loanCount;
    const [loan] = await findLoanPda({ facility: f.address, loanIndex });
    const [lock] = await findLockPda({ loan });
    const until = validUntil(context, "pledge");
    const quantityKg = BigInt(args.quantityKg as string);
    const message = pledgeMessage(
      context.programId,
      context.instanceId,
      lot.lotId,
      quantityKg,
      f.borrower.name,
      f.lender.name,
      Uint8Array.from(f.data.facilityId as ArrayLike<number>),
      loanIndex,
      f.currency,
      BigInt(f.data.rateBps),
      BigInt(f.data.maxLtvBps),
      BigInt(f.data.termsVersion),
      held.revision,
      until,
    );
    return {
      plan: {
        lot: lotAddress,
        position,
        borrowerOrg: f.data.borrower,
        lenderOrg: f.data.lender,
        facility: f.address,
        loan,
        lock,
        loanIndex: String(loanIndex),
        quantityKg: String(quantityKg),
        expectedRevision: String(held.revision),
        validUntil: String(until),
      },
      fields: textFields(message),
      text: message,
      validUntil: until,
      signers: stored("pledge", [f.borrower, f.lender]),
      lot: lotAddress,
      facility: f.address,
      loan,
      intent: null,
      payment: null,
    };
  },

  async record_advance(context) {
    const { args } = context;
    const { address, loan, facility: f, lock } = await readLoan(context, args.loan as Address);
    requireInitiator(context, f.data.lender);
    const lot = await readLot(context, loan.lot);
    const valuation = await requireValuation(context, f.address, lot);
    const amount = BigInt(args.amountMinor as string);
    const principalAfter = loan.principal + amount;
    if (principalAfter > U64_MAX)
      throw new RelayError("VALIDATION", "principal after the advance is above u64");
    const until = validUntil(context, "record_advance");
    const message = advanceMessage(
      context.programId,
      context.instanceId,
      lot.lotId,
      f.borrower.name,
      f.lender.name,
      Uint8Array.from(f.data.facilityId as ArrayLike<number>),
      loan.index,
      amount,
      principalAfter,
      f.currency,
      f.data.currencyDecimals,
      BigInt(loan.rateBps),
      BigInt(loan.termsVersion),
      loan.revision,
      until,
    );
    return {
      plan: {
        lenderOrg: f.data.lender,
        borrowerOrg: f.data.borrower,
        facility: f.address,
        loan: address,
        lock,
        lot: loan.lot,
        valuation,
        amount: String(amount),
        currency: f.currency,
        expectedRevision: String(loan.revision),
        validUntil: String(until),
      },
      fields: textFields(message),
      text: message,
      validUntil: until,
      signers: stored("record_advance", [f.borrower, f.lender]),
      lot: loan.lot,
      facility: f.address,
      loan: address,
      intent: null,
      payment: null,
    };
  },

  async confirm_payment(context) {
    const { args } = context;
    const { address, loan, facility: f } = await readLoan(context, args.loan as Address);
    requireInitiator(context, f.data.lender);
    const release = args.purpose === "Release";
    let subject: Address = address;
    let subjectText = `Loan ${loan.index}`;
    if (release) {
      const intentAddress = args.intent as Address;
      const intent = (await context.reader.read(
        "intent",
        intentAddress,
        decodeReleaseIntent as never,
        "ReleaseIntent",
      )) as {
        nonce: bigint;
      };
      subject = intentAddress;
      subjectText = `Intent ${intent.nonce}`;
    }
    const observedAt = BigInt(args.observedAt as string);
    if (observedAt > context.chainTime)
      throw new RelayError("VALIDATION", "observedAt is after chain time");
    const id = paymentId(f.lender.uuid, args.bankReference as string);
    const [payment] = await findPaymentPda({
      protocol: context.protocol,
      lenderOrg: f.data.lender,
      paymentId: id,
    });
    await checkNotRecorded(context, payment);
    const digest = await context.evidenceDigest(args.evidenceVersionId as string, {
      ownerOrgId: f.lender.uuid,
      purpose: "bank",
    });
    const amount = BigInt(args.amountMinor as string);
    return {
      plan: {
        lenderOrg: f.data.lender,
        facility: f.address,
        loan: address,
        subject,
        payment,
        paymentId: Buffer.from(id).toString("hex"),
        purpose: release ? "Release" : "Repayment",
        amount: String(amount),
        currency: f.currency,
        evidenceDigest: digest,
        observedAt: String(observedAt),
      },
      fields: [
        { label: "Lender", value: f.lender.name },
        { label: "Loan", value: loanLabel(f, loan.index) },
        { label: "Purpose", value: release ? "Release" : "Repayment" },
        { label: "Subject", value: subjectText },
        { label: "Amount", value: money(f, amount) },
        { label: "Bank reference", value: args.bankReference as string },
        { label: "Observed", value: formatSast(observedAt) },
        { label: "Evidence", value: digest.slice(0, 16) },
      ],
      text: null,
      validUntil: null,
      signers: stored("confirm_payment", [f.lender]),
      lot: loan.lot,
      facility: f.address,
      loan: address,
      intent: release ? subject : null,
      payment,
    };
  },

  async correct_payment(context) {
    const { args } = context;
    const target = args.target as Address;
    const attested = (await context.reader.read(
      "target",
      target,
      decodePaymentAttestation as never,
      "PaymentAttestation",
    )) as {
      loan: Address;
    };
    const { address, loan, facility: f } = await readLoan(context, attested.loan);
    requireInitiator(context, f.data.lender);
    const id = correctionPaymentId(f.lender.uuid, args.correctionReference as string);
    const [payment] = await findPaymentPda({
      protocol: context.protocol,
      lenderOrg: f.data.lender,
      paymentId: id,
    });
    await checkNotRecorded(context, payment);
    const digest = await context.evidenceDigest(args.evidenceVersionId as string, {
      ownerOrgId: f.lender.uuid,
      purpose: "bank",
    });
    return {
      plan: {
        lenderOrg: f.data.lender,
        facility: f.address,
        loan: address,
        subject: target,
        target,
        payment,
        paymentId: Buffer.from(id).toString("hex"),
        purpose: "Correction",
        amount: "0",
        currency: f.currency,
        evidenceDigest: digest,
        observedAt: String(context.chainTime),
      },
      fields: [
        { label: "Lender", value: f.lender.name },
        { label: "Loan", value: loanLabel(f, loan.index) },
        { label: "Corrects", value: target },
        { label: "Correction reference", value: args.correctionReference as string },
        { label: "Evidence", value: digest.slice(0, 16) },
      ],
      text: null,
      validUntil: null,
      signers: stored("correct_payment", [f.lender]),
      lot: loan.lot,
      facility: f.address,
      loan: address,
      intent: null,
      payment,
    };
  },

  async repay(context) {
    const payment = context.args.payment as Address;
    const attested = (await context.reader.read(
      "payment",
      payment,
      decodePaymentAttestation as never,
      "PaymentAttestation",
    )) as {
      loan: Address;
      amount: bigint;
    };
    const { address, loan, facility: f } = await readLoan(context, attested.loan);
    requireInitiator(context, f.data.lender);
    return {
      plan: {
        lenderOrg: f.data.lender,
        facility: f.address,
        loan: address,
        payment,
        amount: String(attested.amount),
      },
      fields: [
        { label: "Lender", value: f.lender.name },
        { label: "Loan", value: loanLabel(f, loan.index) },
        { label: "Payment", value: payment },
        { label: "Amount", value: money(f, attested.amount) },
      ],
      text: null,
      validUntil: null,
      signers: stored("repay", [f.lender]),
      lot: loan.lot,
      facility: f.address,
      loan: address,
      intent: null,
      payment,
    };
  },

  async create_release_intent(context) {
    const { args } = context;
    const { address, loan, facility: f, lock } = await readLoan(context, args.loan as Address);
    requireInitiator(context, loan.borrower);
    const buyer = await context.reader.organisationByUuid("buyer", args.buyer as string);
    const lot = await readLot(context, loan.lot);
    const held = (await context.reader.read(
      "position",
      loan.position,
      decodePosition as never,
      "Position",
    )) as {
      revision: bigint;
    };
    const nonce = new DataView(new Uint8Array(randomBytes(8)).buffer).getBigUint64(0, true);
    const [intent] = await findIntentPda({ loan: address, nonce });
    const expiresAt = context.chainTime + BigInt(args.expiresInHours as string) * HOUR;
    const until = validUntil(context, "create_release_intent");
    const quantityKg = BigInt(args.quantityKg as string);
    const price = BigInt(args.priceMinor as string);
    const topUp = BigInt(args.topUpMinor as string);
    const message = releaseIntentMessage(
      context.programId,
      context.instanceId,
      lot.lotId,
      quantityKg,
      f.borrower.name,
      buyer.name,
      f.lender.name,
      Uint8Array.from(f.data.facilityId as ArrayLike<number>),
      loan.index,
      nonce,
      price,
      topUp,
      f.currency,
      f.data.currencyDecimals,
      expiresAt,
      held.revision,
      until,
    );
    return {
      plan: {
        sellerOrg: loan.borrower,
        buyerOrg: buyer.address,
        lenderOrg: f.data.lender,
        facility: f.address,
        loan: address,
        lock,
        lot: loan.lot,
        position: loan.position,
        intent,
        nonce: String(nonce),
        quantityKg: String(quantityKg),
        price: String(price),
        topUp: String(topUp),
        expiresAt: String(expiresAt),
        expectedRevision: String(held.revision),
        validUntil: String(until),
      },
      fields: textFields(message),
      text: message,
      validUntil: until,
      signers: stored("create_release_intent", [f.borrower]),
      lot: loan.lot,
      facility: f.address,
      loan: address,
      intent,
      payment: null,
    };
  },

  async sell_pledged(context) {
    const intentAddress = context.args.intent as Address;
    const intent = (await context.reader.read(
      "intent",
      intentAddress,
      decodeReleaseIntent as never,
      "ReleaseIntent",
    )) as {
      loan: Address;
      lot: Address;
      position: Address;
      seller: Address;
      buyer: Address;
      nonce: bigint;
      quantityKg: bigint;
      price: bigint;
      topUp: bigint;
    };
    requireInitiator(context, intent.buyer);
    const { address, loan, facility: f, lock } = await readLoan(context, intent.loan);
    const lot = await readLot(context, intent.lot);
    const seller = await context.reader.organisation("seller", intent.seller);
    const buyer = await context.reader.organisation("buyer", intent.buyer);
    const valuation = await valuationPda(f.address, lot.classPolicy, lot.grade, lot.custodianClass);
    const payment = await releasePayment(context, intentAddress, intent.price + intent.topUp);
    const seller_ = (await context.reader.read(
      "sellerPosition",
      intent.position,
      decodePosition as never,
      "Position",
    )) as {
      revision: bigint;
    };
    const [mint] = await findMintPda({ lot: intent.lot });
    const [buyerPosition] = await findPositionPda({ lot: intent.lot, owner: intent.buyer });
    const sellerVault = await lotVault(intent.position, mint);
    const buyerVault = await lotVault(buyerPosition, mint);
    const until = validUntil(context, "sell_pledged");
    const message = buyPledgedMessage(
      context.programId,
      context.instanceId,
      lot.lotId,
      intent.quantityKg,
      seller.name,
      buyer.name,
      f.lender.name,
      Uint8Array.from(f.data.facilityId as ArrayLike<number>),
      loan.index,
      intent.nonce,
      intent.price,
      intent.topUp,
      f.currency,
      f.data.currencyDecimals,
      seller_.revision,
      until,
    );
    return {
      plan: {
        facility: f.address,
        lenderOrg: f.data.lender,
        loan: address,
        lock,
        valuation,
        intent: intentAddress,
        payment,
        lot: intent.lot,
        mint,
        sellerOrg: intent.seller,
        buyerOrg: intent.buyer,
        sellerPosition: intent.position,
        sellerVaultAuthority: sellerVault.vaultAuthority,
        sellerVault: sellerVault.vault,
        buyerPosition,
        buyerVaultAuthority: buyerVault.vaultAuthority,
        buyerVault: buyerVault.vault,
        expectedRevision: String(seller_.revision),
        validUntil: String(until),
      },
      fields: textFields(message),
      text: message,
      validUntil: until,
      signers: stored("sell_pledged", [buyer]),
      lot: intent.lot,
      facility: f.address,
      loan: address,
      intent: intentAddress,
      payment,
    };
  },

  async liquidate(context) {
    const {
      address,
      loan,
      facility: f,
      lock,
    } = await readLoan(context, context.args.loan as Address);
    requireInitiator(context, f.data.lender);
    const lot = await readLot(context, loan.lot);
    const valuation = await requireValuation(context, f.address, lot);
    return {
      plan: {
        lenderOrg: f.data.lender,
        facility: f.address,
        loan: address,
        lock,
        lot: loan.lot,
        valuation,
        expectedRevision: String(loan.revision),
      },
      fields: recoveryFields(f, lot.lotId, loan),
      text: null,
      validUntil: null,
      signers: stored("liquidate", [f.lender]),
      lot: loan.lot,
      facility: f.address,
      loan: address,
      intent: null,
      payment: null,
    };
  },

  async close_loan(context) {
    const {
      address,
      loan,
      facility: f,
      lock,
    } = await readLoan(context, context.args.loan as Address);
    requireInitiator(context, f.data.lender);
    const lot = await readLot(context, loan.lot);
    return {
      plan: {
        lenderOrg: f.data.lender,
        facility: f.address,
        loan: address,
        lock,
        position: loan.position,
        expectedRevision: String(loan.revision),
      },
      fields: recoveryFields(f, lot.lotId, loan),
      text: null,
      validUntil: null,
      signers: stored("close_loan", [f.lender]),
      lot: loan.lot,
      facility: f.address,
      loan: address,
      intent: null,
      payment: null,
    };
  },

  async deposit(context) {
    return poolCommand(context, "deposit");
  },

  async withdraw(context) {
    return poolCommand(context, "withdraw");
  },

  async borrow(context) {
    const { args } = context;
    const { address, loan, facility: f, lock } = await readLoan(context, args.loan as Address);
    requireInitiator(context, loan.borrower);
    const wallet = args.wallet as Address;
    if (!(await context.callerLinks(f.borrower.uuid)).includes(wallet)) {
      throw new RelayError("WALLET_NOT_LINKED", wallet);
    }
    const lot = await readLot(context, loan.lot);
    const valuation = await valuationPda(f.address, lot.classPolicy, lot.grade, lot.custodianClass);
    const pool = await readPool(context);
    const [lenderShare] = await findSharePda({ pool: pool.pool, depositorOrg: f.data.lender });
    await context.reader.read("lenderShare", lenderShare, decodePoolShare as never, "PoolShare");
    const destination = await poolToken(wallet, pool.mint);
    if (!(await context.reader.exists(destination)))
      throw new RelayError("ACCOUNT_MISSING", `destination: ${destination}`);
    const amount = BigInt(args.amountMinor as string);
    const principalAfter = loan.principal + amount;
    if (principalAfter > U64_MAX)
      throw new RelayError("VALIDATION", "principal after the loan is above u64");
    const until = validUntil(context, "borrow");
    const message = borrowMessage(
      context.programId,
      context.instanceId,
      lot.lotId,
      f.borrower.name,
      f.lender.name,
      Uint8Array.from(f.data.facilityId as ArrayLike<number>),
      loan.index,
      amount,
      principalAfter,
      f.currency,
      f.data.currencyDecimals,
      destination,
      BigInt(loan.rateBps),
      loan.revision,
      until,
    );
    return {
      plan: {
        borrowerOrg: loan.borrower,
        lenderOrg: f.data.lender,
        facility: f.address,
        loan: address,
        lock,
        lot: loan.lot,
        valuation,
        pool: pool.pool,
        lenderShare,
        poolAuthority: pool.poolAuthority,
        poolVault: pool.vault,
        mint: pool.mint,
        destination,
        wallet,
        amount: String(amount),
        expectedRevision: String(loan.revision),
        validUntil: String(until),
      },
      fields: textFields(message),
      text: message,
      validUntil: until,
      signers: stored("borrow", [f.borrower]),
      lot: loan.lot,
      facility: f.address,
      loan: address,
      intent: null,
      payment: null,
    };
  },

  async repay_simulated(context) {
    const { address, loan, facility: f } = await readLoan(context, context.args.loan as Address);
    requireInitiator(context, loan.borrower);
    const pool = await readPool(context);
    const [lenderShare] = await findSharePda({ pool: pool.pool, depositorOrg: f.data.lender });
    const amount = BigInt(context.args.amountMinor as string);
    return {
      plan: {
        facility: f.address,
        loan: address,
        pool: pool.pool,
        poolAuthority: pool.poolAuthority,
        poolVault: pool.vault,
        mint: pool.mint,
        lenderShare,
        amount: String(amount),
      },
      fields: [
        { label: "Organisation", value: f.borrower.name },
        { label: "Loan", value: loanLabel(f, loan.index) },
        { label: "Pool", value: pool.pool },
        { label: "Amount", value: formatMoney(amount, pool.currencyDecimals, pool.currencyText) },
      ],
      text: null,
      validUntil: null,
      signers: stored("repay_simulated", [f.borrower]),
      lot: loan.lot,
      facility: f.address,
      loan: address,
      intent: null,
      payment: null,
    };
  },
};

function recoveryFields(f: FacilityRead, lotId: string, loan: Loan) {
  return [
    { label: "Lender", value: f.lender.name },
    { label: "Lot", value: lotId },
    { label: "Loan", value: loanLabel(f, loan.index) },
    { label: "Revision", value: String(loan.revision) },
  ];
}

async function poolCommand(
  context: PrepareContext,
  kind: "deposit" | "withdraw",
): Promise<Prepared> {
  if (context.initiator.role !== Role.Lender) notAuthorised("only a lender uses the pool");
  const pool = await readPool(context);
  const [share] = await findSharePda({ pool: pool.pool, depositorOrg: context.initiator.address });
  if (kind === "withdraw")
    await context.reader.read("share", share, decodePoolShare as never, "PoolShare");
  const amount = BigInt(context.args.amountMinor as string);
  return {
    plan: {
      depositorOrg: context.initiator.address,
      pool: pool.pool,
      share,
      poolAuthority: pool.poolAuthority,
      poolVault: pool.vault,
      mint: pool.mint,
      amount: String(amount),
    },
    fields: [
      { label: "Organisation", value: context.initiator.name },
      { label: "Pool", value: pool.pool },
      { label: "Amount", value: formatMoney(amount, pool.currencyDecimals, pool.currencyText) },
    ],
    text: null,
    validUntil: null,
    signers: stored(kind, [context.initiator]),
    lot: null,
    facility: null,
    loan: null,
    intent: null,
    payment: null,
  };
}

/** §4.3.1: the unconsumed Release payment of the intent's amount; the smallest address wins. */
async function releasePayment(
  context: PrepareContext,
  intent: Address,
  amount: bigint,
): Promise<Address> {
  const accounts = await context.reader.chain.programAccounts({
    memcmp: { offset: 137, bytes: intent },
    dataSize: 238,
  });
  const usable: Address[] = [];
  for (const account of accounts) {
    try {
      const { data } = decodePaymentAttestation(account as never) as {
        data: Record<string, unknown>;
      };
      if (
        data.protocol === context.protocol &&
        data.purpose === PaymentPurpose.Release &&
        data.subject === intent &&
        data.status === PaymentStatus.Unconsumed &&
        data.amount === amount
      ) {
        usable.push(account.address);
      }
    } catch {
      // not a PaymentAttestation: not usable
    }
  }
  usable.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const [chosen] = usable;
  if (!chosen) throw new RelayError("PAYMENT_NOT_CONFIRMED", intent);
  return chosen;
}

export async function prepare(kind: CommandKind, context: PrepareContext): Promise<Prepared> {
  const mode = KIND_SPECS[kind].mode;
  const simulation = context.settlementMode === SettlementMode.DevnetTokenSimulation;
  if ((mode === "fiat" && simulation) || (mode === "simulation" && !simulation)) {
    throw new RelayError("WRONG_SETTLEMENT_MODE");
  }
  return PREPARE[kind](context);
}

export async function readProtocol(chain: ChainPort, protocol: Address) {
  const reader = new Reader(chain, protocol);
  const data = (await reader.read("protocol", protocol, decodeProtocol as never, "Protocol")) as {
    instanceId: ReadonlyUint8Array;
    settlementMode: number;
  };
  return {
    instanceId: Uint8Array.from(data.instanceId as ArrayLike<number>),
    settlementMode: data.settlementMode,
  };
}

// ---------------------------------------------------------------- building the instruction

export interface BuildInput {
  kind: CommandKind;
  plan: Record<string, string>;
  protocol: Address;
  sponsor: Address;
  /** The wallet of each role that has signed (text) or is signing (transaction). */
  wallets: Partial<Record<SignerRole, Address>>;
}

const a = (value: string | undefined) => {
  if (!value) throw new Error("plan value missing");
  return value as Address;
};
const n = (value: string | undefined) => BigInt(a(value));
const bytes = (value: string | undefined) => Uint8Array.from(Buffer.from(a(value), "hex"));
const ascii3 = (value: string | undefined) => new TextEncoder().encode(a(value));

async function authority(protocol: Address, wallet: Address | undefined) {
  if (!wallet) throw new Error("signing wallet missing");
  const [found] = await findAuthorityPda({ protocol, wallet });
  return found;
}

/** The token accounts and Authorities that depend on a signing wallet (§3.2 `plan`). */
export async function walletAccounts(input: BuildInput) {
  const { plan, wallets } = input;
  const depositor = wallets.depositor ?? wallets.payer;
  if (
    (input.kind === "deposit" || input.kind === "withdraw" || input.kind === "repay_simulated") &&
    depositor
  ) {
    return { token: await poolToken(depositor, a(plan.mint)) };
  }
  return { token: null };
}

export async function buildInstruction(input: BuildInput): Promise<Instruction> {
  const { plan, protocol, wallets } = input;
  const sponsor = createNoopSigner(input.sponsor);
  const signer = (role: SignerRole) => {
    const wallet = wallets[role];
    if (!wallet) throw new Error(`no wallet for ${role}`);
    return createNoopSigner(wallet);
  };
  switch (input.kind) {
    case "create_loading_intent":
      return getCreateLoadingIntentInstruction({
        sponsor,
        protocol,
        ownerOrg: a(plan.ownerOrg),
        ownerAuthority: await authority(protocol, wallets.owner),
        lot: a(plan.lot),
        position: a(plan.position),
        custodianClass: a(plan.custodianClass),
        terminalOrg: a(plan.terminalOrg),
        intent: a(plan.intent),
        nonce: n(plan.nonce),
        documentSha256: bytes(plan.documentSha256),
        expiresAt: n(plan.expiresAt),
        expectedRevision: n(plan.expectedRevision),
        validUntil: n(plan.validUntil),
      });
    case "record_loading": {
      const instruction = getRecordLoadingInstruction({
        sponsor,
        protocol,
        ownerOrg: a(plan.ownerOrg),
        ownerAuthority: await authority(protocol, wallets.owner),
        terminalOrg: a(plan.terminalOrg),
        terminalAuthority: await authority(protocol, wallets.terminal),
        custodianClass: a(plan.custodianClass),
        lot: a(plan.lot),
        ...(plan.root ? { root: a(plan.root) } : {}),
        intake: a(plan.intake),
        mint: a(plan.mint),
        position: a(plan.position),
        vaultAuthority: a(plan.vaultAuthority),
        vault: a(plan.vault),
        intent: a(plan.intent),
        expectedRevision: n(plan.expectedRevision),
        validUntil: n(plan.validUntil),
      });
      // Fold 43: the triples after the 17 accounts, acceptance read-only, loan and lock writable.
      const triples = plan.triples ? plan.triples.split(",") : [];
      if (triples.length !== Number(n(plan.k)) * 3) throw new Error("plan triples do not match k");
      return {
        ...instruction,
        accounts: [
          ...instruction.accounts,
          ...triples.map((key, index) => ({
            address: key as Address,
            role: index % 3 === 0 ? AccountRole.READONLY : AccountRole.WRITABLE,
          })),
        ],
      };
    }
    case "handover":
      return getHandoverInstruction({
        sponsor,
        protocol,
        shipment: a(plan.shipment),
        batch: a(plan.batch),
        lot: a(plan.lot),
        fromOrg: a(plan.fromOrg),
        fromAuthority: await authority(protocol, wallets.holder),
        toOrg: a(plan.toOrg),
        toAuthority: await authority(protocol, wallets.next_holder),
        sourceClass: a(plan.sourceClass),
        destinationClass: a(plan.destinationClass),
        ...(plan.departureDocument ? { departureDocument: a(plan.departureDocument) } : {}),
        handover: a(plan.handover),
        manifestDigest: bytes(plan.manifestDigest),
        expectedSequence: n(plan.expectedSequence),
        validUntil: n(plan.validUntil),
      });
    case "record_observation":
      return getRecordObservationInstruction({
        sponsor,
        protocol,
        observerOrg: a(plan.observerOrg),
        observerAuthority: await authority(protocol, wallets.observer),
        holderOrg: a(plan.holderOrg),
        shipment: a(plan.shipment),
        batch: a(plan.batch),
        lot: a(plan.lot),
        kind: ObservationKind[a(plan.observationKind) as ObservationKindName],
        locationCode: a(plan.locationCode),
        evidenceDigest: bytes(plan.evidenceDigest),
        observedAt: n(plan.observedAt),
        expectedObservation: Number(n(plan.expectedObservation)),
        validUntil: n(plan.validUntil),
      });
    case "issue_lot":
      return getIssueLotInstruction({
        sponsor,
        protocol,
        authority: await authority(protocol, wallets.custodian),
        owner: a(plan.ownerOrg),
        custodian: a(plan.custodianOrg),
        classPolicy: a(plan.classPolicy),
        custodianClass: a(plan.custodianClass),
        ...(plan.origin ? { origin: a(plan.origin), originIssuer: a(plan.originIssuer) } : {}),
        intake: a(plan.intake),
        lot: a(plan.lot),
        mint: a(plan.mint),
        mintAuthority: a(plan.mintAuthority),
        position: a(plan.position),
        vaultAuthority: a(plan.vaultAuthority),
        vault: a(plan.vault),
        lotId: a(plan.lotId),
        grade: a(plan.grade),
        quantityKg: n(plan.quantityKg),
        intakeDigest: bytes(plan.intakeDigest),
        validUntil: n(plan.validUntil),
      });
    case "open_facility":
      return getOpenFacilityInstruction({
        lender: signer("lender"),
        payer: sponsor,
        protocol,
        authority: await authority(protocol, wallets.lender),
        lenderOrg: a(plan.lenderOrg),
        borrowerOrg: a(plan.borrowerOrg),
        facility: a(plan.facility),
        ...(plan.pool ? { pool: a(plan.pool) } : {}),
        facilityId: bytes(plan.facilityId),
        currency: ascii3(plan.currency),
        currencyDecimals: Number(plan.currencyDecimals),
        termsVersion: Number(plan.termsVersion),
        rateBps: Number(plan.rateBps),
        maxLtvBps: Number(plan.maxLtvBps),
        termsDigest: bytes(plan.termsDigest),
      });
    case "set_valuation":
      return getSetValuationInstruction({
        lender: signer("lender"),
        payer: sponsor,
        protocol,
        authority: await authority(protocol, wallets.lender),
        lenderOrg: a(plan.lenderOrg),
        facility: a(plan.facility),
        classPolicy: a(plan.classPolicy),
        custodianClass: a(plan.custodianClass),
        valuation: a(plan.valuation),
        grade: a(plan.grade),
        valuePerKg: n(plan.valuePerKg),
        haircutBps: Number(plan.haircutBps),
        validUntil: n(plan.validUntil),
        sourceDigest: bytes(plan.sourceDigest),
      });
    case "pledge":
      return getPledgeInstruction({
        sponsor,
        protocol,
        lot: a(plan.lot),
        position: a(plan.position),
        borrowerOrg: a(plan.borrowerOrg),
        borrowerAuthority: await authority(protocol, wallets.borrower),
        lenderOrg: a(plan.lenderOrg),
        lenderAuthority: await authority(protocol, wallets.lender),
        facility: a(plan.facility),
        loan: a(plan.loan),
        lock: a(plan.lock),
        loanIndex: Number(plan.loanIndex),
        quantityKg: n(plan.quantityKg),
        expectedRevision: n(plan.expectedRevision),
        validUntil: n(plan.validUntil),
      });
    case "record_advance":
      return getRecordAdvanceInstruction({
        lender: signer("lender"),
        protocol,
        lenderAuthority: await authority(protocol, wallets.lender),
        lenderOrg: a(plan.lenderOrg),
        facility: a(plan.facility),
        loan: a(plan.loan),
        lock: a(plan.lock),
        lot: a(plan.lot),
        valuation: a(plan.valuation),
        borrowerOrg: a(plan.borrowerOrg),
        borrowerAuthority: await authority(protocol, wallets.borrower),
        amount: n(plan.amount),
        currency: ascii3(plan.currency),
        expectedRevision: n(plan.expectedRevision),
        validUntil: n(plan.validUntil),
      });
    case "confirm_payment":
    case "correct_payment":
      return getConfirmPaymentInstruction({
        lender: signer("lender"),
        payer: sponsor,
        protocol,
        authority: await authority(protocol, wallets.lender),
        lenderOrg: a(plan.lenderOrg),
        facility: a(plan.facility),
        loan: a(plan.loan),
        subject: a(plan.subject),
        ...(plan.target ? { target: a(plan.target) } : {}),
        payment: a(plan.payment),
        paymentId: bytes(plan.paymentId),
        purpose: PaymentPurpose[a(plan.purpose) as "Repayment" | "Release" | "Correction"],
        amount: n(plan.amount),
        currency: ascii3(plan.currency),
        evidenceDigest: bytes(plan.evidenceDigest),
        observedAt: n(plan.observedAt),
      });
    case "repay":
      return getRepayInstruction({
        signer: signer("lender"),
        protocol,
        facility: a(plan.facility),
        loan: a(plan.loan),
        authority: await authority(protocol, wallets.lender),
        lenderOrg: a(plan.lenderOrg),
        payment: a(plan.payment),
        amount: n(plan.amount),
      });
    case "create_release_intent":
      return getCreateReleaseIntentInstruction({
        sponsor,
        protocol,
        sellerOrg: a(plan.sellerOrg),
        sellerAuthority: await authority(protocol, wallets.seller),
        buyerOrg: a(plan.buyerOrg),
        lenderOrg: a(plan.lenderOrg),
        facility: a(plan.facility),
        loan: a(plan.loan),
        lock: a(plan.lock),
        lot: a(plan.lot),
        position: a(plan.position),
        intent: a(plan.intent),
        nonce: n(plan.nonce),
        quantityKg: n(plan.quantityKg),
        price: n(plan.price),
        topUp: n(plan.topUp),
        expiresAt: n(plan.expiresAt),
        expectedRevision: n(plan.expectedRevision),
        validUntil: n(plan.validUntil),
      });
    case "sell_pledged":
      return getSellPledgedInstruction({
        sponsor,
        protocol,
        facility: a(plan.facility),
        lenderOrg: a(plan.lenderOrg),
        loan: a(plan.loan),
        lock: a(plan.lock),
        valuation: a(plan.valuation),
        intent: a(plan.intent),
        payment: a(plan.payment),
        lot: a(plan.lot),
        mint: a(plan.mint),
        sellerOrg: a(plan.sellerOrg),
        buyerOrg: a(plan.buyerOrg),
        buyerAuthority: await authority(protocol, wallets.buyer),
        sellerPosition: a(plan.sellerPosition),
        sellerVaultAuthority: a(plan.sellerVaultAuthority),
        sellerVault: a(plan.sellerVault),
        buyerPosition: a(plan.buyerPosition),
        buyerVaultAuthority: a(plan.buyerVaultAuthority),
        buyerVault: a(plan.buyerVault),
        expectedRevision: n(plan.expectedRevision),
        validUntil: n(plan.validUntil),
      });
    case "accept_loading":
      return getAcceptLoadingInstruction({
        lender: signer("lender"),
        payer: sponsor,
        protocol,
        authority: await authority(protocol, wallets.lender),
        lenderOrg: a(plan.lenderOrg),
        facility: a(plan.facility),
        loan: a(plan.loan),
        lock: a(plan.lock),
        lot: a(plan.lot),
        position: a(plan.position),
        intent: a(plan.intent),
        acceptance: a(plan.acceptance),
        expectedRevision: n(plan.expectedRevision),
      });
    case "liquidate":
      return getLiquidateInstruction({
        lender: signer("lender"),
        protocol,
        authority: await authority(protocol, wallets.lender),
        lenderOrg: a(plan.lenderOrg),
        facility: a(plan.facility),
        loan: a(plan.loan),
        lock: a(plan.lock),
        lot: a(plan.lot),
        valuation: a(plan.valuation),
        expectedRevision: n(plan.expectedRevision),
      });
    case "close_loan":
      return getCloseLoanInstruction({
        lender: signer("lender"),
        protocol,
        authority: await authority(protocol, wallets.lender),
        lenderOrg: a(plan.lenderOrg),
        facility: a(plan.facility),
        loan: a(plan.loan),
        lock: a(plan.lock),
        position: a(plan.position),
        expectedRevision: n(plan.expectedRevision),
      });
    case "deposit": {
      const { token } = await walletAccounts(input);
      return getDepositInstruction({
        depositor: signer("depositor"),
        payer: sponsor,
        protocol,
        authority: await authority(protocol, wallets.depositor),
        depositorOrg: a(plan.depositorOrg),
        pool: a(plan.pool),
        share: a(plan.share),
        depositorToken: a(token ?? undefined),
        poolVault: a(plan.poolVault),
        mint: a(plan.mint),
        amount: n(plan.amount),
      });
    }
    case "withdraw": {
      const { token } = await walletAccounts(input);
      return getWithdrawInstruction({
        depositor: signer("depositor"),
        protocol,
        authority: await authority(protocol, wallets.depositor),
        depositorOrg: a(plan.depositorOrg),
        pool: a(plan.pool),
        share: a(plan.share),
        depositorToken: a(token ?? undefined),
        poolAuthority: a(plan.poolAuthority),
        poolVault: a(plan.poolVault),
        mint: a(plan.mint),
        amount: n(plan.amount),
      });
    }
    case "borrow":
      return getBorrowInstruction({
        sponsor,
        protocol,
        borrowerOrg: a(plan.borrowerOrg),
        borrowerAuthority: await authority(protocol, wallets.borrower),
        lenderOrg: a(plan.lenderOrg),
        facility: a(plan.facility),
        loan: a(plan.loan),
        lock: a(plan.lock),
        lot: a(plan.lot),
        valuation: a(plan.valuation),
        pool: a(plan.pool),
        lenderShare: a(plan.lenderShare),
        poolAuthority: a(plan.poolAuthority),
        poolVault: a(plan.poolVault),
        mint: a(plan.mint),
        destination: a(plan.destination),
        amount: n(plan.amount),
        expectedRevision: n(plan.expectedRevision),
        validUntil: n(plan.validUntil),
      });
    case "repay_simulated": {
      const { token } = await walletAccounts(input);
      const instruction = getRepayInstruction({
        signer: signer("payer"),
        protocol,
        facility: a(plan.facility),
        loan: a(plan.loan),
        pool: a(plan.pool),
        poolAuthority: a(plan.poolAuthority),
        poolVault: a(plan.poolVault),
        payerToken: a(token ?? undefined),
        mint: a(plan.mint),
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        amount: n(plan.amount),
      });
      return {
        ...instruction,
        accounts: [
          ...instruction.accounts,
          { address: a(plan.lenderShare), role: AccountRole.WRITABLE },
        ],
      };
    }
  }
}
