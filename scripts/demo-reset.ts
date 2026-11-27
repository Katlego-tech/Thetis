// Resets the demo to a known state (docs/design/demo.md §5):
//
//   node scripts/demo-reset.ts --scenario phone|lender --run NN|next [--yes]   # pnpm demo:reset …
//   node scripts/demo-reset.ts --check --run <instance id>                     # pnpm demo:check …
//
// A run is a fresh devnet protocol instance, fiat-demo-run-NN (phone) or fiat-lend-run-NN (lender),
// holding the demo cast: the seven seed.sql organisations, the Kopano and Port Terminal T1 custodian
// classes, and one Authority per owner-supplied wallet. The lender scenario also issues CR-0001
// with a seed-held Kopano key; a phone run never holds a lot, because CR-0001 is issued live on the
// phone. Then the local Supabase is recreated and given the cast's users and memberships.
//
// Without --yes nothing is sent and nothing is wiped: the plan and its cost are printed. Devnet only;
// the local Supabase only. Every transaction is logged pending before it is sent and confirmed after,
// in <keys dir>/runs/<instance id>.json, so a rerun of the same NN sends only what is missing.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import {
  findAddressLookupTablePda,
  getCreateLookupTableInstruction,
  getExtendLookupTableInstruction,
} from "@solana-program/address-lookup-table";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";
import { findAssociatedTokenPda, getMintSize, getTokenSize } from "@solana-program/token";
import {
  type Address,
  address,
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  type Blockhash,
  compressTransactionMessageUsingAddressLookupTables,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getAddressDecoder,
  getAddressEncoder,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  getTransactionEncoder,
  type Instruction,
  isAddress,
  type KeyPairSigner,
  pipe,
  type Rpc,
  type RpcSubscriptions,
  type Signature,
  type SolanaRpcApi,
  type SolanaRpcSubscriptionsApi,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signBytes,
  signTransactionMessageWithSigners,
  some,
  type Transaction,
  type TransactionSigner,
} from "@solana/kit";
import {
  fetchMaybeAuthority,
  fetchMaybeClassPolicy,
  fetchMaybeCustodianClass,
  fetchMaybeLot,
  fetchMaybeOrganisation,
  fetchMaybePosition,
  fetchMaybeProtocol,
  findAuthorityPda,
  findIntakePda,
  findMintAuthorityPda,
  findMintPda,
  findOrganisationPda,
  findPositionPda,
  findProtocolPda,
  findVaultAuthorityPda,
  getAccreditCustodianClassInstruction,
  getAuthorityEncoder,
  getClassPolicyEncoder,
  getCustodianClassEncoder,
  getDelegateAuthorityInstruction,
  getIntakeIdentitySize,
  getIssueLotInstruction,
  getLotEncoder,
  getOrganisationEncoder,
  getOrganisationNameSize,
  getPositionSize,
  getProtocolSize,
  THETIS_PROGRAM_ADDRESS,
} from "@thetis/contracts";
import { sharedMessageInstruction } from "../services/api/src/commands/ed25519.ts";
import {
  type AccountReader,
  assertDevnetEnv,
  assertKeysDirOutsideRepo,
  buildAccreditOrganisation,
  buildInitializeProtocol,
  buildRegisterClass,
  CLUSTER_FLAGS,
  DEVNET_RPC_URL,
  DEVNET_WS_URL,
  diffClass,
  diffOrganisation,
  diffProtocol,
  differenceError,
  explorerUrl,
  findClassPolicyPda,
  type InstanceSpec,
  instanceIdBytes,
  isDevnetValue,
  loadOrCreateKey,
  parseSeedOrganisations,
  type RoleName,
  readKeyFile,
  repositoryRoots,
  resolveKeysDir,
  SEED,
  SEED_SQL_PATH,
  type SeedOrganisation,
  type Signers,
  wantedClass,
} from "./seed-demo.ts";

export class DemoError extends Error {}

// ---------------------------------------------------------------------------------------------
// The fixed demo values (demo.md §4, §5.1)
// ---------------------------------------------------------------------------------------------

export type Scenario = "phone" | "lender";
const PREFIX: Record<Scenario, string> = { phone: "fiat-demo-run-", lender: "fiat-lend-run-" };
const RUN_ID = /^fiat-(demo|lend)-run-(\d\d)$/;

/** setup.rs `scope` bits. */
export const SCOPE = {
  ISSUE: 1 << 0,
  TRANSFER: 1 << 1,
  SPLIT: 1 << 2,
  REDEEM: 1 << 3,
  ATTEST_ORIGIN: 1 << 4,
  PLEDGE: 1 << 5,
  BUY: 1 << 6,
  LEND: 1 << 7,
  POOL: 1 << 8,
  SHIP: 1 << 9,
  CARRY: 1 << 10,
  OBSERVE: 1 << 11,
  LOAD: 1 << 12,
  INSPECT: 1 << 13,
  ATTEST_TRANSPORT: 1 << 14,
} as const;

/** setup.rs `delegate_authority`: the scopes each role may hold. */
export const ROLE_SCOPES: Record<RoleName, number> = {
  Exporter: SCOPE.TRANSFER | SCOPE.SPLIT | SCOPE.REDEEM | SCOPE.PLEDGE | SCOPE.SHIP,
  Buyer: SCOPE.TRANSFER | SCOPE.SPLIT | SCOPE.REDEEM | SCOPE.BUY | SCOPE.SHIP,
  Custodian: SCOPE.ISSUE | SCOPE.REDEEM | SCOPE.CARRY | SCOPE.OBSERVE | SCOPE.ATTEST_TRANSPORT,
  Transporter: SCOPE.CARRY | SCOPE.OBSERVE,
  Terminal: SCOPE.CARRY | SCOPE.OBSERVE | SCOPE.LOAD | SCOPE.ATTEST_TRANSPORT,
  Lender: SCOPE.LEND | SCOPE.POOL,
  Inspector: SCOPE.OBSERVE | SCOPE.INSPECT,
  DocumentIssuer: SCOPE.ATTEST_ORIGIN | SCOPE.ATTEST_TRANSPORT,
};

export const WALLET_KEYS = [
  "kopano",
  "port-t1",
  "mosela",
  "mosela-refused",
  "khunou",
  "lender-one",
  "lender-two",
  "buyer-smelter",
] as const;
export type WalletKey = (typeof WALLET_KEYS)[number];

/**
 * One Authority per wallet, with the role's whole scope set, except POOL for the lenders: a fiat
 * instance has no pool (live-lending.md §8 decision 14). mosela-refused is never delegated.
 */
export const DELEGATIONS: readonly { key: Exclude<WalletKey, "mosela-refused">; slug: string; scopes: number }[] = [
  { key: "kopano", slug: "kopano", scopes: ROLE_SCOPES.Custodian },
  { key: "port-t1", slug: "port-t1", scopes: ROLE_SCOPES.Terminal },
  { key: "mosela", slug: "mosela", scopes: ROLE_SCOPES.Transporter },
  { key: "khunou", slug: "khunou", scopes: ROLE_SCOPES.Exporter },
  { key: "lender-one", slug: "lender-one", scopes: SCOPE.LEND },
  { key: "lender-two", slug: "lender-two", scopes: SCOPE.LEND },
  { key: "buyer-smelter", slug: "buyer-smelter", scopes: ROLE_SCOPES.Buyer },
];

/** The lender scenario's issuing key: Kopano, ISSUE only, never on a phone instance (owner, 27 Nov). */
export const ISSUER_KEY = "kopano-seed-issuer" as const;

export const CUSTODIAN_CLASSES: readonly { slug: string; site: string; approvedKg: bigint }[] = [
  { slug: "kopano", site: "KOPANO-YARD-1", approvedKg: 10_000_000n },
  { slug: "port-t1", site: "PORT-T1", approvedKg: 5_000_000n },
];

export const AUTHORITY_LIFETIME_SECS = 2_592_000n; // 30 days

/** CR-0001 in the lender scenario: demo.md §2 and field-app.md §6.4's known answer. */
export const LENDER_LOT = {
  lotId: "CR-0001",
  grade: "G1",
  quantityKg: 5_000_000n,
  owner: "khunou",
  custodian: "kopano",
  site: "KOPANO-YARD-1",
  ticket: "WB2611-0042",
  intakeDigest: "71813b946d9d53f619f3cd4e1fce2d7d8dd6cbe8e0fc44876ac5e09a3c1483de",
} as const;
const ISSUE_WINDOW_SECS = 300n;
const COMPUTE_UNITS = 400_000;

/** The six users of demo.md §5.3, by the organisations each belongs to. */
const CAST_USERS: readonly string[] = [
  "kopano,port-t1",
  "mosela",
  "khunou",
  "lender-one",
  "lender-two",
  "buyer-smelter",
];

export const FIRST_SIGNATURE =
  "vtK8h43bEg8zDn5w7u319t6VfNztCKB87nYBJ7LN6bsgFmMR2cFKA2iVLKgve8spmhri9mQJbSk28amZthbVviE";

export const NEEDS_T067R =
  "the lender scenario needs T067r: services/api/src/commands/texts.ts has no issueLotMessage yet, so CR-0001's issue text can't be built";

const MAX_TRANSACTION_BYTES = 1_232;
const MARGIN_LAMPORTS = 100_000_000n; // 0.1 SOL
const FEE_PER_SIGNATURE = 5_000n;
const SPONSOR_WARN_LAMPORTS = 500_000_000n;
const TOKEN_2022 = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ASSOCIATED_TOKEN_PROGRAM = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
const INSTRUCTIONS_SYSVAR = address("Sysvar1nstructions1111111111111111111111111");
const ALT_PROGRAM = "AddressLookupTab1e1111111111111111111111111";

// ---------------------------------------------------------------------------------------------
// Arguments and run ids
// ---------------------------------------------------------------------------------------------

export function instanceIdFor(scenario: Scenario, run: number): string {
  if (!Number.isInteger(run) || run < 1 || run > 99) {
    throw new DemoError(`refusing: run ${run} is not 01 to 99.`);
  }
  return `${PREFIX[scenario]}${String(run).padStart(2, "0")}`;
}

function spec(instanceId: string): InstanceSpec {
  return { instanceId, settlementMode: "FiatAttestationTest" };
}

async function protocolFor(instanceId: string): Promise<Address> {
  const [protocol] = await findProtocolPda({ instanceId: instanceIdBytes(spec(instanceId)) });
  return protocol;
}

/** The smallest NN whose Protocol account does not exist for the scenario's prefix. */
export async function nextFreeRun(
  scenario: Scenario,
  exists: (protocol: Address) => Promise<boolean>,
): Promise<number> {
  for (let run = 1; run <= 99; run += 1) {
    if (!(await exists(await protocolFor(instanceIdFor(scenario, run))))) return run;
  }
  throw new DemoError(`refusing: every ${PREFIX[scenario]}NN from 01 to 99 is taken.`);
}

export type Args =
  | { mode: "reset"; scenario: Scenario; run: number | "next"; yes: boolean }
  | { mode: "check"; instanceId: string };

export function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv): Args {
  assertDevnetEnv(env);
  let scenario: string | undefined;
  let run: string | undefined;
  let yes = false;
  let check = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const takeValue = (): string => {
      const value = eq === -1 ? argv[i + 1] : arg.slice(eq + 1);
      if (eq === -1) i += 1;
      if (value === undefined) throw new DemoError(`refusing: ${flag} needs a value.`);
      return value;
    };
    if (flag === "--yes" && eq === -1) yes = true;
    else if (flag === "--check" && eq === -1) check = true;
    else if (flag === "--scenario") scenario = takeValue();
    else if (flag === "--run") run = takeValue();
    else if (CLUSTER_FLAGS.includes(flag)) {
      const value = takeValue();
      if (!isDevnetValue(value)) {
        throw new DemoError(`refusing: ${flag} ${value} is not devnet. This script only runs on devnet.`);
      }
    } else {
      throw new DemoError(
        `refusing: unknown argument ${arg}. Use --scenario phone|lender --run NN|next [--yes], or --check --run <instance id>.`,
      );
    }
  }
  if (check) {
    if (scenario !== undefined || yes) throw new DemoError("refusing: --check takes only --run <instance id>.");
    if (run === undefined || !RUN_ID.test(run)) {
      throw new DemoError("refusing: --check needs --run fiat-demo-run-NN or fiat-lend-run-NN.");
    }
    return { mode: "check", instanceId: run };
  }
  if (scenario !== "phone" && scenario !== "lender") {
    throw new DemoError(`refusing: --scenario ${scenario ?? "(missing)"} is not phone or lender.`);
  }
  if (run === undefined) throw new DemoError("refusing: --run NN or --run next is required.");
  if (run === "next") return { mode: "reset", scenario, run, yes };
  if (!/^\d{1,2}$/.test(run)) throw new DemoError(`refusing: --run ${run} is not 01 to 99 or next.`);
  const number = Number(run);
  instanceIdFor(scenario, number);
  return { mode: "reset", scenario, run: number, yes };
}

// ---------------------------------------------------------------------------------------------
// The cast file (owner-supplied public keys and .test emails; never a secret key)
// ---------------------------------------------------------------------------------------------

export type DemoCast = {
  wallets: Record<WalletKey, string>;
  users: { email: string; organisations: string[] }[];
};

export function castTemplate(): string {
  const wallets = Object.fromEntries(WALLET_KEYS.map((key) => [key, ""]));
  const users = CAST_USERS.map((set) => ({ email: "", organisations: set.split(",") }));
  return `${JSON.stringify({ wallets, users }, null, 2)}\n`;
}

const EMAIL = /^[a-z0-9._+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.test$/;

/** Refusal 3: eight distinct wallets that are no operator key, and exactly the six users with .test emails. */
export function validateCast(raw: unknown, operatorKeys: ReadonlyMap<string, string>): DemoCast {
  const cast = raw as Partial<DemoCast> | null;
  if (typeof cast !== "object" || cast === null || typeof cast.wallets !== "object" || !Array.isArray(cast.users)) {
    throw new DemoError("refusing: demo-cast.json must hold wallets and users (see the template).");
  }
  const wallets = cast.wallets as Record<string, unknown>;
  const extra = Object.keys(wallets).filter((key) => !(WALLET_KEYS as readonly string[]).includes(key));
  if (extra.length > 0) throw new DemoError(`refusing: demo-cast.json has unknown wallets: ${extra.join(", ")}.`);
  const seen = new Map<string, string>();
  for (const key of WALLET_KEYS) {
    const value = wallets[key];
    if (typeof value !== "string" || !isAddress(value)) {
      throw new DemoError(`refusing: demo-cast.json wallet ${key} is not a public key (base58, 32 bytes).`);
    }
    const operator = operatorKeys.get(value);
    if (operator !== undefined) {
      throw new DemoError(`refusing: wallet ${key} equals the operator key ${operator}; use the owner's own wallet.`);
    }
    const other = seen.get(value);
    if (other !== undefined) throw new DemoError(`refusing: wallet ${value} appears more than once (${other}, ${key}).`);
    seen.set(value, key);
  }
  const users = cast.users as unknown[];
  const sets = users.map((user) => {
    const entry = user as { email?: unknown; organisations?: unknown };
    if (typeof entry?.email !== "string" || !EMAIL.test(entry.email)) {
      throw new DemoError(
        `refusing: user email ${String(entry?.email)} must be a lowercase .test address (read through Mailpit).`,
      );
    }
    if (!Array.isArray(entry.organisations) || !entry.organisations.every((slug) => typeof slug === "string")) {
      throw new DemoError(`refusing: user ${entry.email} needs a list of organisation slugs.`);
    }
    return [...(entry.organisations as string[])].sort().join(",");
  });
  const wanted = [...CAST_USERS].map((set) => set.split(",").sort().join(",")).sort();
  const emails = new Set(users.map((user) => (user as { email: string }).email));
  if (sets.length !== 6 || [...sets].sort().join(";") !== wanted.join(";") || emails.size !== 6) {
    throw new DemoError(
      "refusing: the cast must list exactly the six users of demo.md §5.3 (phone 1: kopano and port-t1; phone 2: mosela; khunou; lender-one; lender-two; buyer-smelter), each with its own email.",
    );
  }
  return cast as DemoCast;
}

/** The owner's cast file, or the template printed and a refusal when it is missing (reset and check alike). */
function loadCast(keysDir: string, log: (line: string) => void, operatorKeys: ReadonlyMap<string, string>): DemoCast {
  const castPath = join(keysDir, "demo-cast.json");
  if (!existsSync(castPath)) {
    log(`Write ${castPath} (mode 600) with the owner's public keys and .test emails, from this template:`);
    log(castTemplate());
    throw new DemoError(`refusing: ${castPath} is missing. Nothing was sent or wiped.`);
  }
  return validateCast(JSON.parse(readFileSync(castPath, "utf8")), operatorKeys);
}

function operatorKeyMap(keysDir: string): Map<string, string> {
  const keys = new Map<string, string>();
  for (const name of readdirSync(keysDir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const bytes: unknown = JSON.parse(readFileSync(join(keysDir, name), "utf8"));
      if (Array.isArray(bytes) && bytes.length === 64) {
        keys.set(getAddressDecoder().decode(Uint8Array.from(bytes.slice(32) as number[])), name);
      }
    } catch {
      // Not a key file (seed-log.json, demo-cast.json): nothing to compare.
    }
  }
  return keys;
}

// ---------------------------------------------------------------------------------------------
// The plan and its cost
// ---------------------------------------------------------------------------------------------

export type PlannedStep = {
  label: string;
  name: string;
  creates: readonly { label: string; bytes: number }[];
  signatures: number;
};

/** state.rs's `max_len` bounds (MAX_CLASS_CODE … MAX_LOT_ID); a test reads them from state.rs. */
export const STATE_MAX = {
  classCode: 8,
  grades: 8,
  grade: 8,
  displayName: 48,
  related: 8,
  siteCode: 16,
  lotId: 16,
} as const;

/**
 * Each created account's size in bytes, discriminator included (PR #68 review, item 9): a fixed-size
 * account from its codec's size, a variable one by encoding its largest value (every string and
 * vector at state.rs's bound, every option Some), which is what Anchor's InitSpace allocates.
 */
export const ACCOUNT_BYTES = (() => {
  const key = SYSTEM_PROGRAM;
  const text = (length: number) => "x".repeat(length);
  return {
    Protocol: getProtocolSize(),
    ClassPolicy: getClassPolicyEncoder().encode({
      protocol: key,
      classCode: text(STATE_MAX.classCode),
      version: 0,
      unit: 0,
      grades: Array.from({ length: STATE_MAX.grades }, () => text(STATE_MAX.grade)),
      originRequired: false,
      lotValiditySecs: 0n,
      splitInheritsExpiry: false,
      bump: 0,
    }).length,
    Organisation: getOrganisationEncoder().encode({
      protocol: key,
      orgId: new Uint8Array(16),
      role: 0,
      displayName: text(STATE_MAX.displayName),
      admin: key,
      related: Array.from({ length: STATE_MAX.related }, () => key),
      bump: 0,
    }).length,
    OrganisationName: getOrganisationNameSize(),
    CustodianClass: getCustodianClassEncoder().encode({
      protocol: key,
      custodian: key,
      classPolicy: key,
      siteCode: text(STATE_MAX.siteCode),
      approvedCapacityKg: 0n,
      occupiedKg: 0n,
      reservedInboundKg: 0n,
      bump: 0,
    }).length,
    Authority: getAuthorityEncoder().encode({
      protocol: key,
      organisation: key,
      wallet: key,
      scopes: 0,
      expiresAt: 0n,
      revokedAt: some(0n),
      bump: 0,
    }).length,
    IntakeIdentity: getIntakeIdentitySize(),
    Lot: getLotEncoder().encode({
      protocol: key,
      lotId: text(STATE_MAX.lotId),
      classPolicy: key,
      classVersion: 0,
      grade: text(STATE_MAX.grade),
      custodianClass: key,
      intake: key,
      parent: some(key),
      root: key,
      mint: key,
      supplyKg: 0n,
      state: 0,
      restriction: 0,
      expiresAt: 0n,
      revision: 0n,
      liveChildren: 0,
      bump: 0,
    }).length,
    /** A Token-2022 mint with no extension is the base mint's 82 bytes. */
    Mint: getMintSize(),
    Position: getPositionSize(),
    /** The vault is a Token-2022 associated account: base, the account-type byte, ImmutableOwner's empty TLV. */
    Vault: getTokenSize() + 1 + 4,
    /** The lookup table's metadata before its 32-byte addresses. */
    LookupTableHeader: 56,
  };
})();

/** The issue's keys held in the run's lookup table: every account but the sponsor and the programs. */
const LOOKUP_KEY_COUNT = 17;

export function planSteps(scenario: Scenario): PlannedStep[] {
  const organisations = parseSeedOrganisations(readFileSync(SEED_SQL_PATH, "utf8"));
  const base: Omit<PlannedStep, "label">[] = [
    { name: "initialize_protocol", creates: [{ label: "Protocol", bytes: ACCOUNT_BYTES.Protocol }], signatures: 2 },
    {
      name: `register_class ${SEED.classCode} v${SEED.classVersion}`,
      creates: [{ label: "ClassPolicy", bytes: ACCOUNT_BYTES.ClassPolicy }],
      signatures: 2,
    },
    ...organisations.map((organisation) => ({
      name: `accredit_organisation ${organisation.slug}`,
      creates: [
        { label: "Organisation", bytes: ACCOUNT_BYTES.Organisation },
        { label: "OrganisationName", bytes: ACCOUNT_BYTES.OrganisationName },
      ],
      signatures: 2,
    })),
    ...CUSTODIAN_CLASSES.map((custodianClass) => ({
      name: `accredit_custodian_class ${custodianClass.site}`,
      creates: [{ label: "CustodianClass", bytes: ACCOUNT_BYTES.CustodianClass }],
      signatures: 2,
    })),
    ...DELEGATIONS.map((delegation) => ({
      name: `delegate_authority ${delegation.key}`,
      creates: [{ label: "Authority", bytes: ACCOUNT_BYTES.Authority }],
      signatures: 2,
    })),
  ];
  const lender: Omit<PlannedStep, "label">[] =
    scenario === "lender"
      ? [
          { name: `delegate_authority ${ISSUER_KEY}`, creates: [{ label: "Authority", bytes: ACCOUNT_BYTES.Authority }], signatures: 2 },
          {
            name: "create_lookup_table",
            creates: [{ label: "lookup table", bytes: ACCOUNT_BYTES.LookupTableHeader + 32 * LOOKUP_KEY_COUNT }],
            signatures: 1,
          },
          { name: "extend_lookup_table", creates: [], signatures: 1 },
          {
            name: `issue_lot ${LENDER_LOT.lotId}`,
            creates: [
              { label: "IntakeIdentity", bytes: ACCOUNT_BYTES.IntakeIdentity },
              { label: "Lot", bytes: ACCOUNT_BYTES.Lot },
              { label: "Mint", bytes: ACCOUNT_BYTES.Mint },
              { label: "Position", bytes: ACCOUNT_BYTES.Position },
              { label: "Vault", bytes: ACCOUNT_BYTES.Vault },
            ],
            signatures: 1,
          },
        ]
      : [];
  return [
    ...base.map((step, index) => ({ ...step, label: `B${index + 1}` })),
    ...lender.map((step, index) => ({ ...step, label: `L${index + 1}` })),
  ];
}

/** (bytes + 128) × 6,960 lamports: two years of rent at the default rate. */
export function rentEstimate(bytes: number): bigint {
  return BigInt(bytes + 128) * 6_960n;
}

export type Cost = { rent: bigint; fees: bigint; total: bigint };

export function estimateCost(steps: readonly PlannedStep[], rentOf: (bytes: number) => bigint): Cost {
  let rent = 0n;
  let fees = 0n;
  for (const step of steps) {
    for (const account of step.creates) rent += rentOf(account.bytes);
    fees += BigInt(step.signatures) * FEE_PER_SIGNATURE;
  }
  return { rent, fees, total: rent + fees };
}

function sol(lamports: bigint): string {
  const whole = lamports / 1_000_000_000n;
  const fraction = (lamports % 1_000_000_000n).toString().padStart(9, "0").slice(0, 6);
  return `${whole}.${fraction} SOL`;
}

// ---------------------------------------------------------------------------------------------
// Ports: the chain and the local Supabase
// ---------------------------------------------------------------------------------------------

export interface Chain {
  /** getAccountInfo, for the generated fetchMaybe* readers. */
  readonly rpc: AccountReader;
  programDeployed(): Promise<boolean>;
  unixTime(): Promise<bigint>;
  slot(): Promise<bigint>;
  balance(address: Address): Promise<bigint>;
  rent(bytes: number): Promise<bigint>;
  latestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: bigint }>;
  /** Sends a signed transaction and resolves once it is confirmed; throws when it fails. */
  submit(transaction: Transaction): Promise<void>;
  statuses(signatures: readonly string[]): Promise<({ failed: boolean; confirmed: boolean } | null)[]>;
  blockHeight(): Promise<bigint>;
  /** The table's addresses, or null when there is no lookup table there. */
  lookupTable(table: Address): Promise<Address[] | null>;
}

export interface LocalStack {
  status(): Promise<{ apiUrl: string; serviceRoleKey: string }>;
  query(sql: string): Promise<Record<string, unknown>[]>;
  resetDatabase(): Promise<void>;
  /** The new user's id, or "exists" when the email is already registered. */
  createUser(email: string): Promise<string | "exists">;
  listening(port: number): Promise<boolean>;
}

/**
 * Devnet through kit's RPC. Every read is at `confirmed` (PR #68 review, item 2): the default,
 * finalized, lags a just-sent transaction, so L4 would read a lookup table without L3's keys.
 */
export function devnetChain(
  rpc: Rpc<SolanaRpcApi> = createSolanaRpc(DEVNET_RPC_URL),
  subscriptions: () => RpcSubscriptions<SolanaRpcSubscriptionsApi> = () => createSolanaRpcSubscriptions(DEVNET_WS_URL),
): Chain {
  let sendAndConfirm: ReturnType<typeof sendAndConfirmTransactionFactory> | undefined;
  const commitment = "confirmed" as const;
  return {
    rpc,
    programDeployed: async () => {
      const { value } = await rpc.getAccountInfo(THETIS_PROGRAM_ADDRESS, { encoding: "base64", commitment }).send();
      return value !== null && value.executable;
    },
    unixTime: async () => {
      const slot = await rpc.getSlot({ commitment }).send();
      const time = await rpc.getBlockTime(slot).send();
      if (time === null) throw new DemoError(`devnet has no block time for slot ${slot}`);
      return BigInt(time);
    },
    slot: async () => rpc.getSlot({ commitment }).send(),
    balance: async (owner) => (await rpc.getBalance(owner, { commitment }).send()).value,
    rent: async (bytes) => rpc.getMinimumBalanceForRentExemption(BigInt(bytes), { commitment }).send(),
    latestBlockhash: async () => (await rpc.getLatestBlockhash({ commitment }).send()).value,
    submit: async (transaction) => {
      assertIsTransactionWithBlockhashLifetime(transaction);
      sendAndConfirm ??= sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions: subscriptions() });
      await sendAndConfirm(transaction as unknown as Parameters<typeof sendAndConfirm>[0], { commitment });
    },
    statuses: async (signatures) => {
      const { value } = await rpc
        .getSignatureStatuses(signatures as Signature[], { searchTransactionHistory: true })
        .send();
      return value.map((status) =>
        status === null
          ? null
          : {
              failed: status.err !== null,
              confirmed: status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized",
            },
      );
    },
    blockHeight: async () => rpc.getBlockHeight({ commitment }).send(),
    lookupTable: async (table) => {
      const { value } = await rpc.getAccountInfo(table, { encoding: "base64", commitment }).send();
      if (value === null || value.owner !== ALT_PROGRAM) return null;
      const data = Buffer.from(value.data[0], "base64");
      const out: Address[] = [];
      for (let at = ACCOUNT_BYTES.LookupTableHeader; at + 32 <= data.length; at += 32) {
        out.push(getAddressDecoder().decode(data.subarray(at, at + 32)));
      }
      return out;
    },
  };
}

/** Runs the Supabase CLI with these arguments and returns its stdout. */
export type SupabaseCli = (args: string[]) => string;

/**
 * A bare Postgres command tag (`INSERT 0 2`, `UPDATE 1`, `DO`): what `supabase db query` 2.122.1
 * prints, instead of JSON, for a statement that yields no rows (PR #68 review, item 1).
 */
const COMMAND_TAG = /^(?:INSERT \d+ \d+|UPDATE \d+|DELETE \d+|MERGE \d+|SELECT \d+|DO)$/;

/** The rows of `supabase db query --output-format json` stdout: JSON rows, or none for a command tag. */
export function parseQueryOutput(stdout: string, sql: string): Record<string, unknown>[] {
  const text = stdout.trim();
  if (COMMAND_TAG.test(text)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const rows = (parsed as { rows?: unknown } | undefined)?.rows;
  if (typeof parsed === "object" && parsed !== null && Array.isArray(rows)) return rows as Record<string, unknown>[];
  const first = sql.trim().split("\n")[0] ?? "";
  throw new DemoError(
    `supabase db query printed neither JSON rows nor a command tag for: ${first}\n${text.slice(0, 200)}`,
  );
}

/** The local Supabase stack, through the CLI in the repository and its auth admin API. */
export function localStack(
  repoRoot: string,
  cli: SupabaseCli = (args) =>
    execFileSync("supabase", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
): LocalStack {
  let cached: { apiUrl: string; serviceRoleKey: string } | undefined;
  const status = async () => {
    if (cached !== undefined) return cached;
    const values = new Map<string, string>();
    for (const line of cli(["status", "-o", "env"]).split("\n")) {
      const match = /^([A-Z_]+)="?(.*?)"?$/.exec(line.trim());
      if (match) values.set(match[1] as string, match[2] as string);
    }
    const apiUrl = values.get("API_URL");
    const serviceRoleKey = values.get("SERVICE_ROLE_KEY");
    if (!apiUrl || !serviceRoleKey) {
      throw new DemoError("refusing: supabase status gave no API_URL or SERVICE_ROLE_KEY. Start the local stack.");
    }
    cached = { apiUrl, serviceRoleKey };
    return cached;
  };
  return {
    status,
    query: async (sql) => parseQueryOutput(cli(["db", "query", "--local", "--output-format", "json", sql]), sql),
    resetDatabase: async () => {
      execFileSync("supabase", ["db", "reset", "--local"], { cwd: repoRoot, stdio: "inherit" });
    },
    createUser: async (email) => {
      const { apiUrl, serviceRoleKey } = await status();
      const response = await fetch(`${apiUrl}/auth/v1/admin/users`, {
        method: "POST",
        headers: {
          apikey: serviceRoleKey,
          authorization: `Bearer ${serviceRoleKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ email, email_confirm: true }),
      });
      const body = (await response.json().catch(() => ({}))) as { id?: string; error_code?: string; code?: string };
      if (response.ok && typeof body.id === "string") return body.id;
      if (response.status === 422 && (body.error_code === "email_exists" || body.code === "email_exists")) {
        return "exists";
      }
      throw new DemoError(`creating the user ${email} failed with HTTP ${response.status}`);
    },
    listening: (port) =>
      new Promise((done) => {
        const socket = connect({ host: "127.0.0.1", port });
        const finish = (open: boolean) => {
          socket.destroy();
          done(open);
        };
        socket.setTimeout(500, () => finish(false));
        socket.once("connect", () => finish(true));
        socket.once("error", () => finish(false));
      }),
  };
}

// ---------------------------------------------------------------------------------------------
// The issue text (T067r's builder, imported, never copied)
// ---------------------------------------------------------------------------------------------

export type IssueTextFields = {
  programId: string;
  instanceId: Uint8Array;
  lotId: string;
  classCode: string;
  classVersion: number;
  grade: string;
  quantityKg: bigint;
  owner: string;
  custodian: string;
  siteCode: string;
  intakeDigest: Uint8Array;
  validUntil: bigint;
};
export type IssueText = (fields: IssueTextFields) => Uint8Array;

/**
 * The order the script passes `issueLotMessage`'s arguments in: the relay's builders' order (the
 * program's `issue_message`, origin absent for CHROME v1). This is a guess at T067r's signature until
 * it lands, so the binding below checks the real function's arity and parameter names against it and
 * refuses on any difference instead of signing a text with fields in the wrong slots (PR #68 review,
 * item 5). The driver reruns the lender LiteSVM case once T067r exports the real builder.
 */
export const ISSUE_LOT_MESSAGE_PARAMS = [
  "programId",
  "instanceId",
  "lotId",
  "classCode",
  "classVersion",
  "grade",
  "quantityKg",
  "owner",
  "custodian",
  "siteCode",
  "intakeDigest",
  "origin",
  "validUntil",
] as const;

function parameterNames(build: (...args: never[]) => unknown): string[] {
  const source = Function.prototype.toString.call(build);
  const list = /^[^(]*\(([^)]*)\)/.exec(source)?.[1] ?? "";
  return list
    .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")
    .split(",")
    .map((name) => name.trim().split(/[\s=:]/)[0] ?? "")
    .filter((name) => name.length > 0);
}

/** Binds T067r's `issueLotMessage` to the fields, refusing a builder whose signature differs. */
export function bindIssueLotMessage(build: unknown): IssueText {
  if (typeof build !== "function") throw new DemoError("issueLotMessage is not a function");
  const names = parameterNames(build as (...args: never[]) => unknown);
  const wanted = [...ISSUE_LOT_MESSAGE_PARAMS];
  if (build.length !== wanted.length || names.join(",") !== wanted.join(",")) {
    throw new DemoError(
      `refusing: services/api's issueLotMessage takes (${names.join(", ")}) (arity ${build.length}); ` +
        `demo-reset.ts passes (${wanted.join(", ")}). Update ISSUE_LOT_MESSAGE_PARAMS and the call together.`,
    );
  }
  return (f) =>
    build(
      f.programId,
      f.instanceId,
      f.lotId,
      f.classCode,
      f.classVersion,
      f.grade,
      f.quantityKg,
      f.owner,
      f.custodian,
      f.siteCode,
      f.intakeDigest,
      null,
      f.validUntil,
    ) as Uint8Array;
}

/** T067r's `issueLotMessage`, or null while services/api has none. Left as is until T067r lands. */
export async function loadIssueText(): Promise<IssueText | null> {
  const texts = (await import("../services/api/src/commands/texts.ts")) as Record<string, unknown>;
  const build = texts.issueLotMessage;
  if (typeof build !== "function") return null;
  return bindIssueLotMessage(build);
}

// ---------------------------------------------------------------------------------------------
// The run file
// ---------------------------------------------------------------------------------------------

export type LoggedTransaction = {
  step: string;
  signature: string;
  status: "pending" | "confirmed" | "failed" | "expired";
  explorerUrl: string;
  lastValidBlockHeight: string;
  /** create_lookup_table only: the table this transaction creates, so a rerun reuses it. */
  account?: string;
};

export type RunFile = {
  scenario: Scenario;
  instanceId: string;
  protocol: string;
  t0: number;
  expiresAt: number;
  explorer: string;
  authorities: { key: string; wallet: string; organisation: string; address: string; scopes: number }[];
  custodianClasses: { site: string; address: string; approvedKg: string }[];
  lookupTable: string | null;
  lot: { lotId: "CR-0001"; address: string } | null;
  transactions: LoggedTransaction[];
  supabase: { status: "pending" | "done"; users: { email: string; id: string; organisations: string[] }[] };
};

function runPath(keysDir: string, instanceId: string, extension: "json" | "env"): string {
  return join(keysDir, "runs", `${instanceId}.${extension}`);
}

function readRunFile(keysDir: string, instanceId: string): RunFile | null {
  const path = runPath(keysDir, instanceId, "json");
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RunFile>;
  if (parsed.instanceId !== instanceId || typeof parsed.t0 !== "number" || !Array.isArray(parsed.transactions)) {
    throw new DemoError(`${path} is not a run file this script wrote; not touching it`);
  }
  return parsed as RunFile;
}

function writePrivate(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** The env lines the API, the worker and the web app take for a run. Nothing secret. */
export function renderEnv(run: Pick<RunFile, "protocol">): string {
  return [
    "THETIS_NETWORK=devnet",
    `THETIS_PROGRAM_ID=${THETIS_PROGRAM_ADDRESS}`,
    `THETIS_PROTOCOL=${run.protocol}`,
    `THETIS_RPC_URL=${DEVNET_RPC_URL}`,
    `THETIS_FIRST_SIGNATURE=${FIRST_SIGNATURE}`,
    "THETIS_DATA_SOURCE=live",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------
// The Supabase stage (demo.md §5.3)
// ---------------------------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Wipes the local database unless its marker already names this run, then ensures the six users
 * (confirmed, no password) and their admin memberships, and sets the marker. Links are never made here.
 */
export async function resetCast(
  stack: LocalStack,
  instanceId: string,
  cast: DemoCast,
  organisations: readonly SeedOrganisation[],
): Promise<{ email: string; id: string; organisations: string[] }[]> {
  if (!RUN_ID.test(instanceId)) throw new DemoError(`not a run id: ${instanceId}`);
  const marker = await stack.query("select value from private.settings where key = 'demo_run'");
  if (marker[0]?.value !== instanceId) await stack.resetDatabase();
  const users: { email: string; id: string; organisations: string[] }[] = [];
  for (const user of cast.users) {
    if (!EMAIL.test(user.email)) throw new DemoError(`not a .test email: ${user.email}`);
    const created = await stack.createUser(user.email);
    let id = created;
    if (created === "exists") {
      const rows = await stack.query(`select id from auth.users where lower(email) = lower('${user.email}')`);
      id = String(rows[0]?.id ?? "");
    }
    if (!UUID.test(id)) throw new DemoError(`no user id for ${user.email}`);
    const rows = user.organisations.map((slug) => {
      const organisation = organisations.find((o) => o.slug === slug);
      if (!organisation || !UUID.test(organisation.id)) throw new DemoError(`unknown organisation ${slug}`);
      return `('${organisation.id}', '${id}', 'admin'::public.member_role)`;
    });
    // Every write ends in RETURNING so the CLI prints JSON rows (item 1); a kept row returns nothing.
    await stack.query(
      `insert into public.memberships (organisation_id, user_id, member_role) values ${rows.join(", ")} ` +
        "on conflict (organisation_id, user_id) where revoked_at is null do nothing returning organisation_id, user_id",
    );
    users.push({ email: user.email, id, organisations: [...user.organisations] });
  }
  const set = await stack.query(
    `insert into private.settings (key, value) values ('demo_run', '${instanceId}') ` +
      "on conflict (key) do update set value = excluded.value returning value",
  );
  if (set[0]?.value !== instanceId) throw new DemoError(`the run marker was not set to ${instanceId}`);
  return users;
}

// ---------------------------------------------------------------------------------------------
// The reset
// ---------------------------------------------------------------------------------------------

export type ResetDeps = {
  chain: Chain;
  stack: LocalStack;
  keysDir: string;
  repoRoots: readonly string[];
  seedSql: string;
  log: (line: string) => void;
  issueText: () => Promise<IssueText | null>;
  sleep: (ms: number) => Promise<void>;
};

export type ResetResult = {
  instanceId: string;
  protocol: Address;
  t0: bigint;
  expiresAt: bigint;
  steps: { label: string; name: string; action: "send" | "skip" }[];
  cost: Cost;
  sent: string[];
  runFile: RunFile | null;
};

type ExecStep = PlannedStep & {
  decide(): Promise<"send" | "skip">;
  build(): Promise<{ instructions: Instruction[]; tables?: Record<Address, Address[]>; account?: Address }>;
  after?(): Promise<void>;
};

const encoder = new TextEncoder();

async function custodianClassPda(protocol: Address, custodian: Address, classPolicy: Address, site: string) {
  const addresses = getAddressEncoder();
  const [found] = await getProgramDerivedAddress({
    programAddress: THETIS_PROGRAM_ADDRESS,
    seeds: [
      encoder.encode("custodian_class"),
      addresses.encode(protocol),
      addresses.encode(custodian),
      addresses.encode(classPolicy),
      encoder.encode(site),
    ],
  });
  return found;
}

async function lotPda(protocol: Address, lotId: string): Promise<Address> {
  const [found] = await getProgramDerivedAddress({
    programAddress: THETIS_PROGRAM_ADDRESS,
    seeds: [encoder.encode("lot"), getAddressEncoder().encode(protocol), encoder.encode(lotId)],
  });
  return found;
}

function keyPath(keysDir: string, name: string): string {
  return join(keysDir, `${name}.json`);
}

async function readOperatorKey(keysDir: string, name: string): Promise<TransactionSigner> {
  const path = keyPath(keysDir, name);
  if (!existsSync(path)) {
    throw new DemoError(`refusing: ${path} is missing. The demo reset uses the existing operator keys (README, Deployments).`);
  }
  return readKeyFile(path);
}

function intakeDigest(): Uint8Array {
  const digest = createHash("sha256")
    .update(`thetis-intake-v1\n${LENDER_LOT.site}\n${LENDER_LOT.ticket}`, "utf8")
    .digest();
  if (digest.toString("hex") !== LENDER_LOT.intakeDigest) {
    throw new DemoError("the intake digest does not match field-app.md §6.4's known answer");
  }
  return Uint8Array.from(digest);
}

export async function reset(
  args: { scenario: Scenario; run: number | "next"; yes: boolean },
  deps: ResetDeps,
): Promise<ResetResult> {
  const { chain, stack, log } = deps;
  // Refusal 2: keys outside the repository, every operator key present.
  const keysDir = assertKeysDirOutsideRepo(deps.keysDir, deps.repoRoots);
  const organisations = parseSeedOrganisations(deps.seedSql);
  const deployer = await readOperatorKey(keysDir, "deployer");
  const admin = await readOperatorKey(keysDir, "admin");
  const accreditor = await readOperatorKey(keysDir, "accreditor");
  const orgAdmins = new Map<string, TransactionSigner>();
  for (const organisation of organisations) {
    orgAdmins.set(organisation.slug, await readOperatorKey(keysDir, `org-${organisation.slug}`));
  }
  // Refusal 4: only synthetic organisations are ever accredited (demo.md §5.6).
  const real = organisations.filter((organisation) => !organisation.synthetic);
  if (real.length > 0) {
    throw new DemoError(
      `refusing: ${real.map((o) => o.slug).join(", ")} in supabase/seed.sql is not marked synthetic. The demo accredits synthetic organisations only.`,
    );
  }
  const bySlug = (slug: string): SeedOrganisation => {
    const found = organisations.find((organisation) => organisation.slug === slug);
    if (!found) throw new DemoError(`supabase/seed.sql has no organisation ${slug}`);
    return found;
  };
  // Refusal 2 and 3: the owner's cast file.
  const cast = loadCast(keysDir, log, operatorKeyMap(keysDir));
  // Refusal 5: the local stack only.
  const { apiUrl } = await stack.status();
  const host = (() => {
    try {
      return new URL(apiUrl).hostname;
    } catch {
      return "";
    }
  })();
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new DemoError(`refusing: Supabase ${apiUrl} is not the local stack. Only the local database is ever reset.`);
  }
  // Read-only, in the dry run too: the run marker and the indexer checkpoint (demo.md §5.4 sequence).
  const markerRows = await stack.query("select value from private.settings where key = 'demo_run'");
  const marker = typeof markerRows[0]?.value === "string" ? (markerRows[0].value as string) : null;
  const checkpoints = await stack.query(
    "select protocol, extract(epoch from (now() - last_poll_at))::int as age from public.indexer_checkpoints",
  );
  // Refusal 6: the API, the web app and the worker are stopped (only when something will change).
  if (args.yes) {
    for (const [port, what] of [
      [3200, "the API"],
      [3100, "the web app"],
    ] as const) {
      if (await stack.listening(port)) {
        throw new DemoError(`refusing: something is listening on 127.0.0.1:${port} (${what}). Stop it, then run again.`);
      }
    }
    for (const row of checkpoints) {
      if (row.age !== null && Number(row.age) < 120) {
        throw new DemoError("refusing: the worker polled in the last 120 s. Stop it, then run again.");
      }
    }
  }
  if (!(await chain.programDeployed())) {
    throw new DemoError(`refusing: program ${THETIS_PROGRAM_ADDRESS} is not deployed. Run scripts/deploy-devnet.sh first.`);
  }

  const exists = async (account: Address) => {
    const { value } = await (
      chain.rpc as unknown as {
        getAccountInfo(a: Address, c: object): { send(): Promise<{ value: unknown }> };
      }
    )
      .getAccountInfo(account, { encoding: "base64", commitment: "confirmed" })
      .send();
    return value !== null;
  };
  const run = args.run === "next" ? await nextFreeRun(args.scenario, exists) : args.run;
  const instanceId = instanceIdFor(args.scenario, run);
  const instance = spec(instanceId);
  const protocol = await protocolFor(instanceId);
  const existingRun = readRunFile(keysDir, instanceId);
  if (existingRun !== null && existingRun.scenario !== args.scenario) {
    throw new DemoError(`refusing: ${instanceId} was planned as ${existingRun.scenario}.`);
  }
  const t0 = existingRun !== null ? BigInt(existingRun.t0) : await chain.unixTime();
  const expiresAt = t0 + AUTHORITY_LIFETIME_SECS;
  const signers: Signers = { deployer, admin, accreditor };
  const classPolicy = await findClassPolicyPda(protocol, SEED.classCode, SEED.classVersion);
  const orgPda = async (slug: string) => {
    const [found] = await findOrganisationPda({ protocol, orgId: bySlug(slug).orgId });
    return found;
  };

  // Refusal 7: a Used run. A phone run never holds a lot; a lender run's lot is untouched.
  const lot = await lotPda(protocol, LENDER_LOT.lotId);
  const lotAccount = await fetchMaybeLot(chain.rpc, lot, { commitment: "confirmed" }).catch(() => null);
  const lotExists = lotAccount === null ? await exists(lot) : lotAccount.exists;
  if (args.scenario === "phone" && lotExists) {
    throw new DemoError(
      `refusing: ${instanceId} is Used: its Lot ${LENDER_LOT.lotId} exists (${lot}). Use --run next for a new rehearsal.`,
    );
  }
  if (args.scenario === "lender" && lotExists) {
    const [position] = await findPositionPda({ lot, owner: await orgPda(LENDER_LOT.owner) });
    const found = await fetchMaybePosition(chain.rpc, position, { commitment: "confirmed" });
    if (!found.exists || found.data.revision > 0n) {
      throw new DemoError(`refusing: ${instanceId} is Used: Khunou's position in ${LENDER_LOT.lotId} has moved. Use --run next.`);
    }
  }
  // Refusal 9: the refused driver's wallet holds no Authority on this instance.
  const refusedWallet = cast.wallets["mosela-refused"] as Address;
  const [refusedAuthority] = await findAuthorityPda({ protocol, wallet: refusedWallet });
  const assertRefusedHasNone = async () => {
    if (await exists(refusedAuthority)) {
      throw new DemoError(
        `refusing: mosela-refused (${refusedWallet}) has an Authority on ${instanceId} (${refusedAuthority}); the refused driver must hold none.`,
      );
    }
  };
  await assertRefusedHasNone();

  // The lender scenario's issue text and issuing key.
  let issueText: IssueText | null = null;
  let issuer: TransactionSigner | null = null;
  if (args.scenario === "lender") {
    issueText = await deps.issueText();
    if (issueText === null) throw new DemoError(`refusing: ${NEEDS_T067R}. Nothing was sent or wiped.`);
    // Read when present; a missing key is created only after every refusal has passed (item 8).
    issuer = existsSync(keyPath(keysDir, ISSUER_KEY)) ? await readKeyFile(keyPath(keysDir, ISSUER_KEY)) : null;
  }

  const runFile: RunFile = existingRun ?? {
    scenario: args.scenario,
    instanceId,
    protocol,
    t0: Number(t0),
    expiresAt: Number(expiresAt),
    explorer: `https://explorer.solana.com/address/${protocol}?cluster=devnet`,
    authorities: [],
    custodianClasses: [],
    lookupTable: null,
    lot: null,
    transactions: [],
    supabase: { status: "pending", users: [] },
  };
  runFile.authorities = [];
  for (const delegation of DELEGATIONS) {
    const wallet = cast.wallets[delegation.key] as Address;
    const [authority] = await findAuthorityPda({ protocol, wallet });
    runFile.authorities.push({
      key: delegation.key,
      wallet,
      organisation: delegation.slug,
      address: authority,
      scopes: delegation.scopes,
    });
  }
  runFile.custodianClasses = [];
  for (const custodianClass of CUSTODIAN_CLASSES) {
    runFile.custodianClasses.push({
      site: custodianClass.site,
      address: await custodianClassPda(protocol, await orgPda(custodianClass.slug), classPolicy, custodianClass.site),
      approvedKg: custodianClass.approvedKg.toString(),
    });
  }
  const persist = () => writePrivate(runPath(keysDir, instanceId, "json"), `${JSON.stringify(runFile, null, 2)}\n`);

  // The steps, each reading its account first.
  const planned = planSteps(args.scenario);
  const step = (name: string) => {
    const found = planned.find((p) => p.name === name);
    if (!found) throw new Error(`no planned step ${name}`);
    return found;
  };
  const steps: ExecStep[] = [];
  steps.push({
    ...step("initialize_protocol"),
    decide: async () => {
      const found = await fetchMaybeProtocol(chain.rpc, protocol, { commitment: "confirmed" });
      if (!found.exists) return "send";
      const differences = diffProtocol(found.data, {
        instanceId: instanceIdBytes(instance),
        settlementMode: instance.settlementMode,
        admin: admin.address,
        accreditor: accreditor.address,
      });
      if (differences.length > 0) throw differenceError(`protocol ${protocol}`, differences);
      return "skip";
    },
    build: async () => ({ instructions: [await buildInitializeProtocol(signers, instance)] }),
  });
  steps.push({
    ...step(`register_class ${SEED.classCode} v${SEED.classVersion}`),
    decide: async () => {
      const found = await fetchMaybeClassPolicy(chain.rpc, classPolicy, { commitment: "confirmed" });
      if (!found.exists) return "send";
      const differences = diffClass(found.data, wantedClass());
      if (differences.length > 0) throw differenceError(`class ${classPolicy}`, differences);
      return "skip";
    },
    build: async () => ({ instructions: [await buildRegisterClass(signers, instance)] }),
  });
  for (const organisation of organisations) {
    const orgAdmin = (orgAdmins.get(organisation.slug) as TransactionSigner).address;
    steps.push({
      ...step(`accredit_organisation ${organisation.slug}`),
      decide: async () => {
        const at = await orgPda(organisation.slug);
        const found = await fetchMaybeOrganisation(chain.rpc, at, { commitment: "confirmed" });
        if (!found.exists) return "send";
        const differences = diffOrganisation(found.data, {
          orgId: organisation.orgId,
          role: organisation.role,
          displayName: organisation.name,
          admin: orgAdmin,
        });
        if (differences.length > 0) throw differenceError(`organisation ${organisation.slug} (${at})`, differences);
        return "skip";
      },
      build: async () => ({
        instructions: [await buildAccreditOrganisation(signers, organisation, orgAdmin, instance)],
      }),
    });
  }
  for (const [index, custodianClass] of CUSTODIAN_CLASSES.entries()) {
    const at = runFile.custodianClasses[index]?.address as Address;
    steps.push({
      ...step(`accredit_custodian_class ${custodianClass.site}`),
      decide: async () => {
        const found = await fetchMaybeCustodianClass(chain.rpc, at, { commitment: "confirmed" });
        if (!found.exists) return "send";
        const differences: string[] = [];
        if (found.data.custodian !== (await orgPda(custodianClass.slug))) differences.push("custodian differs");
        if (found.data.classPolicy !== classPolicy) differences.push("classPolicy differs");
        if (found.data.siteCode !== custodianClass.site) differences.push(`siteCode: found ${found.data.siteCode}`);
        if (found.data.approvedCapacityKg !== custodianClass.approvedKg) {
          differences.push(`approvedCapacityKg: found ${found.data.approvedCapacityKg}, wanted ${custodianClass.approvedKg}`);
        }
        if (differences.length > 0) throw differenceError(`custodian class ${custodianClass.site} (${at})`, differences);
        return "skip";
      },
      build: async () => ({
        instructions: [
          getAccreditCustodianClassInstruction({
            protocol,
            custodian: await orgPda(custodianClass.slug),
            classPolicy,
            custodianClass: at,
            accreditor,
            payer: deployer,
            siteCode: custodianClass.site,
            approvedCapacityKg: custodianClass.approvedKg,
          }),
        ],
      }),
    });
  }
  const delegateStep = (name: string, slug: string, wallet: Address, scopes: number): ExecStep => ({
    ...step(name),
    decide: async () => {
      const [at] = await findAuthorityPda({ protocol, wallet });
      const found = await fetchMaybeAuthority(chain.rpc, at, { commitment: "confirmed" });
      if (!found.exists) return "send";
      const differences: string[] = [];
      if (found.data.organisation !== (await orgPda(slug))) differences.push("organisation differs");
      if (found.data.scopes !== scopes) differences.push(`scopes: found ${found.data.scopes}, wanted ${scopes}`);
      if (found.data.expiresAt !== expiresAt) {
        differences.push(`expiresAt: found ${found.data.expiresAt}, wanted ${expiresAt}`);
      }
      if (found.data.revokedAt.__option !== "None") differences.push("revoked");
      if (differences.length > 0) throw differenceError(`authority for ${wallet} (${at})`, differences);
      return "skip";
    },
    build: async () => {
      const [at] = await findAuthorityPda({ protocol, wallet });
      return {
        instructions: [
          getDelegateAuthorityInstruction({
            protocol,
            organisation: await orgPda(slug),
            authority: at,
            admin: orgAdmins.get(slug) as TransactionSigner,
            payer: deployer,
            wallet,
            scopes,
            expiresAt,
          }),
        ],
      };
    },
  });
  for (const delegation of DELEGATIONS) {
    steps.push(
      delegateStep(
        `delegate_authority ${delegation.key}`,
        delegation.slug,
        cast.wallets[delegation.key] as Address,
        delegation.scopes,
      ),
    );
  }

  if (args.scenario === "lender") {
    const custodianOrg = await orgPda(LENDER_LOT.custodian);
    const ownerOrg = await orgPda(LENDER_LOT.owner);
    const yard = runFile.custodianClasses.find((c) => c.site === LENDER_LOT.site)?.address as Address;
    const digest = intakeDigest();
    const [intake] = await findIntakePda({ protocol, custodian: custodianOrg, intakeDigest: digest });
    const [mint] = await findMintPda({ lot });
    const [mintAuthority] = await findMintAuthorityPda({ mint });
    const [position] = await findPositionPda({ lot, owner: ownerOrg });
    const [vaultAuthority] = await findVaultAuthorityPda({ position });
    const [vault] = await findAssociatedTokenPda({ owner: vaultAuthority, mint, tokenProgram: TOKEN_2022 });
    // The issuer may be created after the decisions (item 8), so everything that names it reads it late.
    const issuerAuthority = async (): Promise<Address | null> =>
      issuer === null ? null : (await findAuthorityPda({ protocol, wallet: issuer.address }))[0];
    const tableKeys = async (): Promise<Address[]> => [
      protocol,
      (await issuerAuthority()) as Address,
      ownerOrg,
      custodianOrg,
      classPolicy,
      yard,
      intake,
      lot,
      mint,
      mintAuthority,
      position,
      vaultAuthority,
      vault,
      INSTRUCTIONS_SYSVAR,
      TOKEN_2022,
      ASSOCIATED_TOKEN_PROGRAM,
      SYSTEM_PROGRAM,
    ];
    if ((await tableKeys()).length !== LOOKUP_KEY_COUNT) throw new Error("lookup key count changed");

    const issuerStep = (): ExecStep =>
      delegateStep(`delegate_authority ${ISSUER_KEY}`, LENDER_LOT.custodian, (issuer as TransactionSigner).address, SCOPE.ISSUE);
    steps.push({
      ...step(`delegate_authority ${ISSUER_KEY}`),
      // No issuer key yet: its Authority can't exist, and the key is made after the refusals.
      decide: async () => (issuer === null ? "send" : issuerStep().decide()),
      build: async () => {
        if (issuer === null) throw new DemoError("no issuer key");
        return issuerStep().build();
      },
    });
    // The table a confirmed create_lookup_table made: reused, never replaced by a second (item 3).
    const createdTable = (): boolean =>
      runFile.lookupTable !== null &&
      runFile.transactions.some(
        (entry) =>
          entry.step === "create_lookup_table" && entry.status === "confirmed" && entry.account === runFile.lookupTable,
      );
    steps.push({
      ...step("create_lookup_table"),
      decide: async () =>
        createdTable() ||
        (runFile.lookupTable !== null && (await chain.lookupTable(runFile.lookupTable as Address)) !== null)
          ? "skip"
          : "send",
      build: async () => {
        const recentSlot = await chain.slot();
        const [table, bump] = await findAddressLookupTablePda({ authority: deployer.address, recentSlot });
        runFile.lookupTable = table;
        return {
          instructions: [
            getCreateLookupTableInstruction({ address: [table, bump], authority: deployer, payer: deployer, recentSlot }),
          ],
          account: table,
        };
      },
    });
    const missingKeys = async (): Promise<Address[]> => {
      if (runFile.lookupTable === null) return tableKeys();
      const held = (await chain.lookupTable(runFile.lookupTable as Address)) ?? [];
      return (await tableKeys()).filter((key) => !held.includes(key));
    };
    steps.push({
      ...step("extend_lookup_table"),
      decide: async () => (issuer !== null && (await missingKeys()).length === 0 ? "skip" : "send"),
      build: async () => ({
        instructions: [
          getExtendLookupTableInstruction({
            address: runFile.lookupTable as Address,
            authority: deployer,
            payer: deployer,
            addresses: await missingKeys(),
          }),
        ],
      }),
      after: async () => {
        // A table's new keys are usable from the next slot.
        const extendedAt = await chain.slot();
        for (let attempt = 0; attempt < 60; attempt += 1) {
          if ((await chain.slot()) > extendedAt) return;
          await deps.sleep(500);
        }
        throw new DemoError("the chain did not pass the lookup table's extension slot");
      },
    });
    steps.push({
      ...step(`issue_lot ${LENDER_LOT.lotId}`),
      decide: async () => {
        const found = await fetchMaybeLot(chain.rpc, lot, { commitment: "confirmed" });
        if (!found.exists) return "send";
        const differences: string[] = [];
        if (found.data.lotId !== LENDER_LOT.lotId) differences.push(`lotId: found ${found.data.lotId}`);
        if (found.data.custodianClass !== yard) differences.push("custodianClass differs");
        if (differences.length > 0) throw differenceError(`lot ${lot}`, differences);
        return "skip";
      },
      build: async () => {
        const authority = await issuerAuthority();
        if (issuer === null || issueText === null || authority === null) throw new DemoError("no issuer");
        const validUntil = (await chain.unixTime()) + ISSUE_WINDOW_SECS;
        const text = issueText({
          programId: THETIS_PROGRAM_ADDRESS,
          instanceId: instanceIdBytes(instance),
          lotId: LENDER_LOT.lotId,
          classCode: SEED.classCode,
          classVersion: SEED.classVersion,
          grade: LENDER_LOT.grade,
          quantityKg: LENDER_LOT.quantityKg,
          owner: bySlug(LENDER_LOT.owner).name,
          custodian: bySlug(LENDER_LOT.custodian).name,
          siteCode: LENDER_LOT.site,
          intakeDigest: digest,
          validUntil,
        });
        const signature = await signBytes((issuer as KeyPairSigner).keyPair.privateKey, text);
        const table = runFile.lookupTable as Address;
        return {
          instructions: [
            getSetComputeUnitLimitInstruction({ units: COMPUTE_UNITS }),
            sharedMessageInstruction([{ wallet: issuer.address, signature }], text),
            getIssueLotInstruction({
              sponsor: deployer,
              protocol,
              authority,
              owner: ownerOrg,
              custodian: custodianOrg,
              classPolicy,
              custodianClass: yard,
              intake,
              lot,
              mint,
              mintAuthority,
              position,
              vaultAuthority,
              vault,
              tokenProgram: TOKEN_2022,
              lotId: LENDER_LOT.lotId,
              grade: LENDER_LOT.grade,
              quantityKg: LENDER_LOT.quantityKg,
              intakeDigest: digest,
              validUntil,
            }),
          ],
          tables: { [table]: (await chain.lookupTable(table)) ?? [] },
        };
      },
      after: async () => {
        runFile.lot = { lotId: LENDER_LOT.lotId, address: lot };
      },
    });
  }

  // Settle anything an earlier attempt left pending, before deciding anything (seed-demo.ts rules): a
  // landed transaction becomes confirmed, or failed when it carries an on-chain error; one not found
  // stays pending until its blockhash expires (the chain passed lastValidBlockHeight).
  const pending = runFile.transactions.filter((entry) => entry.status === "pending");
  if (pending.length > 0) {
    const statuses = await chain.statuses(pending.map((entry) => entry.signature));
    let height: bigint | undefined;
    for (const [index, entry] of pending.entries()) {
      const status = statuses[index] ?? null;
      if (status?.failed) entry.status = "failed";
      else if (status?.confirmed) entry.status = "confirmed";
      else if (status === null) {
        height ??= await chain.blockHeight();
        if (height > BigInt(entry.lastValidBlockHeight)) entry.status = "expired";
      }
      if (entry.status === "confirmed" && entry.step === "create_lookup_table" && entry.account !== undefined) {
        runFile.lookupTable = entry.account;
      }
    }
    const open = pending.find((entry) => entry.status === "pending");
    if (open) {
      const message = `${open.step} (${open.explorerUrl}) may still land`;
      if (args.yes) throw new DemoError(`refusing: ${message}. Nothing sent or wiped; run again shortly.`);
      log(`Warning: ${message}; the --yes run will refuse until it settles.`);
    }
  }

  // Decide every step before anything is sent: a difference stops the run with nothing spent.
  const actions: ResetResult["steps"] = [];
  for (const s of steps) actions.push({ label: s.label, name: s.name, action: await s.decide() });
  const toSend = planned.filter((p) => actions.find((a) => a.name === p.name)?.action === "send");
  const cost = estimateCost(toSend, rentEstimate);
  let exactRent = 0n;
  for (const p of toSend) for (const account of p.creates) exactRent += await chain.rent(account.bytes);
  const exact: Cost = { rent: exactRent, fees: cost.fees, total: exactRent + cost.fees };
  const balance = await chain.balance(deployer.address);

  log(`${args.yes ? "Reset" : "Dry run"}: scenario ${args.scenario}, instance ${instanceId}, protocol ${protocol}`);
  log(`  ${runFile.explorer}`);
  for (const action of actions) log(`  ${action.label.padEnd(4)}${action.name.padEnd(44)}${action.action}`);
  log(
    `Cost: ${toSend.length} transactions, rent ${sol(exact.rent)}, fees ${sol(exact.fees)}, total ${sol(exact.total)}; deployer ${deployer.address} holds ${sol(balance)}.`,
  );
  const sponsorPath = keyPath(keysDir, "sponsor");
  if (existsSync(sponsorPath)) {
    const sponsor = await readKeyFile(sponsorPath);
    const held = await chain.balance(sponsor.address);
    log(`Sponsor ${sponsor.address} holds ${sol(held)}${held < SPONSOR_WARN_LAMPORTS ? " (below 0.5 SOL: fund it before the run)" : ""}.`);
  }
  const checkpoint = checkpoints[0];
  log(
    checkpoint === undefined
      ? "Indexer: no indexer checkpoint in the local database."
      : `Indexer: indexer checkpoint for ${String(checkpoint.protocol)}, polled ${checkpoint.age === null ? "never" : `${String(checkpoint.age)} s ago`}.`,
  );
  log(
    marker === instanceId
      ? `Supabase: the local database already holds this run's cast (demo_run = ${instanceId}): no wipe; the six users and their memberships are only ensured.`
      : `Supabase: with --yes this wipes the local Supabase database (supabase db reset --local; demo_run = ${marker ?? "absent"}), then creates the six users and their memberships.`,
  );
  if (balance < exact.total + MARGIN_LAMPORTS) {
    const message = `the deployer balance ${sol(balance)} is below the plan's ${sol(exact.total)} plus 0.1 SOL`;
    if (args.yes) throw new DemoError(`refusing: ${message}. Fund it from the devnet faucet.`);
    log(`Warning: ${message}; the --yes run will refuse.`);
  }
  if (!args.yes) {
    log("Dry run: nothing sent, nothing wiped. Run again with --yes to reset.");
    return { instanceId, protocol, t0, expiresAt, steps: actions, cost: exact, sent: [], runFile: null };
  }
  // Every refusal has passed: only now may the lender's issuing key be created (item 8).
  if (args.scenario === "lender" && issuer === null) issuer = await loadOrCreateKey(keysDir, ISSUER_KEY);
  persist();

  persist();

  const sent: string[] = [];
  for (const s of steps) {
    if ((await s.decide()) === "skip") {
      log(`skip ${s.name}`);
      continue;
    }
    const { instructions, tables, account } = await s.build();
    const blockhash = await chain.latestBlockhash();
    const base = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(deployer, m),
      (m) =>
        setTransactionMessageLifetimeUsingBlockhash(
          { blockhash: blockhash.blockhash as Blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight },
          m,
        ),
      (m) => appendTransactionMessageInstructions(instructions, m),
    );
    const message = tables === undefined ? base : compressTransactionMessageUsingAddressLookupTables(base, tables);
    const signed = await signTransactionMessageWithSigners(message);
    const size = getTransactionEncoder().encode(signed).length;
    if (size > MAX_TRANSACTION_BYTES) {
      throw new DemoError(`${s.name}: the transaction is ${size} bytes, above devnet's ${MAX_TRANSACTION_BYTES}. Nothing sent.`);
    }
    const signature = getSignatureFromTransaction(signed);
    const entry: LoggedTransaction = {
      step: s.name,
      signature,
      status: "pending",
      explorerUrl: explorerUrl(signature),
      lastValidBlockHeight: blockhash.lastValidBlockHeight.toString(),
      ...(account === undefined ? {} : { account }),
    };
    runFile.transactions.push(entry);
    persist();
    try {
      await chain.submit(signed);
    } catch (error) {
      // A send error is not proof it didn't land: the entry stays pending and the rerun settles it
      // with getSignatureStatuses and lastValidBlockHeight before deciding anything (item 3).
      persist();
      throw new DemoError(
        `${s.name}: sending failed and the transaction may still land: ${entry.explorerUrl}\n` +
          `${error instanceof Error ? error.message : String(error)}\nRun the same command again to settle it.`,
      );
    }
    entry.status = "confirmed";
    await s.after?.();
    persist();
    sent.push(s.name);
    log(`sent ${s.label} ${s.name}: ${entry.explorerUrl}`);
  }
  if (args.scenario === "lender") runFile.lot = { lotId: LENDER_LOT.lotId, address: lot };
  await assertRefusedHasNone();
  persist();

  // The Supabase stage, after the chain stage, so Supabase never points at a half-seeded run.
  runFile.supabase = { status: "pending", users: runFile.supabase.users };
  persist();
  runFile.supabase = { status: "done", users: await resetCast(stack, instanceId, cast, organisations) };
  persist();
  const env = renderEnv(runFile);
  writePrivate(runPath(keysDir, instanceId, "env"), env);
  log(`Run file: ${runPath(keysDir, instanceId, "json")}`);
  log(`Env file: ${runPath(keysDir, instanceId, "env")}`);
  log("API (services/api pnpm dev): THETIS_NETWORK, THETIS_PROGRAM_ID, THETIS_PROTOCOL, THETIS_RPC_URL");
  log("Worker: THETIS_INDEXER=on plus THETIS_NETWORK, THETIS_PROGRAM_ID, THETIS_PROTOCOL, THETIS_RPC_URL, THETIS_FIRST_SIGNATURE");
  log("Web: THETIS_DATA_SOURCE, THETIS_NETWORK, THETIS_PROGRAM_ID, THETIS_PROTOCOL");
  log("Phones: no change, they read the instance from the index.");
  log(env);
  log("Next (demo.md §5.7): start the worker, API and web with these lines; adb reverse 3200 and 54321;");
  log("sign in on both phones and the browser (codes in Mailpit); link the eight wallets;");
  log("Lender One opens its facility and sets the valuation, Lender Two opens its facility;");
  log(`then pnpm demo:check --run ${instanceId}`);
  return { instanceId, protocol, t0, expiresAt, steps: actions, cost: exact, sent, runFile };
}

// ---------------------------------------------------------------------------------------------
// demo:check (demo.md §5.4)
// ---------------------------------------------------------------------------------------------

export type CheckItem = { item: string; ok: boolean; detail: string };

export async function check(
  instanceId: string,
  deps: { stack: LocalStack; keysDir: string; repoRoots: readonly string[]; log: (line: string) => void },
): Promise<{ ok: boolean; items: CheckItem[] }> {
  const keysDir = assertKeysDirOutsideRepo(deps.keysDir, deps.repoRoots);
  const run = readRunFile(keysDir, instanceId);
  if (run === null) throw new DemoError(`refusing: no run file for ${instanceId}; run demo:reset first.`);
  const cast = loadCast(keysDir, deps.log, new Map());
  const p = run.protocol;
  if (!isAddress(p)) throw new DemoError(`the run file's protocol ${p} is not an address`);
  const q = (sql: string) => deps.stack.query(sql);
  const items: CheckItem[] = [];
  const add = (item: string, ok: boolean, detail: string) => items.push({ item, ok, detail });

  const checkpoints = await q("select protocol, status::text as status from public.indexer_checkpoints");
  add(
    "indexer follows this run and is live",
    checkpoints.length === 1 && checkpoints[0]?.protocol === p && checkpoints[0]?.status === "live",
    JSON.stringify(checkpoints),
  );
  const orgs = await q(`select org_id, synthetic from public.chain_organisations where protocol = '${p}'`);
  add(
    "seven organisations indexed, all synthetic",
    orgs.length === 7 && orgs.every((row) => row.synthetic === true),
    `${orgs.length} indexed, ${orgs.filter((row) => row.synthetic === true).length} synthetic`,
  );
  const classes = await q(
    `select site_code, approved_capacity_kg from public.chain_custodian_classes where protocol = '${p}'`,
  );
  for (const custodianClass of CUSTODIAN_CLASSES) {
    const row = classes.find((r) => r.site_code === custodianClass.site);
    add(
      `custodian class ${custodianClass.site} at ${custodianClass.approvedKg} kg`,
      row?.approved_capacity_kg === custodianClass.approvedKg.toString(),
      row === undefined ? "not indexed" : `approved ${String(row.approved_capacity_kg)} kg`,
    );
  }
  const authorities = await q(
    `select wallet, scopes, expires_at, revoked_at from public.chain_authorities where protocol = '${p}'`,
  );
  for (const delegation of DELEGATIONS) {
    const wallet = cast.wallets[delegation.key];
    const row = authorities.find((r) => r.wallet === wallet);
    add(
      `${delegation.key} Authority (scopes ${delegation.scopes})`,
      row !== undefined &&
        Number(row.scopes) === delegation.scopes &&
        String(row.expires_at) === String(run.expiresAt) &&
        row.revoked_at === null,
      row === undefined ? "not indexed" : `scopes ${String(row.scopes)}, expires ${String(row.expires_at)}`,
    );
  }
  // Exactly the delegated wallets, no more (item 6): 7 in phone, 8 in lender with the seed issuer.
  const wantedCount = DELEGATIONS.length + (run.scenario === "lender" ? 1 : 0);
  add(
    `exactly ${wantedCount} Authorities on ${instanceId}`,
    authorities.length === wantedCount,
    `${authorities.length} indexed`,
  );
  if (run.scenario === "lender") {
    const issuerPath = keyPath(keysDir, ISSUER_KEY);
    const issuer = existsSync(issuerPath) ? (await readKeyFile(issuerPath)).address : null;
    const row = issuer === null ? undefined : authorities.find((r) => r.wallet === issuer);
    add(
      `${ISSUER_KEY} Authority (scopes ${SCOPE.ISSUE})`,
      row !== undefined &&
        Number(row.scopes) === SCOPE.ISSUE &&
        String(row.expires_at) === String(run.expiresAt) &&
        row.revoked_at === null,
      issuer === null ? `${issuerPath} is missing` : row === undefined ? "not indexed" : `scopes ${String(row.scopes)}`,
    );
  }
  add(
    "mosela-refused holds no Authority",
    !authorities.some((r) => r.wallet === cast.wallets["mosela-refused"]),
    "",
  );
  const links = await q(
    "select l.wallet, o.slug from public.signer_links l join public.organisations o on o.id = l.organisation_id where l.revoked_at is null",
  );
  for (const key of WALLET_KEYS) {
    const slug = key === "mosela-refused" ? "mosela" : key;
    const row = links.find((r) => r.wallet === cast.wallets[key]);
    add(`${key} wallet linked to ${slug}`, row?.slug === slug, row === undefined ? "not linked" : `linked to ${String(row.slug)}`);
  }
  if (run.scenario === "lender") {
    const lots = await q(
      `select state, supply_kg from public.chain_lots where protocol = '${p}' and lot_id = '${LENDER_LOT.lotId}'`,
    );
    add(
      `${LENDER_LOT.lotId} stored, 5,000 t`,
      lots[0]?.state === "Stored" && lots[0]?.supply_kg === LENDER_LOT.quantityKg.toString(),
      JSON.stringify(lots),
    );
  }
  for (const entry of items) deps.log(`${entry.ok ? "ok  " : "MISS"} ${entry.item}${entry.detail ? `: ${entry.detail}` : ""}`);
  const ok = items.every((entry) => entry.ok);
  deps.log(ok ? `${instanceId} is ready.` : `${instanceId} is not ready: fix the MISS items, then check again.`);
  return { ok, items };
}

// ---------------------------------------------------------------------------------------------

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  const args = parseArgs(argv, env);
  const repoRoots = repositoryRoots();
  const repoRoot = repoRoots[0] as string;
  const keysDir = resolveKeysDir(env);
  const stack = localStack(repoRoot);
  if (args.mode === "check") {
    const result = await check(args.instanceId, { stack, keysDir, repoRoots, log: console.log });
    return result.ok ? 0 : 1;
  }
  await reset(args, {
    chain: devnetChain(),
    stack,
    keysDir,
    repoRoots,
    seedSql: readFileSync(SEED_SQL_PATH, "utf8"),
    log: console.log,
    issueText: loadIssueText,
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  });
  return 0;
}

if (import.meta.main) {
  main(process.argv.slice(2), process.env)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
