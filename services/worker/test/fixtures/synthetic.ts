// A synthetic Solana chain for the indexer tests.
//
// SYNTHETIC: every key, signature, slot and block time in this file is made up from fixed bytes
// so that the tests are deterministic. None of them exists on devnet, except the addresses that
// follow from public seeds (the program id, the protocol "fiat-attestation", its class policy and
// organisations), which are derived here, never copied. The real devnet history is checked live
// by the operator, not by these tests.
//
// Instructions, event lines and account data are built with the generated encoders of
// @thetis/contracts, the same bytes the program writes. The seed transactions use the instruction
// builders of scripts/seed-demo.ts with the parties of supabase/seed.sql.

import { readFileSync } from "node:fs";
import {
  AccountRole,
  type Address,
  createKeyPairSignerFromPrivateKeyBytes,
  getAddressEncoder,
  getBase58Decoder,
  getProgramDerivedAddress,
  type Instruction,
  type KeyPairSigner,
  type Lamports,
  type MaybeEncodedAccount,
  none,
  type ReadonlyUint8Array,
  some,
} from "@solana/kit";
import {
  findAuthorityPda,
  findFacilityPda,
  findIntakePda,
  findIntentPda,
  findLoanPda,
  findLockPda,
  findMintAuthorityPda,
  findMintPda,
  findOrganisationPda,
  findPaymentPda,
  findPoolPda,
  findPositionPda,
  findProtocolPda,
  findSharePda,
  findVaultAuthorityPda,
  getAccreditCustodianClassInstruction,
  getAdvanceRecordedEventEncoder,
  getBorrowedEventEncoder,
  getBorrowInstruction,
  getClassPolicyEncoder,
  getClassRegisteredEventEncoder,
  getCloseLoanInstruction,
  getConfirmPaymentInstruction,
  getCreateReleaseIntentInstruction,
  getCustodianClassAccreditedEventEncoder,
  getCustodianClassEncoder,
  getDepositedEventEncoder,
  getDepositInstruction,
  getFacilityEncoder,
  getFacilityOpenedEventEncoder,
  getIntakeIdentityEncoder,
  getIssueLotInstruction,
  getLoanClosedEventEncoder,
  getLoanEncoder,
  getLockAllocationEncoder,
  getLotEncoder,
  getLotIssuedEventEncoder,
  getLotSplitEventEncoder,
  getOpenFacilityInstruction,
  getOrganisationAccreditedEventEncoder,
  getOrganisationEncoder,
  getOrganisationNameEncoder,
  getPauseInstruction,
  getPaymentAttestationEncoder,
  getPaymentConfirmedEventEncoder,
  getPaymentCorrectedEventEncoder,
  getPledgedEventEncoder,
  getPledgedSoldEventEncoder,
  getPledgeInstruction,
  getPoolShareEncoder,
  getPositionEncoder,
  getProtocolEncoder,
  getProtocolInitializedEventEncoder,
  getRecordAdvanceInstruction,
  getRedeemInstruction,
  getReleaseIntentCreatedEventEncoder,
  getReleaseIntentEncoder,
  getRepaidEventEncoder,
  getRepayInstruction,
  getSellPledgedInstruction,
  getSetValuationInstruction,
  getSimulationPoolEncoder,
  getSplitInstruction,
  getTransferInstruction,
  getUnitsRedeemedEventEncoder,
  getUnitsTransferredEventEncoder,
  getValuationEncoder,
  getValuationSetEventEncoder,
  getWithdrawInstruction,
  getWithdrawnEventEncoder,
  IntentStatus,
  LoanStatus,
  LockControl,
  LotState,
  PaymentPurpose,
  PaymentStatus,
  QuantityUnit,
  Restriction,
  Role,
  SettlementMode,
  THETIS_PROGRAM_ADDRESS,
} from "@thetis/contracts";
import { accrueSimple } from "../../../../packages/domain/src/accrual.ts";
import {
  buildAccreditOrganisation,
  buildInitializeProtocol,
  buildRegisterClass,
  DEFAULT_INSTANCE,
  derivePoolAddresses,
  findAssociatedTokenAddress,
  findClassPolicyPda,
  findOrganisationNamePda,
  instanceIdBytes,
  parseSeedOrganisations,
  SEED,
  type SeedOrganisation,
  SIMULATION_INSTANCE,
  TOKEN_PROGRAM_ADDRESS,
} from "../../../../scripts/seed-demo.ts";
import type {
  ChainSource,
  FetchedAccount,
  RawTransaction,
  SignatureEntry,
} from "../../src/indexer/rpc.ts";

export const PROGRAM = THETIS_PROGRAM_ADDRESS as string;
export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
export const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
export const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ASSOCIATED_TOKEN = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

const SEED_SQL = new URL("../../../../supabase/seed.sql", import.meta.url);
const base58 = getBase58Decoder();
const addressBytes = getAddressEncoder();
const text = new TextEncoder();

// ------------------------------------------------------------------------------------------------
// Shapes
// ------------------------------------------------------------------------------------------------

/** An account as the chain holds it after a slot; null when the account was closed. */
export type AccountState = { programAddress: string; data: Uint8Array } | null;

export type FakeInstruction = {
  programAddress: string;
  accounts: { address: string; role: AccountRole }[];
  data: Uint8Array;
};

export type FakeTransaction = {
  signature: string;
  failed: boolean;
  feePayer: string;
  instructions: FakeInstruction[];
  inner: { index: number; instructions: FakeInstruction[] }[];
  logs: string[] | null;
  /** Rewrites the JSON response, for the malformed-response cases. */
  edit?: (raw: RawTransaction) => RawTransaction;
};

export type FakeSlot = {
  slot: number;
  blockTime: string | null;
  transactions: FakeTransaction[];
  /** Accounts written in this slot (state after the slot). */
  accounts: Record<string, AccountState>;
};

export type History = FakeSlot[];

export type Status = { slot: number; failed: boolean; confirmationStatus: string | null };

// ------------------------------------------------------------------------------------------------
// Synthetic values
// ------------------------------------------------------------------------------------------------

/** SYNTHETIC: the base58 of 64 bytes all equal to k. */
export function syntheticSignature(k: number): string {
  if (!Number.isInteger(k) || k < 1 || k > 255) throw new Error(`signature index ${k}`);
  return base58.decode(new Uint8Array(64).fill(k));
}

const signerCache = new Map<number, Promise<KeyPairSigner>>();
/** SYNTHETIC: the key whose 32-byte private key is all n. */
export function syntheticSigner(n: number): Promise<KeyPairSigner> {
  let signer = signerCache.get(n);
  if (!signer) {
    signer = createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(n));
    signerCache.set(n, signer);
  }
  return signer;
}

export function seedBlockTime(index: number): string {
  return new Date(Date.parse("2026-11-25T00:00:00Z") + index * 1000).toISOString();
}

export function lotBlockTime(index: number): string {
  return new Date(Date.parse("2026-11-26T00:00:00Z") + index * 1000).toISOString();
}

function u32le(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

async function pda(
  seeds: ReadonlyUint8Array[],
  programAddress: string = PROGRAM,
): Promise<[string, number]> {
  const [found, bump] = await getProgramDerivedAddress({
    programAddress: programAddress as Address,
    seeds,
  });
  return [found, bump];
}

/** Encodes `args` with a generated encoder; the casts keep one helper for every encoder type. */
export function bytesOf(
  encoder: { encode: (value: never) => ArrayLike<number> },
  args: unknown,
): Uint8Array {
  return Uint8Array.from((encoder.encode as (value: unknown) => ArrayLike<number>)(args));
}

export function thetis(data: Uint8Array): AccountState {
  return { programAddress: PROGRAM, data };
}

// ------------------------------------------------------------------------------------------------
// Transactions and logs
// ------------------------------------------------------------------------------------------------

export function toFakeInstruction(instruction: Instruction): FakeInstruction {
  return {
    programAddress: instruction.programAddress,
    accounts: (instruction.accounts ?? []).map((meta) => ({
      address: meta.address,
      role: meta.role,
    })),
    data: Uint8Array.from(instruction.data ?? new Uint8Array()),
  };
}

export function eventLine(bytes: Uint8Array): string {
  return `Program data: ${Buffer.from(bytes).toString("base64")}`;
}

/** The logs a top-level Thetis invocation writes: invoke, optional system CPIs, data lines, success. */
export function thetisLogs(
  name: string,
  events: Uint8Array[],
  options: { systemCpi?: boolean } = {},
): string[] {
  return [
    `Program ${PROGRAM} invoke [1]`,
    `Program log: Instruction: ${name}`,
    ...(options.systemCpi
      ? [`Program ${SYSTEM_PROGRAM} invoke [2]`, `Program ${SYSTEM_PROGRAM} success`]
      : []),
    ...events.map(eventLine),
    `Program ${PROGRAM} consumed 21000 of 200000 compute units`,
    `Program ${PROGRAM} success`,
  ];
}

export function otherProgramLogs(programAddress: string, extra: string[] = []): string[] {
  return [`Program ${programAddress} invoke [1]`, ...extra, `Program ${programAddress} success`];
}

export function thetisTransaction(input: {
  signature: string;
  feePayer: string;
  instruction: Instruction;
  name: string;
  events: Uint8Array[];
  systemCpi?: boolean;
}): FakeTransaction {
  return {
    signature: input.signature,
    failed: false,
    feePayer: input.feePayer,
    instructions: [toFakeInstruction(input.instruction)],
    inner: input.systemCpi
      ? [
          {
            index: 0,
            instructions: [
              {
                programAddress: SYSTEM_PROGRAM,
                accounts: [{ address: input.feePayer, role: AccountRole.WRITABLE_SIGNER }],
                data: new Uint8Array([0, 0, 0, 0]),
              },
            ],
          },
        ]
      : [],
    logs: thetisLogs(input.name, input.events, input.systemCpi ? { systemCpi: true } : {}),
  };
}

/** Compiles a fake transaction into the getTransaction JSON shape (legacy message). */
export function compileTransaction(
  tx: FakeTransaction,
  slot: number,
  blockTime: string | null,
): RawTransaction {
  const roles = new Map<string, number>();
  const note = (address: string, role: number) =>
    roles.set(address, (roles.get(address) ?? 0) | role);
  note(tx.feePayer, AccountRole.WRITABLE_SIGNER);
  const all = [...tx.instructions, ...tx.inner.flatMap((group) => group.instructions)];
  for (const instruction of all) {
    for (const meta of instruction.accounts) note(meta.address, meta.role);
    note(instruction.programAddress, AccountRole.READONLY);
  }
  const rank = (address: string) => {
    if (address === tx.feePayer) return -1;
    const role = roles.get(address) ?? 0;
    return [3, 2, 1, 0].indexOf(role);
  };
  const keys = [...roles.keys()].sort((a, b) => rank(a) - rank(b));
  const count = (role: number) => keys.filter((key) => roles.get(key) === role).length;
  const index = (address: string) => keys.indexOf(address);
  const compile = (instruction: FakeInstruction) => ({
    programIdIndex: index(instruction.programAddress),
    accounts: instruction.accounts.map((meta) => index(meta.address)),
    data: base58.decode(instruction.data),
  });
  const raw: RawTransaction = {
    slot,
    blockTime,
    version: "legacy",
    transaction: {
      message: {
        accountKeys: keys,
        header: {
          numRequiredSignatures: count(3) + count(2),
          numReadonlySignedAccounts: count(2),
          numReadonlyUnsignedAccounts: count(0),
        },
        instructions: tx.instructions.map(compile),
      },
    },
    meta: {
      err: tx.failed ? { InstructionError: [0, { Custom: 3012 }] } : null,
      logMessages: tx.logs,
      innerInstructions: tx.inner.map((group) => ({
        index: group.index,
        instructions: group.instructions.map(compile),
      })),
    },
  } as unknown as RawTransaction;
  return tx.edit ? tx.edit(raw) : raw;
}

// ------------------------------------------------------------------------------------------------
// The fake chain
// ------------------------------------------------------------------------------------------------

type Method = keyof ChainSource;

export type FakeChain = ChainSource & {
  setConfirmedSlot(slot: number): void;
  setFinalizedSlot(slot: number): void;
  setStatus(signature: string, status: Status | null): void;
  /** Hides listing entries below this slot (a provider that no longer serves old history). */
  setListingFloor(slot: number): void;
  setHistory(history: History): void;
  /** The next `times` calls of `method` (those whose arguments match `when`, if given) reject. */
  failNext(method: Method, times?: number, when?: (args: unknown[]) => boolean): void;
  /** Chooses the state (and context slot) a confirmed getMultipleAccounts call returns. */
  setAccountReadSlot(
    choose:
      | ((call: { index: number; minContextSlot: number | null; head: number }) => number)
      | null,
  ): void;
  calls: { method: Method; args: unknown[] }[];
};

export function lastSlot(history: History): number {
  return history.reduce((max, entry) => Math.max(max, entry.slot), 0);
}

export function fakeChain(initial: History): FakeChain {
  let history = initial;
  let confirmed = lastSlot(history);
  let finalized = confirmed;
  let floor = 0;
  let readSlot: Parameters<FakeChain["setAccountReadSlot"]>[0] = null;
  let reads = 0;
  const statuses = new Map<string, Status | null>();
  const failures: { method: Method; left: number; when?: (args: unknown[]) => boolean }[] = [];
  const calls: FakeChain["calls"] = [];

  function enter(method: Method, args: unknown[], signal?: AbortSignal) {
    calls.push({ method, args });
    signal?.throwIfAborted();
    const failure = failures.find(
      (candidate) =>
        candidate.method === method && candidate.left > 0 && (candidate.when?.(args) ?? true),
    );
    if (failure) {
      failure.left -= 1;
      throw new Error(`synthetic RPC failure in ${method}`);
    }
  }

  function stateAt(slot: number): Map<string, NonNullable<AccountState>> {
    const state = new Map<string, NonNullable<AccountState>>();
    for (const entry of [...history].sort((a, b) => a.slot - b.slot)) {
      if (entry.slot > slot) break;
      for (const [address, account] of Object.entries(entry.accounts)) {
        if (account === null) state.delete(address);
        else state.set(address, account);
      }
    }
    return state;
  }

  function located(signature: string) {
    for (const entry of history) {
      const tx = entry.transactions.find((candidate) => candidate.signature === signature);
      if (tx) return { entry, tx };
    }
    return null;
  }

  function maybe(address: string, account: AccountState | undefined): FetchedAccount {
    if (!account) return { address: address as Address, exists: false } as FetchedAccount;
    return {
      address: address as Address,
      exists: true,
      programAddress: account.programAddress as Address,
      data: account.data,
      executable: false,
      lamports: 2_000_000n as Lamports,
      space: BigInt(account.data.length),
    } as MaybeEncodedAccount as FetchedAccount;
  }

  const chain: FakeChain = {
    calls,
    setConfirmedSlot(slot) {
      confirmed = slot;
    },
    setFinalizedSlot(slot) {
      finalized = slot;
    },
    setStatus(signature, status) {
      statuses.set(signature, status);
    },
    setListingFloor(slot) {
      floor = slot;
    },
    setHistory(next) {
      history = next;
    },
    failNext(method, times = 1, when) {
      failures.push(when ? { method, left: times, when } : { method, left: times });
    },
    setAccountReadSlot(choose) {
      readSlot = choose;
      reads = 0;
    },

    async getGenesisHash(signal) {
      enter("getGenesisHash", [], signal);
      return DEVNET_GENESIS;
    },
    async getSlot(commitment, signal) {
      enter("getSlot", [commitment], signal);
      return commitment === "finalized" ? finalized : confirmed;
    },
    async getSignatures(before, minContextSlot, signal) {
      enter("getSignatures", [before, minContextSlot], signal);
      const listed: SignatureEntry[] = [...history]
        .filter((entry) => entry.slot <= confirmed && entry.slot >= floor)
        .sort((a, b) => b.slot - a.slot)
        .flatMap((entry) =>
          [...entry.transactions].reverse().map((tx) => ({
            signature: tx.signature,
            slot: entry.slot,
            failed: tx.failed,
            blockTime: entry.blockTime,
          })),
        );
      const start = before === null ? 0 : listed.findIndex((item) => item.signature === before) + 1;
      if (before !== null && start === 0) return [];
      return listed.slice(start, start + 1000);
    },
    async getTransaction(signature, signal) {
      enter("getTransaction", [signature], signal);
      const found = located(signature);
      if (!found || found.entry.slot > confirmed) return null;
      return compileTransaction(found.tx, found.entry.slot, found.entry.blockTime);
    },
    async getBlockTime(slot, signal) {
      enter("getBlockTime", [slot], signal);
      return history.find((entry) => entry.slot === slot)?.blockTime ?? null;
    },
    async getMultipleAccounts(addresses, commitment, minContextSlot, signal) {
      enter("getMultipleAccounts", [addresses, commitment, minContextSlot], signal);
      let slot = commitment === "finalized" ? finalized : confirmed;
      if (commitment === "confirmed" && readSlot) {
        slot = readSlot({ index: reads, minContextSlot, head: confirmed });
        reads += 1;
      }
      const state = stateAt(slot);
      return { slot, accounts: addresses.map((address) => maybe(address, state.get(address))) };
    },
    async getProgramAccounts(filter, signal) {
      enter("getProgramAccounts", [filter], signal);
      const wanted = addressBytes.encode(filter.offset8 as Address);
      const accounts = [...stateAt(finalized)]
        .filter(
          ([, account]) =>
            account.programAddress === PROGRAM &&
            account.data.length >= 40 &&
            (filter.dataSize === null || account.data.length === filter.dataSize) &&
            wanted.every((byte, index) => account.data[8 + index] === byte),
        )
        .map(([address, account]) => {
          const { exists: _exists, ...encoded } = maybe(address, account) as MaybeEncodedAccount & {
            exists: true;
          };
          return encoded;
        });
      return { slot: finalized, accounts } as Awaited<
        ReturnType<ChainSource["getProgramAccounts"]>
      >;
    },
    async getSignatureStatuses(signatures, signal) {
      enter("getSignatureStatuses", [signatures], signal);
      return signatures.map((signature) => {
        if (statuses.has(signature)) return statuses.get(signature) ?? null;
        const found = located(signature);
        if (!found || found.entry.slot > confirmed) return null;
        return {
          slot: found.entry.slot,
          failed: found.tx.failed,
          confirmationStatus: found.entry.slot <= finalized ? "finalized" : "confirmed",
        };
      });
    },
  };
  return chain;
}

// ------------------------------------------------------------------------------------------------
// History editing (malformed cases)
// ------------------------------------------------------------------------------------------------

export function cloneHistory(history: History): History {
  return history.map((entry) => ({
    ...entry,
    accounts: Object.fromEntries(
      Object.entries(entry.accounts).map(([address, account]) => [
        address,
        account && { programAddress: account.programAddress, data: account.data.slice() },
      ]),
    ),
    transactions: entry.transactions.map((tx) => ({
      ...tx,
      instructions: tx.instructions.map((instruction) => ({
        ...instruction,
        accounts: instruction.accounts.map((meta) => ({ ...meta })),
        data: instruction.data.slice(),
      })),
      inner: tx.inner.map((group) => ({ ...group, instructions: [...group.instructions] })),
      logs: tx.logs && [...tx.logs],
    })),
  }));
}

export function transactionOf(history: History, signature: string): FakeTransaction {
  for (const entry of history) {
    const tx = entry.transactions.find((candidate) => candidate.signature === signature);
    if (tx) return tx;
  }
  throw new Error(`no transaction ${signature} in the history`);
}

export function slotOf(history: History, signature: string): FakeSlot {
  const entry = history.find((candidate) =>
    candidate.transactions.some((tx) => tx.signature === signature),
  );
  if (!entry) throw new Error(`no transaction ${signature} in the history`);
  return entry;
}

/** Rewrites the bytes of the n-th `Program data:` line of a transaction. */
export function editEvent(tx: FakeTransaction, n: number, edit: (bytes: Uint8Array) => Uint8Array) {
  if (!tx.logs) throw new Error("transaction has no logs");
  const lines = tx.logs
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.startsWith("Program data: "));
  const target = lines[n];
  if (!target) throw new Error(`transaction has no event line ${n}`);
  const bytes = Uint8Array.from(Buffer.from(target.line.slice("Program data: ".length), "base64"));
  tx.logs[target.index] = eventLine(edit(bytes));
}

export function eventLines(tx: FakeTransaction): string[] {
  return (tx.logs ?? []).filter((line) => line.startsWith("Program data: "));
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// The seed and the lot fixtures
// ------------------------------------------------------------------------------------------------

export type Fixture = {
  protocol: string;
  classPolicy: string;
  organisations: (SeedOrganisation & { address: string; nameMarker: string; admin: string })[];
  org: (slug: string) => string;
  custodianClass: string;
  intake: string;
  lot: string;
  child: string;
  mint: string;
  childMint: string;
  positions: { khunouParent: string; buyerParent: string; khunouChild: string };
  signers: {
    deployer: KeyPairSigner;
    admin: KeyPairSigner;
    accreditor: KeyPairSigner;
    sponsor: KeyPairSigner;
  };
  seedSignatures: {
    deploy: string;
    initializeProtocol: string;
    registerClass: string;
    accredit: string[];
  };
  lotSignatures: {
    accreditCustodianClass: string;
    issue: string;
    transfer: string;
    split: string;
    redeem: string;
  };
  seedOrganisationsRows: { id: string; slug: string; synthetic: boolean }[];
  build: Builders;
};

type Builders = {
  /** A Transfer of `quantity` from one organisation to another, with its event and account states. */
  transfer(input: {
    signature: string;
    lot: string;
    mint: string;
    from: string;
    to: string;
    quantityKg: bigint;
    revision: bigint;
  }): Promise<FakeTransaction>;
  position(input: {
    lot: string;
    owner: string;
    quantityKg: bigint;
    revision: bigint;
  }): Promise<[string, AccountState]>;
  lotAccount(input: {
    lotId: string;
    supplyKg: bigint;
    revision: bigint;
    liveChildren: number;
    parent: string | null;
    root?: string;
    state?: number;
  }): Promise<[string, AccountState]>;
  organisationAccount(slug: string, overrides?: { displayName?: string }): AccountState;
  pause(signature: string): Promise<FakeTransaction>;
  openFacility(signature: string): Promise<FakeTransaction>;
  facilityAccount(): Promise<[string, AccountState]>;
  facilityOpenedEvent(): Uint8Array;
  foreignInitializeProtocol(signature: string): Promise<FakeTransaction>;
  /** A successful System transfer that lists the program address as a read-only account. */
  namesProgramOnly(signature: string): Promise<FakeTransaction>;
  failed(signature: string, data?: Uint8Array): Promise<FakeTransaction>;
};

const CHILD_LOT_ID = "CR-0001-A";
const LOT_ID = "CR-0001";
const SITE_CODE = "PORT-STOCKYARD";
const CAPACITY_KG = 10_000_000n;

let built: Promise<{ fixture: Fixture; seed: History; lots: History }> | null = null;

async function lotPda(protocol: string, lotId: string) {
  return pda([text.encode("lot"), addressBytes.encode(protocol as Address), text.encode(lotId)]);
}

async function buildAll() {
  const deployer = await syntheticSigner(1);
  const admin = await syntheticSigner(2);
  const accreditor = await syntheticSigner(3);
  const sponsor = await syntheticSigner(30);
  const custodianWallet = await syntheticSigner(31);
  const ownerWallet = await syntheticSigner(32);
  const parties = parseSeedOrganisations(readFileSync(SEED_SQL, "utf8"));
  const [protocol, protocolBump] = await findProtocolPda({ instanceId: instanceIdBytes() });
  const classPolicy = await findClassPolicyPda(protocol, SEED.classCode, SEED.classVersion);
  const [, classBump] = await pda([
    text.encode("class"),
    addressBytes.encode(protocol),
    text.encode(SEED.classCode),
    u32le(SEED.classVersion),
  ]);

  const organisations = await Promise.all(
    parties.map(async (party, index) => {
      const [address, bump] = await findOrganisationPda({ protocol, orgId: party.orgId });
      const orgAdmin = await syntheticSigner(10 + index);
      return {
        ...party,
        address: address as string,
        bump,
        nameMarker: (await findOrganisationNamePda(protocol, party.name)) as string,
        admin: orgAdmin.address as string,
      };
    }),
  );
  const org = (slug: string) => {
    const found = organisations.find((candidate) => candidate.slug === slug);
    if (!found) throw new Error(`no organisation ${slug} in seed.sql`);
    return found.address;
  };
  const orgRecord = (slug: string) => organisations.find((candidate) => candidate.slug === slug);

  function organisationAccount(
    slug: string,
    overrides: { displayName?: string } = {},
  ): AccountState {
    const party = orgRecord(slug);
    if (!party) throw new Error(`no organisation ${slug}`);
    return thetis(
      bytesOf(getOrganisationEncoder(), {
        protocol,
        orgId: party.orgId,
        role: Role[party.role],
        displayName: overrides.displayName ?? party.name,
        admin: party.admin,
        related: [],
        bump: party.bump,
      }),
    );
  }

  // ---- seed history: the deploy and the nine seed transactions, slots 1,000 … 10,000 ----
  const seed: History = [];
  const signers = { deployer, admin, accreditor };
  const deploy: FakeTransaction = {
    signature: syntheticSignature(1),
    failed: false,
    feePayer: deployer.address,
    instructions: [
      {
        programAddress: LOADER,
        accounts: [
          { address: deployer.address, role: AccountRole.WRITABLE_SIGNER },
          { address: PROGRAM, role: AccountRole.WRITABLE },
          { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
        ],
        data: new Uint8Array([2, 0, 0, 0, 0, 16, 0, 0, 0, 0, 0, 0]),
      },
    ],
    inner: [
      {
        index: 0,
        instructions: [
          {
            programAddress: SYSTEM_PROGRAM,
            accounts: [{ address: deployer.address, role: AccountRole.WRITABLE_SIGNER }],
            data: new Uint8Array([0, 0, 0, 0]),
          },
        ],
      },
    ],
    logs: [
      `Program ${LOADER} invoke [1]`,
      `Program ${SYSTEM_PROGRAM} invoke [2]`,
      `Program ${SYSTEM_PROGRAM} success`,
      "Deployed program jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3",
      `Program ${LOADER} success`,
    ],
  };
  seed.push({ slot: 1000, blockTime: seedBlockTime(0), transactions: [deploy], accounts: {} });

  seed.push({
    slot: 2000,
    blockTime: seedBlockTime(1),
    transactions: [
      thetisTransaction({
        signature: syntheticSignature(2),
        feePayer: deployer.address,
        instruction: await buildInitializeProtocol(signers),
        name: "InitializeProtocol",
        events: [bytesOf(getProtocolInitializedEventEncoder(), { protocol })],
        systemCpi: true,
      }),
    ],
    accounts: {
      [protocol]: thetis(
        bytesOf(getProtocolEncoder(), {
          instanceId: instanceIdBytes(),
          settlementMode: SettlementMode[SEED.settlementMode],
          admin: admin.address,
          accreditor: accreditor.address,
          pauseFlags: 0,
          bump: protocolBump,
        }),
      ),
    },
  });

  seed.push({
    slot: 3000,
    blockTime: seedBlockTime(2),
    transactions: [
      thetisTransaction({
        signature: syntheticSignature(3),
        feePayer: deployer.address,
        instruction: await buildRegisterClass(signers),
        name: "RegisterClass",
        events: [
          bytesOf(getClassRegisteredEventEncoder(), { classPolicy, version: SEED.classVersion }),
        ],
        systemCpi: true,
      }),
    ],
    accounts: {
      [classPolicy]: thetis(
        bytesOf(getClassPolicyEncoder(), {
          protocol,
          classCode: SEED.classCode,
          version: SEED.classVersion,
          unit: QuantityUnit.Kilogram,
          grades: [...SEED.grades],
          originRequired: SEED.originRequired,
          lotValiditySecs: SEED.lotValiditySecs,
          splitInheritsExpiry: SEED.splitInheritsExpiry,
          bump: classBump,
        }),
      ),
    },
  });

  const accredit: string[] = [];
  for (const [index, party] of organisations.entries()) {
    const signature = syntheticSignature(4 + index);
    accredit.push(signature);
    seed.push({
      slot: 4000 + index * 1000,
      blockTime: seedBlockTime(3 + index),
      transactions: [
        thetisTransaction({
          signature,
          feePayer: deployer.address,
          instruction: await buildAccreditOrganisation(signers, party, party.admin as Address),
          name: "AccreditOrganisation",
          events: [
            bytesOf(getOrganisationAccreditedEventEncoder(), {
              organisation: party.address,
              role: Role[party.role],
            }),
          ],
          systemCpi: true,
        }),
      ],
      accounts: {
        [party.address]: organisationAccount(party.slug),
        [party.nameMarker]: thetis(bytesOf(getOrganisationNameEncoder(), {})),
      },
    });
  }

  // ---- lot history: five labelled synthetic actions, slots 11,000 … 15,000 ----
  const kopano = org("kopano");
  const khunou = org("khunou");
  const buyer = org("buyer-smelter");
  const [custodianClass, custodianClassBump] = await pda([
    text.encode("custodian_class"),
    addressBytes.encode(protocol),
    addressBytes.encode(kopano as Address),
    addressBytes.encode(classPolicy),
    text.encode(SITE_CODE),
  ]);
  const intakeDigest = new Uint8Array(32).fill(1);
  const [intake, intakeBump] = await findIntakePda({
    protocol,
    custodian: kopano as Address,
    intakeDigest,
  });
  const [lot] = await lotPda(protocol, LOT_ID);
  const [child] = await lotPda(protocol, CHILD_LOT_ID);
  const [mint] = await findMintPda({ lot: lot as Address });
  const [childMint] = await findMintPda({ lot: child as Address });
  const [custodianAuthority] = await findAuthorityPda({
    protocol,
    wallet: custodianWallet.address,
  });
  const [ownerAuthority] = await findAuthorityPda({ protocol, wallet: ownerWallet.address });
  const issuedAt = Date.parse(lotBlockTime(1)) / 1000;
  const expiresAt = BigInt(issuedAt) + SEED.lotValiditySecs;

  async function vaultOf(position: string, lotMint: string) {
    const [vaultAuthority] = await findVaultAuthorityPda({ position: position as Address });
    const [vault] = await pda(
      [
        addressBytes.encode(vaultAuthority),
        addressBytes.encode(TOKEN_2022 as Address),
        addressBytes.encode(lotMint as Address),
      ],
      ASSOCIATED_TOKEN,
    );
    return { vaultAuthority: vaultAuthority as string, vault };
  }

  async function position(input: {
    lot: string;
    owner: string;
    quantityKg: bigint;
    revision: bigint;
  }): Promise<[string, AccountState]> {
    const [address, bump] = await findPositionPda({
      lot: input.lot as Address,
      owner: input.owner as Address,
    });
    return [
      address,
      thetis(
        bytesOf(getPositionEncoder(), {
          protocol,
          lot: input.lot,
          owner: input.owner,
          quantityKg: input.quantityKg,
          lockedKg: 0n,
          reservedKg: 0n,
          revision: input.revision,
          bump,
        }),
      ),
    ];
  }

  async function lotAccount(input: {
    lotId: string;
    supplyKg: bigint;
    revision: bigint;
    liveChildren: number;
    parent: string | null;
    root?: string;
    state?: number;
  }): Promise<[string, AccountState]> {
    const [address, bump] = await lotPda(protocol, input.lotId);
    const [lotMint] = await findMintPda({ lot: address as Address });
    return [
      address,
      thetis(
        bytesOf(getLotEncoder(), {
          protocol,
          lotId: input.lotId,
          classPolicy,
          classVersion: SEED.classVersion,
          grade: "G1",
          custodianClass,
          intake,
          parent: input.parent === null ? none() : some(input.parent),
          root: input.root ?? (input.parent === null ? address : lot),
          mint: lotMint,
          supplyKg: input.supplyKg,
          state: input.state ?? LotState.Stored,
          restriction: Restriction.Normal,
          expiresAt,
          revision: input.revision,
          liveChildren: input.liveChildren,
          bump,
        }),
      ),
    ];
  }

  function custodianClassAccount(occupiedKg: bigint): AccountState {
    return thetis(
      bytesOf(getCustodianClassEncoder(), {
        protocol,
        custodian: kopano,
        classPolicy,
        siteCode: SITE_CODE,
        approvedCapacityKg: CAPACITY_KG,
        occupiedKg,
        reservedInboundKg: 0n,
        bump: custodianClassBump,
      }),
    );
  }

  function intakeAccount(): AccountState {
    return thetis(
      bytesOf(getIntakeIdentityEncoder(), {
        protocol,
        custodian: kopano,
        intakeDigest,
        lot,
        retired: false,
        bump: intakeBump,
      }),
    );
  }

  async function transfer(input: {
    signature: string;
    lot: string;
    mint: string;
    from: string;
    to: string;
    quantityKg: bigint;
    revision: bigint;
  }): Promise<FakeTransaction> {
    const [fromPosition] = await findPositionPda({
      lot: input.lot as Address,
      owner: input.from as Address,
    });
    const [toPosition] = await findPositionPda({
      lot: input.lot as Address,
      owner: input.to as Address,
    });
    const fromVault = await vaultOf(fromPosition, input.mint);
    const toVault = await vaultOf(toPosition, input.mint);
    return thetisTransaction({
      signature: input.signature,
      feePayer: sponsor.address,
      name: "Transfer",
      systemCpi: true,
      instruction: getTransferInstruction({
        sponsor,
        protocol,
        authority: ownerAuthority,
        lot: input.lot as Address,
        mint: input.mint as Address,
        owner: input.from as Address,
        fromPosition,
        fromVaultAuthority: fromVault.vaultAuthority as Address,
        fromVault: fromVault.vault as Address,
        recipient: input.to as Address,
        toPosition,
        toVaultAuthority: toVault.vaultAuthority as Address,
        toVault: toVault.vault as Address,
        quantityKg: input.quantityKg,
        expectedRevision: input.revision - 1n,
        validUntil: BigInt(issuedAt + 3600),
      }),
      events: [
        bytesOf(getUnitsTransferredEventEncoder(), {
          lot: input.lot,
          from: input.from,
          to: input.to,
          quantityKg: input.quantityKg,
          revision: input.revision,
        }),
      ],
    });
  }

  const [khunouParent] = await findPositionPda({ lot: lot as Address, owner: khunou as Address });
  const [buyerParent] = await findPositionPda({ lot: lot as Address, owner: buyer as Address });
  const [khunouChild] = await findPositionPda({ lot: child as Address, owner: khunou as Address });
  const khunouParentVault = await vaultOf(khunouParent, mint);
  const khunouChildVault = await vaultOf(khunouChild, childMint);
  const [mintAuthority] = await findMintAuthorityPda({ mint });
  const [childMintAuthority] = await findMintAuthorityPda({ mint: childMint });

  const lotSignatures = {
    accreditCustodianClass: syntheticSignature(11),
    issue: syntheticSignature(12),
    transfer: syntheticSignature(13),
    split: syntheticSignature(14),
    redeem: syntheticSignature(15),
  };

  const lots: History = [];
  lots.push({
    slot: 11_000,
    blockTime: lotBlockTime(0),
    transactions: [
      thetisTransaction({
        signature: lotSignatures.accreditCustodianClass,
        feePayer: deployer.address,
        name: "AccreditCustodianClass",
        systemCpi: true,
        instruction: getAccreditCustodianClassInstruction({
          protocol,
          custodian: kopano as Address,
          classPolicy,
          custodianClass: custodianClass as Address,
          accreditor,
          payer: deployer,
          siteCode: SITE_CODE,
          approvedCapacityKg: CAPACITY_KG,
        }),
        events: [
          bytesOf(getCustodianClassAccreditedEventEncoder(), {
            custodianClass,
            approvedCapacityKg: CAPACITY_KG,
          }),
        ],
      }),
    ],
    accounts: { [custodianClass]: custodianClassAccount(0n) },
  });

  lots.push({
    slot: 12_000,
    blockTime: lotBlockTime(1),
    transactions: [
      thetisTransaction({
        signature: lotSignatures.issue,
        feePayer: sponsor.address,
        name: "IssueLot",
        systemCpi: true,
        instruction: getIssueLotInstruction({
          sponsor,
          protocol,
          authority: custodianAuthority,
          owner: khunou as Address,
          custodian: kopano as Address,
          classPolicy,
          custodianClass: custodianClass as Address,
          intake,
          lot: lot as Address,
          mint,
          mintAuthority,
          position: khunouParent,
          vaultAuthority: khunouParentVault.vaultAuthority as Address,
          vault: khunouParentVault.vault as Address,
          lotId: LOT_ID,
          grade: "G1",
          quantityKg: 5_000_000n,
          intakeDigest,
          validUntil: BigInt(issuedAt + 3600),
        }),
        events: [
          bytesOf(getLotIssuedEventEncoder(), {
            lot,
            owner: khunou,
            quantityKg: 5_000_000n,
            intake,
            revision: 0n,
          }),
        ],
      }),
    ],
    accounts: Object.fromEntries([
      await lotAccount({
        lotId: LOT_ID,
        supplyKg: 5_000_000n,
        revision: 0n,
        liveChildren: 0,
        parent: null,
      }),
      [intake, intakeAccount()],
      await position({ lot, owner: khunou, quantityKg: 5_000_000n, revision: 0n }),
      [custodianClass, custodianClassAccount(5_000_000n)],
    ]),
  });

  lots.push({
    slot: 13_000,
    blockTime: lotBlockTime(2),
    transactions: [
      await transfer({
        signature: lotSignatures.transfer,
        lot,
        mint,
        from: khunou,
        to: buyer,
        quantityKg: 2_000_000n,
        revision: 1n,
      }),
    ],
    accounts: Object.fromEntries([
      await lotAccount({
        lotId: LOT_ID,
        supplyKg: 5_000_000n,
        revision: 1n,
        liveChildren: 0,
        parent: null,
      }),
      await position({ lot, owner: khunou, quantityKg: 3_000_000n, revision: 1n }),
      await position({ lot, owner: buyer, quantityKg: 2_000_000n, revision: 0n }),
    ]),
  });

  lots.push({
    slot: 14_000,
    blockTime: lotBlockTime(3),
    transactions: [
      thetisTransaction({
        signature: lotSignatures.split,
        feePayer: sponsor.address,
        name: "Split",
        systemCpi: true,
        instruction: getSplitInstruction({
          sponsor,
          protocol,
          ownerAuthority,
          custodianAuthority,
          lot: lot as Address,
          classPolicy,
          custodianClass: custodianClass as Address,
          owner: khunou as Address,
          custodian: kopano as Address,
          mint,
          position: khunouParent,
          vaultAuthority: khunouParentVault.vaultAuthority as Address,
          vault: khunouParentVault.vault as Address,
          childLot: child as Address,
          childMint,
          childMintAuthority,
          childPosition: khunouChild,
          childVaultAuthority: khunouChildVault.vaultAuthority as Address,
          childVault: khunouChildVault.vault as Address,
          childLotId: CHILD_LOT_ID,
          quantityKg: 1_000_000n,
          expectedRevision: 1n,
          validUntil: BigInt(issuedAt + 3600),
        }),
        events: [
          bytesOf(getLotSplitEventEncoder(), {
            parent: lot,
            child,
            owner: khunou,
            quantityKg: 1_000_000n,
            parentRevision: 2n,
          }),
        ],
      }),
    ],
    accounts: Object.fromEntries([
      await lotAccount({
        lotId: LOT_ID,
        supplyKg: 4_000_000n,
        revision: 2n,
        liveChildren: 1,
        parent: null,
      }),
      await lotAccount({
        lotId: CHILD_LOT_ID,
        supplyKg: 1_000_000n,
        revision: 0n,
        liveChildren: 0,
        parent: lot,
      }),
      await position({ lot, owner: khunou, quantityKg: 2_000_000n, revision: 2n }),
      await position({ lot: child, owner: khunou, quantityKg: 1_000_000n, revision: 0n }),
    ]),
  });

  lots.push({
    slot: 15_000,
    blockTime: lotBlockTime(4),
    transactions: [
      thetisTransaction({
        signature: lotSignatures.redeem,
        feePayer: sponsor.address,
        name: "Redeem",
        instruction: getRedeemInstruction({
          sponsor,
          protocol,
          ownerAuthority,
          custodianAuthority,
          owner: khunou as Address,
          custodian: kopano as Address,
          custodianClass: custodianClass as Address,
          lot: child as Address,
          root: lot as Address,
          intake,
          mint: childMint,
          position: khunouChild,
          vaultAuthority: khunouChildVault.vaultAuthority as Address,
          vault: khunouChildVault.vault as Address,
          quantityKg: 500_000n,
          collectionTicket: new Uint8Array(32).fill(2),
          expectedRevision: 0n,
          validUntil: BigInt(issuedAt + 3600),
        }),
        events: [
          bytesOf(getUnitsRedeemedEventEncoder(), {
            lot: child,
            owner: khunou,
            quantityKg: 500_000n,
            collectionTicket: new Uint8Array(32).fill(2),
            revision: 1n,
            lotRedeemed: false,
          }),
        ],
      }),
    ],
    accounts: Object.fromEntries([
      await lotAccount({
        lotId: CHILD_LOT_ID,
        supplyKg: 500_000n,
        revision: 1n,
        liveChildren: 0,
        parent: lot,
      }),
      await position({ lot: child, owner: khunou, quantityKg: 500_000n, revision: 1n }),
      [custodianClass, custodianClassAccount(4_500_000n)],
    ]),
  });

  // ---- builders for the malformed and extra cases ----
  const [facility, facilityBump] = await pda([
    text.encode("facility"),
    addressBytes.encode(protocol),
    new Uint8Array(16).fill(7),
  ]);
  const lender = org("lender-one");
  const facilityOpenedEvent = () =>
    bytesOf(getFacilityOpenedEventEncoder(), {
      facility,
      lender,
      borrower: khunou,
      currency: text.encode("ZAR"),
      currencyDecimals: 2,
      termsVersion: 1,
      rateBps: 1150,
      maxLtvBps: 6000,
    });

  const build: Builders = {
    transfer,
    position,
    lotAccount,
    organisationAccount,
    async pause(signature) {
      return thetisTransaction({
        signature,
        feePayer: deployer.address,
        name: "Pause",
        instruction: getPauseInstruction({ protocol, admin, flags: 0 }),
        events: [],
      });
    },
    async openFacility(signature) {
      const lenderSigner = await syntheticSigner(33);
      const [authority] = await findAuthorityPda({ protocol, wallet: lenderSigner.address });
      return thetisTransaction({
        signature,
        feePayer: deployer.address,
        name: "OpenFacility",
        systemCpi: true,
        instruction: getOpenFacilityInstruction({
          lender: lenderSigner,
          payer: deployer,
          protocol,
          authority,
          lenderOrg: lender as Address,
          borrowerOrg: khunou as Address,
          facility: facility as Address,
          facilityId: new Uint8Array(16).fill(7),
          currency: text.encode("ZAR"),
          currencyDecimals: 2,
          termsVersion: 1,
          rateBps: 1150,
          maxLtvBps: 6000,
          termsDigest: new Uint8Array(32).fill(9),
        }),
        events: [facilityOpenedEvent()],
      });
    },
    async facilityAccount() {
      return [
        facility,
        thetis(
          bytesOf(getFacilityEncoder(), {
            protocol,
            lender,
            borrower: khunou,
            facilityId: new Uint8Array(16).fill(7),
            currency: text.encode("ZAR"),
            currencyDecimals: 2,
            termsVersion: 1,
            rateBps: 1150,
            maxLtvBps: 6000,
            termsDigest: new Uint8Array(32).fill(9),
            loanCount: 0,
            bump: facilityBump,
          }),
        ),
      ];
    },
    facilityOpenedEvent,
    async foreignInitializeProtocol(signature) {
      const instanceId = text.encode("other-instance-1");
      const [foreign] = await findProtocolPda({ instanceId });
      const { getInitializeProtocolInstruction } = await import("@thetis/contracts");
      return thetisTransaction({
        signature,
        feePayer: deployer.address,
        name: "InitializeProtocol",
        systemCpi: true,
        instruction: getInitializeProtocolInstruction({
          protocol: foreign,
          admin,
          payer: deployer,
          instanceId,
          settlementMode: SettlementMode.FiatAttestationTest,
          adminArg: admin.address,
          accreditor: accreditor.address,
        }),
        events: [bytesOf(getProtocolInitializedEventEncoder(), { protocol: foreign })],
      });
    },
    async namesProgramOnly(signature) {
      return {
        signature,
        failed: false,
        feePayer: deployer.address,
        instructions: [
          {
            programAddress: SYSTEM_PROGRAM,
            accounts: [
              { address: deployer.address, role: AccountRole.WRITABLE_SIGNER },
              { address: PROGRAM, role: AccountRole.READONLY },
            ],
            data: new Uint8Array([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]),
          },
        ],
        inner: [],
        logs: otherProgramLogs(SYSTEM_PROGRAM),
      };
    },
    async failed(signature, data = new Uint8Array([255, 254, 253, 252, 251, 250, 249, 248])) {
      return {
        signature,
        failed: true,
        feePayer: deployer.address,
        instructions: [{ programAddress: PROGRAM, accounts: [], data }],
        inner: [],
        logs: [
          `Program ${PROGRAM} invoke [1]`,
          "Program log: AnchorError occurred. Error Code: InstructionFallbackNotFound.",
          `Program ${PROGRAM} failed: custom program error: 0x65`,
        ],
      };
    },
  };

  const fixture: Fixture = {
    protocol,
    classPolicy,
    organisations,
    org,
    custodianClass,
    intake,
    lot,
    child,
    mint,
    childMint,
    positions: { khunouParent, buyerParent, khunouChild },
    signers: { deployer, admin, accreditor, sponsor },
    seedSignatures: {
      deploy: deploy.signature,
      initializeProtocol: syntheticSignature(2),
      registerClass: syntheticSignature(3),
      accredit,
    },
    lotSignatures,
    seedOrganisationsRows: parties.map((party) => ({
      id: party.id,
      slug: party.slug,
      synthetic: true,
    })),
    build,
  };
  return { fixture, seed, lots };
}

function all() {
  built ??= buildAll();
  return built;
}

export async function fixture(): Promise<Fixture> {
  return (await all()).fixture;
}

/** The deploy and the nine seed transactions (a fresh copy each call). */
export async function seedHistory(): Promise<History> {
  return cloneHistory((await all()).seed);
}

/** seedHistory() followed by the five synthetic lot actions (a fresh copy each call). */
export async function lotHistory(): Promise<History> {
  const { seed, lots } = await all();
  return cloneHistory([...seed, ...lots]);
}

/** `public.organisations` as supabase/seed.sql inserts it (id, slug, synthetic). */
export async function seedOrganisations(): Promise<
  { id: string; slug: string; synthetic: boolean }[]
> {
  return (await fixture()).seedOrganisationsRows.map((row) => ({ ...row }));
}

// ------------------------------------------------------------------------------------------------
// The lending fixtures (live-lending.md §9.1 and its T063c folds)
// ------------------------------------------------------------------------------------------------
//
// SYNTHETIC: every amount below is the one live-lending.md §9.1 pins (demo.md §2: USD cents,
// 20 c/kg, haircut 0, LTV 60%, 1,200 bps). Digests, payment ids, wallets, signatures, slots and
// block times are byte fills and offsets (the T063c folds, item 6). Each account's data is the
// program's state after the action, worked out here from the handlers in programs/thetis, with
// interest from `accrueSimple` and the block times.

/** The steps a lending scenario is built from, in the order they are listed. */
export type LendingStep =
  | "accreditCustodianClass"
  | "issueLot"
  | "openFacility"
  | "setValuation"
  | "pledge"
  | "recordAdvance"
  | "createReleaseIntent"
  | "confirmRelease"
  | "sellPledged"
  | "confirmRepayment"
  | "repay"
  | "closeLoan"
  | "setValuation2"
  | "correctRepayment"
  | "voidRepayment"
  | "createReleaseIntent2"
  | "confirmRelease2"
  | "sellPledged2"
  | "deposit"
  | "borrow"
  | "repaySimulated"
  | "withdraw";

/** The 14 actions of `lendingHistory()`, in order. */
export const LENDING_STEPS: readonly LendingStep[] = [
  "accreditCustodianClass",
  "issueLot",
  "openFacility",
  "setValuation",
  "pledge",
  "recordAdvance",
  "createReleaseIntent",
  "confirmRelease",
  "sellPledged",
  "confirmRepayment",
  "repay",
  "closeLoan",
  "setValuation2",
  "correctRepayment",
];

/** The lending actions of `poolHistory()`, after the token-simulation seed. */
export const POOL_STEPS: readonly LendingStep[] = [
  "accreditCustodianClass",
  "issueLot",
  "openFacility",
  "setValuation",
  "deposit",
  "pledge",
  "borrow",
  "repaySimulated",
  "withdraw",
];

/** SYNTHETIC: one signature index per step (k from 200 for fiat, from 220 for the pool). */
const STEP_SIGNATURE: Record<LendingStep, number> = {
  accreditCustodianClass: 200,
  issueLot: 201,
  openFacility: 202,
  setValuation: 203,
  pledge: 204,
  recordAdvance: 205,
  createReleaseIntent: 206,
  confirmRelease: 207,
  sellPledged: 208,
  confirmRepayment: 209,
  repay: 210,
  closeLoan: 211,
  setValuation2: 212,
  correctRepayment: 213,
  voidRepayment: 214,
  createReleaseIntent2: 215,
  confirmRelease2: 216,
  sellPledged2: 217,
  deposit: 224,
  borrow: 226,
  repaySimulated: 227,
  withdraw: 228,
};
const POOL_SIGNATURE_OFFSET: Partial<Record<LendingStep, number>> = {
  accreditCustodianClass: 220,
  issueLot: 221,
  openFacility: 222,
  setValuation: 223,
  pledge: 225,
};

export type LendingScenario = {
  history: History;
  /** Where each step landed. */
  steps: Partial<Record<LendingStep, { signature: string; slot: number; blockTime: string }>>;
  protocol: string;
  org: (slug: string) => string;
  classPolicy: string;
  custodianClass: string;
  lot: string;
  facility: string;
  valuation: string;
  loan: string;
  lock: string;
  positions: { khunou: string; buyer: string };
  intents: string[];
  payments: { release: string; repayment: string; correction: string; release2: string };
  pool: string | null;
  share: string | null;
  /** The first signature of the history (THETIS_FIRST_SIGNATURE for its stream). */
  firstSignature: string;
};

type LoanState = {
  principal: bigint;
  bookedInterest: bigint;
  accrualRemainder: bigint;
  accruedAt: bigint;
  status: number;
  openExceptions: number;
  revision: bigint;
};

type PaymentState = {
  address: string;
  bump: number;
  paymentId: Uint8Array;
  purpose: number;
  subject: string;
  amount: bigint;
  evidenceDigest: Uint8Array;
  observedAt: bigint;
  status: number;
  applied: bigint;
  surplus: bigint;
};

const LENDING_LOT_ID = "CR-0001";
const fill = (length: number, byte: number) => new Uint8Array(length).fill(byte);
const unix = (iso: string) => BigInt(Date.parse(iso) / 1000);

function applyPayment(principal: bigint, interestNow: bigint, received: bigint) {
  const debt = principal + interestNow;
  const applied = debt < received ? debt : received;
  const fromInterest = applied < interestNow ? applied : interestNow;
  const fromPrincipal = applied - fromInterest;
  return {
    applied,
    fromInterest,
    fromPrincipal,
    surplus: received - applied,
    principal: principal - fromPrincipal,
    bookedInterest: interestNow - fromInterest,
  };
}

async function lendingScenario(
  mode: "fiat" | "pool",
  stepList: readonly LendingStep[],
): Promise<LendingScenario> {
  const f = await fixture();
  const simulation = mode === "pool";
  const instance = simulation ? SIMULATION_INSTANCE : DEFAULT_INSTANCE;
  const [protocol] = await findProtocolPda({ instanceId: instanceIdBytes(instance) });
  const classPolicy = await findClassPolicyPda(protocol, SEED.classCode, SEED.classVersion);
  const orgs = new Map<string, { address: string; bump: number }>();
  for (const party of f.organisations) {
    const [address, bump] = await findOrganisationPda({ protocol, orgId: party.orgId });
    orgs.set(party.slug, { address, bump });
  }
  const org = (slug: string) => {
    const found = orgs.get(slug);
    if (!found) throw new Error(`no organisation ${slug}`);
    return found.address;
  };
  const kopano = org("kopano");
  const khunou = org("khunou");
  const buyer = org("buyer-smelter");
  const lenderOrg = org("lender-one");
  const { deployer, accreditor, sponsor } = f.signers;
  const lenderWallet = await syntheticSigner(40);
  const borrowerWallet = await syntheticSigner(41);
  const buyerWallet = await syntheticSigner(42);
  const custodianWallet = await syntheticSigner(43);
  const depositorWallet = await syntheticSigner(44);
  const authorityOf = async (wallet: KeyPairSigner) =>
    (await findAuthorityPda({ protocol, wallet: wallet.address }))[0];
  const lenderAuthority = await authorityOf(lenderWallet);
  const borrowerAuthority = await authorityOf(borrowerWallet);
  const buyerAuthority = await authorityOf(buyerWallet);
  const custodianAuthority = await authorityOf(custodianWallet);
  const depositorAuthority = await authorityOf(depositorWallet);

  const [custodianClass, custodianClassBump] = await pda([
    text.encode("custodian_class"),
    addressBytes.encode(protocol),
    addressBytes.encode(kopano as Address),
    addressBytes.encode(classPolicy),
    text.encode(SITE_CODE),
  ]);
  const intakeDigest = fill(32, 0x01);
  const [intake, intakeBump] = await findIntakePda({
    protocol,
    custodian: kopano as Address,
    intakeDigest,
  });
  const [lot, lotBump] = await lotPda(protocol, LENDING_LOT_ID);
  const [mint] = await findMintPda({ lot: lot as Address });
  const [mintAuthority] = await findMintAuthorityPda({ mint });
  const [khunouPosition, khunouPositionBump] = await findPositionPda({
    lot: lot as Address,
    owner: khunou as Address,
  });
  const [buyerPosition, buyerPositionBump] = await findPositionPda({
    lot: lot as Address,
    owner: buyer as Address,
  });
  const vaultOf = async (position: string) => {
    const [vaultAuthority] = await findVaultAuthorityPda({ position: position as Address });
    const [vault] = await pda(
      [
        addressBytes.encode(vaultAuthority),
        addressBytes.encode(TOKEN_2022 as Address),
        addressBytes.encode(mint),
      ],
      ASSOCIATED_TOKEN,
    );
    return { vaultAuthority, vault: vault as Address };
  };
  const khunouVault = await vaultOf(khunouPosition);
  const buyerVault = await vaultOf(buyerPosition);

  const facilityId = fill(16, simulation ? 0x12 : 0x11);
  const [facility, facilityBump] = await findFacilityPda({
    protocol,
    lenderOrg: lenderOrg as Address,
    facilityId,
  });
  const [valuation, valuationBump] = await pda([
    text.encode("valuation"),
    addressBytes.encode(facility),
    addressBytes.encode(classPolicy),
    text.encode("G1"),
    addressBytes.encode(custodianClass as Address),
  ]);
  const [loan, loanBump] = await findLoanPda({ facility, loanIndex: 0 });
  const [lock, lockBump] = await findLockPda({ loan });
  const usd = text.encode("USD");

  const poolMint = (await syntheticSigner(34)).address;
  const { pool, poolAuthority, vault: poolVault } = await derivePoolAddresses(protocol, poolMint);
  const [, poolBump] = await findPoolPda({ protocol });
  const [share, shareBump] = await findSharePda({ pool, depositorOrg: lenderOrg as Address });
  const depositorToken = await findAssociatedTokenAddress(depositorWallet.address, poolMint);
  const destination = await findAssociatedTokenAddress(borrowerWallet.address, poolMint);

  async function paymentState(
    paymentId: Uint8Array,
    purpose: number,
    subject: string,
    amount: bigint,
    evidenceDigest: Uint8Array,
    observedAt: bigint,
  ): Promise<PaymentState> {
    const [address, bump] = await findPaymentPda({
      protocol,
      lenderOrg: lenderOrg as Address,
      paymentId,
    });
    return {
      address,
      bump,
      paymentId,
      purpose,
      subject,
      amount,
      evidenceDigest,
      observedAt,
      status:
        purpose === PaymentPurpose.Correction ? PaymentStatus.Consumed : PaymentStatus.Unconsumed,
      applied: 0n,
      surplus: 0n,
    };
  }

  // ---- the chain state the steps change ----
  const state = {
    occupiedKg: 0n,
    lotRevision: 0n,
    khunou: { quantityKg: 0n, lockedKg: 0n, revision: 0n },
    buyer: null as { quantityKg: bigint; revision: bigint } | null,
    loanCount: 0,
    valuationVersion: 0,
    valuationSetAt: 0n,
    valuationSource: fill(32, 0),
    loan: null as LoanState | null,
    lockKg: 0n,
    lockControl: LockControl.Pledged,
    intents: [] as {
      address: string;
      bump: number;
      nonce: bigint;
      quantityKg: bigint;
      price: bigint;
      expiresAt: bigint;
      positionRevision: bigint;
      status: number;
    }[],
    payments: new Map<string, PaymentState>(),
    pool: { cashMinor: 0n, totalShares: 0n, lentMinor: 0n, incomeMinor: 0n, revision: 0n },
    share: null as { shares: bigint; lentMinor: bigint } | null,
  };

  const enc = {
    custodianClass: () =>
      thetis(
        bytesOf(getCustodianClassEncoder(), {
          protocol,
          custodian: kopano,
          classPolicy,
          siteCode: SITE_CODE,
          approvedCapacityKg: CAPACITY_KG,
          occupiedKg: state.occupiedKg,
          reservedInboundKg: 0n,
          bump: custodianClassBump,
        }),
      ),
    lot: (issuedAt: bigint) =>
      thetis(
        bytesOf(getLotEncoder(), {
          protocol,
          lotId: LENDING_LOT_ID,
          classPolicy,
          classVersion: SEED.classVersion,
          grade: "G1",
          custodianClass,
          intake,
          parent: none(),
          root: lot,
          mint,
          supplyKg: 5_000_000n,
          state: LotState.Stored,
          restriction: Restriction.Normal,
          expiresAt: issuedAt + SEED.lotValiditySecs,
          revision: state.lotRevision,
          liveChildren: 0,
          bump: lotBump,
        }),
      ),
    khunouPosition: () =>
      thetis(
        bytesOf(getPositionEncoder(), {
          protocol,
          lot,
          owner: khunou,
          quantityKg: state.khunou.quantityKg,
          lockedKg: state.khunou.lockedKg,
          reservedKg: 0n,
          revision: state.khunou.revision,
          bump: khunouPositionBump,
        }),
      ),
    buyerPosition: () =>
      thetis(
        bytesOf(getPositionEncoder(), {
          protocol,
          lot,
          owner: buyer,
          quantityKg: state.buyer?.quantityKg ?? 0n,
          lockedKg: 0n,
          reservedKg: 0n,
          revision: state.buyer?.revision ?? 0n,
          bump: buyerPositionBump,
        }),
      ),
    facility: () =>
      thetis(
        bytesOf(getFacilityEncoder(), {
          protocol,
          lender: lenderOrg,
          borrower: khunou,
          facilityId,
          currency: usd,
          currencyDecimals: 2,
          termsVersion: 1,
          rateBps: 1200,
          maxLtvBps: 6000,
          termsDigest: fill(32, 0x21),
          loanCount: state.loanCount,
          bump: facilityBump,
        }),
      ),
    valuation: () =>
      thetis(
        bytesOf(getValuationEncoder(), {
          protocol,
          facility,
          classPolicy,
          grade: "G1",
          custodianClass,
          valuePerKg: 20n,
          haircutBps: 0,
          validUntil: state.valuationSetAt + 30n * 86_400n,
          sourceDigest: state.valuationSource,
          version: state.valuationVersion,
          setAt: state.valuationSetAt,
          bump: valuationBump,
        }),
      ),
    loan: () => {
      const current = state.loan as LoanState;
      return thetis(
        bytesOf(getLoanEncoder(), {
          protocol,
          facility,
          borrower: khunou,
          lot,
          position: khunouPosition,
          index: 0,
          status: current.status,
          rateBps: 1200,
          termsVersion: 1,
          principal: current.principal,
          bookedInterest: current.bookedInterest,
          accrualRemainder: current.accrualRemainder,
          accruedAt: current.accruedAt,
          openExceptions: current.openExceptions,
          revision: current.revision,
          bump: loanBump,
        }),
      );
    },
    lock: () =>
      thetis(
        bytesOf(getLockAllocationEncoder(), {
          protocol,
          loan,
          position: khunouPosition,
          quantityKg: state.lockKg,
          control: state.lockControl,
          bump: lockBump,
        }),
      ),
    payment: (payment: PaymentState) =>
      thetis(
        bytesOf(getPaymentAttestationEncoder(), {
          protocol,
          lender: lenderOrg,
          loan,
          paymentId: payment.paymentId,
          purpose: payment.purpose,
          subject: payment.subject,
          amount: payment.amount,
          currency: usd,
          evidenceDigest: payment.evidenceDigest,
          observedAt: payment.observedAt,
          status: payment.status,
          applied: payment.applied,
          surplus: payment.surplus,
          bump: payment.bump,
        }),
      ),
    intent: (intent: (typeof state.intents)[number]) =>
      thetis(
        bytesOf(getReleaseIntentEncoder(), {
          protocol,
          loan,
          lot,
          position: khunouPosition,
          seller: khunou,
          buyer,
          nonce: intent.nonce,
          quantityKg: intent.quantityKg,
          price: intent.price,
          topUp: 0n,
          currency: usd,
          expiresAt: intent.expiresAt,
          positionRevision: intent.positionRevision,
          status: intent.status,
          bump: intent.bump,
        }),
      ),
    pool: () =>
      thetis(
        bytesOf(getSimulationPoolEncoder(), {
          protocol,
          mint: poolMint,
          vault: poolVault,
          currency: usd,
          currencyDecimals: 2,
          ...state.pool,
          bump: poolBump,
        }),
      ),
    share: () =>
      thetis(
        bytesOf(getPoolShareEncoder(), {
          pool,
          organisation: lenderOrg,
          shares: state.share?.shares ?? 0n,
          lentMinor: state.share?.lentMinor ?? 0n,
          bump: shareBump,
        }),
      ),
  };

  const accrue = (current: LoanState, now: bigint) => {
    const { interest, remainder } = accrueSimple({
      principal: current.principal,
      rateBps: 1200n,
      elapsedSeconds: now - current.accruedAt,
      carriedRemainder: current.accrualRemainder,
    });
    return {
      bookedInterest: current.bookedInterest + interest,
      accrualRemainder: remainder,
      accruedAt: now,
    };
  };
  const loanState = () => {
    if (!state.loan) throw new Error("the scenario has no loan yet");
    return state.loan;
  };
  const tx = (
    signature: string,
    name: string,
    instruction: Instruction,
    event: Uint8Array,
    systemCpi = false,
  ) =>
    thetisTransaction({
      signature,
      feePayer: sponsor.address,
      name,
      instruction,
      events: [event],
      systemCpi,
    });
  const confirm = async (
    signature: string,
    now: bigint,
    payment: PaymentState,
    target: PaymentState | null,
    event: Uint8Array,
  ) =>
    tx(
      signature,
      "ConfirmPayment",
      getConfirmPaymentInstruction({
        lender: lenderWallet,
        payer: sponsor,
        protocol,
        authority: lenderAuthority,
        lenderOrg: lenderOrg as Address,
        facility,
        loan,
        subject: payment.subject as Address,
        ...(target ? { target: target.address as Address } : {}),
        payment: payment.address as Address,
        paymentId: payment.paymentId,
        purpose: payment.purpose,
        amount: payment.amount,
        currency: usd,
        evidenceDigest: payment.evidenceDigest,
        observedAt: now,
      }),
      event,
      true,
    );
  const correction = async (signature: string, now: bigint, id: number, voided: boolean) => {
    const target = state.payments.get("repayment") as PaymentState;
    const current = loanState();
    const made = await paymentState(
      fill(32, id),
      PaymentPurpose.Correction,
      target.address,
      0n,
      fill(32, id + 0x10),
      now,
    );
    state.payments.set(voided ? "voided" : "correction", made);
    if (voided) target.status = PaymentStatus.Voided;
    else {
      current.openExceptions += 1;
      current.revision += 1n;
    }
    const accounts: Record<string, AccountState> = {
      [made.address]: enc.payment(made),
      [target.address]: enc.payment(target),
      [loan]: enc.loan(),
    };
    return {
      tx: await confirm(
        signature,
        now,
        made,
        target,
        bytesOf(getPaymentCorrectedEventEncoder(), {
          payment: made.address,
          target: target.address,
          loan,
          voided,
          openExceptions: current.openExceptions,
          loanRevision: current.revision,
        }),
      ),
      accounts,
    };
  };
  const intentStep = async (
    signature: string,
    now: bigint,
    nonce: bigint,
    quantityKg: bigint,
    price: bigint,
  ) => {
    const [address, bump] = await findIntentPda({ loan, nonce });
    const intent = {
      address,
      bump,
      nonce,
      quantityKg,
      price,
      expiresAt: now + 86_400n,
      positionRevision: state.khunou.revision,
      status: IntentStatus.Open,
    };
    state.intents.push(intent);
    return {
      tx: tx(
        signature,
        "CreateReleaseIntent",
        getCreateReleaseIntentInstruction({
          sponsor,
          protocol,
          sellerOrg: khunou as Address,
          sellerAuthority: borrowerAuthority,
          buyerOrg: buyer as Address,
          lenderOrg: lenderOrg as Address,
          facility,
          loan,
          lock,
          lot: lot as Address,
          position: khunouPosition,
          intent: address,
          nonce,
          quantityKg,
          price,
          topUp: 0n,
          expiresAt: intent.expiresAt,
          expectedRevision: state.khunou.revision,
          validUntil: now + 270n,
        }),
        bytesOf(getReleaseIntentCreatedEventEncoder(), {
          intent: address,
          loan,
          seller: khunou,
          buyer,
          quantityKg,
          price,
          topUp: 0n,
          expiresAt: intent.expiresAt,
        }),
        true,
      ),
      accounts: { [address]: enc.intent(intent) },
    };
  };
  const releaseStep = async (signature: string, now: bigint, key: string, id: number) => {
    const intent = state.intents.at(-1) as (typeof state.intents)[number];
    const payment = await paymentState(
      fill(32, id),
      PaymentPurpose.Release,
      intent.address,
      intent.price,
      fill(32, id + 0x10),
      now,
    );
    state.payments.set(key, payment);
    return {
      tx: await confirm(
        signature,
        now,
        payment,
        null,
        bytesOf(getPaymentConfirmedEventEncoder(), {
          payment: payment.address,
          loan,
          purpose: payment.purpose,
          subject: payment.subject,
          amount: payment.amount,
          currency: usd,
        }),
      ),
      accounts: { [payment.address]: enc.payment(payment) },
    };
  };
  const saleStep = async (signature: string, now: bigint, key: string) => {
    const intent = state.intents.at(-1) as (typeof state.intents)[number];
    const payment = state.payments.get(key) as PaymentState;
    const current = loanState();
    const accrual = accrue(current, now);
    const application = applyPayment(current.principal, accrual.bookedInterest, payment.amount);
    const expectedRevision = state.khunou.revision;
    Object.assign(current, {
      bookedInterest: application.bookedInterest,
      accrualRemainder: accrual.accrualRemainder,
      accruedAt: now,
      principal: application.principal,
      revision: current.revision + 1n,
    });
    state.lockKg -= intent.quantityKg;
    state.khunou.quantityKg -= intent.quantityKg;
    state.khunou.lockedKg -= intent.quantityKg;
    state.khunou.revision += 1n;
    state.buyer = state.buyer
      ? {
          quantityKg: state.buyer.quantityKg + intent.quantityKg,
          revision: state.buyer.revision + 1n,
        }
      : { quantityKg: intent.quantityKg, revision: 0n };
    state.lotRevision += 1n;
    intent.status = IntentStatus.Executed;
    payment.status = PaymentStatus.Consumed;
    payment.applied = application.applied;
    payment.surplus = application.surplus;
    return {
      tx: tx(
        signature,
        "SellPledged",
        getSellPledgedInstruction({
          sponsor,
          protocol,
          facility,
          lenderOrg: lenderOrg as Address,
          loan,
          lock,
          valuation: valuation as Address,
          intent: intent.address as Address,
          payment: payment.address as Address,
          lot: lot as Address,
          mint,
          sellerOrg: khunou as Address,
          buyerOrg: buyer as Address,
          buyerAuthority,
          sellerPosition: khunouPosition,
          sellerVaultAuthority: khunouVault.vaultAuthority,
          sellerVault: khunouVault.vault,
          buyerPosition,
          buyerVaultAuthority: buyerVault.vaultAuthority,
          buyerVault: buyerVault.vault,
          expectedRevision,
          validUntil: now + 270n,
        }),
        bytesOf(getPledgedSoldEventEncoder(), {
          intent: intent.address,
          loan,
          payment: payment.address,
          lot,
          sellerPosition: khunouPosition,
          buyerPosition,
          quantityKg: intent.quantityKg,
          applied: application.applied,
          surplus: application.surplus,
          principal: application.principal,
          bookedInterest: application.bookedInterest,
          lotRevision: state.lotRevision,
          revision: current.revision,
        }),
        true,
      ),
      accounts: {
        [loan]: enc.loan(),
        [lock]: enc.lock(),
        [khunouPosition]: enc.khunouPosition(),
        [buyerPosition]: enc.buyerPosition(),
        [lot]: enc.lot(issuedAt),
        [intent.address]: enc.intent(intent),
        [payment.address]: enc.payment(payment),
      },
    };
  };
  const setValuationStep = (signature: string, now: bigint, source: number) => {
    state.valuationVersion += 1;
    state.valuationSetAt = now;
    state.valuationSource = fill(32, source);
    return {
      tx: tx(
        signature,
        "SetValuation",
        getSetValuationInstruction({
          lender: lenderWallet,
          payer: sponsor,
          protocol,
          authority: lenderAuthority,
          lenderOrg: lenderOrg as Address,
          facility,
          classPolicy,
          custodianClass: custodianClass as Address,
          valuation: valuation as Address,
          grade: "G1",
          valuePerKg: 20n,
          haircutBps: 0,
          validUntil: now + 30n * 86_400n,
          sourceDigest: state.valuationSource,
        }),
        bytesOf(getValuationSetEventEncoder(), {
          valuation,
          facility,
          version: state.valuationVersion,
          valuePerKg: 20n,
          haircutBps: 0,
          validUntil: now + 30n * 86_400n,
          sourceDigest: state.valuationSource,
          setAt: now,
        }),
        state.valuationVersion === 1,
      ),
      accounts: { [valuation]: enc.valuation() },
    };
  };

  let issuedAt = 0n;
  const steps: LendingScenario["steps"] = {};
  const history: History = [];
  const start = simulation ? 41_000 : 21_000;
  const firstTime = Date.parse(simulation ? "2026-11-27T12:00:00Z" : "2026-11-27T00:00:00Z");
  for (const [index, step] of stepList.entries()) {
    const slot = start + index * 1000;
    const blockTime = new Date(firstTime + index * 1000).toISOString();
    const now = unix(blockTime);
    const signature = syntheticSignature(
      simulation ? (POOL_SIGNATURE_OFFSET[step] ?? STEP_SIGNATURE[step]) : STEP_SIGNATURE[step],
    );
    steps[step] = { signature, slot, blockTime };
    let made: { tx: FakeTransaction; accounts: Record<string, AccountState> };
    switch (step) {
      case "accreditCustodianClass":
        made = {
          tx: thetisTransaction({
            signature,
            feePayer: deployer.address,
            name: "AccreditCustodianClass",
            systemCpi: true,
            instruction: getAccreditCustodianClassInstruction({
              protocol,
              custodian: kopano as Address,
              classPolicy,
              custodianClass: custodianClass as Address,
              accreditor,
              payer: deployer,
              siteCode: SITE_CODE,
              approvedCapacityKg: CAPACITY_KG,
            }),
            events: [
              bytesOf(getCustodianClassAccreditedEventEncoder(), {
                custodianClass,
                approvedCapacityKg: CAPACITY_KG,
              }),
            ],
          }),
          accounts: { [custodianClass]: enc.custodianClass() },
        };
        break;
      case "issueLot":
        issuedAt = now;
        state.occupiedKg = 5_000_000n;
        state.khunou = { quantityKg: 5_000_000n, lockedKg: 0n, revision: 0n };
        made = {
          tx: tx(
            signature,
            "IssueLot",
            getIssueLotInstruction({
              sponsor,
              protocol,
              authority: custodianAuthority,
              owner: khunou as Address,
              custodian: kopano as Address,
              classPolicy,
              custodianClass: custodianClass as Address,
              intake,
              lot: lot as Address,
              mint,
              mintAuthority,
              position: khunouPosition,
              vaultAuthority: khunouVault.vaultAuthority,
              vault: khunouVault.vault,
              lotId: LENDING_LOT_ID,
              grade: "G1",
              quantityKg: 5_000_000n,
              intakeDigest,
              validUntil: now + 270n,
            }),
            bytesOf(getLotIssuedEventEncoder(), {
              lot,
              owner: khunou,
              quantityKg: 5_000_000n,
              intake,
              revision: 0n,
            }),
            true,
          ),
          accounts: {
            [lot]: enc.lot(issuedAt),
            [intake]: thetis(
              bytesOf(getIntakeIdentityEncoder(), {
                protocol,
                custodian: kopano,
                intakeDigest,
                lot,
                retired: false,
                bump: intakeBump,
              }),
            ),
            [khunouPosition]: enc.khunouPosition(),
            [custodianClass]: enc.custodianClass(),
          },
        };
        break;
      case "openFacility":
        made = {
          tx: tx(
            signature,
            "OpenFacility",
            getOpenFacilityInstruction({
              lender: lenderWallet,
              payer: sponsor,
              protocol,
              authority: lenderAuthority,
              lenderOrg: lenderOrg as Address,
              borrowerOrg: khunou as Address,
              facility,
              ...(simulation ? { pool } : {}),
              facilityId,
              currency: usd,
              currencyDecimals: 2,
              termsVersion: 1,
              rateBps: 1200,
              maxLtvBps: 6000,
              termsDigest: fill(32, 0x21),
            }),
            bytesOf(getFacilityOpenedEventEncoder(), {
              facility,
              lender: lenderOrg,
              borrower: khunou,
              currency: usd,
              currencyDecimals: 2,
              termsVersion: 1,
              rateBps: 1200,
              maxLtvBps: 6000,
            }),
            true,
          ),
          accounts: { [facility]: enc.facility() },
        };
        break;
      case "setValuation":
        made = setValuationStep(signature, now, 0x22);
        break;
      case "setValuation2":
        made = setValuationStep(signature, now, 0x23);
        break;
      case "pledge": {
        const expectedRevision = state.khunou.revision;
        state.loanCount = 1;
        state.khunou.lockedKg = 5_000_000n;
        state.khunou.revision += 1n;
        state.loan = {
          principal: 0n,
          bookedInterest: 0n,
          accrualRemainder: 0n,
          accruedAt: now,
          status: LoanStatus.Active,
          openExceptions: 0,
          revision: 0n,
        };
        state.lockKg = 5_000_000n;
        made = {
          tx: tx(
            signature,
            "Pledge",
            getPledgeInstruction({
              sponsor,
              protocol,
              lot: lot as Address,
              position: khunouPosition,
              borrowerOrg: khunou as Address,
              borrowerAuthority,
              lenderOrg: lenderOrg as Address,
              lenderAuthority,
              facility,
              loan,
              lock,
              loanIndex: 0,
              quantityKg: 5_000_000n,
              expectedRevision,
              validUntil: now + 270n,
            }),
            bytesOf(getPledgedEventEncoder(), {
              loan,
              lock,
              position: khunouPosition,
              lot,
              quantityKg: 5_000_000n,
              positionRevision: state.khunou.revision,
              revision: 0n,
            }),
            true,
          ),
          accounts: {
            [loan]: enc.loan(),
            [lock]: enc.lock(),
            [khunouPosition]: enc.khunouPosition(),
            [facility]: enc.facility(),
          },
        };
        break;
      }
      case "recordAdvance": {
        const current = loanState();
        const expectedRevision = current.revision;
        Object.assign(current, accrue(current, now));
        current.principal += 60_000_000n;
        current.revision += 1n;
        made = {
          tx: tx(
            signature,
            "RecordAdvance",
            getRecordAdvanceInstruction({
              lender: lenderWallet,
              protocol,
              lenderAuthority,
              lenderOrg: lenderOrg as Address,
              facility,
              loan,
              lock,
              lot: lot as Address,
              valuation: valuation as Address,
              borrowerOrg: khunou as Address,
              borrowerAuthority,
              amount: 60_000_000n,
              currency: usd,
              expectedRevision,
              validUntil: now + 270n,
            }),
            bytesOf(getAdvanceRecordedEventEncoder(), {
              loan,
              amount: 60_000_000n,
              principal: current.principal,
              bookedInterest: current.bookedInterest,
              revision: current.revision,
            }),
          ),
          accounts: { [loan]: enc.loan() },
        };
        break;
      }
      case "createReleaseIntent":
        made = await intentStep(signature, now, 1n, 2_000_000n, 40_000_000n);
        break;
      case "createReleaseIntent2":
        made = await intentStep(signature, now, 2n, 1_000_000n, 10_000_000n);
        break;
      case "confirmRelease":
        made = await releaseStep(signature, now, "release", 0x31);
        break;
      case "confirmRelease2":
        made = await releaseStep(signature, now, "release2", 0x34);
        break;
      case "sellPledged":
        made = await saleStep(signature, now, "release");
        break;
      case "sellPledged2":
        made = await saleStep(signature, now, "release2");
        break;
      case "confirmRepayment": {
        const payment = await paymentState(
          fill(32, 0x32),
          PaymentPurpose.Repayment,
          loan,
          21_000_000n,
          fill(32, 0x42),
          now,
        );
        state.payments.set("repayment", payment);
        made = {
          tx: await confirm(
            signature,
            now,
            payment,
            null,
            bytesOf(getPaymentConfirmedEventEncoder(), {
              payment: payment.address,
              loan,
              purpose: payment.purpose,
              subject: payment.subject,
              amount: payment.amount,
              currency: usd,
            }),
          ),
          accounts: { [payment.address]: enc.payment(payment) },
        };
        break;
      }
      case "repay": {
        const payment = state.payments.get("repayment") as PaymentState;
        const current = loanState();
        const accrual = accrue(current, now);
        const application = applyPayment(current.principal, accrual.bookedInterest, payment.amount);
        Object.assign(current, {
          bookedInterest: application.bookedInterest,
          accrualRemainder: accrual.accrualRemainder,
          accruedAt: now,
          principal: application.principal,
          revision: current.revision + 1n,
        });
        payment.status = PaymentStatus.Consumed;
        payment.applied = application.applied;
        payment.surplus = application.surplus;
        made = {
          tx: tx(
            signature,
            "Repay",
            getRepayInstruction({
              signer: lenderWallet,
              protocol,
              facility,
              loan,
              authority: lenderAuthority,
              lenderOrg: lenderOrg as Address,
              payment: payment.address as Address,
              amount: payment.amount,
            }),
            bytesOf(getRepaidEventEncoder(), {
              loan,
              payment: some(payment.address),
              pool: none(),
              poolRevision: none(),
              applied: application.applied,
              fromInterest: application.fromInterest,
              fromPrincipal: application.fromPrincipal,
              surplus: application.surplus,
              principal: application.principal,
              bookedInterest: application.bookedInterest,
              revision: current.revision,
            }),
          ),
          accounts: { [loan]: enc.loan(), [payment.address]: enc.payment(payment) },
        };
        break;
      }
      case "closeLoan": {
        const current = loanState();
        const expectedRevision = current.revision;
        Object.assign(current, accrue(current, now));
        if (current.principal + current.bookedInterest !== 0n) {
          throw new Error("the scenario closes a loan that still has debt");
        }
        current.status = LoanStatus.Closed;
        current.revision += 1n;
        const released = state.lockKg;
        state.khunou.lockedKg -= released;
        state.khunou.revision += 1n;
        state.lockKg = 0n;
        made = {
          tx: tx(
            signature,
            "CloseLoan",
            getCloseLoanInstruction({
              lender: lenderWallet,
              protocol,
              authority: lenderAuthority,
              lenderOrg: lenderOrg as Address,
              facility,
              loan,
              lock,
              position: khunouPosition,
              expectedRevision,
            }),
            bytesOf(getLoanClosedEventEncoder(), {
              loan,
              position: khunouPosition,
              releasedKg: released,
              revision: current.revision,
            }),
          ),
          accounts: {
            [loan]: enc.loan(),
            [lock]: enc.lock(),
            [khunouPosition]: enc.khunouPosition(),
          },
        };
        break;
      }
      case "correctRepayment":
        made = await correction(signature, now, 0x33, false);
        break;
      case "voidRepayment":
        made = await correction(signature, now, 0x35, true);
        break;
      case "deposit": {
        const first = state.share === null;
        state.share = {
          shares: (state.share?.shares ?? 0n) + 60_000_000n,
          lentMinor: state.share?.lentMinor ?? 0n,
        };
        state.pool.cashMinor += 60_000_000n;
        state.pool.totalShares += 60_000_000n;
        state.pool.revision += 1n;
        made = {
          tx: thetisTransaction({
            signature,
            feePayer: sponsor.address,
            name: "Deposit",
            systemCpi: first,
            instruction: getDepositInstruction({
              depositor: depositorWallet,
              payer: sponsor,
              protocol,
              authority: depositorAuthority,
              depositorOrg: lenderOrg as Address,
              pool,
              share,
              depositorToken,
              poolVault,
              mint: poolMint,
              amount: 60_000_000n,
            }),
            events: [
              bytesOf(getDepositedEventEncoder(), {
                pool,
                organisation: lenderOrg,
                wallet: depositorWallet.address,
                amount: 60_000_000n,
                shares: state.share.shares,
                poolRevision: state.pool.revision,
              }),
            ],
          }),
          accounts: { [pool]: enc.pool(), [share]: enc.share() },
        };
        break;
      }
      case "borrow": {
        const current = loanState();
        const expectedRevision = current.revision;
        Object.assign(current, accrue(current, now));
        current.principal += 40_000_000n;
        current.revision += 1n;
        state.pool.cashMinor -= 40_000_000n;
        state.pool.lentMinor += 40_000_000n;
        state.pool.revision += 1n;
        const held = state.share as { shares: bigint; lentMinor: bigint };
        held.lentMinor += 40_000_000n;
        made = {
          tx: tx(
            signature,
            "Borrow",
            getBorrowInstruction({
              sponsor,
              protocol,
              borrowerOrg: khunou as Address,
              borrowerAuthority,
              lenderOrg: lenderOrg as Address,
              facility,
              loan,
              lock,
              lot: lot as Address,
              valuation: valuation as Address,
              pool,
              lenderShare: share,
              poolAuthority,
              poolVault,
              mint: poolMint,
              destination,
              amount: 40_000_000n,
              expectedRevision,
              validUntil: now + 270n,
            }),
            bytesOf(getBorrowedEventEncoder(), {
              loan,
              pool,
              amount: 40_000_000n,
              principal: current.principal,
              bookedInterest: current.bookedInterest,
              revision: current.revision,
              poolRevision: state.pool.revision,
            }),
          ),
          accounts: { [loan]: enc.loan(), [pool]: enc.pool(), [share]: enc.share() },
        };
        break;
      }
      case "repaySimulated": {
        const current = loanState();
        const accrual = accrue(current, now);
        const application = applyPayment(current.principal, accrual.bookedInterest, 10_000_000n);
        Object.assign(current, {
          bookedInterest: application.bookedInterest,
          accrualRemainder: accrual.accrualRemainder,
          accruedAt: now,
          principal: application.principal,
          revision: current.revision + 1n,
        });
        state.pool.cashMinor += application.applied;
        state.pool.lentMinor -= application.fromPrincipal;
        state.pool.incomeMinor += application.fromInterest;
        state.pool.revision += 1n;
        const held = state.share as { shares: bigint; lentMinor: bigint };
        held.lentMinor -= application.fromPrincipal;
        const instruction = getRepayInstruction({
          signer: borrowerWallet,
          protocol,
          facility,
          loan,
          pool,
          poolAuthority,
          poolVault,
          payerToken: destination,
          mint: poolMint,
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
          amount: 10_000_000n,
        });
        made = {
          tx: tx(
            signature,
            "Repay",
            {
              ...instruction,
              accounts: [...instruction.accounts, { address: share, role: AccountRole.WRITABLE }],
            } as Instruction,
            bytesOf(getRepaidEventEncoder(), {
              loan,
              payment: none(),
              pool: some(pool),
              poolRevision: some(state.pool.revision),
              applied: application.applied,
              fromInterest: application.fromInterest,
              fromPrincipal: application.fromPrincipal,
              surplus: 0n,
              principal: application.principal,
              bookedInterest: application.bookedInterest,
              revision: current.revision,
            }),
          ),
          accounts: { [loan]: enc.loan(), [pool]: enc.pool(), [share]: enc.share() },
        };
        break;
      }
      case "withdraw": {
        const held = state.share as { shares: bigint; lentMinor: bigint };
        held.shares -= 10_000_000n;
        state.pool.cashMinor -= 10_000_000n;
        state.pool.totalShares -= 10_000_000n;
        state.pool.revision += 1n;
        made = {
          tx: tx(
            signature,
            "Withdraw",
            getWithdrawInstruction({
              depositor: depositorWallet,
              protocol,
              authority: depositorAuthority,
              depositorOrg: lenderOrg as Address,
              pool,
              share,
              depositorToken,
              poolAuthority,
              poolVault,
              mint: poolMint,
              amount: 10_000_000n,
            }),
            bytesOf(getWithdrawnEventEncoder(), {
              pool,
              organisation: lenderOrg,
              wallet: depositorWallet.address,
              amount: 10_000_000n,
              shares: held.shares,
              poolRevision: state.pool.revision,
            }),
          ),
          accounts: { [pool]: enc.pool(), [share]: enc.share() },
        };
        break;
      }
    }
    history.push({ slot, blockTime, transactions: [made.tx], accounts: made.accounts });
  }

  let base: History;
  let firstSignature: string;
  if (simulation) {
    const { simulationSeed } = await import("./instances.ts");
    base = await simulationSeed();
    firstSignature = syntheticSignature(180);
  } else {
    base = (await all()).seed;
    firstSignature = f.seedSignatures.deploy;
  }
  const payments = state.payments;
  const addressOf = (key: string) => payments.get(key)?.address ?? "";
  return {
    history: cloneHistory([...base, ...history]),
    steps,
    protocol,
    org,
    classPolicy,
    custodianClass,
    lot,
    facility,
    valuation,
    loan,
    lock,
    positions: { khunou: khunouPosition, buyer: buyerPosition },
    intents: state.intents.map((intent) => intent.address),
    payments: {
      release: addressOf("release"),
      repayment: addressOf("repayment"),
      correction: addressOf(stepList.includes("voidRepayment") ? "voided" : "correction"),
      release2: addressOf("release2"),
    },
    pool: simulation ? pool : null,
    share: simulation ? share : null,
    firstSignature,
  };
}

/**
 * seedHistory() followed by the 14 lending actions of live-lending.md §9.1, or by `steps` when
 * given (the variants the lending tests need). One transaction per slot from 21,000.
 */
export async function lendingHistory(
  steps: readonly LendingStep[] = LENDING_STEPS,
): Promise<LendingScenario> {
  return lendingScenario("fiat", steps);
}

/**
 * The token-simulation instance: instances.ts simulationSeed() (initialize_protocol,
 * register_class, the seven accredit_organisation, open_pool) followed by the nine pool actions of
 * live-lending.md §9.1, one per slot from 41,000.
 */
export async function poolHistory(): Promise<LendingScenario> {
  return lendingScenario("pool", POOL_STEPS);
}
