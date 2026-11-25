// Seeds the Thetis program on devnet with the demo's fixed values:
//
//   node scripts/seed-demo.ts
//
// What it seeds (the whole list; nothing else is sent):
//   - initialize_protocol: instance id = the 16 ASCII bytes "fiat-attestation", settlement mode
//     FiatAttestationTest, an admin key and a separate accreditor key (both generated here).
//   - register_class: class code CHROME, version 1, grades ["G1"], origin_required false,
//     lot_validity_secs 7,776,000 (90 days), split_inherits_expiry true.
//   - accredit_organisation, once per row of the organisations insert in supabase/seed.sql: org_id is
//     the 16 bytes of the row's fixed UUID, the role comes from its kind, display_name is its name,
//     and admin is that organisation's own generated key (org-<slug>.json).
//
// Devnet only: the RPC and websocket URLs are pinned below, the Solana CLI is never run, and so the
// machine's own Solana config is never read. Keys live outside the repository in THETIS_KEYS_DIR
// (default $HOME/.config/thetis/devnet). Safe to run again: every step first reads its account and
// sends nothing when the account already holds the wanted values.
//
// Every transaction is signed and written to seed-log.json as "pending" before it is sent, then marked
// "confirmed" once it lands. A rerun first settles pending entries with getSignatureStatuses.

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
  type Address,
  appendTransactionMessageInstruction,
  assertIsTransactionWithBlockhashLifetime,
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
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
  findOrganisationPda,
  findProtocolPda,
  getAccreditOrganisationInstruction,
  getInitializeProtocolInstruction,
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
};

// Decoded enums arrive as their numeric value although the generated type says the name; accept both.
export function enumName(names: Record<number, string>, value: string | number): string {
  return typeof value === "number" ? (names[value] ?? `unknown(${value})`) : value;
}

export class SeedError extends Error {}

const URL_FLAGS = ["--url", "-u", "--cluster", "--provider.cluster"];
const URL_ENV = ["CLUSTER", "URL", "SOLANA_URL", "SOLANA_CLUSTER", "ANCHOR_PROVIDER_URL"];

/** Refuses any cluster or URL override that is not devnet, and any argument it does not know. */
export function assertDevnetOnly(argv: readonly string[], env: NodeJS.ProcessEnv): void {
  for (const name of URL_ENV) {
    const value = env[name];
    if (value !== undefined && value !== "" && !DEVNET_VALUES.has(value)) {
      throw new SeedError(`refusing: ${name}=${value} is not devnet. This script only runs on devnet.`);
    }
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    if (!URL_FLAGS.includes(flag)) {
      throw new SeedError(`refusing: unknown argument ${arg}. This script takes no arguments.`);
    }
    const value = eq === -1 ? argv[i + 1] : arg.slice(eq + 1);
    if (eq === -1) i += 1;
    if (value === undefined || !DEVNET_VALUES.has(value)) {
      throw new SeedError(
        `refusing: ${flag} ${value ?? "(missing)"} is not devnet. This script only runs on devnet.`,
      );
    }
  }
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

export function instanceIdBytes(): Uint8Array {
  const bytes = new TextEncoder().encode(SEED.instanceId);
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
    return { id, slug, name, kind, role, orgId: uuidToBytes(id) };
  });
}

export type KeyRole = "deployer" | "admin" | "accreditor" | `org-${string}`;

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

export async function buildInitializeProtocol(signers: Signers): Promise<Instruction> {
  const [protocol] = await findProtocolPda({ instanceId: instanceIdBytes() });
  return getInitializeProtocolInstruction({
    protocol,
    admin: signers.admin,
    payer: signers.deployer,
    instanceId: instanceIdBytes(),
    settlementMode: SettlementMode[SEED.settlementMode],
    adminArg: signers.admin.address,
    accreditor: signers.accreditor.address,
  });
}

export async function buildRegisterClass(signers: Signers): Promise<Instruction> {
  const [protocol] = await findProtocolPda({ instanceId: instanceIdBytes() });
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
): Promise<Instruction> {
  const [protocol] = await findProtocolPda({ instanceId: instanceIdBytes() });
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

export function explorerUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}

// ---------------------------------------------------------------------------------------------
// Key files (Solana CLI format: a JSON array of 64 bytes, seed then public key)
// ---------------------------------------------------------------------------------------------

function readKeyFile(path: string): Promise<TransactionSigner> {
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
type SeedLog = { cluster: "devnet"; program: string; protocol: string; transactions: LoggedTransaction[] };

const LOG_STATUSES: readonly string[] = ["pending", "confirmed", "failed", "expired"];

function readSeedLog(path: string): LoggedTransaction[] {
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<SeedLog>;
  const transactions = parsed.transactions ?? [];
  const valid =
    Array.isArray(transactions) &&
    transactions.every(
      (entry) =>
        typeof entry?.step === "string" &&
        typeof entry.signature === "string" &&
        typeof entry.url === "string" &&
        LOG_STATUSES.includes(entry.status) &&
        typeof entry.lastValidBlockHeight === "string",
    );
  if (!valid) throw new SeedError(`${path} is not a seed log this script wrote; not touching it`);
  return transactions;
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
  const transactions = readSeedLog(logPath);
  const [protocolAddress] = await findProtocolPda({ instanceId: instanceIdBytes() });

  const writeLog = (): void => {
    const log: SeedLog = {
      cluster: "devnet",
      program: THETIS_PROGRAM_ADDRESS,
      protocol: protocolAddress,
      transactions,
    };
    writeFileSync(logPath, `${JSON.stringify(log, null, 2)}\n`, { mode: 0o600 });
    chmodSync(logPath, 0o600);
  };

  await reconcilePending(rpc, transactions);
  writeLog();

  const send = async (step: string, instruction: Instruction): Promise<void> => {
    assertNoPending(transactions, step);
    const { value: latestBlockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(deployer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
      (m) => appendTransactionMessageInstruction(instruction, m),
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

  const stop = (what: string, differences: string[]): never => {
    throw new SeedError(`${what} already exists with different values; nothing sent for it:\n  ${differences.join("\n  ")}`);
  };

  // 1. initialize_protocol
  const protocol = await fetchMaybeProtocol(rpc, protocolAddress, { commitment: "confirmed" });
  if (protocol.exists) {
    const differences = diffProtocol(protocol.data, {
      instanceId: instanceIdBytes(),
      settlementMode: SEED.settlementMode,
      admin: admin.address,
      accreditor: accreditor.address,
    });
    if (differences.length > 0) stop(`protocol ${protocolAddress}`, differences);
    console.log(`skip initialize_protocol: ${protocolAddress} already holds the wanted values`);
  } else {
    await send("initialize_protocol", await buildInitializeProtocol(signers));
  }

  // 2. register_class CHROME v1
  const classAddress = await findClassPolicyPda(protocolAddress, SEED.classCode, SEED.classVersion);
  const classPolicy = await fetchMaybeClassPolicy(rpc, classAddress, { commitment: "confirmed" });
  if (classPolicy.exists) {
    const differences = diffClass(classPolicy.data, wantedClass());
    if (differences.length > 0) stop(`class ${classAddress}`, differences);
    console.log(`skip register_class: ${classAddress} already holds the wanted values`);
  } else {
    await send(`register_class ${SEED.classCode} v${SEED.classVersion}`, await buildRegisterClass(signers));
  }

  // 3. accredit_organisation, one per row of seed.sql
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
      if (differences.length > 0) stop(`organisation ${organisation.slug} (${organisationAddress})`, differences);
      console.log(`skip accredit_organisation ${organisation.slug}: ${organisationAddress} already holds the wanted values`);
    } else {
      await send(
        `accredit_organisation ${organisation.slug}`,
        await buildAccreditOrganisation(signers, organisation, orgAdmin),
      );
    }
  }

  writeLog();
  console.log(`protocol ${protocolAddress}\nlog ${logPath}`);
}

if (import.meta.main) {
  main(process.argv.slice(2), process.env).catch((error: unknown) => {
    console.error(error instanceof SeedError ? error.message : error);
    process.exit(1);
  });
}
