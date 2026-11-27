// Seeds the Thetis program on devnet with the demo's fixed values:
//
//   node scripts/seed-demo.ts                              # the fiat-attestation instance (default)
//   node scripts/seed-demo.ts --instance token-simulation  # the devnet token-simulation instance
//
// What the default run seeds (the whole list; nothing else is sent):
//   - initialize_protocol: instance id = the 16 ASCII bytes "fiat-attestation", settlement mode
//     FiatAttestationTest, an admin key and a separate accreditor key (both generated here).
//   - register_class: class code CHROME, version 1, grades ["G1"], origin_required false,
//     lot_validity_secs 7,776,000 (90 days), split_inherits_expiry true.
//   - accredit_organisation, once per row of the organisations insert in supabase/seed.sql: org_id is
//     the 16 bytes of the row's fixed UUID, the role comes from its kind, display_name is its name,
//     and admin is that organisation's own generated key (org-<slug>.json).
//
// What the token-simulation run seeds (the whole list; nothing else is sent):
//   - initialize_protocol: instance id = the 16 ASCII bytes "token-simulation", settlement mode
//     DevnetTokenSimulation, the same admin and accreditor keys.
//   - a test mint: a classic SPL Token mint with 2 decimals (USD cents), no freeze authority, its
//     mint authority the key sim-mint-authority.json, and an initial supply of 0. The mint's own key
//     is sim-mint.json, so a rerun finds the same mint.
//   - open_pool: currency "USD", sent by the admin on that mint.
//   - register_class and accredit_organisation exactly as above, with the same organisations and the
//     same organisation keys, under the simulation instance.
//
// Devnet only: the RPC and websocket URLs are pinned below, the Solana CLI is never run, and so the
// machine's own Solana config is never read. Keys live outside the repository in THETIS_KEYS_DIR
// (default $HOME/.config/thetis/devnet) and are created only when missing. Safe to run again: every
// step first reads its account and sends nothing when the account already holds the wanted values,
// and stops with the difference when it holds other values.
//
// Every transaction is signed and written to seed-log.json as "pending" before it is sent, then marked
// "confirmed" once it lands. A rerun first settles pending entries with getSignatureStatuses. The
// default instance's transactions stay at the top level of seed-log.json; the simulation instance's
// are kept apart under "instances", keyed by its instance id.

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AccountRole,
  type AccountSignerMeta,
  type Address,
  address,
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  fetchEncodedAccount,
  getAddressDecoder,
  getAddressEncoder,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  type Instruction,
  type ReadonlyUint8Array,
  type Signature,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type TransactionSigner,
} from "@solana/kit";
import {
  fetchMaybeClassPolicy,
  fetchMaybeOrganisation,
  fetchMaybeProtocol,
  fetchMaybeSimulationPool,
  findOrganisationPda,
  findPoolAuthorityPda,
  findPoolPda,
  findProtocolPda,
  getAccreditOrganisationInstruction,
  getInitializeProtocolInstruction,
  getOpenPoolInstruction,
  getRegisterClassInstruction,
  Role,
  SettlementMode,
  THETIS_PROGRAM_ADDRESS,
} from "@thetis/contracts";

export const DEVNET_RPC_URL = "https://api.devnet.solana.com";
export const DEVNET_WS_URL = "wss://api.devnet.solana.com";
const DEVNET_VALUES = new Set(["devnet", DEVNET_RPC_URL]);

export const SEED = {
  instanceId: "fiat-attestation",
  settlementMode: "FiatAttestationTest",
  classCode: "CHROME",
  classVersion: 1,
  grades: ["G1"],
  originRequired: false,
  lotValiditySecs: 7_776_000n,
  splitInheritsExpiry: true,
} as const;

export type InstanceName = "fiat-attestation" | "token-simulation";

export type InstanceSpec = {
  /** 16 ASCII bytes: this script's two names, or a demo run's id (scripts/demo-reset.ts). */
  readonly instanceId: string;
  readonly settlementMode: "FiatAttestationTest" | "DevnetTokenSimulation";
};

/** The instances this script can seed. The instance id is 16 ASCII bytes and doubles as the name. */
export const INSTANCES: Readonly<Record<InstanceName, InstanceSpec>> = {
  "fiat-attestation": { instanceId: SEED.instanceId, settlementMode: SEED.settlementMode },
  "token-simulation": { instanceId: "token-simulation", settlementMode: "DevnetTokenSimulation" },
};

export const DEFAULT_INSTANCE: InstanceSpec = INSTANCES[SEED.instanceId];
export const SIMULATION_INSTANCE: InstanceSpec = INSTANCES["token-simulation"];

/** The simulation pool's test token and pool currency. */
export const SIMULATION = {
  currency: "USD",
  mintDecimals: 2,
  mintStep: "create_test_mint",
  openPoolStep: "open_pool USD",
} as const;

export const TOKEN_PROGRAM_ADDRESS = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ASSOCIATED_TOKEN_PROGRAM_ADDRESS = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const SYSTEM_PROGRAM_ADDRESS = address("11111111111111111111111111111111");
/** The size of a classic SPL Token mint account. */
export const MINT_ACCOUNT_SIZE = 82;

export type RoleName = Exclude<keyof typeof Role, number>;

const ROLE_BY_KIND: Record<string, RoleName> = {
  exporter: "Exporter",
  buyer: "Buyer",
  custodian: "Custodian",
  transporter: "Transporter",
  terminal: "Terminal",
  lender: "Lender",
};

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const SEED_SQL = join(REPO_ROOT, "supabase", "seed.sql");
export const SEED_SQL_PATH = SEED_SQL;

// ---------------------------------------------------------------------------------------------
// Pure parts (no network, no files except where a path is passed in)
// ---------------------------------------------------------------------------------------------

export type SeedOrganisation = {
  id: string;
  slug: string;
  name: string;
  kind: string;
  role: RoleName;
  orgId: Uint8Array;
  /** The row's `synthetic` value; false when the insert has no such column. */
  synthetic: boolean;
};

// Decoded enums arrive as their numeric value although the generated type says the name; accept both.
export function enumName(names: Record<number, string>, value: string | number): string {
  return typeof value === "number" ? (names[value] ?? `unknown(${value})`) : value;
}

export class SeedError extends Error {}

const URL_FLAGS = ["--url", "-u", "--cluster", "--provider.cluster"];
const URL_ENV = ["CLUSTER", "URL", "SOLANA_URL", "SOLANA_CLUSTER", "ANCHOR_PROVIDER_URL"];

const INSTANCE_FLAG = "--instance";

export function instanceByName(name: string | undefined): InstanceSpec {
  if (name === undefined || !Object.hasOwn(INSTANCES, name)) {
    throw new SeedError(
      `refusing: ${INSTANCE_FLAG} ${name ?? "(missing)"} is not an instance this script seeds (${Object.keys(INSTANCES).join(", ")}).`,
    );
  }
  return INSTANCES[name as InstanceName];
}

/** Checks the arguments and returns the instance they name (the default one when none is given). */
function readArguments(argv: readonly string[]): InstanceSpec {
  let instance: InstanceSpec | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    if (flag !== INSTANCE_FLAG && !URL_FLAGS.includes(flag)) {
      throw new SeedError(
        `refusing: unknown argument ${arg}. This script takes only ${INSTANCE_FLAG} <name> and a devnet --url.`,
      );
    }
    const value = eq === -1 ? argv[i + 1] : arg.slice(eq + 1);
    if (eq === -1) i += 1;
    if (flag === INSTANCE_FLAG) {
      if (instance !== undefined) throw new SeedError(`refusing: ${INSTANCE_FLAG} given more than once.`);
      instance = instanceByName(value);
    } else if (value === undefined || !DEVNET_VALUES.has(value)) {
      throw new SeedError(
        `refusing: ${flag} ${value ?? "(missing)"} is not devnet. This script only runs on devnet.`,
      );
    }
  }
  return instance ?? DEFAULT_INSTANCE;
}

/** Refuses any cluster or URL environment variable that is not devnet. */
export function assertDevnetEnv(env: NodeJS.ProcessEnv): void {
  for (const name of URL_ENV) {
    const value = env[name];
    if (value !== undefined && value !== "" && !DEVNET_VALUES.has(value)) {
      throw new SeedError(`refusing: ${name}=${value} is not devnet. This script only runs on devnet.`);
    }
  }
}

/** Refuses any cluster or URL override that is not devnet, and any argument it does not know. */
export function assertDevnetOnly(argv: readonly string[], env: NodeJS.ProcessEnv): void {
  assertDevnetEnv(env);
  readArguments(argv);
}

/** The values a --url style flag may take. */
export function isDevnetValue(value: string): boolean {
  return DEVNET_VALUES.has(value);
}

/** The flags that name a cluster or URL. */
export const CLUSTER_FLAGS: readonly string[] = URL_FLAGS;

/** The instance the arguments select: fiat-attestation unless --instance names another. */
export function parseInstance(argv: readonly string[]): InstanceSpec {
  return readArguments(argv);
}

function realpathOfExistingAncestor(path: string): string {
  const absolute = resolve(path);
  let probe = absolute;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) return absolute;
    probe = parent;
  }
  return join(realpathSync(probe), relative(probe, absolute));
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Refuses a keys directory that resolves inside any of the repository roots. */
export function assertKeysDirOutsideRepo(keysDir: string, repoRoots: readonly string[]): string {
  const resolved = realpathOfExistingAncestor(keysDir);
  for (const root of repoRoots) {
    if (isInside(resolved, realpathOfExistingAncestor(root))) {
      throw new SeedError(
        `refusing: THETIS_KEYS_DIR ${resolved} is inside the repository ${root}. Keep keys outside it.`,
      );
    }
  }
  return resolved;
}

export function resolveKeysDir(env: NodeJS.ProcessEnv): string {
  const configured = env.THETIS_KEYS_DIR;
  if (configured !== undefined && configured !== "") return resolve(configured);
  const home = env.HOME ?? homedir();
  return join(home, ".config", "thetis", "devnet");
}

/** The checkout's own root, plus the main checkout's root when this is a linked worktree. */
export function repositoryRoots(): string[] {
  const roots = [REPO_ROOT];
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (common !== "") roots.push(dirname(common));
  } catch {
    // Not a git checkout: the script's own root is all there is to guard.
  }
  return roots;
}

export function uuidToBytes(uuid: string): Uint8Array {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid)) {
    throw new SeedError(`not a lowercase UUID: ${uuid}`);
  }
  return Uint8Array.from(Buffer.from(uuid.replaceAll("-", ""), "hex"));
}

export function instanceIdBytes(instance: InstanceSpec = DEFAULT_INSTANCE): Uint8Array {
  const bytes = new TextEncoder().encode(instance.instanceId);
  if (bytes.length !== 16) throw new SeedError(`instance id must be 16 bytes, got ${bytes.length}`);
  return bytes;
}

type SqlValue = string | boolean | null;

function parseSqlTuples(body: string): SqlValue[][] {
  const tuples: SqlValue[][] = [];
  let i = 0;
  while (i < body.length) {
    const ch = body.charAt(i);
    if (ch !== "(") {
      if (/[\s,]/.test(ch)) {
        i += 1;
        continue;
      }
      throw new SeedError(`seed.sql: unexpected "${ch}" between rows`);
    }
    i += 1;
    const row: SqlValue[] = [];
    for (;;) {
      while (/\s/.test(body.charAt(i))) i += 1;
      if (body.charAt(i) === "'") {
        let text = "";
        i += 1;
        for (;;) {
          if (i >= body.length) throw new SeedError("seed.sql: unterminated string");
          if (body.charAt(i) === "'") {
            if (body.charAt(i + 1) === "'") {
              text += "'";
              i += 2;
              continue;
            }
            i += 1;
            break;
          }
          text += body.charAt(i);
          i += 1;
        }
        row.push(text);
      } else {
        const word = /^[A-Za-z]+/.exec(body.slice(i))?.[0];
        if (word === undefined) throw new SeedError(`seed.sql: cannot read a value at "${body.slice(i, i + 12)}"`);
        i += word.length;
        const lower = word.toLowerCase();
        if (lower === "true") row.push(true);
        else if (lower === "false") row.push(false);
        else if (lower === "null") row.push(null);
        else throw new SeedError(`seed.sql: unsupported value ${word}`);
      }
      while (/\s/.test(body.charAt(i))) i += 1;
      const next = body.charAt(i);
      i += 1;
      if (next === ",") continue;
      if (next === ")") break;
      throw new SeedError(`seed.sql: expected "," or ")" but found "${next}"`);
    }
    tuples.push(row);
  }
  return tuples;
}

/** Reads the organisations insert of supabase/seed.sql: the one source of the demo's parties. */
export function parseSeedOrganisations(sql: string): SeedOrganisation[] {
  const match =
    /insert\s+into\s+public\.organisations\s*\(([^)]*)\)\s*values\s*([\s\S]*?)\s*(?:on\s+conflict[\s\S]*?)?;/i.exec(
      sql,
    );
  if (match === null) throw new SeedError("seed.sql: no insert into public.organisations found");
  const columns = (match[1] as string).split(",").map((column) => column.trim());
  const column = (name: string): number => {
    const index = columns.indexOf(name);
    if (index === -1) throw new SeedError(`seed.sql: organisations insert has no ${name} column`);
    return index;
  };
  const [idAt, slugAt, nameAt, kindAt] = [column("id"), column("slug"), column("name"), column("kind")];
  const syntheticAt = columns.indexOf("synthetic");
  const rows = parseSqlTuples(match[2] as string);
  if (rows.length === 0) throw new SeedError("seed.sql: organisations insert has no rows");
  return rows.map((row) => {
    if (row.length !== columns.length) {
      throw new SeedError(`seed.sql: a row has ${row.length} values for ${columns.length} columns`);
    }
    const [id, slug, name, kind] = [row[idAt], row[slugAt], row[nameAt], row[kindAt]];
    if (
      typeof id !== "string" ||
      typeof slug !== "string" ||
      typeof name !== "string" ||
      typeof kind !== "string"
    ) {
      throw new SeedError("seed.sql: id, slug, name and kind must be text");
    }
    if (!/^[a-z0-9-]+$/.test(slug)) throw new SeedError(`seed.sql: unsafe slug ${slug}`);
    const role = ROLE_BY_KIND[kind];
    if (role === undefined) throw new SeedError(`seed.sql: no on-chain role for kind ${kind}`);
    const synthetic = syntheticAt === -1 ? false : row[syntheticAt] === true;
    return { id, slug, name, kind, role, orgId: uuidToBytes(id), synthetic };
  });
}

export type KeyRole =
  | "deployer"
  | "admin"
  | "accreditor"
  | "sim-mint"
  | "sim-mint-authority"
  | "kopano-seed-issuer"
  | `org-${string}`;

export function keyFileName(role: KeyRole): string {
  return `${role}.json`;
}

const textEncoder = new TextEncoder();

export async function findClassPolicyPda(
  protocol: Address,
  classCode: string,
  version: number,
): Promise<Address> {
  const versionLe = new Uint8Array(4);
  new DataView(versionLe.buffer).setUint32(0, version, true);
  const [address] = await getProgramDerivedAddress({
    programAddress: THETIS_PROGRAM_ADDRESS,
    seeds: [textEncoder.encode("class"), getAddressEncoder().encode(protocol), textEncoder.encode(classCode), versionLe],
  });
  return address;
}

/** Anchor's IDL cannot express the hash seed, so the marker address is derived here. */
export async function findOrganisationNamePda(protocol: Address, displayName: string): Promise<Address> {
  const digest = createHash("sha256").update(displayName.toLowerCase(), "ascii").digest();
  const [address] = await getProgramDerivedAddress({
    programAddress: THETIS_PROGRAM_ADDRESS,
    seeds: [textEncoder.encode("org_name"), getAddressEncoder().encode(protocol), digest],
  });
  return address;
}

export type Signers = {
  deployer: TransactionSigner;
  admin: TransactionSigner;
  accreditor: TransactionSigner;
};

export async function buildInitializeProtocol(
  signers: Signers,
  instance: InstanceSpec = DEFAULT_INSTANCE,
): Promise<Instruction> {
  const [protocol] = await findProtocolPda({ instanceId: instanceIdBytes(instance) });
  return getInitializeProtocolInstruction({
    protocol,
    admin: signers.admin,
    payer: signers.deployer,
    instanceId: instanceIdBytes(instance),
    settlementMode: SettlementMode[instance.settlementMode],
    adminArg: signers.admin.address,
    accreditor: signers.accreditor.address,
  });
}

export async function buildRegisterClass(
  signers: Signers,
  instance: InstanceSpec = DEFAULT_INSTANCE,
): Promise<Instruction> {
  const [protocol] = await findProtocolPda({ instanceId: instanceIdBytes(instance) });
  return getRegisterClassInstruction({
    protocol,
    classPolicy: await findClassPolicyPda(protocol, SEED.classCode, SEED.classVersion),
    accreditor: signers.accreditor,
    payer: signers.deployer,
    classCode: SEED.classCode,
    version: SEED.classVersion,
    grades: [...SEED.grades],
    originRequired: SEED.originRequired,
    lotValiditySecs: SEED.lotValiditySecs,
    splitInheritsExpiry: SEED.splitInheritsExpiry,
  });
}

export async function buildAccreditOrganisation(
  signers: Pick<Signers, "deployer" | "accreditor">,
  organisation: SeedOrganisation,
  orgAdmin: Address,
  instance: InstanceSpec = DEFAULT_INSTANCE,
): Promise<Instruction> {
  const [protocol] = await findProtocolPda({ instanceId: instanceIdBytes(instance) });
  const [organisationAddress] = await findOrganisationPda({ protocol, orgId: organisation.orgId });
  return getAccreditOrganisationInstruction({
    protocol,
    organisation: organisationAddress,
    organisationName: await findOrganisationNamePda(protocol, organisation.name),
    accreditor: signers.accreditor,
    payer: signers.deployer,
    orgId: organisation.orgId,
    role: Role[organisation.role],
    displayName: organisation.name,
    admin: orgAdmin,
  });
}

/** The token account the associated token program derives for an owner and a classic SPL Token mint. */
export async function findAssociatedTokenAddress(owner: Address, mint: Address): Promise<Address> {
  const encoder = getAddressEncoder();
  const [derived] = await getProgramDerivedAddress({
    programAddress: ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
    seeds: [encoder.encode(owner), encoder.encode(TOKEN_PROGRAM_ADDRESS), encoder.encode(mint)],
  });
  return derived;
}

export type PoolAddresses = { pool: Address; poolAuthority: Address; vault: Address };

/** The pool, its authority and its vault, as the program derives them for a protocol and a mint. */
export async function derivePoolAddresses(protocol: Address, mint: Address): Promise<PoolAddresses> {
  const [pool] = await findPoolPda({ protocol });
  const [poolAuthority] = await findPoolAuthorityPda({ pool });
  return { pool, poolAuthority, vault: await findAssociatedTokenAddress(poolAuthority, mint) };
}

/**
 * Creates the test mint and initialises it in one transaction: a classic SPL Token mint with
 * 2 decimals, the given mint authority and no freeze authority. Nothing is minted.
 */
export function buildCreateTestMint(args: {
  payer: TransactionSigner;
  mint: TransactionSigner;
  mintAuthority: Address;
  lamports: bigint;
}): Instruction[] {
  const createData = new Uint8Array(52);
  const createView = new DataView(createData.buffer);
  createView.setUint32(0, 0, true); // system program: CreateAccount
  createView.setBigUint64(4, args.lamports, true);
  createView.setBigUint64(12, BigInt(MINT_ACCOUNT_SIZE), true);
  createData.set(getAddressEncoder().encode(TOKEN_PROGRAM_ADDRESS), 20);

  const initData = new Uint8Array(35);
  initData[0] = 20; // token program: InitializeMint2
  initData[1] = SIMULATION.mintDecimals;
  initData.set(getAddressEncoder().encode(args.mintAuthority), 2);
  initData[34] = 0; // no freeze authority

  const createAccounts: readonly AccountSignerMeta[] = [
    { address: args.payer.address, role: AccountRole.WRITABLE_SIGNER, signer: args.payer },
    { address: args.mint.address, role: AccountRole.WRITABLE_SIGNER, signer: args.mint },
  ];
  return [
    { programAddress: SYSTEM_PROGRAM_ADDRESS, accounts: createAccounts, data: createData },
    {
      programAddress: TOKEN_PROGRAM_ADDRESS,
      accounts: [{ address: args.mint.address, role: AccountRole.WRITABLE }],
      data: initData,
    },
  ];
}

export async function buildOpenPool(
  signers: Pick<Signers, "deployer" | "admin">,
  mint: Address,
  instance: InstanceSpec = SIMULATION_INSTANCE,
): Promise<Instruction> {
  const [protocol] = await findProtocolPda({ instanceId: instanceIdBytes(instance) });
  const { pool, poolAuthority, vault } = await derivePoolAddresses(protocol, mint);
  return getOpenPoolInstruction({
    admin: signers.admin,
    payer: signers.deployer,
    protocol,
    pool,
    poolAuthority,
    mint,
    poolVault: vault,
    currency: new TextEncoder().encode(SIMULATION.currency),
  });
}

function bytesEqual(a: ReadonlyUint8Array, b: ReadonlyUint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

type ProtocolFields = {
  instanceId: ReadonlyUint8Array;
  settlementMode: string | number;
  admin: string;
  accreditor: string;
};

export function diffProtocol(found: ProtocolFields, wanted: ProtocolFields): string[] {
  const differences: string[] = [];
  if (!bytesEqual(found.instanceId, wanted.instanceId)) differences.push("instanceId differs");
  const [foundMode, wantedMode] = [found.settlementMode, wanted.settlementMode].map((mode) =>
    enumName(SettlementMode, mode),
  );
  if (foundMode !== wantedMode) {
    differences.push(`settlementMode: found ${foundMode}, wanted ${wantedMode}`);
  }
  if (found.admin !== wanted.admin) differences.push(`admin: found ${found.admin}, wanted ${wanted.admin}`);
  if (found.accreditor !== wanted.accreditor) {
    differences.push(`accreditor: found ${found.accreditor}, wanted ${wanted.accreditor}`);
  }
  return differences;
}

type ClassFields = {
  classCode: string;
  version: number;
  grades: readonly string[];
  originRequired: boolean;
  lotValiditySecs: bigint;
  splitInheritsExpiry: boolean;
};

export function wantedClass(): ClassFields {
  return {
    classCode: SEED.classCode,
    version: SEED.classVersion,
    grades: SEED.grades,
    originRequired: SEED.originRequired,
    lotValiditySecs: SEED.lotValiditySecs,
    splitInheritsExpiry: SEED.splitInheritsExpiry,
  };
}

export function diffClass(found: ClassFields, wanted: ClassFields): string[] {
  const differences: string[] = [];
  if (found.classCode !== wanted.classCode) differences.push(`classCode: found ${found.classCode}, wanted ${wanted.classCode}`);
  if (found.version !== wanted.version) differences.push(`version: found ${found.version}, wanted ${wanted.version}`);
  if (found.grades.join(",") !== wanted.grades.join(",")) {
    differences.push(`grades: found [${found.grades.join(",")}], wanted [${wanted.grades.join(",")}]`);
  }
  if (found.originRequired !== wanted.originRequired) {
    differences.push(`originRequired: found ${found.originRequired}, wanted ${wanted.originRequired}`);
  }
  if (found.lotValiditySecs !== wanted.lotValiditySecs) {
    differences.push(`lotValiditySecs: found ${found.lotValiditySecs}, wanted ${wanted.lotValiditySecs}`);
  }
  if (found.splitInheritsExpiry !== wanted.splitInheritsExpiry) {
    differences.push(`splitInheritsExpiry: found ${found.splitInheritsExpiry}, wanted ${wanted.splitInheritsExpiry}`);
  }
  return differences;
}

type OrganisationFields = { orgId: ReadonlyUint8Array; role: string | number; displayName: string; admin: string };

export function diffOrganisation(found: OrganisationFields, wanted: OrganisationFields): string[] {
  const differences: string[] = [];
  if (!bytesEqual(found.orgId, wanted.orgId)) differences.push("orgId differs");
  const [foundRole, wantedRole] = [found.role, wanted.role].map((role) => enumName(Role, role));
  if (foundRole !== wantedRole) differences.push(`role: found ${foundRole}, wanted ${wantedRole}`);
  if (found.displayName !== wanted.displayName) {
    differences.push(`displayName: found ${found.displayName}, wanted ${wanted.displayName}`);
  }
  if (found.admin !== wanted.admin) differences.push(`admin: found ${found.admin}, wanted ${wanted.admin}`);
  return differences;
}

export type MintAccount = { programAddress: string; data: ReadonlyUint8Array };

/**
 * Compares an existing account with the wanted test mint: owned by the classic Token program,
 * initialised, 2 decimals, no freeze authority, and the wanted mint authority. The supply is not
 * compared: it is 0 at creation and grows when test tokens are minted afterwards.
 */
export function diffMint(found: MintAccount, wanted: { mintAuthority: string }): string[] {
  if (found.programAddress !== TOKEN_PROGRAM_ADDRESS) {
    return [`owner: found ${found.programAddress}, wanted ${TOKEN_PROGRAM_ADDRESS}`];
  }
  const data = found.data;
  if (data.length !== MINT_ACCOUNT_SIZE) {
    return [`data length: found ${data.length}, wanted ${MINT_ACCOUNT_SIZE}`];
  }
  const differences: string[] = [];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data[45] !== 1) differences.push("mint is not initialised");
  if (data[44] !== SIMULATION.mintDecimals) {
    differences.push(`decimals: found ${data[44]}, wanted ${SIMULATION.mintDecimals}`);
  }
  const optionalKey = (tagAt: number): string | "none" | "malformed" => {
    const tag = view.getUint32(tagAt, true);
    if (tag === 0) return "none";
    if (tag !== 1) return "malformed";
    return getAddressDecoder().decode(data.slice(tagAt + 4, tagAt + 36));
  };
  const mintAuthority = optionalKey(0);
  if (mintAuthority !== wanted.mintAuthority) {
    differences.push(`mintAuthority: found ${mintAuthority}, wanted ${wanted.mintAuthority}`);
  }
  const freezeAuthority = optionalKey(46);
  if (freezeAuthority !== "none") {
    differences.push(`freezeAuthority: found ${freezeAuthority}, wanted none`);
  }
  return differences;
}

export type PoolFields = {
  protocol: string;
  mint: string;
  vault: string;
  currency: ReadonlyUint8Array;
  currencyDecimals: number;
};

/** Compares the pool's fixed fields. The counters are not compared: deposits and loans move them. */
export function diffPool(found: PoolFields, wanted: PoolFields): string[] {
  const differences: string[] = [];
  if (found.protocol !== wanted.protocol) {
    differences.push(`protocol: found ${found.protocol}, wanted ${wanted.protocol}`);
  }
  if (found.mint !== wanted.mint) differences.push(`mint: found ${found.mint}, wanted ${wanted.mint}`);
  if (found.vault !== wanted.vault) differences.push(`vault: found ${found.vault}, wanted ${wanted.vault}`);
  const [foundCurrency, wantedCurrency] = [found.currency, wanted.currency].map((currency) =>
    new TextDecoder().decode(Uint8Array.from(currency)),
  );
  if (foundCurrency !== wantedCurrency) {
    differences.push(`currency: found ${foundCurrency}, wanted ${wantedCurrency}`);
  }
  if (found.currencyDecimals !== wanted.currencyDecimals) {
    differences.push(`currencyDecimals: found ${found.currencyDecimals}, wanted ${wanted.currencyDecimals}`);
  }
  return differences;
}

/** The error for a step whose account already exists with other values. */
export function differenceError(what: string, differences: readonly string[]): SeedError {
  return new SeedError(
    `${what} already exists with different values; nothing sent for it:\n  ${differences.join("\n  ")}`,
  );
}

/** The part of the RPC that reading an account needs. */
export type AccountReader = Parameters<typeof fetchEncodedAccount>[0];

/** Whether the test mint must be created, or already holds the wanted values. Stops on any other mint. */
export async function decideTestMint(
  rpc: AccountReader,
  mint: Address,
  mintAuthority: Address,
): Promise<"create" | "skip"> {
  const account = await fetchEncodedAccount(rpc, mint, { commitment: "confirmed" });
  if (!account.exists) return "create";
  const differences = diffMint(account, { mintAuthority });
  if (differences.length > 0) throw differenceError(`test mint ${mint}`, differences);
  return "skip";
}

/** Whether the pool must be opened, or already holds the wanted values. Stops on any other pool. */
export async function decideOpenPool(
  rpc: AccountReader,
  wanted: PoolFields & { pool: Address },
): Promise<"open" | "skip"> {
  const pool = await fetchMaybeSimulationPool(rpc, wanted.pool, { commitment: "confirmed" });
  if (!pool.exists) return "open";
  const differences = diffPool(pool.data, wanted);
  if (differences.length > 0) throw differenceError(`pool ${wanted.pool}`, differences);
  return "skip";
}

/**
 * Reads the pool and then the test mint, before anything is sent, and says what each step needs.
 * The pool is read first: its address does not depend on the mint, so a pool left by an earlier run
 * on another mint (for example after sim-mint.json was lost) stops the run here, before a new mint
 * is paid for.
 */
export async function decideSimulationSteps(
  rpc: AccountReader,
  wanted: { mintAuthority: Address; pool: PoolFields & { pool: Address } },
): Promise<{ pool: "open" | "skip"; mint: "create" | "skip" }> {
  const pool = await decideOpenPool(rpc, wanted.pool);
  const mint = await decideTestMint(rpc, wanted.pool.mint as Address, wanted.mintAuthority);
  return { pool, mint };
}

export function explorerUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}

// ---------------------------------------------------------------------------------------------
// Key files (Solana CLI format: a JSON array of 64 bytes, seed then public key)
// ---------------------------------------------------------------------------------------------

export function readKeyFile(path: string): Promise<TransactionSigner> {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 64 ||
    !parsed.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
  ) {
    throw new SeedError(`${path} is not a Solana keypair file (a JSON array of 64 bytes)`);
  }
  return createKeyPairSignerFromBytes(Uint8Array.from(parsed as number[]));
}

export async function loadOrCreateKey(keysDir: string, role: KeyRole): Promise<TransactionSigner> {
  const path = join(keysDir, keyFileName(role));
  if (existsSync(path)) return readKeyFile(path);
  const seed = Uint8Array.from(randomBytes(32));
  const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
  const pair = new Uint8Array(64);
  pair.set(seed, 0);
  pair.set(getAddressEncoder().encode(signer.address), 32);
  writeFileSync(path, JSON.stringify(Array.from(pair)), { flag: "wx", mode: 0o600 });
  chmodSync(path, 0o600);
  console.log(`created ${path} (${signer.address})`);
  return signer;
}

// ---------------------------------------------------------------------------------------------
// The seed run
// ---------------------------------------------------------------------------------------------

export type LogStatus = "pending" | "confirmed" | "failed" | "expired";
export type LoggedTransaction = {
  step: string;
  signature: string;
  url: string;
  status: LogStatus;
  lastValidBlockHeight: string;
};

/** What the simulation instance keeps in seed-log.json: its addresses and its own transactions. */
export type InstanceLog = {
  protocol: string;
  mint?: string | undefined;
  pool?: string | undefined;
  vault?: string | undefined;
  transactions: LoggedTransaction[];
};

/**
 * seed-log.json. The default instance's protocol and transactions sit at the top level, as they
 * always have. Any other instance is kept apart under `instances`, keyed by its instance id.
 */
export type SeedLog = {
  cluster: "devnet";
  program: string;
  protocol?: string | undefined;
  transactions?: LoggedTransaction[] | undefined;
  instances?: Record<string, InstanceLog> | undefined;
};

const LOG_STATUSES: readonly string[] = ["pending", "confirmed", "failed", "expired"];

function validTransactions(transactions: unknown): transactions is LoggedTransaction[] {
  return (
    Array.isArray(transactions) &&
    transactions.every(
      (entry) =>
        typeof entry?.step === "string" &&
        typeof entry.signature === "string" &&
        typeof entry.url === "string" &&
        LOG_STATUSES.includes(entry.status) &&
        typeof entry.lastValidBlockHeight === "string",
    )
  );
}

function validInstanceLog(value: unknown): value is InstanceLog {
  const log = value as Partial<InstanceLog> | null;
  return (
    typeof log === "object" &&
    log !== null &&
    typeof log.protocol === "string" &&
    validTransactions(log.transactions) &&
    (["mint", "pool", "vault"] as const).every((key) => log[key] === undefined || typeof log[key] === "string")
  );
}

/** Reads seed-log.json, or returns nothing when there is none. Refuses a file this script did not write. */
export function readSeedLog(path: string): SeedLog | undefined {
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<SeedLog>;
  const transactions = parsed.transactions ?? [];
  const instances = parsed.instances ?? {};
  const valid =
    validTransactions(transactions) &&
    typeof instances === "object" &&
    instances !== null &&
    !Array.isArray(instances) &&
    Object.values(instances).every(validInstanceLog);
  if (!valid) throw new SeedError(`${path} is not a seed log this script wrote; not touching it`);
  return parsed as SeedLog;
}

/** The transactions an instance has logged: the top level for the default one, else its own entry. */
export function ownTransactions(log: SeedLog | undefined, instance: InstanceSpec): LoggedTransaction[] {
  return instance === DEFAULT_INSTANCE
    ? (log?.transactions ?? [])
    : (log?.instances?.[instance.instanceId]?.transactions ?? []);
}

/**
 * The log with one instance's part replaced and every other part kept as `current` has it. The
 * default instance owns the top-level protocol and transactions; any other owns its `instances` entry.
 */
export function mergeSeedLog(
  current: SeedLog | undefined,
  program: string,
  instance: InstanceSpec,
  own: InstanceLog,
): SeedLog {
  const merged: SeedLog = {
    cluster: "devnet",
    program,
    protocol: current?.protocol,
    transactions: current?.transactions,
    instances: { ...current?.instances },
  };
  if (instance === DEFAULT_INSTANCE) {
    merged.protocol = own.protocol;
    merged.transactions = own.transactions;
  } else {
    (merged.instances as Record<string, InstanceLog>)[instance.instanceId] = own;
  }
  return merged;
}

/** The log as written to disk: a fixed key order, and `instances` only when there is one. */
export function renderSeedLog(log: SeedLog): string {
  const ordered: SeedLog = {
    cluster: log.cluster,
    program: log.program,
    protocol: log.protocol,
    transactions: log.transactions,
    instances: log.instances === undefined || Object.keys(log.instances).length === 0 ? undefined : log.instances,
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/** The parts of the RPC that settling a pending entry needs. */
export type ReconcileRpc = {
  getSignatureStatuses(
    signatures: readonly Signature[],
    config: { searchTransactionHistory: boolean },
  ): {
    send(): Promise<{
      value: readonly ({ err: unknown; confirmationStatus: string | null } | null)[];
    }>;
  };
  getBlockHeight(): { send(): Promise<bigint> };
};

/**
 * Settles every pending entry in place. A landed transaction becomes confirmed, or failed when it
 * carries an error. One that cannot be found stays pending until its blockhash can no longer be used
 * (the chain is past lastValidBlockHeight), then becomes expired and may be sent again.
 */
export async function reconcilePending(rpc: ReconcileRpc, entries: LoggedTransaction[]): Promise<void> {
  const pending = entries.filter((entry) => entry.status === "pending");
  if (pending.length === 0) return;
  const { value } = await rpc
    .getSignatureStatuses(
      pending.map((entry) => entry.signature as Signature),
      { searchTransactionHistory: true },
    )
    .send();
  let height: bigint | undefined;
  for (const [index, entry] of pending.entries()) {
    const status = value[index] ?? null;
    if (status !== null && status.err !== null) {
      entry.status = "failed";
    } else if (
      status !== null &&
      (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")
    ) {
      entry.status = "confirmed";
    } else {
      height ??= await rpc.getBlockHeight().send();
      if (height > BigInt(entry.lastValidBlockHeight)) entry.status = "expired";
    }
  }
}

/** Refuses to act on a step whose earlier transaction may still land. */
export function assertNoPending(entries: readonly LoggedTransaction[], step: string): void {
  const open = entries.find((entry) => entry.step === step && entry.status === "pending");
  if (open !== undefined) {
    throw new SeedError(
      `${step}: transaction ${open.url} is still pending (it can land until block height ${open.lastValidBlockHeight}). Nothing sent; run again shortly.`,
    );
  }
}

/** Writes the signed transaction's signature to the log as pending, sends it, then marks it confirmed. */
export async function submitLogged(
  entries: LoggedTransaction[],
  signed: { step: string; signature: string; lastValidBlockHeight: bigint },
  send: () => Promise<void>,
  persist: () => void,
): Promise<LoggedTransaction> {
  const entry: LoggedTransaction = {
    step: signed.step,
    signature: signed.signature,
    url: explorerUrl(signed.signature),
    status: "pending",
    lastValidBlockHeight: signed.lastValidBlockHeight.toString(),
  };
  entries.push(entry);
  persist();
  await send();
  entry.status = "confirmed";
  persist();
  return entry;
}

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<void> {
  assertDevnetOnly(argv, env);
  const instance = parseInstance(argv);
  const simulation = instance.settlementMode === "DevnetTokenSimulation";
  const keysDir = assertKeysDirOutsideRepo(resolveKeysDir(env), repositoryRoots());
  const deployerPath = join(keysDir, keyFileName("deployer"));
  if (!existsSync(deployerPath)) {
    throw new SeedError(
      `${deployerPath} is missing. Create and fund the deployer first:\n` +
        `  mkdir -p "${keysDir}" && solana-keygen new --no-bip39-passphrase -o "${deployerPath}"\n` +
        "  then fund its address (solana-keygen pubkey) from the devnet faucet; see the README's Deployments section for how much",
    );
  }
  const organisations = parseSeedOrganisations(readFileSync(SEED_SQL, "utf8"));

  mkdirSync(keysDir, { recursive: true, mode: 0o700 });
  const deployer = await readKeyFile(deployerPath);
  const admin = await loadOrCreateKey(keysDir, "admin");
  const accreditor = await loadOrCreateKey(keysDir, "accreditor");
  const orgAdmins = new Map<string, TransactionSigner>();
  for (const organisation of organisations) {
    orgAdmins.set(organisation.slug, await loadOrCreateKey(keysDir, `org-${organisation.slug}`));
  }
  const simMintAuthority = simulation ? await loadOrCreateKey(keysDir, "sim-mint-authority") : undefined;
  const simMint = simulation ? await loadOrCreateKey(keysDir, "sim-mint") : undefined;
  const signers: Signers = { deployer, admin, accreditor };

  const rpc = createSolanaRpc(DEVNET_RPC_URL);
  const sendAndConfirm = sendAndConfirmTransactionFactory({
    rpc,
    rpcSubscriptions: createSolanaRpcSubscriptions(DEVNET_WS_URL),
  });

  const program = await rpc.getAccountInfo(THETIS_PROGRAM_ADDRESS, { encoding: "base64" }).send();
  if (program.value === null || !program.value.executable) {
    throw new SeedError(`program ${THETIS_PROGRAM_ADDRESS} is not deployed on devnet. Run scripts/deploy-devnet.sh first.`);
  }

  const logPath = join(keysDir, "seed-log.json");
  const existingLog = readSeedLog(logPath);
  const transactions: LoggedTransaction[] = ownTransactions(existingLog, instance);
  const [protocolAddress] = await findProtocolPda({ instanceId: instanceIdBytes(instance) });
  const pool =
    simMint === undefined ? undefined : await derivePoolAddresses(protocolAddress, simMint.address);

  const writeLog = (): void => {
    // Read the file again on every write: another instance's part may have changed since this run began.
    const log = mergeSeedLog(readSeedLog(logPath), THETIS_PROGRAM_ADDRESS, instance, {
      protocol: protocolAddress,
      mint: simMint?.address,
      pool: pool?.pool,
      vault: pool?.vault,
      transactions,
    });
    writeFileSync(logPath, renderSeedLog(log), { mode: 0o600 });
    chmodSync(logPath, 0o600);
  };

  await reconcilePending(rpc, transactions);
  writeLog();

  const send = async (step: string, instructions: readonly Instruction[]): Promise<void> => {
    assertNoPending(transactions, step);
    const { value: latestBlockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(deployer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    );
    const signed = await signTransactionMessageWithSigners(message);
    assertIsTransactionWithBlockhashLifetime(signed);
    const signature = getSignatureFromTransaction(signed);
    const entry = await submitLogged(
      transactions,
      { step, signature, lastValidBlockHeight: latestBlockhash.lastValidBlockHeight },
      () => sendAndConfirm(signed, { commitment: "confirmed" }),
      writeLog,
    );
    console.log(`sent ${step}: ${entry.url}`);
  };

  // Simulation only: read the pool and the test mint before anything is sent, so a difference stops the run
  // with nothing spent.
  const wantedPool =
    simMint !== undefined && pool !== undefined
      ? {
          pool: pool.pool,
          protocol: protocolAddress,
          mint: simMint.address,
          vault: pool.vault,
          currency: new TextEncoder().encode(SIMULATION.currency),
          currencyDecimals: SIMULATION.mintDecimals,
        }
      : undefined;
  const simulationPlan =
    wantedPool !== undefined && simMintAuthority !== undefined
      ? await decideSimulationSteps(rpc, { mintAuthority: simMintAuthority.address, pool: wantedPool })
      : undefined;

  // 1. initialize_protocol
  const protocol = await fetchMaybeProtocol(rpc, protocolAddress, { commitment: "confirmed" });
  if (protocol.exists) {
    const differences = diffProtocol(protocol.data, {
      instanceId: instanceIdBytes(instance),
      settlementMode: instance.settlementMode,
      admin: admin.address,
      accreditor: accreditor.address,
    });
    if (differences.length > 0) throw differenceError(`protocol ${protocolAddress}`, differences);
    console.log(`skip initialize_protocol: ${protocolAddress} already holds the wanted values`);
  } else {
    await send("initialize_protocol", [await buildInitializeProtocol(signers, instance)]);
  }

  // 2 and 3 (simulation only). The test mint, then the pool opened on it by the admin.
  if (simulationPlan !== undefined && simMint !== undefined && simMintAuthority !== undefined && pool !== undefined) {
    if (simulationPlan.mint === "create") {
      const lamports = await rpc.getMinimumBalanceForRentExemption(BigInt(MINT_ACCOUNT_SIZE)).send();
      await send(
        SIMULATION.mintStep,
        buildCreateTestMint({
          payer: deployer,
          mint: simMint,
          mintAuthority: simMintAuthority.address,
          lamports,
        }),
      );
    } else {
      console.log(`skip ${SIMULATION.mintStep}: ${simMint.address} already holds the wanted values`);
    }

    if (simulationPlan.pool === "open") {
      await send(SIMULATION.openPoolStep, [await buildOpenPool(signers, simMint.address, instance)]);
    } else {
      console.log(`skip ${SIMULATION.openPoolStep}: ${pool.pool} already holds the wanted values`);
    }
  }

  // 4. register_class CHROME v1
  const classAddress = await findClassPolicyPda(protocolAddress, SEED.classCode, SEED.classVersion);
  const classPolicy = await fetchMaybeClassPolicy(rpc, classAddress, { commitment: "confirmed" });
  if (classPolicy.exists) {
    const differences = diffClass(classPolicy.data, wantedClass());
    if (differences.length > 0) throw differenceError(`class ${classAddress}`, differences);
    console.log(`skip register_class: ${classAddress} already holds the wanted values`);
  } else {
    await send(`register_class ${SEED.classCode} v${SEED.classVersion}`, [
      await buildRegisterClass(signers, instance),
    ]);
  }

  // 5. accredit_organisation, one per row of seed.sql
  for (const organisation of organisations) {
    const orgAdmin = (orgAdmins.get(organisation.slug) as TransactionSigner).address;
    const [organisationAddress] = await findOrganisationPda({ protocol: protocolAddress, orgId: organisation.orgId });
    const existing = await fetchMaybeOrganisation(rpc, organisationAddress, { commitment: "confirmed" });
    if (existing.exists) {
      const differences = diffOrganisation(existing.data, {
        orgId: organisation.orgId,
        role: organisation.role,
        displayName: organisation.name,
        admin: orgAdmin,
      });
      if (differences.length > 0) {
        throw differenceError(`organisation ${organisation.slug} (${organisationAddress})`, differences);
      }
      console.log(`skip accredit_organisation ${organisation.slug}: ${organisationAddress} already holds the wanted values`);
    } else {
      await send(`accredit_organisation ${organisation.slug}`, [
        await buildAccreditOrganisation(signers, organisation, orgAdmin, instance),
      ]);
    }
  }

  writeLog();
  console.log(`protocol ${protocolAddress}`);
  if (simMint !== undefined && pool !== undefined) {
    console.log(`mint ${simMint.address}\npool ${pool.pool}\nvault ${pool.vault}`);
  }
  console.log(`log ${logPath}`);
}

if (import.meta.main) {
  main(process.argv.slice(2), process.env).catch((error: unknown) => {
    console.error(error instanceof SeedError ? error.message : error);
    process.exit(1);
  });
}
