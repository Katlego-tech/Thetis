// Each command kind: who may start it, who signs, what the API reads from the chain to prepare
// it, the text or fields a person reads, and the Thetis instruction it builds
// (live-lending.md §4.3, §6.5.6). Nothing here is authority: the program checks every value.
import { randomBytes } from "node:crypto";
import {
  AccountRole,
  type Address,
  createNoopSigner,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Instruction,
  type MaybeEncodedAccount,
} from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
  decodeClassPolicy,
  decodeCustodianClass,
  decodeFacility,
  decodeLoan,
  decodeLot,
  decodeOrganisation,
  decodePaymentAttestation,
  decodePoolShare,
  decodePosition,
  decodeProtocol,
  decodeReleaseIntent,
  decodeSimulationPool,
  decodeValuation,
  type Facility,
  findAuthorityPda,
  findFacilityPda,
  findIntentPda,
  findLoanPda,
  findLockPda,
  findMintPda,
  findOrganisationPda,
  findPaymentPda,
  findPoolAuthorityPda,
  findPoolPda,
  findPositionPda,
  findSharePda,
  findVaultAuthorityPda,
  getBorrowInstruction,
  getCloseLoanInstruction,
  getConfirmPaymentInstruction,
  getCreateReleaseIntentInstruction,
  getDepositInstruction,
  getLiquidateInstruction,
  getOpenFacilityInstruction,
  getPledgeInstruction,
  getRecordAdvanceInstruction,
  getRepayInstruction,
  getSellPledgedInstruction,
  getSetValuationInstruction,
  getWithdrawInstruction,
  type Loan,
  type Organisation,
  PaymentPurpose,
  PaymentStatus,
  Role,
  SettlementMode,
  THETIS_PROGRAM_ADDRESS,
  U64_MAX,
} from "@thetis/contracts";
import type { ChainPort } from "./chain.ts";
import {
  advanceMessage,
  borrowMessage,
  buyPledgedMessage,
  correctionPaymentId,
  formatBps,
  formatMoney,
  formatSast,
  paymentId,
  pledgeMessage,
  releaseIntentMessage,
  sourceDigest,
  termsDigest,
  textFields,
} from "./texts.ts";
import { type CommandKind, RelayError, type SignerRole, type StoredSigner } from "./views.ts";

export const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;
export const TEXT_WINDOW_SECS = 270n;
const DAY = 86_400n;
const HOUR = 3_600n;

const SCOPES = { PLEDGE: 1 << 5, BUY: 1 << 6, LEND: 1 << 7, POOL: 1 << 8 } as const;
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
}

const tx = (role: SignerRole, scope: ScopeName | null, preCheckAuthority = true): SignerSpec => ({
  role,
  method: "transaction",
  scope,
  preCheckAuthority,
});
const text = (role: SignerRole, scope: ScopeName): SignerSpec => ({
  role,
  method: "text",
  scope,
  preCheckAuthority: true,
});

export const KIND_SPECS: Record<CommandKind, KindSpec> = {
  open_facility: {
    mode: "both",
    args: ["borrower", "currency", "currencyDecimals", "termsVersion", "rateBps", "maxLtvBps"],
    signers: [tx("lender", "LEND")],
    event: "FacilityOpened",
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
  },
  pledge: {
    mode: "both",
    args: ["facility", "lot", "quantityKg"],
    signers: [text("borrower", "PLEDGE"), text("lender", "LEND")],
    event: "Pledged",
  },
  record_advance: {
    mode: "fiat",
    args: ["loan", "amountMinor"],
    signers: [text("borrower", "PLEDGE"), tx("lender", "LEND")],
    event: "AdvanceRecorded",
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
  },
  correct_payment: {
    mode: "fiat",
    args: ["target", "correctionReference", "evidenceVersionId"],
    signers: [tx("lender", "LEND")],
    event: "PaymentCorrected",
  },
  repay: { mode: "fiat", args: ["payment"], signers: [tx("lender", "LEND")], event: "Repaid" },
  create_release_intent: {
    mode: "fiat",
    args: ["loan", "buyer", "quantityKg", "priceMinor", "topUpMinor", "expiresInHours"],
    signers: [text("seller", "PLEDGE")],
    event: "ReleaseIntentCreated",
  },
  sell_pledged: {
    mode: "fiat",
    args: ["intent"],
    signers: [text("buyer", "BUY")],
    event: "PledgedSold",
  },
  liquidate: { mode: "both", args: ["loan"], signers: [tx("lender", "LEND")], event: "Liquidated" },
  close_loan: {
    mode: "both",
    args: ["loan"],
    signers: [tx("lender", "LEND")],
    event: "LoanClosed",
  },
  deposit: {
    mode: "simulation",
    args: ["amountMinor"],
    signers: [tx("depositor", "POOL")],
    event: "Deposited",
  },
  withdraw: {
    mode: "simulation",
    args: ["amountMinor"],
    signers: [tx("depositor", "POOL")],
    event: "Withdrawn",
  },
  borrow: {
    mode: "simulation",
    args: ["loan", "amountMinor", "wallet"],
    signers: [text("borrower", "PLEDGE")],
    event: "Borrowed",
  },
  repay_simulated: {
    mode: "simulation",
    args: ["loan", "amountMinor"],
    signers: [tx("payer", null, false)],
    event: "Repaid",
  },
};

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

/** Reads accounts fresh at `confirmed`; a missing or wrong account is ACCOUNT_MISSING. */
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
  evidenceDigest(versionId: string, lenderOrgId: string): Promise<string>;
  /** WALLET_NOT_LINKED unless `wallet` is one of the caller's active links for the org. */
  callerLinks(organisationId: string): Promise<string[]>;
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

function validUntil(context: PrepareContext) {
  return context.chainTime + TEXT_WINDOW_SECS;
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

const PREPARE: Record<CommandKind, Preparer> = {
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
    const until = validUntil(context);
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
    const until = validUntil(context);
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
    const digest = await context.evidenceDigest(args.evidenceVersionId as string, f.lender.uuid);
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
    const digest = await context.evidenceDigest(args.evidenceVersionId as string, f.lender.uuid);
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
    const until = validUntil(context);
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
    const until = validUntil(context);
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
    const until = validUntil(context);
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
