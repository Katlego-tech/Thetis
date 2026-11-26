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
  findIntakePda,
  findMintAuthorityPda,
  findMintPda,
  findOrganisationPda,
  findPositionPda,
  findProtocolPda,
  findVaultAuthorityPda,
  getAccreditCustodianClassInstruction,
  getClassPolicyEncoder,
  getClassRegisteredEventEncoder,
  getCustodianClassAccreditedEventEncoder,
  getCustodianClassEncoder,
  getFacilityEncoder,
  getFacilityOpenedEventEncoder,
  getIntakeIdentityEncoder,
  getIssueLotInstruction,
  getLotEncoder,
  getLotIssuedEventEncoder,
  getLotSplitEventEncoder,
  getOpenFacilityInstruction,
  getOrganisationAccreditedEventEncoder,
  getOrganisationEncoder,
  getOrganisationNameEncoder,
  getPauseInstruction,
  getPositionEncoder,
  getProtocolEncoder,
  getProtocolInitializedEventEncoder,
  getRedeemInstruction,
  getSplitInstruction,
  getTransferInstruction,
  getUnitsRedeemedEventEncoder,
  getUnitsTransferredEventEncoder,
  LotState,
  QuantityUnit,
  Restriction,
  Role,
  SettlementMode,
  THETIS_PROGRAM_ADDRESS,
} from "@thetis/contracts";
import {
  buildAccreditOrganisation,
  buildInitializeProtocol,
  buildRegisterClass,
  findClassPolicyPda,
  findOrganisationNamePda,
  instanceIdBytes,
  parseSeedOrganisations,
  SEED,
  type SeedOrganisation,
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
    async getProgramAccounts(protocol, signal) {
      enter("getProgramAccounts", [protocol], signal);
      const wanted = addressBytes.encode(protocol as Address);
      const accounts = [...stateAt(finalized)]
        .filter(
          ([, account]) =>
            account.programAddress === PROGRAM &&
            account.data.length >= 40 &&
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
