// The relay against the real Thetis program in LiteSVM and the local Supabase stack
// (live-lending.md §9.3). Every key is a throwaway generated here; every organisation, lot and
// amount is synthetic test data. No transaction reaches devnet.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Address,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  createTransactionMessage,
  getAddressDecoder,
  getAddressEncoder,
  getBase58Decoder,
  getBase64Decoder,
  getBase64Encoder,
  getProgramDerivedAddress,
  getTransactionDecoder,
  getTransactionEncoder,
  type Instruction,
  type KeyPairSigner,
  lamports,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signBytes,
  signTransaction,
  type Transaction,
} from "@solana/kit";
import {
  AccountState,
  findAssociatedTokenPda,
  getMintEncoder,
  getTokenEncoder,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  DocumentKind,
  decodeAuthority,
  decodeCustodianClass,
  decodeHandoffAcceptance,
  decodeLoadingIntent,
  decodeLoan,
  decodeLockAllocation,
  decodeLot,
  decodeManifestBatch,
  decodePaymentAttestation,
  decodePosition,
  decodeShipment,
  findAcceptancePda,
  findAuthorityPda,
  findHandoverPda,
  findIntakePda,
  findLockPda,
  findMintAuthorityPda,
  findMintPda,
  findOrganisationPda,
  findPoolAuthorityPda,
  findPoolPda,
  findPositionPda,
  findProtocolPda,
  findVaultAuthorityPda,
  getAccreditCustodianClassInstruction,
  getAccreditOrganisationInstruction,
  getAttestDocumentInstruction,
  getAuthorityEncoder,
  getCancelShipmentInstruction,
  getDelegateAuthorityInstruction,
  getInitializeProtocolInstruction,
  getIssueLotInstruction,
  getLoanEncoder,
  getLockAllocationEncoder,
  getOpenPoolInstruction,
  getPositionEncoder,
  getPrepareShipmentInstructionAsync,
  getRegisterBatchInstructionAsync,
  getRegisterClassInstruction,
  getRevokeDocumentInstruction,
  Role,
  SettlementMode,
  ShipmentStatus,
  THETIS_PROGRAM_ADDRESS,
} from "@thetis/contracts";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { FailedTransactionMetadata, LiteSVM } from "litesvm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ChainPort } from "../src/commands/chain.ts";
import { KIND_SPECS } from "../src/commands/plan.ts";
import type { CommandDependencies } from "../src/commands/routes.ts";
import { keyFileSponsor, SponsorUnavailableError } from "../src/commands/sponsor.ts";
import {
  custodyHandoverMessage,
  envelope,
  formatTonnes,
  intakeDigest,
  issueLotMessage,
  loadingIntentMessage,
  observationMessage,
  recordLoadingMessage,
} from "../src/commands/texts.ts";
import type { CommandView } from "../src/commands/views.ts";
import { localSupabaseEnv } from "../src/local.ts";
import { route } from "../src/routes.ts";
import { type AccessClients, createAccessClients } from "../src/supabase.ts";

const origin = "http://localhost:3100";
const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
const programSo = join(projectRoot, "target/deploy/thetis.so");
const namespace = randomUUID();
const password = "Thetis-local-integration-password";
const clientOptions = { auth: { autoRefreshToken: false, persistSession: false } };
const MAX_TRANSACTION_BYTES = 1_232;
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const TOKEN_2022 = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const NOW = 1_795_098_155n;
const DAY = 86_400n;
const LOT_ID = "CR-0001";
const GRADE = "G1";
const SITE = "PORT-STOCKYARD";
const LOT_KG = 5_000_000n;
const INTAKE = new Uint8Array(32).fill(0x0a);

// ---------------------------------------------------------------- organisations and people

type OrgKey =
  | "khunou"
  | "kopano"
  | "lenderOne"
  | "lenderTwo"
  | "buyer"
  | "outsider"
  | "mosela"
  | "portT1";
const ORGS: Record<OrgKey, { name: string; role: number; kind: string }> = {
  khunou: { name: "Khunou Ore Exports", role: Role.Exporter, kind: "exporter" },
  kopano: { name: "Kopano Stockyard Custody", role: Role.Custodian, kind: "custodian" },
  lenderOne: { name: "Lender One Bank", role: Role.Lender, kind: "lender" },
  lenderTwo: { name: "Lender Two Bank", role: Role.Lender, kind: "lender" },
  buyer: { name: "Buyer Smelter Co", role: Role.Buyer, kind: "buyer" },
  outsider: { name: "Outsider Lender (synthetic)", role: Role.Lender, kind: "lender" },
  mosela: { name: "Mosela Haulage", role: Role.Transporter, kind: "transporter" },
  portT1: { name: "Port Terminal T1", role: Role.Terminal, kind: "terminal" },
};

interface Person {
  id: string;
  token: string;
  client: SupabaseClient;
}

type WalletKey =
  | "lenderOne"
  | "lenderTwo"
  | "khunou"
  | "khunouUnscoped"
  | "khunouUnlinked"
  | "buyer"
  | "kopano"
  | "kopanoField"
  | "kopanoNoAuthority"
  | "khunouShip"
  | "mosela"
  | "moselaNoAuthority"
  | "khunouLoading"
  | "portT1"
  | "portT1NoLoad";
const SCOPE = {
  ISSUE: 1,
  TRANSFER: 2,
  PLEDGE: 32,
  BUY: 64,
  LEND: 128,
  POOL: 256,
  SHIP: 512,
  CARRY: 1024,
  OBSERVE: 2048,
  LOAD: 4096,
  ATTEST_ORIGIN: 16,
  ATTEST_TRANSPORT: 16384,
} as const;
const WALLETS: Record<
  WalletKey,
  { org: OrgKey; scopes: number; linked: boolean; delegated?: false }
> = {
  lenderOne: { org: "lenderOne", scopes: SCOPE.LEND | SCOPE.POOL, linked: true },
  lenderTwo: { org: "lenderTwo", scopes: SCOPE.LEND, linked: true },
  khunou: { org: "khunou", scopes: SCOPE.PLEDGE, linked: true },
  khunouUnscoped: { org: "khunou", scopes: SCOPE.TRANSFER, linked: true },
  khunouUnlinked: { org: "khunou", scopes: SCOPE.PLEDGE, linked: false },
  buyer: { org: "buyer", scopes: SCOPE.BUY, linked: true },
  kopano: { org: "kopano", scopes: SCOPE.ISSUE, linked: false },
  // The field kinds (field-app.md §6.3): Kopano's linked issuer, and a linked wallet with no Authority.
  kopanoField: {
    org: "kopano",
    scopes: SCOPE.ISSUE | SCOPE.CARRY | SCOPE.OBSERVE | SCOPE.ATTEST_TRANSPORT,
    linked: true,
  },
  kopanoNoAuthority: { org: "kopano", scopes: 0, linked: true, delegated: false },
  khunouShip: { org: "khunou", scopes: SCOPE.SHIP, linked: false },
  // Phone 2: Mosela's carrier wallet, and the second wallet with no Authority (the refused driver).
  mosela: { org: "mosela", scopes: SCOPE.CARRY | SCOPE.OBSERVE, linked: true },
  moselaNoAuthority: { org: "mosela", scopes: 0, linked: true, delegated: false },
  // The loading (field-app.md §7.7, T067r.3 folds): Khunou's owner wallet on the web, Port
  // Terminal T1's terminal wallet on phone 1, and a terminal wallet without LOAD.
  khunouLoading: { org: "khunou", scopes: SCOPE.SHIP, linked: true },
  portT1: { org: "portT1", scopes: SCOPE.CARRY | SCOPE.LOAD, linked: true },
  portT1NoLoad: { org: "portT1", scopes: SCOPE.CARRY, linked: true },
};

let clients: AccessClients;
let service: SupabaseClient;
const orgIds = {} as Record<OrgKey, string>;
const people = {} as Record<OrgKey, Person>;
const wallets = {} as Record<WalletKey, KeyPairSigner>;
let payer: KeyPairSigner;
let admin: KeyPairSigner;
let accreditor: KeyPairSigner;
let orgAdmin: KeyPairSigner;
let sponsorPath: string;
let sponsorAddress: Address;

function mustSucceed<T>(result: { data: T; error: { message: string } | null }): NonNullable<T> {
  if (result.error) throw new Error(result.error.message);
  if (result.data == null) throw new Error("Supabase returned no data");
  return result.data;
}

async function signer(): Promise<KeyPairSigner> {
  return createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(randomBytes(32)));
}

function uuidBytes(uuid: string): Uint8Array {
  return Uint8Array.from(Buffer.from(uuid.replaceAll("-", ""), "hex"));
}

// ---------------------------------------------------------------- the chain: LiteSVM as a ChainPort

interface SvmChain extends ChainPort {
  /** Thetis command transactions are accepted and dropped: they never land. */
  dropSends: boolean;
  /** Every Thetis command transaction the API sent (lookup-table upkeep excluded), in order. */
  sent: string[];
  advanceSlots(n: bigint): void;
  /** Adds accounts made outside the API to what `programAccounts` scans. */
  touch(...keys: Address[]): void;
}

/** LiteSVM's InstructionError (its class is not exported): an index and an inner error. */
function instructionError(failed: FailedTransactionMetadata) {
  const err = failed.err() as unknown;
  if (
    typeof err === "object" &&
    err !== null &&
    "index" in err &&
    "err" in err &&
    typeof err.err === "function"
  ) {
    return err as { index: number; err(): unknown };
  }
  return null;
}

function errorJson(failed: FailedTransactionMetadata): unknown {
  const err = instructionError(failed);
  if (err) {
    const inner = err.err();
    if (typeof inner === "object" && inner !== null && "code" in inner) {
      return { InstructionError: [err.index, { Custom: inner.code }] };
    }
    return { InstructionError: [err.index, String(inner)] };
  }
  return { TransactionError: String(failed.err()) };
}

function lookupTableAddresses(svm: LiteSVM, table: Address): Address[] {
  const account = svm.getAccount(table);
  if (!account.exists) return [];
  const decoder = getAddressDecoder();
  const out: Address[] = [];
  for (let offset = 56; offset + 32 <= account.data.length; offset += 32) {
    out.push(decoder.decode(account.data.subarray(offset, offset + 32)));
  }
  return out;
}

function svmChain(svm: LiteSVM): SvmChain {
  const results = new Map<string, { slot: bigint; failed: unknown | null; logs: string[] }>();
  // LiteSVM has no getProgramAccounts: remember every account a landed transaction named.
  const touched = new Set<Address>();
  const decoder = getAddressDecoder();
  function advanceSlots(n: bigint) {
    svm.warpToSlot(svm.getClock().slot + n);
    const [latest] = svm.getSlotHashes();
    if (!latest) throw new Error("LiteSVM has no slot hash");
    latest.slot = svm.getClock().slot;
    latest.hash = svm.latestBlockhash();
    svm.setSlotHashes([latest]);
  }
  function remember(transaction: Transaction) {
    const bytes = transaction.messageBytes;
    // v0 prefix, header (3), static keys, blockhash, instructions, lookups.
    let offset = bytes[0] === 0x80 ? 1 : 0;
    offset += 3;
    const count = bytes[offset] ?? 0; // fewer than 128 keys: one-byte compact length
    offset += 1;
    for (let index = 0; index < count; index++) {
      touched.add(decoder.decode(bytes.subarray(offset, offset + 32)));
      offset += 32;
    }
    for (const table of touched) {
      const account = svm.getAccount(table);
      if (
        account.exists &&
        account.programAddress === "AddressLookupTab1e1111111111111111111111111"
      ) {
        for (const key of lookupTableAddresses(svm, table)) touched.add(key);
      }
    }
  }
  const chain: SvmChain = {
    dropSends: false,
    sent: [],
    advanceSlots,
    touch(...keys) {
      for (const key of keys) touched.add(key);
    },
    async genesisHash() {
      return DEVNET_GENESIS;
    },
    async slot() {
      advanceSlots(1n);
      return svm.getClock().slot;
    },
    async chainTime() {
      return svm.getClock().unixTimestamp;
    },
    async blockHeight() {
      return svm.getClock().slot;
    },
    async latestBlockhash() {
      // A fresh blockhash per request, as on devnet: two identical commands never share bytes.
      svm.expireBlockhash();
      return { blockhash: svm.latestBlockhash(), lastValidBlockHeight: svm.getClock().slot + 150n };
    },
    async accounts(addresses) {
      return addresses.map((key) => svm.getAccount(key));
    },
    async programAccounts({ memcmp, dataSize }) {
      const encoder = getAddressEncoder();
      const found = [];
      for (const key of touched) {
        const account = svm.getAccount(key);
        if (!account.exists || account.programAddress !== THETIS_PROGRAM_ADDRESS) continue;
        if (account.data.length !== dataSize) continue;
        if (memcmp) {
          const wanted = encoder.encode(memcmp.bytes);
          const slice = account.data.subarray(memcmp.offset, memcmp.offset + 32);
          if (!Buffer.from(slice).equals(Buffer.from(wanted))) continue;
        }
        found.push(account);
      }
      return found;
    },
    async lookupTable(table) {
      const account = svm.getAccount(table);
      if (!account.exists) return null;
      const lastExtendedSlot = Buffer.from(account.data).readBigUInt64LE(12);
      return { addresses: lookupTableAddresses(svm, table), lastExtendedSlot };
    },
    async send(wireBase64) {
      // LiteSVM takes any size; devnet refuses a transaction above 1,232 bytes (S1 fold 9).
      const size = getBase64Encoder().encode(wireBase64).length;
      if (size > MAX_TRANSACTION_BYTES) throw new Error(`transaction of ${size} bytes`);
      const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(wireBase64));
      const feePayerSignature = Object.values(transaction.signatures)[0];
      if (!feePayerSignature) throw new Error("unsigned transaction");
      const signature = getBase58Decoder().decode(feePayerSignature);
      const thetis = Buffer.from(transaction.messageBytes).includes(
        Buffer.from(getAddressEncoder().encode(THETIS_PROGRAM_ADDRESS)),
      );
      if (thetis) chain.sent.push(signature);
      if ((thetis && chain.dropSends) || results.has(signature)) return;
      const result = svm.sendTransaction(transaction);
      if (result instanceof FailedTransactionMetadata) {
        if (!instructionError(result)) return; // never landed
        results.set(signature, {
          slot: svm.getClock().slot,
          failed: errorJson(result),
          logs: result.meta().logs(),
        });
        return;
      }
      remember(transaction);
      results.set(signature, { slot: svm.getClock().slot, failed: null, logs: result.logs() });
    },
    async status(signature) {
      const found = results.get(signature);
      return found
        ? { slot: found.slot, failed: found.failed, confirmationStatus: "confirmed" }
        : null;
    },
    async transaction(signature) {
      const found = results.get(signature);
      return found ? { slot: found.slot, logs: found.logs } : null;
    },
  };
  return chain;
}

// ---------------------------------------------------------------- Phase 1 state, sent directly

interface World {
  svm: LiteSVM;
  chain: SvmChain;
  deps: CommandDependencies;
  protocol: Address;
  lot: Address;
  custodianClass: Address;
  orgs: Record<OrgKey, Address>;
  mint: Address | null;
  instanceId: Uint8Array;
}

function send(svm: LiteSVM, instructions: Instruction[], signers: KeyPairSigner[]) {
  return (async () => {
    svm.expireBlockhash();
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(payer.address, m),
      (m) =>
        setTransactionMessageLifetimeUsingBlockhash(
          { blockhash: svm.latestBlockhash(), lastValidBlockHeight: 0n },
          m,
        ),
      (m) => appendTransactionMessageInstructions(instructions, m),
    );
    const transaction = await signTransaction(
      [payer, ...signers.filter((s) => s.address !== payer.address)].map((s) => s.keyPair),
      compileTransaction(message),
    );
    const result = svm.sendTransaction(transaction);
    if (result instanceof FailedTransactionMetadata) {
      throw new Error(
        `setup transaction failed: ${result.toString()}\n${result.meta().prettyLogs()}`,
      );
    }
  })();
}

function sharedEd25519(
  signatures: { wallet: Address; signature: Uint8Array }[],
  message: Uint8Array,
): Instruction {
  const entriesAt = 2 + 14 * signatures.length;
  const messageOffset = entriesAt + 96 * signatures.length;
  const data = new Uint8Array(messageOffset + message.length);
  const view = new DataView(data.buffer);
  data[0] = signatures.length;
  signatures.forEach(({ wallet, signature }, index) => {
    const signatureOffset = entriesAt + 96 * index;
    [
      signatureOffset,
      0xffff,
      signatureOffset + 64,
      0xffff,
      messageOffset,
      message.length,
      0xffff,
    ].forEach((value, field) => {
      view.setUint16(2 + 14 * index + 2 * field, value, true);
    });
    data.set(signature, signatureOffset);
    data.set(getAddressEncoder().encode(wallet), signatureOffset + 64);
  });
  data.set(message, messageOffset);
  return {
    programAddress: address("Ed25519SigVerify111111111111111111111111111"),
    accounts: [],
    data,
  };
}

async function classPolicyPda(protocol: Address, classCode = "CHROME") {
  const version = new Uint8Array(4);
  new DataView(version.buffer).setUint32(0, 1, true);
  const [found] = await getProgramDerivedAddress({
    programAddress: THETIS_PROGRAM_ADDRESS,
    seeds: ["class", getAddressEncoder().encode(protocol), classCode, version],
  });
  return found;
}

async function orgNamePda(protocol: Address, name: string) {
  const [found] = await getProgramDerivedAddress({
    programAddress: THETIS_PROGRAM_ADDRESS,
    seeds: [
      "org_name",
      getAddressEncoder().encode(protocol),
      createHash("sha256").update(name.toLowerCase(), "ascii").digest(),
    ],
  });
  return found;
}

let worlds = BigInt(Date.now() % 1_000_000);

async function world(
  mode: "fiat" | "simulation" = "fiat",
  options: { names?: Partial<Record<OrgKey, string>> } = {},
): Promise<World> {
  const nameOf = (key: OrgKey) => options.names?.[key] ?? ORGS[key].name;
  if (!existsSync(programSo)) {
    throw new Error(`${programSo} is missing: run anchor build before the relay suite`);
  }
  const svm = new LiteSVM().withPrecompiles();
  svm.addProgramFromFile(THETIS_PROGRAM_ADDRESS, programSo);
  const clock = svm.getClock();
  clock.unixTimestamp = NOW;
  // Each world starts at its own slot: the sponsor's lookup-table address is derived from a
  // recent slot, and relay_lookup_tables keeps every address unique across instances.
  worlds += 1n;
  clock.slot = 1_000n + worlds * 1_000_000n;
  svm.setClock(clock);
  svm.airdrop(payer.address, lamports(100_000_000_000n));
  svm.airdrop(sponsorAddress, lamports(10_000_000_000n));
  for (const wallet of Object.values(wallets))
    svm.airdrop(wallet.address, lamports(1_000_000_000n));

  const instanceId = new Uint8Array(randomBytes(16));
  const [protocol] = await findProtocolPda({ instanceId });
  await send(
    svm,
    [
      getInitializeProtocolInstruction({
        protocol,
        admin,
        payer,
        instanceId,
        settlementMode:
          mode === "fiat"
            ? SettlementMode.FiatAttestationTest
            : SettlementMode.DevnetTokenSimulation,
        adminArg: admin.address,
        accreditor: accreditor.address,
      }),
    ],
    [admin],
  );
  const classPolicy = await classPolicyPda(protocol);
  await send(
    svm,
    [
      getRegisterClassInstruction({
        protocol,
        classPolicy,
        accreditor,
        payer,
        classCode: "CHROME",
        version: 1,
        grades: [GRADE],
        originRequired: false,
        lotValiditySecs: 30n * DAY,
        splitInheritsExpiry: true,
      }),
    ],
    [accreditor],
  );
  const orgs = {} as Record<OrgKey, Address>;
  for (const key of Object.keys(ORGS) as OrgKey[]) {
    const [organisation] = await findOrganisationPda({ protocol, orgId: uuidBytes(orgIds[key]) });
    orgs[key] = organisation;
    await send(
      svm,
      [
        getAccreditOrganisationInstruction({
          protocol,
          organisation,
          organisationName: await orgNamePda(protocol, nameOf(key)),
          accreditor,
          payer,
          orgId: uuidBytes(orgIds[key]),
          role: ORGS[key].role as never,
          displayName: nameOf(key),
          admin: orgAdmin.address,
        }),
      ],
      [accreditor],
    );
  }
  const custodianClass = (
    await getProgramDerivedAddress({
      programAddress: THETIS_PROGRAM_ADDRESS,
      seeds: [
        "custodian_class",
        getAddressEncoder().encode(protocol),
        getAddressEncoder().encode(orgs.kopano),
        getAddressEncoder().encode(classPolicy),
        SITE,
      ],
    })
  )[0];
  await send(
    svm,
    [
      getAccreditCustodianClassInstruction({
        protocol,
        custodian: orgs.kopano,
        classPolicy,
        custodianClass,
        accreditor,
        payer,
        siteCode: SITE,
        approvedCapacityKg: 10_000_000n,
      }),
    ],
    [accreditor],
  );
  for (const key of Object.keys(WALLETS) as WalletKey[]) {
    if (WALLETS[key].delegated === false) continue;
    const [authority] = await findAuthorityPda({ protocol, wallet: wallets[key].address });
    await send(
      svm,
      [
        getDelegateAuthorityInstruction({
          protocol,
          organisation: orgs[WALLETS[key].org],
          authority,
          admin: orgAdmin,
          payer,
          wallet: wallets[key].address,
          scopes: WALLETS[key].scopes,
          expiresAt: NOW + 60n * DAY,
        }),
      ],
      [orgAdmin],
    );
  }

  // Issue CR-0001 to Khunou, signed by Kopano's wallet.
  const [lot] = await getProgramDerivedAddress({
    programAddress: THETIS_PROGRAM_ADDRESS,
    seeds: ["lot", getAddressEncoder().encode(protocol), LOT_ID],
  });
  const [mint] = await findMintPda({ lot });
  const [position] = await findPositionPda({ lot, owner: orgs.khunou });
  const [vaultAuthority] = await findVaultAuthorityPda({ position });
  const [vault] = await findAssociatedTokenPda({
    owner: vaultAuthority,
    mint,
    tokenProgram: TOKEN_2022,
  });
  const validUntil = NOW + 570n;
  const text = envelope(
    THETIS_PROGRAM_ADDRESS,
    Buffer.from(instanceId).toString("hex"),
    "Issue lot",
    [
      ["Lot", LOT_ID],
      ["Class", "CHROME v1"],
      ["Grade", GRADE],
      ["Quantity", formatTonnes(LOT_KG)],
      ["Owner", nameOf("khunou")],
      ["Custodian", nameOf("kopano")],
      ["Site", SITE],
      ["Intake", Buffer.from(INTAKE).toString("hex")],
      ["Origin document", "not required"],
    ],
    validUntil,
  );
  const textSignature = await signBytes(wallets.kopano.keyPair.privateKey, text);
  await send(
    svm,
    [
      sharedEd25519([{ wallet: wallets.kopano.address, signature: textSignature }], text),
      getIssueLotInstruction({
        sponsor: payer,
        protocol,
        authority: (await findAuthorityPda({ protocol, wallet: wallets.kopano.address }))[0],
        owner: orgs.khunou,
        custodian: orgs.kopano,
        classPolicy,
        custodianClass,
        intake: (
          await findIntakePda({ protocol, custodian: orgs.kopano, intakeDigest: INTAKE })
        )[0],
        lot,
        mint,
        mintAuthority: (await findMintAuthorityPda({ mint }))[0],
        position,
        vaultAuthority,
        vault,
        lotId: LOT_ID,
        grade: GRADE,
        quantityKg: LOT_KG,
        intakeDigest: INTAKE,
        validUntil,
      }),
    ],
    [],
  );

  let poolMint: Address | null = null;
  if (mode === "simulation") {
    poolMint = (await signer()).address;
    const rent = svm.minimumBalanceForRentExemption(82n);
    svm.setAccount({
      address: poolMint,
      programAddress: TOKEN_PROGRAM_ADDRESS,
      lamports: lamports(rent),
      executable: false,
      space: 82n,
      data: new Uint8Array(
        getMintEncoder().encode({
          mintAuthority: payer.address,
          supply: 200_000_000n,
          decimals: 2,
          isInitialized: true,
          freezeAuthority: null,
        }),
      ),
    } as never);
    for (const [key, amount] of [
      ["lenderOne", 100_000_000n],
      ["khunou", 50_000_000n],
    ] as const) {
      const [ata] = await findAssociatedTokenPda({
        owner: wallets[key].address,
        mint: poolMint,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
      svm.setAccount({
        address: ata,
        programAddress: TOKEN_PROGRAM_ADDRESS,
        lamports: lamports(svm.minimumBalanceForRentExemption(165n)),
        executable: false,
        space: 165n,
        data: new Uint8Array(
          getTokenEncoder().encode({
            mint: poolMint,
            owner: wallets[key].address,
            amount,
            delegate: null,
            state: AccountState.Initialized,
            isNative: null,
            delegatedAmount: 0n,
            closeAuthority: null,
          }),
        ),
      } as never);
    }
    const [pool] = await findPoolPda({ protocol });
    const [poolAuthority] = await findPoolAuthorityPda({ pool });
    const [poolVault] = await findAssociatedTokenPda({
      owner: poolAuthority,
      mint: poolMint,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    await send(
      svm,
      [
        getOpenPoolInstruction({
          admin,
          payer,
          protocol,
          pool,
          poolAuthority,
          mint: poolMint,
          poolVault,
          currency: new TextEncoder().encode("USD"),
        }),
      ],
      [admin],
    );
  }

  const chain = svmChain(svm);
  const deps: CommandDependencies = {
    network: "devnet",
    programId: THETIS_PROGRAM_ADDRESS,
    protocol,
    chain,
    sponsor: keyFileSponsor(sponsorPath, { programId: THETIS_PROGRAM_ADDRESS, protocol }),
    // Waiting moves the chain on instead of the wall clock.
    sleep: async () => chain.advanceSlots(10n),
    now: () => Date.now(),
  };
  return { svm, chain, deps, protocol, lot, custodianClass, orgs, mint: poolMint, instanceId };
}

// ---------------------------------------------------------------- the API, as the web calls it

function call(w: World, method: string, path: string, person: Person | null, body?: object) {
  const event = {
    version: "2.0",
    routeKey: "$default",
    rawPath: path,
    rawQueryString: "",
    headers: { origin, ...(person && { authorization: `Bearer ${person.token}` }) },
    ...(body && { body: JSON.stringify(body) }),
    isBase64Encoded: false,
    requestContext: {
      accountId: "test",
      apiId: "test",
      domainName: "localhost",
      domainPrefix: "localhost",
      requestId: randomUUID(),
      routeKey: "$default",
      stage: "$default",
      time: new Date().toISOString(),
      timeEpoch: Date.now(),
      http: { method, path, protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "vitest" },
    },
  } as APIGatewayProxyEventV2;
  return route(event, clients, async () => w.deps);
}

type Response = Awaited<ReturnType<typeof call>>;

function data<T>(response: Response, status = 200): T {
  const body = JSON.parse(response.body ?? "{}");
  if (response.statusCode !== status) {
    throw new Error(`expected ${status}, got ${response.statusCode}: ${response.body}`);
  }
  return body.data as T;
}

function errorOf(response: Response) {
  return JSON.parse(response.body ?? "{}").error as {
    code: string;
    message: string;
    detail?: string;
  };
}

async function create(w: World, org: OrgKey, kind: string, args: Record<string, string>) {
  return data<CommandView>(
    await call(w, "POST", "/v1/commands", people[org], { kind, organisationId: orgIds[org], args }),
    201,
  );
}

function signTextRequest(
  view: CommandView,
  wallet: KeyPairSigner,
  role: string,
  bytes?: Uint8Array,
) {
  if (!view.text) throw new Error("command has no text");
  const message = new Uint8Array(getBase64Encoder().encode(view.text.messageBase64));
  return (async () => ({
    role,
    wallet: wallet.address,
    messageSha256: view.text?.messageSha256 ?? "",
    signature: getBase58Decoder().decode(
      await signBytes(wallet.keyPair.privateKey, bytes ?? message),
    ),
  }))();
}

async function signText(
  w: World,
  org: OrgKey,
  view: CommandView,
  role: string,
  wallet: KeyPairSigner,
) {
  return call(
    w,
    "POST",
    `/v1/commands/${view.id}/signatures`,
    people[org],
    await signTextRequest(view, wallet, role),
  );
}

async function requestTransaction(w: World, org: OrgKey, view: CommandView, wallet: KeyPairSigner) {
  return data<{ transactionBase64: string; lastValidBlockHeight: string }>(
    await call(w, "POST", `/v1/commands/${view.id}/transaction-request`, people[org], {
      wallet: wallet.address,
    }),
  );
}

async function walletSigns(transactionBase64: string, wallet: KeyPairSigner) {
  const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(transactionBase64));
  const signed = await partiallySignTransaction([wallet.keyPair], transaction);
  return getBase64Decoder().decode(getTransactionEncoder().encode(signed));
}

async function signTransactionAs(w: World, org: OrgKey, view: CommandView, wallet: KeyPairSigner) {
  const { transactionBase64 } = await requestTransaction(w, org, view, wallet);
  return call(w, "POST", `/v1/commands/${view.id}/transaction`, people[org], {
    transactionBase64: await walletSigns(transactionBase64, wallet),
  });
}

type Actor = { org: OrgKey; wallet: KeyPairSigner };

/** Creates a command, has every signer sign in order, and returns the last view. */
async function run(
  w: World,
  initiator: OrgKey,
  kind: string,
  args: Record<string, string>,
  actors: Partial<Record<string, Actor>>,
): Promise<CommandView> {
  let view = await create(w, initiator, kind, args);
  for (const s of view.signers) {
    const actor = actors[s.role];
    if (!actor) throw new Error(`no actor for ${s.role}`);
    const response =
      s.method === "text"
        ? await signText(w, actor.org, view, s.role, actor.wallet)
        : await signTransactionAs(w, actor.org, view, actor.wallet);
    view = data<CommandView>(response);
  }
  return view;
}

function confirmed(view: CommandView, event: string) {
  expect(view.error, JSON.stringify(view.error)).toBeNull();
  const shown = JSON.stringify({ status: view.status, error: view.error, outcome: view.outcome });
  expect(view.status, shown).toBe("confirmed");
  expect(view.confirmedCommitment, shown).toBe("confirmed");
  expect(view.outcome?.event, shown).toBe(event);
  expect(view.transaction?.explorerUrl).toBe(
    `https://explorer.solana.com/tx/${view.transaction?.signature}?cluster=devnet`,
  );
  return view;
}

const lenderOne = (): Actor => ({ org: "lenderOne", wallet: wallets.lenderOne });
const lenderTwo = (): Actor => ({ org: "lenderTwo", wallet: wallets.lenderTwo });
const khunou = (): Actor => ({ org: "khunou", wallet: wallets.khunou });
const buyer = (): Actor => ({ org: "buyer", wallet: wallets.buyer });

async function openFacility(w: World, lender: "lenderOne" | "lenderTwo" = "lenderOne") {
  const view = await run(
    w,
    lender,
    "open_facility",
    {
      borrower: orgIds.khunou,
      currency: "USD",
      currencyDecimals: "2",
      termsVersion: "1",
      rateBps: "1200",
      maxLtvBps: "6000",
    },
    { lender: { org: lender, wallet: wallets[lender] } },
  );
  confirmed(view, "FacilityOpened");
  if (!view.facility) throw new Error("no facility");
  return view.facility;
}

async function setValuation(w: World, facility: string, validForDays = "30") {
  return confirmed(
    await run(
      w,
      "lenderOne",
      "set_valuation",
      {
        facility,
        custodianClass: w.custodianClass,
        grade: GRADE,
        valuePerKgMinor: "20",
        haircutBps: "0",
        validForDays,
        sourceNote: "Synthetic test price per kg, not a market quote",
      },
      { lender: lenderOne() },
    ),
    "ValuationSet",
  );
}

async function pledge(
  w: World,
  facility: string,
  lender: Actor = lenderOne(),
  quantityKg = "5000000",
) {
  return run(
    w,
    "khunou",
    "pledge",
    { facility, lot: w.lot, quantityKg },
    { borrower: khunou(), lender },
  );
}

async function advance(w: World, loan: string, amountMinor = "60000000") {
  return confirmed(
    await run(
      w,
      "lenderOne",
      "record_advance",
      { loan, amountMinor },
      { borrower: khunou(), lender: lenderOne() },
    ),
    "AdvanceRecorded",
  );
}

async function pledgedLoan(w: World) {
  const facility = await openFacility(w);
  await setValuation(w, facility);
  const pledged = confirmed(await pledge(w, facility), "Pledged");
  if (!pledged.loan) throw new Error("no loan");
  return { facility, loan: pledged.loan };
}

async function bankEvidence(org: OrgKey = "lenderOne") {
  const person = people[org];
  const bytes = Buffer.from(
    "%PDF-1.4\nSynthetic test bank confirmation, not a real bank record\n%%EOF\n",
  );
  const { id: objectId } = mustSucceed(
    await person.client
      .from("evidence_objects")
      .insert({
        owner_organisation_id: orgIds[org],
        subject_kind: "lot",
        subject_ref: LOT_ID,
        purpose: "bank",
        created_by: person.id,
      })
      .select("id")
      .single(),
  );
  const storagePath = `${orgIds[org]}/${objectId}/1`;
  const { id: versionId } = mustSucceed(
    await person.client
      .from("evidence_versions")
      .insert({
        object_id: objectId,
        version: 1,
        storage_path: storagePath,
        mime: "application/pdf",
        uploaded_by: person.id,
      })
      .select("id")
      .single(),
  );
  mustSucceed(
    await person.client.storage
      .from("originals")
      .upload(storagePath, bytes, { contentType: "application/pdf" }),
  );
  return versionId as string;
}

async function finalizedEvidence(w: World, org: OrgKey = "lenderOne") {
  const versionId = await bankEvidence(org);
  data(await call(w, "POST", `/v1/evidence/${versionId}/finalize`, people[org]));
  return versionId;
}

async function confirmPayment(
  w: World,
  loan: string,
  purpose: "Repayment" | "Release",
  amountMinor: string,
  bankReference: string,
  intent?: string,
) {
  const args: Record<string, string> = {
    loan,
    purpose,
    amountMinor,
    bankReference,
    observedAt: String(w.svm.getClock().unixTimestamp - 60n),
    evidenceVersionId: await finalizedEvidence(w),
  };
  if (intent) args.intent = intent;
  return run(w, "lenderOne", "confirm_payment", args, { lender: lenderOne() });
}

function loanAccount(w: World, loan: string) {
  return decodeLoan(w.svm.getAccount(address(loan)) as never).data;
}

// ---------------------------------------------------------------- setup

beforeAll(async () => {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = localSupabaseEnv();
  const hostname = new URL(API_URL).hostname;
  if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "[::1]") {
    throw new Error("API integration tests require a local Supabase API_URL");
  }
  vi.stubEnv("SUPABASE_URL", API_URL);
  vi.stubEnv("SUPABASE_ANON_KEY", ANON_KEY);
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);
  vi.stubEnv("SITE_URL", origin);
  vi.stubEnv("CORS_ORIGIN", origin);
  clients = createAccessClients();
  service = createClient(API_URL, SERVICE_ROLE_KEY, clientOptions);

  for (const key of Object.keys(ORGS) as OrgKey[]) orgIds[key] = randomUUID();
  for (const key of Object.keys(ORGS) as OrgKey[]) {
    const email = `${key.toLowerCase()}-${namespace}@example.com`;
    const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error) throw created.error;
    const client = createClient(API_URL, ANON_KEY, clientOptions);
    const signedIn = await client.auth.signInWithPassword({ email, password });
    if (signedIn.error) throw signedIn.error;
    people[key] = { id: created.data.user.id, token: signedIn.data.session.access_token, client };
  }
  const values = (Object.keys(ORGS) as OrgKey[])
    .map(
      (key) =>
        `('${orgIds[key]}', '${key.toLowerCase()}-${namespace}', '${ORGS[key].name}', '${ORGS[key].kind}', true)`,
    )
    .join(",\n");
  const members = (Object.keys(ORGS) as OrgKey[])
    .map((key) => `('${orgIds[key]}', '${people[key].id}', 'admin')`)
    .join(",\n");
  // One statement per query: production grants forbid membership inserts, so the local
  // database is written directly; every route call uses a user's own token.
  for (const statement of [
    `insert into public.organisations (id, slug, name, kind, synthetic) values ${values}`,
    `insert into public.memberships (organisation_id, user_id, member_role) values ${members}`,
  ]) {
    execFileSync("supabase", ["db", "query", "--local", statement], {
      cwd: projectRoot,
      timeout: 15_000,
    });
  }

  [payer, admin, accreditor, orgAdmin] = await Promise.all([
    signer(),
    signer(),
    signer(),
    signer(),
  ]);
  for (const key of Object.keys(WALLETS) as WalletKey[]) wallets[key] = await signer();

  // Link each linked wallet through the API's own wallet-link routes.
  const linkWorld = { deps: undefined } as unknown as World;
  for (const key of Object.keys(WALLETS) as WalletKey[]) {
    if (!WALLETS[key].linked) continue;
    const org = WALLETS[key].org;
    const challenge = data<{ challengeId: string; message: string }>(
      await call(linkWorld, "POST", "/v1/wallet-links/challenges", people[org], {
        organisationId: orgIds[org],
        wallet: wallets[key].address,
      }),
    );
    const signature = await signBytes(
      wallets[key].keyPair.privateKey,
      new TextEncoder().encode(challenge.message),
    );
    data(
      await call(linkWorld, "POST", "/v1/wallet-links", people[org], {
        challengeId: challenge.challengeId,
        signatureBase58: getBase58Decoder().decode(signature),
      }),
    );
  }

  // The sponsor key file lives outside the repository, as THETIS_SPONSOR requires.
  const seed = new Uint8Array(randomBytes(32));
  const key = await createKeyPairSignerFromPrivateKeyBytes(seed, true);
  const publicKey = getAddressEncoder().encode(key.address);
  const directory = await mkdtemp(join(tmpdir(), "thetis-sponsor-"));
  sponsorPath = join(directory, "sponsor.json");
  await writeFile(sponsorPath, JSON.stringify([...seed, ...publicKey]), { mode: 0o600 });
  sponsorAddress = (await createKeyPairSignerFromBytes(new Uint8Array([...seed, ...publicKey])))
    .address;
}, 60_000);

/** Removes this suite's open commands, so each test starts under the five-open cap (fold 10). */
function closeOpenCommands() {
  const users = Object.values(people).map((person) => `'${person.id}'`);
  if (users.length === 0) return;
  execFileSync(
    "supabase",
    [
      "db",
      "query",
      "--local",
      `delete from public.commands where created_by in (${users.join(", ")}) and status in ('awaiting_signatures', 'submitted', 'outcome_unknown')`,
    ],
    { cwd: projectRoot, timeout: 15_000 },
  );
}

afterEach(() => {
  vi.useRealTimers();
  closeOpenCommands();
});

// ---------------------------------------------------------------- tests

describe("relay commands on the real program", () => {
  it("the demo lender path confirms on the real program: facility, valuation, pledge, advance, release intent, payment, sale, repayment, repay, close", async () => {
    const w = await world();
    const { loan } = await pledgedLoan(w);
    await advance(w, loan);

    const intentView = confirmed(
      await run(
        w,
        "khunou",
        "create_release_intent",
        {
          loan,
          buyer: orgIds.buyer,
          quantityKg: "2000000",
          priceMinor: "40000000",
          topUpMinor: "0",
          expiresInHours: "24",
        },
        { seller: khunou() },
      ),
      "ReleaseIntentCreated",
    );
    const intent = intentView.intent;
    if (!intent) throw new Error("no intent");
    confirmed(
      await confirmPayment(w, loan, "Release", "40000000", "BANK-REL-0001", intent),
      "PaymentConfirmed",
    );
    const sale = confirmed(
      await run(w, "buyer", "sell_pledged", { intent }, { buyer: buyer() }),
      "PledgedSold",
    );
    expect(sale.payment).toBeTruthy();
    expect(sale.lot).toBe(w.lot);

    const repayment = confirmed(
      await confirmPayment(w, loan, "Repayment", "21000000", "BANK-REP-0001"),
      "PaymentConfirmed",
    );
    if (!repayment.payment) throw new Error("no payment");
    confirmed(
      await run(w, "lenderOne", "repay", { payment: repayment.payment }, { lender: lenderOne() }),
      "Repaid",
    );
    confirmed(
      await run(w, "lenderOne", "close_loan", { loan }, { lender: lenderOne() }),
      "LoanClosed",
    );
    expect(loanAccount(w, loan).status).toBe(3); // Closed
    expect(loanAccount(w, loan).principal).toBe(0n);
  }, 120_000);

  it("lender two's pledge of pledged units lands as a failed transaction named InsufficientAvailable", async () => {
    const w = await world();
    await pledgedLoan(w);
    const facilityTwo = await openFacility(w, "lenderTwo");
    const refused = await pledge(w, facilityTwo, lenderTwo());
    expect(refused.status).toBe("failed");
    expect(refused.error?.code).toBe("InsufficientAvailable");
    expect(refused.outcome).toBeNull();
    expect(refused.transaction?.signature).toBeTruthy();
    expect(await w.chain.status(refused.transaction?.signature ?? "")).toMatchObject({
      // [limit, price, Ed25519, pledge]: the relay's compute price puts pledge at index 3 (28 Nov).
      failed: { InstructionError: [3, { Custom: expect.any(Number) }] },
    });
  }, 120_000);

  it("liquidate confirms once the clock has passed the limit, and close_loan refuses outstanding debt on chain", async () => {
    const w = await world();
    const { loan } = await pledgedLoan(w);
    await advance(w, loan);
    const close = await run(w, "lenderOne", "close_loan", { loan }, { lender: lenderOne() });
    expect(close.status).toBe("failed");
    expect(close.error?.code).toBe("DebtOutstanding");

    const healthy = await run(w, "lenderOne", "liquidate", { loan }, { lender: lenderOne() });
    expect(healthy.status).toBe("failed");
    expect(healthy.error?.code).toBe("LoanHealthy");

    const clock = w.svm.getClock();
    clock.unixTimestamp += DAY;
    w.svm.setClock(clock);
    confirmed(
      await run(w, "lenderOne", "liquidate", { loan }, { lender: lenderOne() }),
      "Liquidated",
    );
    expect(loanAccount(w, loan).status).toBe(1); // Recovery
  }, 120_000);

  it("a correction after consumption confirms and advances the loan revision", async () => {
    const w = await world();
    const { loan } = await pledgedLoan(w);
    await advance(w, loan);
    const repayment = confirmed(
      await confirmPayment(w, loan, "Repayment", "1000000", "BANK-REP-0002"),
      "PaymentConfirmed",
    );
    if (!repayment.payment) throw new Error("no payment");
    confirmed(
      await run(w, "lenderOne", "repay", { payment: repayment.payment }, { lender: lenderOne() }),
      "Repaid",
    );
    const before = loanAccount(w, loan).revision;
    const correction = confirmed(
      await run(
        w,
        "lenderOne",
        "correct_payment",
        {
          target: repayment.payment,
          correctionReference: "CORR-0001",
          evidenceVersionId: await finalizedEvidence(w),
        },
        { lender: lenderOne() },
      ),
      "PaymentCorrected",
    );
    expect(correction.loan).toBe(loan);
    expect(loanAccount(w, loan).revision).toBe(before + 1n);
    const corrected = decodePaymentAttestation(
      w.svm.getAccount(address(repayment.payment)) as never,
    ).data;
    expect(corrected.status).not.toBe(0); // no longer Unconsumed
  }, 120_000);

  it("the simulation path confirms: facility, deposit, pledge, borrow, simulated repay, withdraw", async () => {
    const w = await world("simulation");
    const facility = await openFacility(w);
    await setValuation(w, facility);
    confirmed(
      await run(w, "lenderOne", "deposit", { amountMinor: "60000000" }, { depositor: lenderOne() }),
      "Deposited",
    );
    const pledged = confirmed(await pledge(w, facility), "Pledged");
    if (!pledged.loan) throw new Error("no loan");
    confirmed(
      await run(
        w,
        "khunou",
        "borrow",
        { loan: pledged.loan, amountMinor: "40000000", wallet: wallets.khunou.address },
        { borrower: khunou() },
      ),
      "Borrowed",
    );
    confirmed(
      await run(
        w,
        "khunou",
        "repay_simulated",
        { loan: pledged.loan, amountMinor: "10000000" },
        { payer: khunou() },
      ),
      "Repaid",
    );
    confirmed(
      await run(
        w,
        "lenderOne",
        "withdraw",
        { amountMinor: "10000000" },
        { depositor: lenderOne() },
      ),
      "Withdrawn",
    );
    expect(loanAccount(w, pledged.loan).principal).toBe(30_000_000n);
    // A fiat-only kind is refused before anything is built.
    const refused = await call(w, "POST", "/v1/commands", people.lenderOne, {
      kind: "record_advance",
      organisationId: orgIds.lenderOne,
      args: { loan: pledged.loan, amountMinor: "1" },
    });
    expect(refused.statusCode).toBe(409);
    expect(errorOf(refused).code).toBe("WRONG_SETTLEMENT_MODE");
  }, 120_000);

  it("refuses a signer without an active link, an Authority without the scope, a stale text and a wrong signature", async () => {
    // Every role keeps the Authority pre-check (fold 1) except repay_simulated's payer (no scope)
    // and handover's next_holder (refused on chain, field-app.md §11).
    for (const [kind, spec] of Object.entries(KIND_SPECS)) {
      for (const role of spec.signers) {
        expect(role.preCheckAuthority, `${kind}.${role.role}`).toBe(
          kind !== "repay_simulated" && !(kind === "handover" && role.role === "next_holder"),
        );
      }
    }
    const w = await world();
    const facility = await openFacility(w);
    const view = await create(w, "khunou", "pledge", { facility, lot: w.lot, quantityKg: "1000" });
    const sentBefore = w.chain.sent.length;

    const unlinked = await signText(w, "khunou", view, "borrower", wallets.khunouUnlinked);
    expect(unlinked.statusCode).toBe(409);
    expect(errorOf(unlinked).code).toBe("WALLET_NOT_LINKED");

    const unscoped = await signText(w, "khunou", view, "borrower", wallets.khunouUnscoped);
    expect(unscoped.statusCode).toBe(409);
    expect(errorOf(unscoped).code).toBe("AUTHORITY_INVALID");
    expect(errorOf(unscoped).detail).toMatch(/scope/);

    const stale = await signTextRequest(view, wallets.khunou, "borrower");
    const staleResponse = await call(
      w,
      "POST",
      `/v1/commands/${view.id}/signatures`,
      people.khunou,
      {
        ...stale,
        messageSha256: "0".repeat(64),
      },
    );
    expect(staleResponse.statusCode).toBe(409);
    expect(errorOf(staleResponse).code).toBe("STALE_TEXT");

    const wrong = await call(
      w,
      "POST",
      `/v1/commands/${view.id}/signatures`,
      people.khunou,
      await signTextRequest(
        view,
        wallets.khunou,
        "borrower",
        new TextEncoder().encode("another text"),
      ),
    );
    expect(wrong.statusCode).toBe(422);
    expect(errorOf(wrong).code).toBe("BAD_SIGNATURE");

    // A role the command doesn't have, and a linked wallet of the wrong organisation.
    const role = await call(w, "POST", `/v1/commands/${view.id}/signatures`, people.khunou, {
      ...(await signTextRequest(view, wallets.khunou, "buyer")),
    });
    expect(errorOf(role).code).toBe("ROLE_INVALID");
    const otherOrg = await signText(w, "lenderOne", view, "borrower", wallets.lenderOne);
    expect(otherOrg.statusCode).toBe(403);
    expect(errorOf(otherOrg).code).toBe("NOT_AUTHORISED");

    const fine = data<CommandView>(await signText(w, "khunou", view, "borrower", wallets.khunou));
    expect(fine.signers.find((s) => s.role === "borrower")?.signed?.wallet).toBe(
      wallets.khunou.address,
    );
    const again = await signText(w, "khunou", view, "borrower", wallets.khunou);
    expect(errorOf(again).code).toBe("ALREADY_SIGNED");
    expect(w.chain.sent).toHaveLength(sentBefore); // nothing refused reached the chain
  }, 120_000);

  it("a text expires 30 seconds before validUntil and renew issues a fresh text with the signatures cleared", async () => {
    const w = await world();
    const facility = await openFacility(w);
    const view = await create(w, "khunou", "pledge", { facility, lot: w.lot, quantityKg: "1000" });
    const validUntil = BigInt(view.text?.validUntil ? Date.parse(view.text.validUntil) / 1000 : 0);
    expect(validUntil).toBe(w.svm.getClock().unixTimestamp + 270n);
    data(await signText(w, "khunou", view, "borrower", wallets.khunou));

    const clock = w.svm.getClock();
    clock.unixTimestamp = validUntil - 29n;
    w.svm.setClock(clock);
    const late = await signText(w, "lenderOne", view, "lender", wallets.lenderOne);
    expect(late.statusCode).toBe(409);
    expect(errorOf(late).code).toBe("TEXT_EXPIRED");
    const expired = data<CommandView>(
      await call(w, "GET", `/v1/commands/${view.id}`, people.lenderOne),
    );
    expect(expired.status).toBe("expired");
    expect(expired.signers.find((s) => s.role === "borrower")?.signed).not.toBeNull();

    const notInitiator = await call(
      w,
      "POST",
      `/v1/commands/${view.id}/renew`,
      people.lenderOne,
      {},
    );
    expect(errorOf(notInitiator).code).toBe("NOT_AUTHORISED");
    const renewed = data<CommandView>(
      await call(w, "POST", `/v1/commands/${view.id}/renew`, people.khunou, {}),
    );
    expect(renewed.status).toBe("awaiting_signatures");
    expect(renewed.text?.version).toBe(2);
    expect(renewed.text?.messageSha256).not.toBe(view.text?.messageSha256);
    expect(renewed.signers.every((s) => s.signed === null)).toBe(true);
    const again = await call(w, "POST", `/v1/commands/${view.id}/renew`, people.khunou, {});
    expect(errorOf(again).code).toBe("COMMAND_STATE");

    let current = data<CommandView>(
      await signText(w, "khunou", renewed, "borrower", wallets.khunou),
    );
    current = data<CommandView>(
      await signText(w, "lenderOne", current, "lender", wallets.lenderOne),
    );
    confirmed(current, "Pledged");
  }, 120_000);

  it("two final signatures posted at once submit one transaction", async () => {
    const w = await world();
    const facility = await openFacility(w);
    const view = await create(w, "khunou", "pledge", { facility, lot: w.lot, quantityKg: "1000" });
    const before = w.chain.sent.length;
    const [first, second] = await Promise.all([
      signText(w, "khunou", view, "borrower", wallets.khunou),
      signText(w, "lenderOne", view, "lender", wallets.lenderOne),
    ]);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const final = data<CommandView>(await call(w, "GET", `/v1/commands/${view.id}`, people.khunou));
    confirmed(final, "Pledged");
    expect(final.transaction?.sends).toBe(1);
    expect(w.chain.sent.slice(before)).toEqual([final.transaction?.signature]);
  }, 120_000);

  it("a transaction kind that did not land returns to awaiting signatures and a new transaction confirms", async () => {
    const w = await world();
    const view = await create(w, "lenderOne", "open_facility", {
      borrower: orgIds.khunou,
      currency: "USD",
      currencyDecimals: "2",
      termsVersion: "1",
      rateBps: "1200",
      maxLtvBps: "6000",
    });
    w.chain.dropSends = true;
    const lost = data<CommandView>(
      await signTransactionAs(w, "lenderOne", view, wallets.lenderOne),
    );
    expect(lost.status).toBe("awaiting_signatures");
    expect(lost.transaction).toBeNull();
    expect(lost.signers[0]?.signed).toBeNull();
    w.chain.dropSends = false;
    confirmed(
      data<CommandView>(await signTransactionAs(w, "lenderOne", lost, wallets.lenderOne)),
      "FacilityOpened",
    );
  }, 120_000);

  it("three transactions that did not land, then a fourth, keep the command signable and the fifth confirms", async () => {
    const w = await world();
    let view = await create(w, "lenderOne", "open_facility", {
      borrower: orgIds.khunou,
      currency: "USD",
      currencyDecimals: "2",
      termsVersion: "1",
      rateBps: "1200",
      maxLtvBps: "6000",
    });
    w.chain.dropSends = true;
    for (let cycle = 0; cycle < 4; cycle++) {
      view = data<CommandView>(await signTransactionAs(w, "lenderOne", view, wallets.lenderOne));
      expect(view.status, `cycle ${cycle + 1}`).toBe("awaiting_signatures");
      expect(view.transaction).toBeNull();
    }
    w.chain.dropSends = false;
    const final = confirmed(
      data<CommandView>(await signTransactionAs(w, "lenderOne", view, wallets.lenderOne)),
      "FacilityOpened",
    );
    expect(final.transaction?.sends).toBe(1);
  }, 180_000);

  it("transaction requests never put an account the instruction creates into the lookup table", async () => {
    const w = await world();
    // One of each kind confirms first, so every account that exists is already in the table.
    const { facility, loan } = await pledgedLoan(w);
    await advance(w, loan);
    confirmed(
      await confirmPayment(w, loan, "Repayment", "1000000", "BANK-TBL-0000"),
      "PaymentConfirmed",
    );
    confirmed(
      await run(
        w,
        "lenderOne",
        "open_facility",
        {
          borrower: orgIds.khunou,
          currency: "USD",
          currencyDecimals: "2",
          termsVersion: "1",
          rateBps: "1200",
          maxLtvBps: "6000",
        },
        { lender: lenderOne() },
      ),
      "FacilityOpened",
    );
    const { address: table } = mustSucceed(
      await service
        .from("relay_lookup_tables")
        .select("address")
        .eq("protocol", w.protocol)
        .single(),
    );
    const before = lookupTableAddresses(w.svm, table as Address);
    const created: string[] = [];
    for (let round = 0; round < 3; round++) {
      const opened = await create(w, "lenderOne", "open_facility", {
        borrower: orgIds.khunou,
        currency: "USD",
        currencyDecimals: "2",
        termsVersion: "1",
        rateBps: "1200",
        maxLtvBps: "6000",
      });
      await requestTransaction(w, "lenderOne", opened, wallets.lenderOne);
      created.push(opened.facility as string);
      const valued = await create(w, "lenderOne", "set_valuation", {
        facility,
        custodianClass: w.custodianClass,
        grade: `G-ALT-${round}`,
        valuePerKgMinor: "20",
        haircutBps: "0",
        validForDays: "30",
        sourceNote: "Synthetic test price per kg, not a market quote",
      });
      await requestTransaction(w, "lenderOne", valued, wallets.lenderOne);
      const { plan } = mustSucceed(
        await service.from("commands").select("plan").eq("id", valued.id).single(),
      );
      created.push((plan as { valuation: string }).valuation);
      const paid = await create(w, "lenderOne", "confirm_payment", {
        loan,
        purpose: "Repayment",
        amountMinor: "1000000",
        bankReference: `BANK-TBL-${round + 1}`,
        observedAt: String(w.svm.getClock().unixTimestamp - 60n),
        evidenceVersionId: await finalizedEvidence(w),
      });
      await requestTransaction(w, "lenderOne", paid, wallets.lenderOne);
      created.push(paid.payment as string);
      closeOpenCommands();
    }
    const after = lookupTableAddresses(w.svm, table as Address);
    for (const key of created) expect(after, key).not.toContain(key);
    expect(after).toEqual(before);
  }, 240_000);

  it("a user with five open commands gets TOO_MANY_OPEN_COMMANDS (429) on a sixth, and creates again once one is terminal", async () => {
    const w = await world();
    const args = {
      borrower: orgIds.khunou,
      currency: "USD",
      currencyDecimals: "2",
      termsVersion: "1",
      rateBps: "1200",
      maxLtvBps: "6000",
    };
    const createRequest = () =>
      call(w, "POST", "/v1/commands", people.lenderOne, {
        kind: "open_facility",
        organisationId: orgIds.lenderOne,
        args,
      });
    const open: CommandView[] = [];
    for (let index = 0; index < 5; index++)
      open.push(await create(w, "lenderOne", "open_facility", args));
    const sixth = await createRequest();
    expect(sixth.statusCode).toBe(429);
    expect(errorOf(sixth).code).toBe("TOO_MANY_OPEN_COMMANDS");
    // Another user is not counted against this one.
    await create(w, "lenderTwo", "open_facility", args);
    // One reaches a terminal status: a new create succeeds, and the cap holds again after it.
    confirmed(
      data<CommandView>(
        await signTransactionAs(w, "lenderOne", open[0] as CommandView, wallets.lenderOne),
      ),
      "FacilityOpened",
    );
    await create(w, "lenderOne", "open_facility", args);
    expect((await createRequest()).statusCode).toBe(429);
    // Seven creates at once with none open: exactly five are accepted.
    closeOpenCommands();
    const burst = await Promise.all(Array.from({ length: 7 }, createRequest));
    expect(burst.map((response) => response.statusCode).sort()).toEqual([
      201, 201, 201, 201, 201, 429, 429,
    ]);
  }, 180_000);

  it("a sponsor that does not answer its address is SPONSOR_UNAVAILABLE (503)", async () => {
    const w = await world();
    const view = await create(w, "lenderOne", "open_facility", {
      borrower: orgIds.khunou,
      currency: "USD",
      currencyDecimals: "2",
      termsVersion: "1",
      rateBps: "1200",
      maxLtvBps: "6000",
    });
    const working = w.deps.sponsor;
    w.deps = {
      ...w.deps,
      sponsor: {
        address: () => Promise.reject(new SponsorUnavailableError("the sponsor did not answer")),
        sign: working.sign,
      },
    };
    const response = await call(
      w,
      "POST",
      `/v1/commands/${view.id}/transaction-request`,
      people.lenderOne,
      { wallet: wallets.lenderOne.address },
    );
    expect(response.statusCode).toBe(503);
    expect(errorOf(response).code).toBe("SPONSOR_UNAVAILABLE");
  }, 120_000);

  it("a signed transaction whose message differs from the issued one is TRANSACTION_MISMATCH", async () => {
    const w = await world();
    const view = await create(w, "lenderOne", "open_facility", {
      borrower: orgIds.khunou,
      currency: "USD",
      currencyDecimals: "2",
      termsVersion: "1",
      rateBps: "1200",
      maxLtvBps: "6000",
    });
    const first = await requestTransaction(w, "lenderOne", view, wallets.lenderOne);
    w.svm.expireBlockhash();
    const second = await requestTransaction(w, "lenderOne", view, wallets.lenderOne);
    expect(second.transactionBase64).not.toBe(first.transactionBase64);
    const stale = await call(w, "POST", `/v1/commands/${view.id}/transaction`, people.lenderOne, {
      transactionBase64: await walletSigns(first.transactionBase64, wallets.lenderOne),
    });
    expect(stale.statusCode).toBe(422);
    expect(errorOf(stale).code).toBe("TRANSACTION_MISMATCH");
    // The lender's slot holds a signature by another wallet.
    const issued = getTransactionDecoder().decode(
      getBase64Encoder().encode(second.transactionBase64),
    );
    const forged = {
      ...issued,
      signatures: {
        ...issued.signatures,
        [wallets.lenderOne.address]: await signBytes(
          wallets.lenderTwo.keyPair.privateKey,
          issued.messageBytes,
        ),
      },
    } as Transaction;
    const otherWallet = await call(
      w,
      "POST",
      `/v1/commands/${view.id}/transaction`,
      people.lenderOne,
      {
        transactionBase64: getBase64Decoder().decode(getTransactionEncoder().encode(forged)),
      },
    );
    expect(errorOf(otherWallet).code).toBe("TRANSACTION_MISMATCH");
    // Unsigned.
    const unsigned = await call(
      w,
      "POST",
      `/v1/commands/${view.id}/transaction`,
      people.lenderOne,
      {
        transactionBase64: second.transactionBase64,
      },
    );
    expect(errorOf(unsigned).code).toBe("TRANSACTION_MISMATCH");
    expect(w.chain.sent).toHaveLength(0); // nothing was sent for the refused transactions
    confirmed(
      data<CommandView>(
        await call(w, "POST", `/v1/commands/${view.id}/transaction`, people.lenderOne, {
          transactionBase64: await walletSigns(second.transactionBase64, wallets.lenderOne),
        }),
      ),
      "FacilityOpened",
    );
  }, 120_000);

  it("a second confirmation with the same bank reference is PAYMENT_ALREADY_RECORDED", async () => {
    const w = await world();
    const { loan } = await pledgedLoan(w);
    await advance(w, loan);
    const first = confirmed(
      await confirmPayment(w, loan, "Repayment", "1000000", "BANK-REP-0003"),
      "PaymentConfirmed",
    );
    const repeat = await call(w, "POST", "/v1/commands", people.lenderOne, {
      kind: "confirm_payment",
      organisationId: orgIds.lenderOne,
      args: {
        loan,
        purpose: "Repayment",
        amountMinor: "1000000",
        bankReference: "BANK-REP-0003",
        observedAt: String(NOW - 60n),
        evidenceVersionId: await finalizedEvidence(w),
      },
    });
    expect(repeat.statusCode).toBe(409);
    expect(errorOf(repeat)).toMatchObject({
      code: "PAYMENT_ALREADY_RECORDED",
      detail: first.payment,
    });
    // Evidence of another organisation is not this lender's bank record.
    const foreign = await call(w, "POST", "/v1/commands", people.lenderOne, {
      kind: "confirm_payment",
      organisationId: orgIds.lenderOne,
      args: {
        loan,
        purpose: "Repayment",
        amountMinor: "1000000",
        bankReference: "BANK-REP-0004",
        observedAt: String(NOW - 60n),
        evidenceVersionId: await finalizedEvidence(w, "khunou"),
      },
    });
    expect(errorOf(foreign).code).toBe("EVIDENCE_INVALID");
  }, 120_000);

  it("a member of another organisation can't read, sign or renew a command", async () => {
    const w = await world();
    const facility = await openFacility(w);
    const view = await create(w, "khunou", "pledge", { facility, lot: w.lot, quantityKg: "1000" });
    const read = await call(w, "GET", `/v1/commands/${view.id}`, people.outsider);
    expect(read.statusCode).toBe(404);
    const sign = await call(
      w,
      "POST",
      `/v1/commands/${view.id}/signatures`,
      people.outsider,
      await signTextRequest(view, wallets.khunou, "borrower"),
    );
    expect(sign.statusCode).toBe(404);
    const renew = await call(w, "POST", `/v1/commands/${view.id}/renew`, people.outsider, {});
    expect(renew.statusCode).toBe(404);
    const request = await call(
      w,
      "POST",
      `/v1/commands/${view.id}/transaction-request`,
      people.outsider,
      {
        wallet: wallets.lenderOne.address,
      },
    );
    expect(request.statusCode).toBe(404);
    // Nor create one in another organisation's name.
    const foreign = await call(w, "POST", "/v1/commands", people.outsider, {
      kind: "pledge",
      organisationId: orgIds.khunou,
      args: { facility, lot: w.lot, quantityKg: "1000" },
    });
    expect(foreign.statusCode).toBe(403);
    expect(errorOf(foreign).code).toBe("NOT_AUTHORISED");
    const unauthenticated = await call(w, "GET", `/v1/commands/${view.id}`, null);
    expect(unauthenticated.statusCode).toBe(401);
  }, 120_000);

  it("the outcome is the decoded event of the confirmed transaction", async () => {
    const w = await world();
    const view = await run(
      w,
      "lenderOne",
      "open_facility",
      {
        borrower: orgIds.khunou,
        currency: "USD",
        currencyDecimals: "2",
        termsVersion: "1",
        rateBps: "1200",
        maxLtvBps: "6000",
      },
      { lender: lenderOne() },
    );
    confirmed(view, "FacilityOpened");
    expect(view.outcome?.data).toEqual({
      facility: view.facility,
      lender: w.orgs.lenderOne,
      borrower: w.orgs.khunou,
      currency: Buffer.from("USD").toString("hex"),
      currencyDecimals: 2,
      termsVersion: 1,
      rateBps: 1200,
      maxLtvBps: 6000,
    });
    expect(view.outcome?.slot).toBe(view.confirmedSlot);
    expect(view.fields.map((f) => f.label)).toEqual([
      "Lender",
      "Borrower",
      "Facility",
      "Currency",
      "Rate",
      "Max LTV",
      "Terms",
    ]);
    expect(view.fields[0]?.value).toBe("Lender One Bank");
    const logs = (await w.chain.transaction(view.transaction?.signature ?? ""))?.logs ?? [];
    expect(logs.some((line) => line.startsWith("Program data: "))).toBe(true);
  }, 120_000);
});

// ---------------------------------------------------------------- the field kinds (field-app.md §6.3)

const TICKET = "WB2611-0042";

function issueArgs(
  w: World,
  lotId: string,
  quantityKg: string,
  weighbridgeTicket = "wb 2611-0042",
) {
  return {
    custodianClass: w.custodianClass,
    owner: orgIds.khunou,
    lotId,
    grade: GRADE,
    quantityKg,
    weighbridgeTicket,
  };
}

const kopanoIssuer = (): Actor => ({ org: "kopano", wallet: wallets.kopanoField });

async function lotPda(protocol: Address, lotId: string) {
  const [found] = await getProgramDerivedAddress({
    programAddress: THETIS_PROGRAM_ADDRESS,
    seeds: ["lot", getAddressEncoder().encode(protocol), lotId],
  });
  return found;
}

function failedWith(view: CommandView, code: string) {
  const shown = JSON.stringify({ status: view.status, error: view.error });
  expect(view.status, shown).toBe("failed");
  expect(view.error?.code, shown).toBe(code);
  expect(view.transaction?.explorerUrl).toBe(
    `https://explorer.solana.com/tx/${view.transaction?.signature}?cluster=devnet`,
  );
}

describe("field kinds on the real program", () => {
  it("issue_lot through /v1/commands lands with the pinned text and values", async () => {
    const w = await world();
    const chainTime = w.svm.getClock().unixTimestamp;
    const created = await create(w, "kopano", "issue_lot", issueArgs(w, "CR-0002", "2000000"));
    const lot = await lotPda(w.protocol, "CR-0002");
    expect(created.kind).toBe("issue_lot");
    expect(created.lot).toBe(lot);
    expect(created.signers).toStrictEqual([
      { role: "custodian", organisationId: orgIds.kopano, method: "text", signed: null },
    ]);
    const validUntil = BigInt(Date.parse(created.text?.validUntil ?? "") / 1000);
    expect(validUntil - chainTime).toBe(570n);
    const expected = issueLotMessage(
      THETIS_PROGRAM_ADDRESS,
      w.instanceId,
      "CR-0002",
      "CHROME",
      1,
      GRADE,
      2_000_000n,
      ORGS.khunou.name,
      ORGS.kopano.name,
      SITE,
      Uint8Array.from(Buffer.from(intakeDigest(SITE, TICKET), "hex")),
      null,
      validUntil,
    );
    const sent = new Uint8Array(getBase64Encoder().encode(created.text?.messageBase64 ?? ""));
    expect(Buffer.from(sent).equals(Buffer.from(expected))).toBe(true);
    expect(created.text?.messageSha256).toBe(createHash("sha256").update(expected).digest("hex"));
    expect(created.fields).toContainEqual({ label: "Origin document", value: "not required" });

    const view = confirmed(
      data<CommandView>(await signText(w, "kopano", created, "custodian", wallets.kopanoField)),
      "LotIssued",
    );
    const [intake] = await findIntakePda({
      protocol: w.protocol,
      custodian: w.orgs.kopano,
      intakeDigest: Uint8Array.from(Buffer.from(intakeDigest(SITE, TICKET), "hex")),
    });
    expect(view.outcome?.data).toStrictEqual({
      lot,
      owner: w.orgs.khunou,
      quantityKg: "2000000",
      intake,
      revision: "0",
    });
    const stored = decodeLot(w.svm.getAccount(lot) as never).data;
    expect(stored.lotId).toBe("CR-0002");
    expect(stored.supplyKg).toBe(2_000_000n);
    expect(stored.grade).toBe(GRADE);
    expect(stored.custodianClass).toBe(w.custodianClass);
    const site = decodeCustodianClass(w.svm.getAccount(w.custodianClass) as never).data;
    expect(site.occupiedKg).toBe(LOT_KG + 2_000_000n);
    // Fold 9: an account the instruction created never went into the lookup table.
    const { address: table } = mustSucceed(
      await service
        .from("relay_lookup_tables")
        .select("address")
        .eq("protocol", w.protocol)
        .single(),
    );
    const tableKeys = lookupTableAddresses(w.svm, address(table as string));
    expect(tableKeys).not.toContain(lot);
    // Fold 25: the mint and vault authorities (never accounts) are table entries, so the
    // transaction fits devnet's 1,232 bytes (the LiteSVM port refuses a larger one).
    const [mint] = await findMintPda({ lot });
    const [position] = await findPositionPda({ lot, owner: w.orgs.khunou });
    expect(tableKeys).toContain((await findMintAuthorityPda({ mint }))[0]);
    expect(tableKeys).toContain((await findVaultAuthorityPda({ position }))[0]);
  });

  it("a second lot for the same weighbridge ticket fails on chain as Anchor0", async () => {
    const w = await world();
    confirmed(
      await run(w, "kopano", "issue_lot", issueArgs(w, "CR-0002", "1000000"), {
        custodian: kopanoIssuer(),
      }),
      "LotIssued",
    );
    const again = await run(
      w,
      "kopano",
      "issue_lot",
      issueArgs(w, "CR-0003", "1000000", "WB2611-0042"),
      { custodian: kopanoIssuer() },
    );
    failedWith(again, "Anchor0");
    expect(w.svm.getAccount(await lotPda(w.protocol, "CR-0003")).exists).toBe(false);
  });

  it("a lot above the site's free capacity fails on chain as OverCapacity", async () => {
    const w = await world();
    // 10,000 t approved, 5,000 t occupied by CR-0001.
    const view = await run(w, "kopano", "issue_lot", issueArgs(w, "CR-0002", "5000001"), {
      custodian: kopanoIssuer(),
    });
    failedWith(view, "OverCapacity");
    const site = decodeCustodianClass(w.svm.getAccount(w.custodianClass) as never).data;
    expect(site.occupiedKg).toBe(LOT_KG);
  });

  it("a linked custodian wallet with no Authority is AUTHORITY_INVALID and nothing is sent", async () => {
    const w = await world();
    const created = await create(w, "kopano", "issue_lot", issueArgs(w, "CR-0002", "1000000"));
    const before = w.chain.sent.length;
    const response = await signText(w, "kopano", created, "custodian", wallets.kopanoNoAuthority);
    expect(response.statusCode).toBe(409);
    expect(errorOf(response).code).toBe("AUTHORITY_INVALID");
    expect(w.chain.sent.length).toBe(before);
    const view = data<CommandView>(
      await call(w, "GET", `/v1/commands/${created.id}`, people.kopano),
    );
    expect(view.status).toBe("awaiting_signatures");
    expect(view.transaction).toBeNull();
  });

  it("refuses an initiator that is not the class's custodian and an owner that is not on chain", async () => {
    const w = await world();
    const notCustodian = await call(w, "POST", "/v1/commands", people.khunou, {
      kind: "issue_lot",
      organisationId: orgIds.khunou,
      args: issueArgs(w, "CR-0002", "1000000"),
    });
    expect(notCustodian.statusCode).toBe(403);
    expect(errorOf(notCustodian).code).toBe("NOT_AUTHORISED");
    const missingOwner = await call(w, "POST", "/v1/commands", people.kopano, {
      kind: "issue_lot",
      organisationId: orgIds.kopano,
      args: { ...issueArgs(w, "CR-0002", "1000000"), owner: randomUUID() },
    });
    expect(errorOf(missingOwner).code).toBe("ACCOUNT_MISSING");
    expect(errorOf(missingOwner).detail).toMatch(/^ownerOrg: /);
  });
});

// ---------------------------------------------------------------- handover (program-custody.md)

const sha = (...parts: Uint8Array[]) =>
  new Uint8Array(createHash("sha256").update(Buffer.concat(parts)).digest());
const u64le = (value: bigint) => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
};

/** program-custody.md §6.3's manifest for one batch at index 0: the root and the proof. */
function oneBatchManifest(
  quantityKg: bigint,
  carrier: Address,
  load: Uint8Array,
  manifest: Uint8Array,
) {
  const leaf = sha(
    Uint8Array.of(0, 0),
    u64le(quantityKg),
    new Uint8Array(getAddressEncoder().encode(carrier)),
    load,
    manifest,
  );
  const node = (left: Uint8Array, right: Uint8Array) => sha(Uint8Array.of(1), left, right);
  const empty: Uint8Array[] = [new Uint8Array(32)];
  for (let level = 1; level < 4; level++) {
    const below = empty[level - 1] as Uint8Array;
    empty.push(node(below, below));
  }
  let root = leaf;
  for (const sibling of empty) root = node(root, sibling);
  return { root, proof: empty };
}

/** A one-batch shipment of CR-0001 from Kopano's site to Port Terminal T1, carried by Mosela,
 * prepared by Khunou and registered; Kopano holds the batch at source. */
async function shippedBatch(w: World) {
  const classPolicy = await classPolicyPda(w.protocol);
  const [destination] = await getProgramDerivedAddress({
    programAddress: THETIS_PROGRAM_ADDRESS,
    seeds: [
      "custodian_class",
      getAddressEncoder().encode(w.protocol),
      getAddressEncoder().encode(w.orgs.portT1),
      getAddressEncoder().encode(classPolicy),
      "PORT-T1",
    ],
  });
  await send(
    w.svm,
    [
      getAccreditCustodianClassInstruction({
        protocol: w.protocol,
        custodian: w.orgs.portT1,
        classPolicy,
        custodianClass: destination,
        accreditor,
        payer,
        siteCode: "PORT-T1",
        approvedCapacityKg: 5_000_000n,
      }),
    ],
    [accreditor],
  );
  const version = new Uint8Array(4);
  new DataView(version.buffer).setUint32(0, 1, true);
  const subject = new Uint8Array(getAddressEncoder().encode(w.lot));
  const [document] = await getProgramDerivedAddress({
    programAddress: THETIS_PROGRAM_ADDRESS,
    seeds: [
      "document",
      getAddressEncoder().encode(w.protocol),
      Uint8Array.of(DocumentKind.Departure),
      subject,
      version,
    ],
  });
  const documentSha = new Uint8Array(32).fill(0x45);
  const [kopanoAuthority] = await findAuthorityPda({
    protocol: w.protocol,
    wallet: wallets.kopanoField.address,
  });
  await send(
    w.svm,
    [
      getAttestDocumentInstruction({
        protocol: w.protocol,
        organisation: w.orgs.kopano,
        authority: kopanoAuthority,
        document,
        wallet: wallets.kopanoField,
        payer,
        kind: DocumentKind.Departure,
        subject,
        version: 1,
        sha256: documentSha,
        validUntil: NOW + 30n * DAY,
      }),
    ],
    [wallets.kopanoField],
  );

  const load = new Uint8Array(32).fill(0x33);
  const manifestDigest = new Uint8Array(32).fill(0x44);
  const { root, proof } = oneBatchManifest(LOT_KG, w.orgs.mosela, load, manifestDigest);
  const shipmentId = new Uint8Array(randomBytes(16));
  const lotRevision = decodeLot(w.svm.getAccount(w.lot) as never).data.revision;
  const validUntil = w.svm.getClock().unixTimestamp + 300n;
  const text = envelope(
    THETIS_PROGRAM_ADDRESS,
    Buffer.from(w.instanceId).toString("hex"),
    "Prepare shipment",
    [
      ["Lot", LOT_ID],
      ["Shipment", Buffer.from(shipmentId).toString("hex")],
      ["Quantity", formatTonnes(LOT_KG)],
      ["Owner", ORGS.khunou.name],
      ["To", ORGS.portT1.name],
      ["Site", "PORT-T1"],
      ["Batches", "1"],
      ["Manifest", Buffer.from(root).toString("hex")],
      ["Departure document", `${Buffer.from(documentSha).toString("hex")} v1`],
      ["Revision", String(lotRevision)],
    ],
    validUntil,
  );
  const [position] = await findPositionPda({ lot: w.lot, owner: w.orgs.khunou });
  const [ownerAuthority] = await findAuthorityPda({
    protocol: w.protocol,
    wallet: wallets.khunouShip.address,
  });
  const prepare = await getPrepareShipmentInstructionAsync({
    sponsor: payer,
    protocol: w.protocol,
    ownerOrg: w.orgs.khunou,
    ownerAuthority,
    lot: w.lot,
    position,
    sourceClass: w.custodianClass,
    destinationClass: destination,
    destinationOrg: w.orgs.portT1,
    departureDocument: document,
    departureIssuer: w.orgs.kopano,
    shipmentId,
    batchCount: 1,
    manifestRoot: root,
    expectedRevision: lotRevision,
    validUntil,
  });
  const ownerSignature = await signBytes(wallets.khunouShip.keyPair.privateKey, text);
  await send(
    w.svm,
    [
      sharedEd25519([{ wallet: wallets.khunouShip.address, signature: ownerSignature }], text),
      prepare,
    ],
    [],
  );
  const shipment = prepare.accounts[11]?.address as Address;
  const register = await getRegisterBatchInstructionAsync({
    payer,
    protocol: w.protocol,
    shipment,
    index: 0,
    quantityKg: LOT_KG,
    carrier: w.orgs.mosela,
    loadDigest: load,
    manifestDigest,
    proof,
  });
  await send(w.svm, [register], []);
  return { shipmentId, batch: register.accounts[3]?.address as Address, manifestDigest };
}

const kopanoHolder = (): Actor => ({ org: "kopano", wallet: wallets.kopanoField });

describe("handover on the real program", () => {
  it("the holder and the carrier sign one text, and the batch moves to the carrier at Departure", async () => {
    const w = await world();
    const { batch, shipmentId, manifestDigest } = await shippedBatch(w);
    const chainTime = w.svm.getClock().unixTimestamp;
    const created = await create(w, "kopano", "handover", { batch, to: orgIds.mosela });
    expect(created.lot).toBe(w.lot);
    expect(created.signers.map((s) => [s.role, s.organisationId])).toStrictEqual([
      ["holder", orgIds.kopano],
      ["next_holder", orgIds.mosela],
    ]);
    const validUntil = BigInt(Date.parse(created.text?.validUntil ?? "") / 1000);
    expect(validUntil - chainTime).toBe(570n);
    const expected = custodyHandoverMessage(
      THETIS_PROGRAM_ADDRESS,
      w.instanceId,
      LOT_ID,
      shipmentId,
      1,
      1,
      LOT_KG,
      ORGS.kopano.name,
      ORGS.mosela.name,
      "Departure",
      manifestDigest,
      0n,
      validUntil,
    );
    const sent = new Uint8Array(getBase64Encoder().encode(created.text?.messageBase64 ?? ""));
    expect(Buffer.from(sent).equals(Buffer.from(expected))).toBe(true);

    let view = data<CommandView>(
      await signText(w, "kopano", created, "holder", wallets.kopanoField),
    );
    expect(view.status).toBe("awaiting_signatures");
    view = confirmed(
      data<CommandView>(await signText(w, "mosela", view, "next_holder", wallets.mosela)),
      "CustodyHandedOver",
    );
    const [handover] = await findHandoverPda({ batch, expectedSequence: 0n });
    expect(view.outcome?.data).toMatchObject({
      handover,
      batch,
      lot: w.lot,
      sequence: "0",
      from: w.orgs.kopano,
      to: w.orgs.mosela,
      quantityKg: String(LOT_KG),
    });
    const after = decodeManifestBatch(w.svm.getAccount(batch) as never).data;
    expect(after.holder).toBe(w.orgs.mosela);
    expect(after.sequence).toBe(1n);
    // T056r R7 (program-custody.md §4.6): the relay appended the HandoverRecord to the table
    // before sending, and the handover that created it landed.
    const [{ address: table }] = (await lookupTableRows(w)) as [{ address: string }];
    expect(lookupTableAddresses(w.svm, table as Address)).toContain(handover);
    expect(w.svm.getAccount(handover).exists).toBe(true);
  });

  it("the refused driver: a linked carrier wallet with no Authority reaches the chain and fails as Anchor3012", async () => {
    const w = await world();
    const { batch } = await shippedBatch(w);
    const before = w.chain.sent.length;
    const view = await run(
      w,
      "kopano",
      "handover",
      { batch, to: orgIds.mosela },
      {
        holder: kopanoHolder(),
        next_holder: { org: "mosela", wallet: wallets.moselaNoAuthority },
      },
    );
    failedWith(view, "Anchor3012");
    expect(w.chain.sent.length).toBe(before + 1);
    // A wallet-derived key that is not on chain never enters the table (fold 9; PR #69 folds).
    const [undelegated] = await findAuthorityPda({
      protocol: w.protocol,
      wallet: wallets.moselaNoAuthority.address,
    });
    const { address: table } = mustSucceed(
      await service
        .from("relay_lookup_tables")
        .select("address")
        .eq("protocol", w.protocol)
        .single(),
    );
    expect(lookupTableAddresses(w.svm, address(table as string))).not.toContain(undelegated);
    const after = decodeManifestBatch(w.svm.getAccount(batch) as never).data;
    expect(after.holder).toBe(w.orgs.kopano);
    expect(after.sequence).toBe(0n);
  });

  it("refuses a caller that is not the batch's holder", async () => {
    const w = await world();
    const { batch } = await shippedBatch(w);
    const response = await call(w, "POST", "/v1/commands", people.mosela, {
      kind: "handover",
      organisationId: orgIds.mosela,
      args: { batch, to: orgIds.portT1 },
    });
    expect(response.statusCode).toBe(403);
    expect(errorOf(response).code).toBe("NOT_AUTHORISED");
  });
});

// ---------------------------------------------------------------- PR #69 review folds (field-app.md)

/** A class and a Kopano site for it, registered directly (Phase 1 state). */
async function accreditSite(
  w: World,
  values: { classCode: string; grade: string; site: string; originRequired: boolean },
) {
  const classPolicy = await classPolicyPda(w.protocol, values.classCode);
  await send(
    w.svm,
    [
      getRegisterClassInstruction({
        protocol: w.protocol,
        classPolicy,
        accreditor,
        payer,
        classCode: values.classCode,
        version: 1,
        grades: [values.grade],
        originRequired: values.originRequired,
        lotValiditySecs: 30n * DAY,
        splitInheritsExpiry: true,
      }),
    ],
    [accreditor],
  );
  const [custodianClass] = await getProgramDerivedAddress({
    programAddress: THETIS_PROGRAM_ADDRESS,
    seeds: [
      "custodian_class",
      getAddressEncoder().encode(w.protocol),
      getAddressEncoder().encode(w.orgs.kopano),
      getAddressEncoder().encode(classPolicy),
      values.site,
    ],
  });
  await send(
    w.svm,
    [
      getAccreditCustodianClassInstruction({
        protocol: w.protocol,
        custodian: w.orgs.kopano,
        classPolicy,
        custodianClass,
        accreditor,
        payer,
        siteCode: values.site,
        approvedCapacityKg: 10_000_000n,
      }),
    ],
    [accreditor],
  );
  return custodianClass;
}

/** A synthetic document issuer on chain, with one wallet holding ATTEST_ORIGIN. */
async function originIssuer(w: World) {
  const orgId = uuidBytes(randomUUID());
  const [organisation] = await findOrganisationPda({ protocol: w.protocol, orgId });
  const name = "Origin Registry (synthetic)";
  await send(
    w.svm,
    [
      getAccreditOrganisationInstruction({
        protocol: w.protocol,
        organisation,
        organisationName: await orgNamePda(w.protocol, name),
        accreditor,
        payer,
        orgId,
        role: Role.DocumentIssuer as never,
        displayName: name,
        admin: orgAdmin.address,
      }),
    ],
    [accreditor],
  );
  const wallet = await signer();
  const [authority] = await findAuthorityPda({ protocol: w.protocol, wallet: wallet.address });
  await send(
    w.svm,
    [
      getDelegateAuthorityInstruction({
        protocol: w.protocol,
        organisation,
        authority,
        admin: orgAdmin,
        payer,
        wallet: wallet.address,
        scopes: SCOPE.ATTEST_ORIGIN,
        expiresAt: NOW + 60n * DAY,
      }),
    ],
    [orgAdmin],
  );
  return { organisation, authority, wallet };
}

async function attestOrigin(
  w: World,
  issuer: Awaited<ReturnType<typeof originIssuer>>,
  subject: Uint8Array,
  version: number,
  validUntil: bigint,
  sha256: Uint8Array,
) {
  const versionBytes = new Uint8Array(4);
  new DataView(versionBytes.buffer).setUint32(0, version, true);
  const [document] = await getProgramDerivedAddress({
    programAddress: THETIS_PROGRAM_ADDRESS,
    seeds: [
      "document",
      getAddressEncoder().encode(w.protocol),
      Uint8Array.of(DocumentKind.Origin),
      subject,
      versionBytes,
    ],
  });
  await send(
    w.svm,
    [
      getAttestDocumentInstruction({
        protocol: w.protocol,
        organisation: issuer.organisation,
        authority: issuer.authority,
        document,
        wallet: issuer.wallet,
        payer,
        kind: DocumentKind.Origin,
        subject,
        version,
        sha256,
        validUntil,
      }),
    ],
    [issuer.wallet],
  );
  w.chain.touch(document);
  return document;
}

async function commandCount(w: World) {
  const { count, error } = await service
    .from("commands")
    .select("id", { count: "exact", head: true })
    .eq("protocol", w.protocol);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

async function lookupTableRows(w: World) {
  return mustSucceed(
    await service.from("relay_lookup_tables").select("address").eq("protocol", w.protocol),
  );
}

describe("PR #69 review folds on the real program", () => {
  it("an issue_lot above 1,232 bytes is TRANSACTION_TOO_LARGE at create (T056r R1): no command is stored, so the custodian never signs a text that cannot be sent, the table does not grow and nothing is sent", async () => {
    // Every field at its widest (48-character names, 16-character lot ID and site, 8-character
    // class code and grade), no origin: 1,251 bytes after the PR #69 folds. The custodian's
    // Authority is taken as in the table, the best case, so the estimate is that exact size.
    const w = await world("fiat", {
      names: {
        khunou: "Khunou Ore Exports".padEnd(48, "-"),
        kopano: "Kopano Stockyard Custody".padEnd(48, "-"),
      },
    });
    const custodianClass = await accreditSite(w, {
      classCode: "MANGANES",
      grade: "GRADE-A1",
      site: "KOPANO-YARD-0001",
      originRequired: false,
    });
    const sponsor = w.deps.sponsor;
    const signed: string[] = [];
    w.deps = {
      ...w.deps,
      sponsor: {
        address: () => sponsor.address(),
        sign: async (wire, table) => {
          signed.push(wire);
          return sponsor.sign(wire, table);
        },
      },
    };
    const lotId = "CR-0000000000002";
    const commandsBefore = await commandCount(w);
    const before = w.chain.sent.length;
    const response = await call(w, "POST", "/v1/commands", people.kopano, {
      kind: "issue_lot",
      organisationId: orgIds.kopano,
      args: {
        custodianClass,
        owner: orgIds.khunou,
        lotId,
        grade: "GRADE-A1",
        quantityKg: "1000000",
        weighbridgeTicket: "WB2611-0099",
      },
    });
    expect(response.statusCode, response.body).toBe(422);
    expect(errorOf(response)).toMatchObject({
      code: "TRANSACTION_TOO_LARGE",
      detail: "1251 bytes",
    });
    expect(await commandCount(w)).toBe(commandsBefore);
    expect(signed).toHaveLength(0);
    expect(w.chain.sent.length).toBe(before);
    expect(await lookupTableRows(w)).toStrictEqual([]);
    expect(w.svm.getAccount(await lotPda(w.protocol, lotId)).exists).toBe(false);
  });

  it("origin required: revoked and expired attestations are skipped, none valid is ACCOUNT_MISSING, and the valid one is in the text and lands", async () => {
    const w = await world();
    const site = "KOPANO-YARD-1";
    const custodianClass = await accreditSite(w, {
      classCode: "MANGAN",
      grade: GRADE,
      site,
      originRequired: true,
    });
    const issuer = await originIssuer(w);
    const ticket = "WB2611-0077";
    const digest = Uint8Array.from(Buffer.from(intakeDigest(site, ticket), "hex"));
    const now = w.svm.getClock().unixTimestamp;
    await attestOrigin(w, issuer, digest, 2, now + 100n, new Uint8Array(32).fill(0x52));
    const revoked = await attestOrigin(
      w,
      issuer,
      digest,
      3,
      now + 30n * DAY,
      new Uint8Array(32).fill(0x53),
    );
    await send(
      w.svm,
      [
        getRevokeDocumentInstruction({
          protocol: w.protocol,
          organisation: issuer.organisation,
          authority: issuer.authority,
          document: revoked,
          wallet: issuer.wallet,
        }),
      ],
      [issuer.wallet],
    );
    // Version 2 expires.
    const clock = w.svm.getClock();
    clock.unixTimestamp = now + 200n;
    w.svm.setClock(clock);

    const args = {
      custodianClass,
      owner: orgIds.khunou,
      lotId: "MN-0001",
      grade: GRADE,
      quantityKg: "1000000",
      weighbridgeTicket: ticket,
    };
    const before = w.chain.sent.length;
    const none = await call(w, "POST", "/v1/commands", people.kopano, {
      kind: "issue_lot",
      organisationId: orgIds.kopano,
      args,
    });
    expect(none.statusCode).toBe(409);
    expect(errorOf(none)).toMatchObject({ code: "ACCOUNT_MISSING", detail: "origin: none valid" });

    const validSha = new Uint8Array(32).fill(0x51);
    await attestOrigin(w, issuer, digest, 1, now + 30n * DAY, validSha);
    const created = await create(w, "kopano", "issue_lot", args);
    expect(created.fields).toContainEqual({
      label: "Origin document",
      value: `${Buffer.from(validSha).toString("hex")} v1`,
    });
    const validUntil = BigInt(Date.parse(created.text?.validUntil ?? "") / 1000);
    const expected = issueLotMessage(
      THETIS_PROGRAM_ADDRESS,
      w.instanceId,
      "MN-0001",
      "MANGAN",
      1,
      GRADE,
      1_000_000n,
      ORGS.khunou.name,
      ORGS.kopano.name,
      site,
      digest,
      { sha256: validSha, version: 1 },
      validUntil,
    );
    const sent = new Uint8Array(getBase64Encoder().encode(created.text?.messageBase64 ?? ""));
    expect(Buffer.from(sent).equals(Buffer.from(expected))).toBe(true);
    confirmed(
      data<CommandView>(await signText(w, "kopano", created, "custodian", wallets.kopanoField)),
      "LotIssued",
    );
    expect(w.chain.sent.length).toBe(before + 1);
    expect(
      decodeLot(w.svm.getAccount(await lotPda(w.protocol, "MN-0001")) as never).data.lotId,
    ).toBe("MN-0001");
  });

  it("a custodianClass lookalike owned by another program is ACCOUNT_MISSING, and nothing is sent or put in the table", async () => {
    const w = await world();
    const real = w.svm.getAccount(w.custodianClass);
    if (!real.exists) throw new Error("no custodian class");
    const lookalike = (await signer()).address;
    const otherProgram = (await signer()).address;
    w.svm.setAccount({
      address: lookalike,
      programAddress: otherProgram,
      lamports: real.lamports,
      executable: false,
      space: real.space,
      data: real.data,
    } as never);
    const before = w.chain.sent.length;
    const response = await call(w, "POST", "/v1/commands", people.kopano, {
      kind: "issue_lot",
      organisationId: orgIds.kopano,
      args: { ...issueArgs(w, "CR-0002", "1000000"), custodianClass: lookalike },
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(errorOf(response)).toMatchObject({
      code: "ACCOUNT_MISSING",
      detail: `${lookalike}: not a CustodianClass`,
    });
    expect(w.chain.sent.length).toBe(before);
    expect(await lookupTableRows(w)).toStrictEqual([]);
  });

  it("a handover holder whose linked wallet has no Authority is AUTHORITY_INVALID and nothing is sent", async () => {
    const w = await world();
    const { batch } = await shippedBatch(w);
    const created = await create(w, "kopano", "handover", { batch, to: orgIds.mosela });
    const before = w.chain.sent.length;
    const response = await signText(w, "kopano", created, "holder", wallets.kopanoNoAuthority);
    expect(response.statusCode).toBe(409);
    expect(errorOf(response)).toMatchObject({
      code: "AUTHORITY_INVALID",
      detail: "no authority for this wallet",
    });
    expect(w.chain.sent.length).toBe(before);
    const view = data<CommandView>(
      await call(w, "GET", `/v1/commands/${created.id}`, people.kopano),
    );
    expect(view.status).toBe("awaiting_signatures");
    expect(view.signers.every((s) => s.signed === null)).toBe(true);
    expect(view.transaction).toBeNull();
  });
});

// ---------------------------------------------------------------- record_observation (T067r.2)

/** A finalized transport photo of `batch`, uploaded by a member of `org` (field-app.md §4.4, §5.2). */
async function transportEvidence(
  w: World,
  org: OrgKey,
  batch: Address,
  object: { purpose?: string; subjectRef?: string } = {},
) {
  const person = people[org];
  const bytes = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.from(`Synthetic test border photo ${randomUUID()}, not a real photo`),
  ]);
  const { id: objectId } = mustSucceed(
    await person.client
      .from("evidence_objects")
      .insert({
        owner_organisation_id: orgIds[org],
        subject_kind: "batch",
        subject_ref: object.subjectRef ?? batch,
        purpose: object.purpose ?? "transport",
        created_by: person.id,
      })
      .select("id")
      .single(),
  );
  const storagePath = `${orgIds[org]}/${objectId}/1`;
  const { id: versionId } = mustSucceed(
    await person.client
      .from("evidence_versions")
      .insert({
        object_id: objectId,
        version: 1,
        storage_path: storagePath,
        mime: "image/jpeg",
        uploaded_by: person.id,
      })
      .select("id")
      .single(),
  );
  mustSucceed(
    await person.client.storage
      .from("originals")
      .upload(storagePath, bytes, { contentType: "image/jpeg" }),
  );
  const finalized = data<{ sha256: string }>(
    await call(w, "POST", `/v1/evidence/${versionId}/finalize`, person),
  );
  return { versionId: versionId as string, sha256: finalized.sha256 };
}

async function observationArgs(
  w: World,
  org: OrgKey,
  batch: Address,
  kind: "Border" | "Checkpoint" = "Border",
) {
  const evidence = await transportEvidence(w, org, batch);
  const observedAt = w.svm.getClock().unixTimestamp - 60n;
  return {
    args: {
      batch,
      kind,
      locationCode: "BORDER-1",
      evidenceVersionId: evidence.versionId,
      observedAt: String(observedAt),
    },
    sha256: evidence.sha256,
    observedAt,
  };
}

const moselaObserver = (): Actor => ({ org: "mosela", wallet: wallets.mosela });
const kopanoObserver = (): Actor => ({ org: "kopano", wallet: wallets.kopanoField });

/** The owner cancels the shipment directly (program-custody.md cancel_shipment). */
async function cancelShipment(w: World, batch: Address) {
  const shipmentAddress = decodeManifestBatch(w.svm.getAccount(batch) as never).data.shipment;
  const shipment = decodeShipment(w.svm.getAccount(shipmentAddress) as never).data;
  const validUntil = w.svm.getClock().unixTimestamp + 300n;
  const text = envelope(
    THETIS_PROGRAM_ADDRESS,
    Buffer.from(w.instanceId).toString("hex"),
    "Cancel shipment",
    [
      ["Lot", LOT_ID],
      ["Shipment", Buffer.from(Uint8Array.from(shipment.shipmentId)).toString("hex")],
      ["Owner", ORGS.khunou.name],
      ["To", ORGS.portT1.name],
      ["Site", "PORT-T1"],
      ["Revision", String(shipment.revision)],
    ],
    validUntil,
  );
  const [ownerAuthority] = await findAuthorityPda({
    protocol: w.protocol,
    wallet: wallets.khunouShip.address,
  });
  const signature = await signBytes(wallets.khunouShip.keyPair.privateKey, text);
  await send(
    w.svm,
    [
      sharedEd25519([{ wallet: wallets.khunouShip.address, signature }], text),
      getCancelShipmentInstruction({
        sponsor: payer,
        protocol: w.protocol,
        ownerOrg: w.orgs.khunou,
        ownerAuthority,
        lot: w.lot,
        shipment: shipmentAddress,
        destinationClass: shipment.destination,
        destinationOrg: w.orgs.portT1,
        expectedRevision: shipment.revision,
        validUntil,
      }),
    ],
    [],
  );
  expect(decodeShipment(w.svm.getAccount(shipmentAddress) as never).data.status).toBe(
    ShipmentStatus.Cancelled,
  );
}

describe("record_observation on the real program", () => {
  it("a Checkpoint observation by the custodian holding the batch lands with ObservationRecorded and the pinned text", async () => {
    const w = await world();
    const { batch, shipmentId } = await shippedBatch(w);
    const chainTime = w.svm.getClock().unixTimestamp;
    const { args, sha256, observedAt } = await observationArgs(w, "kopano", batch, "Checkpoint");
    const created = await create(w, "kopano", "record_observation", args);
    expect(created.lot).toBe(w.lot);
    expect(created.signers.map((s) => [s.role, s.organisationId, s.method])).toStrictEqual([
      ["observer", orgIds.kopano, "text"],
    ]);
    const validUntil = BigInt(Date.parse(created.text?.validUntil ?? "") / 1000);
    expect(validUntil - chainTime).toBe(570n);
    const expected = observationMessage(
      THETIS_PROGRAM_ADDRESS,
      w.instanceId,
      LOT_ID,
      shipmentId,
      1,
      1,
      ORGS.kopano.name,
      ORGS.kopano.name,
      "Checkpoint",
      "BORDER-1",
      Uint8Array.from(Buffer.from(sha256, "hex")),
      observedAt,
      0,
      validUntil,
    );
    const sent = new Uint8Array(getBase64Encoder().encode(created.text?.messageBase64 ?? ""));
    expect(Buffer.from(sent).equals(Buffer.from(expected))).toBe(true);

    const view = confirmed(
      data<CommandView>(await signText(w, "kopano", created, "observer", wallets.kopanoField)),
      "ObservationRecorded",
    );
    expect(view.outcome?.data).toMatchObject({
      batch,
      lot: w.lot,
      observer: w.orgs.kopano,
      holder: w.orgs.kopano,
      locationCode: "BORDER-1",
      evidenceDigest: sha256,
      observedAt: String(observedAt),
      index: 0,
    });
    const after = decodeManifestBatch(w.svm.getAccount(batch) as never).data;
    expect(after.observationCount).toBe(1);
    expect(after.holder).toBe(w.orgs.kopano);
    expect(after.sequence).toBe(0n);
  });

  it("a Border observation by the transporter lands and leaves the holder unchanged", async () => {
    const w = await world();
    const { batch } = await shippedBatch(w);
    const { args } = await observationArgs(w, "mosela", batch);
    const view = confirmed(
      await run(w, "mosela", "record_observation", args, { observer: moselaObserver() }),
      "ObservationRecorded",
    );
    expect(view.outcome?.data).toMatchObject({
      observer: w.orgs.mosela,
      holder: w.orgs.kopano,
      kind: 1,
    });
    const after = decodeManifestBatch(w.svm.getAccount(batch) as never).data;
    expect(after.holder).toBe(w.orgs.kopano);
    expect(after.observationCount).toBe(1);
  });

  it("a Border observation by a custodian reaches the chain and fails as WrongRole", async () => {
    const w = await world();
    const { batch } = await shippedBatch(w);
    const { args } = await observationArgs(w, "kopano", batch, "Border");
    const before = w.chain.sent.length;
    const view = await run(w, "kopano", "record_observation", args, {
      observer: kopanoObserver(),
    });
    failedWith(view, "WrongRole");
    expect(w.chain.sent.length).toBe(before + 1);
    expect(decodeManifestBatch(w.svm.getAccount(batch) as never).data.observationCount).toBe(0);
  });

  it("an observer whose linked wallet has no Authority is AUTHORITY_INVALID and nothing is sent", async () => {
    const w = await world();
    const { batch } = await shippedBatch(w);
    const { args } = await observationArgs(w, "mosela", batch);
    const created = await create(w, "mosela", "record_observation", args);
    const before = w.chain.sent.length;
    const response = await signText(w, "mosela", created, "observer", wallets.moselaNoAuthority);
    expect(response.statusCode).toBe(409);
    expect(errorOf(response)).toMatchObject({
      code: "AUTHORITY_INVALID",
      detail: "no authority for this wallet",
    });
    expect(w.chain.sent.length).toBe(before);
    const view = data<CommandView>(
      await call(w, "GET", `/v1/commands/${created.id}`, people.mosela),
    );
    expect(view.status).toBe("awaiting_signatures");
    expect(view.transaction).toBeNull();
  });

  it("a second observation prepared at the same count fails as StaleRevision once the first lands", async () => {
    const w = await world();
    const { batch } = await shippedBatch(w);
    const first = await create(
      w,
      "mosela",
      "record_observation",
      (await observationArgs(w, "mosela", batch)).args,
    );
    const second = await create(
      w,
      "mosela",
      "record_observation",
      (await observationArgs(w, "mosela", batch)).args,
    );
    confirmed(
      data<CommandView>(await signText(w, "mosela", first, "observer", wallets.mosela)),
      "ObservationRecorded",
    );
    const view = data<CommandView>(await signText(w, "mosela", second, "observer", wallets.mosela));
    failedWith(view, "StaleRevision");
    expect(decodeManifestBatch(w.svm.getAccount(batch) as never).data.observationCount).toBe(1);
  });

  it("an observation of a batch whose shipment was cancelled fails as ShipmentNotOpen", async () => {
    const w = await world();
    const { batch } = await shippedBatch(w);
    await cancelShipment(w, batch);
    const { args } = await observationArgs(w, "mosela", batch);
    const view = await run(w, "mosela", "record_observation", args, {
      observer: moselaObserver(),
    });
    failedWith(view, "ShipmentNotOpen");
    expect(decodeManifestBatch(w.svm.getAccount(batch) as never).data.observationCount).toBe(0);
  });

  it("refuses an initiator that can't observe, evidence that is not this batch's transport record, and a time after chain time, sending nothing", async () => {
    const w = await world();
    const { batch } = await shippedBatch(w);
    const before = w.chain.sent.length;
    const exporter = await transportEvidence(w, "khunou", batch);
    const notObserver = await call(w, "POST", "/v1/commands", people.khunou, {
      kind: "record_observation",
      organisationId: orgIds.khunou,
      args: {
        batch,
        kind: "Checkpoint",
        locationCode: "BORDER-1",
        evidenceVersionId: exporter.versionId,
        observedAt: String(w.svm.getClock().unixTimestamp - 60n),
      },
    });
    expect(notObserver.statusCode).toBe(403);
    expect(errorOf(notObserver).code).toBe("NOT_AUTHORISED");

    const { args } = await observationArgs(w, "mosela", batch);
    const post = (body: Record<string, string>) =>
      call(w, "POST", "/v1/commands", people.mosela, {
        kind: "record_observation",
        organisationId: orgIds.mosela,
        args: { ...args, ...body },
      });
    for (const evidence of [
      await transportEvidence(w, "mosela", batch, { purpose: "loading" }),
      await transportEvidence(w, "mosela", batch, { subjectRef: w.lot }),
      await transportEvidence(w, "kopano", batch),
    ]) {
      const response = await post({ evidenceVersionId: evidence.versionId });
      expect(response.statusCode, response.body).toBe(409);
      expect(errorOf(response)).toMatchObject({
        code: "EVIDENCE_INVALID",
        detail: "transport evidence of this batch",
      });
    }
    const future = await post({ observedAt: String(w.svm.getClock().unixTimestamp + 1n) });
    expect(future.statusCode).toBe(400);
    expect(errorOf(future)).toMatchObject({ code: "VALIDATION", detail: "observedAt" });
    expect(w.chain.sent.length).toBe(before);
  });
});

// ---------------------------------------------------------------- the loading (T067r.3 folds 41–50)

const khunouOwner = (): Actor => ({ org: "khunou", wallet: wallets.khunouLoading });
const portTerminal = (): Actor => ({ org: "portT1", wallet: wallets.portT1 });

/** CR-0001 at Port Terminal T1: optionally pledged to Lender One as `pledges` loans (kg each),
 * then shipped from Kopano's site, handed to Mosela at Departure and to the terminal at Arrival,
 * all through the relay. */
async function lotAtTerminal(w: World, pledges: string[] = []) {
  let facility: string | null = null;
  const loans: Address[] = [];
  if (pledges.length > 0) {
    facility = await openFacility(w);
    await setValuation(w, facility);
    for (const quantityKg of pledges) {
      const pledged = confirmed(await pledge(w, facility, lenderOne(), quantityKg), "Pledged");
      loans.push(address(pledged.loan ?? ""));
    }
  }
  const { batch } = await shippedBatch(w);
  confirmed(
    await run(
      w,
      "kopano",
      "handover",
      { batch, to: orgIds.mosela },
      { holder: kopanoHolder(), next_holder: { org: "mosela", wallet: wallets.mosela } },
    ),
    "CustodyHandedOver",
  );
  confirmed(
    await run(
      w,
      "mosela",
      "handover",
      { batch, to: orgIds.portT1 },
      { holder: { org: "mosela", wallet: wallets.mosela }, next_holder: portTerminal() },
    ),
    "CustodyHandedOver",
  );
  const lot = decodeLot(w.svm.getAccount(w.lot) as never).data;
  if (facility) {
    // The lender's valuation for the terminal's site: an advance and liquidate read the lot's class.
    confirmed(
      await run(
        w,
        "lenderOne",
        "set_valuation",
        {
          facility,
          custodianClass: lot.custodianClass,
          grade: GRADE,
          valuePerKgMinor: "20",
          haircutBps: "0",
          validForDays: "30",
          sourceNote: "Synthetic test price per kg, not a market quote",
        },
        { lender: lenderOne() },
      ),
      "ValuationSet",
    );
  }
  const [position] = await findPositionPda({ lot: w.lot, owner: w.orgs.khunou });
  return { facility, loans, terminalClass: lot.custodianClass, position };
}

/** A finalized loading document (the bill of lading) of `org` for `subjectRef`. */
async function loadingEvidence(
  w: World,
  org: OrgKey,
  object: { subjectRef?: string; purpose?: string } = {},
) {
  const person = people[org];
  const bytes = Buffer.from(
    `%PDF-1.4\nSynthetic test bill of lading ${randomUUID()}, not a real shipping record\n%%EOF\n`,
  );
  const { id: objectId } = mustSucceed(
    await person.client
      .from("evidence_objects")
      .insert({
        owner_organisation_id: orgIds[org],
        subject_kind: "lot",
        subject_ref: object.subjectRef ?? w.lot,
        purpose: object.purpose ?? "loading",
        created_by: person.id,
      })
      .select("id")
      .single(),
  );
  const storagePath = `${orgIds[org]}/${objectId}/1`;
  const { id: versionId } = mustSucceed(
    await person.client
      .from("evidence_versions")
      .insert({
        object_id: objectId,
        version: 1,
        storage_path: storagePath,
        mime: "application/pdf",
        uploaded_by: person.id,
      })
      .select("id")
      .single(),
  );
  mustSucceed(
    await person.client.storage
      .from("originals")
      .upload(storagePath, bytes, { contentType: "application/pdf" }),
  );
  const finalized = data<{ sha256: string }>(
    await call(w, "POST", `/v1/evidence/${versionId}/finalize`, person),
  );
  return { versionId: versionId as string, sha256: finalized.sha256 };
}

/** The owner's loading intent through the relay; returns the intent and the confirmed view. */
async function createIntent(w: World) {
  const evidence = await loadingEvidence(w, "khunou");
  const view = confirmed(
    await run(
      w,
      "khunou",
      "create_loading_intent",
      { lot: w.lot, evidenceVersionId: evidence.versionId, expiresInHours: "48" },
      { owner: khunouOwner() },
    ),
    "LoadingIntentCreated",
  );
  return { intent: address(view.intent ?? ""), view, evidence };
}

/** Lender One accepts the hand-off for `loan` through the relay, sponsor-paid (field-app.md owner
 * decision 1, T067r.4 folds 52–57). */
async function acceptLoading(w: World, loan: Address, intent: Address) {
  const view = confirmed(
    await run(w, "lenderOne", "accept_loading", { intent, loan }, { lender: lenderOne() }),
    "LoadingAccepted",
  );
  const [acceptance] = await findAcceptancePda({ intent, loan });
  expect(view.outcome?.data).toMatchObject({ acceptance, intent, loan });
  return acceptance;
}

const byRawKey = (left: Address, right: Address) =>
  Buffer.compare(
    Buffer.from(getAddressEncoder().encode(left)),
    Buffer.from(getAddressEncoder().encode(right)),
  );

function sentText(view: CommandView) {
  return new Uint8Array(getBase64Encoder().encode(view.text?.messageBase64 ?? ""));
}

describe("the loading on the real program", () => {
  it("create_loading_intent: the owner's Prepare loading text lands with LoadingIntentCreated and raises the position revision", async () => {
    const w = await world();
    const { position, terminalClass } = await lotAtTerminal(w);
    const revision = decodePosition(w.svm.getAccount(position) as never).data.revision;
    const evidence = await loadingEvidence(w, "khunou");
    const chainTime = w.svm.getClock().unixTimestamp;
    const created = await create(w, "khunou", "create_loading_intent", {
      lot: w.lot,
      evidenceVersionId: evidence.versionId,
      expiresInHours: "48",
    });
    expect(created.lot).toBe(w.lot);
    expect(created.signers.map((s) => [s.role, s.organisationId, s.method])).toStrictEqual([
      ["owner", orgIds.khunou, "text"],
    ]);
    const validUntil = BigInt(Date.parse(created.text?.validUntil ?? "") / 1000);
    expect(validUntil - chainTime).toBe(570n);
    const field = (label: string) => created.fields.find((f) => f.label === label)?.value ?? "";
    const nonce = BigInt(field("Intent"));
    const expected = loadingIntentMessage(
      THETIS_PROGRAM_ADDRESS,
      w.instanceId,
      LOT_ID,
      LOT_KG,
      ORGS.khunou.name,
      ORGS.portT1.name,
      "PORT-T1",
      Uint8Array.from(Buffer.from(evidence.sha256, "hex")),
      nonce,
      chainTime + 48n * 3_600n,
      revision,
      validUntil,
    );
    expect(Buffer.from(sentText(created)).equals(Buffer.from(expected))).toBe(true);

    const view = confirmed(
      data<CommandView>(await signText(w, "khunou", created, "owner", wallets.khunouLoading)),
      "LoadingIntentCreated",
    );
    const intent = address(view.intent ?? "");
    expect(view.outcome?.data).toMatchObject({
      intent,
      lot: w.lot,
      position,
      owner: w.orgs.khunou,
      terminal: w.orgs.portT1,
      quantityKg: String(LOT_KG),
      lockedKg: "0",
      documentSha256: evidence.sha256,
      positionRevision: String(revision + 1n),
    });
    const stored = decodeLoadingIntent(w.svm.getAccount(intent) as never).data;
    expect(stored.nonce).toBe(nonce);
    expect(stored.custodianClass).toBe(terminalClass);
    expect(stored.status).toBe(0); // Open
    expect(decodePosition(w.svm.getAccount(position) as never).data.revision).toBe(revision + 1n);
  }, 180_000);

  it("record_loading with no lender lock: owner then terminal sign one text, and LoadingRecorded lands with no hand-offs", async () => {
    const w = await world();
    const { position } = await lotAtTerminal(w);
    const { intent } = await createIntent(w);
    const created = await create(w, "portT1", "record_loading", { intent });
    expect(created.intent).toBe(intent);
    expect(created.signers.map((s) => [s.role, s.organisationId])).toStrictEqual([
      ["owner", orgIds.khunou],
      ["terminal", orgIds.portT1],
    ]);
    const stored = decodeLoadingIntent(w.svm.getAccount(intent) as never).data;
    const revision = decodePosition(w.svm.getAccount(position) as never).data.revision;
    const validUntil = BigInt(Date.parse(created.text?.validUntil ?? "") / 1000);
    const expected = recordLoadingMessage(
      THETIS_PROGRAM_ADDRESS,
      w.instanceId,
      LOT_ID,
      LOT_KG,
      ORGS.khunou.name,
      ORGS.portT1.name,
      Uint8Array.from(stored.documentSha256),
      stored.nonce,
      0n,
      0,
      revision,
      validUntil,
    );
    expect(Buffer.from(sentText(created)).equals(Buffer.from(expected))).toBe(true);

    let view = data<CommandView>(
      await signText(w, "khunou", created, "owner", wallets.khunouLoading),
    );
    expect(view.status).toBe("awaiting_signatures");
    view = confirmed(
      data<CommandView>(await signText(w, "portT1", view, "terminal", wallets.portT1)),
      "LoadingRecorded",
    );
    expect(view.outcome?.data).toMatchObject({
      intent,
      lot: w.lot,
      position,
      quantityKg: String(LOT_KG),
      loansAccepted: 0,
      lotLoaded: true,
      loanHandOffs: [],
    });
    expect(decodeLot(w.svm.getAccount(w.lot) as never).data.supplyKg).toBe(0n);
    expect(decodeLoadingIntent(w.svm.getAccount(intent) as never).data.status).toBe(1); // Executed
  }, 180_000);

  it("record_loading with two accepted loans: the triples go in ascending loan order, into the table, and both LoanHandedOff events land", async () => {
    const w = await world();
    const { loans } = await lotAtTerminal(w, ["3000000", "2000000"]);
    const [first, second] = loans as [Address, Address];
    await advance(w, first, "30000000");
    const { intent } = await createIntent(w);
    const acceptances = [
      await acceptLoading(w, first, intent),
      await acceptLoading(w, second, intent),
    ];
    const created = await create(w, "khunou", "record_loading", { intent });
    expect(created.fields).toContainEqual({ label: "Loan acceptances", value: "2" });
    expect(created.fields).toContainEqual({ label: "Locked", value: formatTonnes(LOT_KG) });
    let view = data<CommandView>(
      await signText(w, "khunou", created, "owner", wallets.khunouLoading),
    );
    view = confirmed(
      data<CommandView>(await signText(w, "portT1", view, "terminal", wallets.portT1)),
      "LoadingRecorded",
    );
    const ordered = [...loans].sort(byRawKey);
    const handOffs = view.outcome?.data?.loanHandOffs as { loan: string }[];
    expect(view.outcome?.data).toMatchObject({ loansAccepted: 2, lotLoaded: true });
    expect(handOffs.map((h) => h.loan)).toStrictEqual(ordered);
    expect(handOffs.find((h) => h.loan === first)).toMatchObject({
      externalHandoff: true,
      releasedKg: "3000000",
    });
    expect(handOffs.find((h) => h.loan === second)).toMatchObject({
      externalHandoff: false,
      releasedKg: "2000000",
    });
    expect(loanAccount(w, first).status).toBe(2); // ExternalHandoff
    // Fold 9 holds for the acceptances: existing chain accounts, so they entered the table.
    const { address: table } = mustSucceed(
      await service
        .from("relay_lookup_tables")
        .select("address")
        .eq("protocol", w.protocol)
        .single(),
    );
    const inTable = lookupTableAddresses(w.svm, address(table as string));
    for (const acceptance of acceptances) expect(inTable).toContain(acceptance);
  }, 240_000);

  it("a lock whose lender has not accepted is ACCEPTANCE_MISSING at create, naming the loan, and nothing is signed or sent (PR #76 D2)", async () => {
    const w = await world();
    const { loans } = await lotAtTerminal(w, ["5000000"]);
    const [loan] = loans as [Address];
    const { intent } = await createIntent(w);
    const before = w.chain.sent.length;
    const response = await call(w, "POST", "/v1/commands", people.portT1, {
      kind: "record_loading",
      organisationId: orgIds.portT1,
      args: { intent },
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(errorOf(response)).toMatchObject({
      code: "ACCEPTANCE_MISSING",
      detail: `loan: ${loan}`,
    });
    expect(w.chain.sent.length).toBe(before);
    expect(decodeLot(w.svm.getAccount(w.lot) as never).data.supplyKg).toBe(LOT_KG);
  }, 180_000);

  it("lamports sent to the acceptance PDA are not an acceptance: ACCEPTANCE_MISSING, nothing sent (PR #76 D1)", async () => {
    const w = await world();
    const { loans } = await lotAtTerminal(w, ["5000000"]);
    const [loan] = loans as [Address];
    const { intent } = await createIntent(w);
    const [acceptance] = await findAcceptancePda({ intent, loan });
    w.svm.setAccount({
      address: acceptance,
      programAddress: address("11111111111111111111111111111111"),
      lamports: 1_000_000n,
      executable: false,
      space: 0n,
      data: new Uint8Array(),
    } as never);
    expect(w.svm.getAccount(acceptance).exists).toBe(true);
    const before = w.chain.sent.length;
    const response = await call(w, "POST", "/v1/commands", people.portT1, {
      kind: "record_loading",
      organisationId: orgIds.portT1,
      args: { intent },
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(errorOf(response)).toMatchObject({
      code: "ACCEPTANCE_MISSING",
      detail: `loan: ${loan}`,
    });
    expect(w.chain.sent.length).toBe(before);
  }, 180_000);

  it("an accepted loan in Recovery is LOAN_NOT_ACTIVE at create, and a loading prepared before the liquidation fails on chain as LoanNotActive (PR #76 D2)", async () => {
    const w = await world();
    const { loans } = await lotAtTerminal(w, ["5000000"]);
    const [loan] = loans as [Address];
    await advance(w, loan);
    const { intent } = await createIntent(w);
    await acceptLoading(w, loan, intent);
    const clock = w.svm.getClock();
    clock.unixTimestamp += DAY;
    w.svm.setClock(clock);
    // Prepared while the loan is Active: the chain's refusal is the backstop.
    const prepared = await create(w, "portT1", "record_loading", { intent });
    expect(prepared.fields).toContainEqual({ label: "Loan acceptances", value: "1" });
    confirmed(
      await run(w, "lenderOne", "liquidate", { loan }, { lender: lenderOne() }),
      "Liquidated",
    );
    expect(loanAccount(w, loan).status).toBe(1); // Recovery
    const before = w.chain.sent.length;
    const response = await call(w, "POST", "/v1/commands", people.portT1, {
      kind: "record_loading",
      organisationId: orgIds.portT1,
      args: { intent },
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(errorOf(response)).toMatchObject({ code: "LOAN_NOT_ACTIVE", detail: `loan: ${loan}` });
    expect(w.chain.sent.length).toBe(before);

    let view = data<CommandView>(
      await signText(w, "khunou", prepared, "owner", wallets.khunouLoading),
    );
    view = data<CommandView>(await signText(w, "portT1", view, "terminal", wallets.portT1));
    failedWith(view, "LoanNotActive");
    expect(decodeLot(w.svm.getAccount(w.lot) as never).data.supplyKg).toBe(LOT_KG);
  }, 240_000);

  it("more than four locked loans is TOO_MANY_LOANS at create, and nothing is sent (PR #76 D3)", async () => {
    const w = await world();
    await lotAtTerminal(w, ["1000000", "1000000", "1000000", "1000000", "1000000"]);
    const { intent } = await createIntent(w);
    const before = w.chain.sent.length;
    const response = await call(w, "POST", "/v1/commands", people.portT1, {
      kind: "record_loading",
      organisationId: orgIds.portT1,
      args: { intent },
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(errorOf(response).code).toBe("TOO_MANY_LOANS");
    expect(w.chain.sent.length).toBe(before);
  }, 300_000);

  it("a loading prepared before a newer intent fails on chain as StaleRevision", async () => {
    const w = await world();
    await lotAtTerminal(w);
    const { intent } = await createIntent(w);
    const created = await create(w, "portT1", "record_loading", { intent });
    // The owner replaces the bill of lading: a new intent raises the position revision.
    await createIntent(w);
    let view = data<CommandView>(
      await signText(w, "khunou", created, "owner", wallets.khunouLoading),
    );
    view = data<CommandView>(await signText(w, "portT1", view, "terminal", wallets.portT1));
    failedWith(view, "StaleRevision");
  }, 180_000);

  it("a terminal wallet without LOAD is AUTHORITY_INVALID and nothing is sent", async () => {
    const w = await world();
    await lotAtTerminal(w);
    const { intent } = await createIntent(w);
    const before = w.chain.sent.length;
    const created = await create(w, "portT1", "record_loading", { intent });
    const view = data<CommandView>(
      await signText(w, "khunou", created, "owner", wallets.khunouLoading),
    );
    const response = await signText(w, "portT1", view, "terminal", wallets.portT1NoLoad);
    expect(response.statusCode, response.body).toBe(409);
    expect(errorOf(response)).toMatchObject({
      code: "AUTHORITY_INVALID",
      detail: "scope LOAD missing",
    });
    expect(w.chain.sent.length).toBe(before);
  }, 180_000);

  it("refuses a non-owner's intent, evidence that is not the owner's loading document of this lot, and a non-party's loading, sending nothing", async () => {
    const w = await world();
    await lotAtTerminal(w);
    const before = w.chain.sent.length;
    const terminalDocument = await loadingEvidence(w, "portT1");
    const notOwner = await call(w, "POST", "/v1/commands", people.portT1, {
      kind: "create_loading_intent",
      organisationId: orgIds.portT1,
      args: { lot: w.lot, evidenceVersionId: terminalDocument.versionId, expiresInHours: "48" },
    });
    expect(notOwner.statusCode, notOwner.body).toBe(403);
    expect(errorOf(notOwner).code).toBe("NOT_AUTHORISED");

    for (const evidence of [
      await loadingEvidence(w, "khunou", { purpose: "bank" }),
      await loadingEvidence(w, "khunou", { subjectRef: LOT_ID }),
      terminalDocument,
    ]) {
      const response = await call(w, "POST", "/v1/commands", people.khunou, {
        kind: "create_loading_intent",
        organisationId: orgIds.khunou,
        args: { lot: w.lot, evidenceVersionId: evidence.versionId, expiresInHours: "48" },
      });
      expect(response.statusCode, response.body).toBe(409);
      expect(errorOf(response)).toMatchObject({
        code: "EVIDENCE_INVALID",
        detail: "loading document of this lot",
      });
    }
    expect(w.chain.sent.length).toBe(before);

    const { intent } = await createIntent(w);
    const sent = w.chain.sent.length;
    const outsider = await call(w, "POST", "/v1/commands", people.mosela, {
      kind: "record_loading",
      organisationId: orgIds.mosela,
      args: { intent },
    });
    expect(outsider.statusCode, outsider.body).toBe(403);
    expect(errorOf(outsider).code).toBe("NOT_AUTHORISED");
    expect(w.chain.sent.length).toBe(sent);
  }, 180_000);
});

// ---------------------------------------------------------------- accept_loading (T067r.4 folds 52–58)

describe("accept_loading on the real program", () => {
  it("the lender's acceptance lands sponsor-paid with LoadingAccepted, and record_loading then hands that loan off", async () => {
    const w = await world();
    const { loans } = await lotAtTerminal(w, ["5000000"]);
    const [loan] = loans as [Address];
    const { intent } = await createIntent(w);
    const before = loanAccount(w, loan);
    const created = await create(w, "lenderOne", "accept_loading", { intent, loan });
    expect(created.signers.map((s) => [s.role, s.organisationId, s.method])).toStrictEqual([
      ["lender", orgIds.lenderOne, "transaction"],
    ]);
    expect(created.text).toBeNull();
    expect(created.intent).toBe(intent);
    expect(created.loan).toBe(loan);
    expect(created.lot).toBe(w.lot);
    expect(created.fields).toContainEqual({ label: "Revision", value: String(before.revision) });
    expect(created.fields).toContainEqual({ label: "Locked", value: formatTonnes(5_000_000n) });
    expect(created.fields).toContainEqual({ label: "Terminal", value: ORGS.portT1.name });

    const lenderLamports = w.svm.getBalance(wallets.lenderOne.address);
    const sponsorLamports = w.svm.getBalance(sponsorAddress) ?? 0n;
    const view = confirmed(
      data<CommandView>(await signTransactionAs(w, "lenderOne", created, wallets.lenderOne)),
      "LoadingAccepted",
    );
    const [acceptance] = await findAcceptancePda({ intent, loan });
    expect(view.outcome?.data).toMatchObject({
      acceptance,
      intent,
      loan,
      lender: w.orgs.lenderOne,
      lockQuantityKg: "5000000",
      loanRevision: String(before.revision),
      version: 1,
    });
    // Sponsor-paid: the lender's wallet pays neither the fee nor the acceptance's rent.
    expect(w.svm.getBalance(wallets.lenderOne.address)).toBe(lenderLamports);
    expect((w.svm.getBalance(sponsorAddress) ?? 0n) < sponsorLamports).toBe(true);
    const stored = decodeHandoffAcceptance(w.svm.getAccount(acceptance) as never).data;
    expect(stored).toMatchObject({ intent, loan, lockQuantityKg: 5_000_000n, version: 1 });

    const loading = await run(
      w,
      "portT1",
      "record_loading",
      { intent },
      {
        owner: khunouOwner(),
        terminal: portTerminal(),
      },
    );
    confirmed(loading, "LoadingRecorded");
    const handOffs = loading.outcome?.data?.loanHandOffs as { loan: string }[];
    expect(handOffs.map((h) => h.loan)).toStrictEqual([loan]);
    expect(decodeLot(w.svm.getAccount(w.lot) as never).data.supplyKg).toBe(0n);
  }, 240_000);

  it("refuses a loan in Recovery, an executed intent, an expired intent and a non-lender at create, sending nothing", async () => {
    const w = await world();
    const { loans } = await lotAtTerminal(w, ["3000000", "2000000"]);
    const [first, second] = loans as [Address, Address];
    // 3,000,000 kg at 20 per kg and 60% LTV: 36,000,000 is the limit, so a day's interest is over it.
    await advance(w, first, "36000000");
    const { intent } = await createIntent(w);
    const post = (org: OrgKey, loan: Address, at: Address = intent) =>
      call(w, "POST", "/v1/commands", people[org], {
        kind: "accept_loading",
        organisationId: orgIds[org],
        args: { intent: at, loan },
      });
    const sent = w.chain.sent.length;

    const outsider = await post("khunou", second);
    expect(outsider.statusCode, outsider.body).toBe(403);
    expect(errorOf(outsider).code).toBe("NOT_AUTHORISED");

    const clock = w.svm.getClock();
    clock.unixTimestamp += DAY;
    w.svm.setClock(clock);
    confirmed(
      await run(w, "lenderOne", "liquidate", { loan: first }, { lender: lenderOne() }),
      "Liquidated",
    );
    const sentAfterLiquidation = w.chain.sent.length;
    const recovery = await post("lenderOne", first);
    expect(recovery.statusCode, recovery.body).toBe(409);
    expect(errorOf(recovery)).toMatchObject({ code: "LOAN_NOT_ACTIVE", detail: `loan: ${first}` });

    clock.unixTimestamp += 3n * DAY;
    w.svm.setClock(clock);
    const expired = await post("lenderOne", second);
    expect(expired.statusCode, expired.body).toBe(409);
    expect(errorOf(expired)).toMatchObject({
      code: "LOADING_EXPIRED",
      detail: `intent: ${intent}`,
    });
    expect(w.chain.sent.length).toBe(sentAfterLiquidation);
    expect(sentAfterLiquidation).toBeGreaterThan(sent);
  }, 240_000);

  it("an executed intent is LOADING_NOT_OPEN at create, and nothing is sent", async () => {
    const w = await world();
    const { loans } = await lotAtTerminal(w, ["5000000"]);
    const [loan] = loans as [Address];
    const { intent } = await createIntent(w);
    await acceptLoading(w, loan, intent);
    confirmed(
      await run(
        w,
        "portT1",
        "record_loading",
        { intent },
        { owner: khunouOwner(), terminal: portTerminal() },
      ),
      "LoadingRecorded",
    );
    const before = w.chain.sent.length;
    const response = await call(w, "POST", "/v1/commands", people.lenderOne, {
      kind: "accept_loading",
      organisationId: orgIds.lenderOne,
      args: { intent, loan },
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(errorOf(response)).toMatchObject({
      code: "LOADING_NOT_OPEN",
      detail: `intent: ${intent}`,
    });
    expect(w.chain.sent.length).toBe(before);
  }, 240_000);
});

// ---------------------------------------------------------------- T056r relay follow-ups

/** Rewrites a Thetis account in place with `change` applied: a fixture for a state the relay
 * must refuse before signing. */
function rewrite<T extends object>(
  w: World,
  key: Address,
  decode: (account: never) => { data: T },
  encode: (value: T) => ArrayLike<number>,
  change: Partial<T>,
) {
  const account = w.svm.getAccount(key);
  if (!account.exists) throw new Error(`${key} does not exist`);
  const value = { ...decode(account as never).data, ...change };
  w.svm.setAccount({
    address: key,
    programAddress: account.programAddress,
    lamports: account.lamports,
    executable: false,
    space: account.space,
    data: new Uint8Array(encode(value)),
  } as never);
}

describe("T056r relay follow-ups on the real program", () => {
  it("R2: a transaction-signed kind that can't fit is TRANSACTION_TOO_LARGE and ends expired with the error, nothing signed by the sponsor or sent", async () => {
    const w = await world();
    const { loan } = await pledgedLoan(w);
    const created = await create(w, "lenderOne", "record_advance", {
      loan,
      amountMinor: "60000000",
    });
    const signedText = data<CommandView>(
      await signText(w, "khunou", created, "borrower", wallets.khunou),
    );
    expect(signedText.status).toBe("awaiting_signatures");
    // A stored text this long can't fit one transaction with its Ed25519 instruction.
    mustSucceed(
      await service
        .from("commands")
        .update({ message_base64: Buffer.alloc(1_100, 0x41).toString("base64") })
        .eq("id", created.id)
        .select("id"),
    );
    const sponsor = w.deps.sponsor;
    const signed: string[] = [];
    w.deps = {
      ...w.deps,
      sponsor: {
        address: () => sponsor.address(),
        sign: async (wire, table) => {
          signed.push(wire);
          return sponsor.sign(wire, table);
        },
      },
    };
    const before = w.chain.sent.length;
    const response = await call(
      w,
      "POST",
      `/v1/commands/${created.id}/transaction-request`,
      people.lenderOne,
      { wallet: wallets.lenderOne.address },
    );
    expect(response.statusCode, response.body).toBe(422);
    expect(errorOf(response).code).toBe("TRANSACTION_TOO_LARGE");
    expect(errorOf(response).detail).toMatch(/^\d+ bytes$/);
    expect(signed).toHaveLength(0);
    expect(w.chain.sent.length).toBe(before);
    const view = data<CommandView>(
      await call(w, "GET", `/v1/commands/${created.id}`, people.lenderOne),
    );
    expect(view.status).toBe("expired");
    expect(view.error).toStrictEqual({
      code: "TRANSACTION_TOO_LARGE",
      detail: errorOf(response).detail,
    });
    expect(view.transaction).toBeNull();
  }, 180_000);

  it("R3: a holder Authority owned by another program is AUTHORITY_INVALID before decoding, and nothing is sent", async () => {
    const w = await world();
    const { batch } = await shippedBatch(w);
    const created = await create(w, "kopano", "handover", { batch, to: orgIds.mosela });
    const [authority] = await findAuthorityPda({
      protocol: w.protocol,
      wallet: wallets.kopanoField.address,
    });
    const real = w.svm.getAccount(authority);
    if (!real.exists) throw new Error("no authority");
    w.svm.setAccount({
      address: authority,
      programAddress: (await signer()).address,
      lamports: real.lamports,
      executable: false,
      space: real.space,
      data: real.data,
    } as never);
    const before = w.chain.sent.length;
    const response = await signText(w, "kopano", created, "holder", wallets.kopanoField);
    expect(response.statusCode, response.body).toBe(409);
    expect(errorOf(response)).toMatchObject({
      code: "AUTHORITY_INVALID",
      detail: `${authority}: not an Authority`,
    });
    expect(w.chain.sent.length).toBe(before);
  });

  it("R4: accept_loading refuses a loan on another position and a zero lock (VALIDATION args.loan) at create, and a lender wallet without LEND (AUTHORITY_INVALID) before anything is sent", async () => {
    const w = await world();
    const { loans } = await lotAtTerminal(w, ["3000000", "2000000"]);
    const [first, second] = loans as [Address, Address];
    const { intent } = await createIntent(w);
    const post = (loan: Address) =>
      call(w, "POST", "/v1/commands", people.lenderOne, {
        kind: "accept_loading",
        organisationId: orgIds.lenderOne,
        args: { intent, loan },
      });
    const before = w.chain.sent.length;

    rewrite(w, first, decodeLoan, (v) => getLoanEncoder().encode(v), {
      position: (await signer()).address,
    });
    const elsewhere = await post(first);
    expect(elsewhere.statusCode, elsewhere.body).toBe(400);
    expect(errorOf(elsewhere)).toMatchObject({ code: "VALIDATION", detail: "args.loan" });

    const [lock] = await findLockPda({ loan: second });
    rewrite(w, lock, decodeLockAllocation, (v) => getLockAllocationEncoder().encode(v), {
      quantityKg: 0n,
    });
    const zero = await post(second);
    expect(zero.statusCode, zero.body).toBe(400);
    expect(errorOf(zero)).toMatchObject({ code: "VALIDATION", detail: "args.loan" });
    expect(w.chain.sent.length).toBe(before);
  }, 240_000);

  it("R4: a lender wallet whose Authority lacks LEND is AUTHORITY_INVALID at the transaction request, and nothing is signed or sent", async () => {
    const w = await world();
    const { loans } = await lotAtTerminal(w, ["5000000"]);
    const [loan] = loans as [Address];
    const { intent } = await createIntent(w);
    const created = await create(w, "lenderOne", "accept_loading", { intent, loan });
    const [authority] = await findAuthorityPda({
      protocol: w.protocol,
      wallet: wallets.lenderOne.address,
    });
    const held = decodeAuthority(w.svm.getAccount(authority) as never).data;
    rewrite(w, authority, decodeAuthority, (v) => getAuthorityEncoder().encode(v), {
      scopes: held.scopes & ~(1 << 7),
    });
    const before = w.chain.sent.length;
    const response = await call(
      w,
      "POST",
      `/v1/commands/${created.id}/transaction-request`,
      people.lenderOne,
      { wallet: wallets.lenderOne.address },
    );
    expect(response.statusCode, response.body).toBe(409);
    expect(errorOf(response)).toMatchObject({
      code: "AUTHORITY_INVALID",
      detail: "scope LEND missing",
    });
    expect(w.chain.sent.length).toBe(before);
  }, 240_000);

  it("R5: accept_loading refuses a superseded intent (LOADING_SUPERSEDED) and a loan under an open exception (LOAN_UNDER_EXCEPTION) at create, sending nothing", async () => {
    const w = await world();
    const { loans, position } = await lotAtTerminal(w, ["3000000", "2000000"]);
    const [first, second] = loans as [Address, Address];
    const { intent } = await createIntent(w);
    const post = (loan: Address) =>
      call(w, "POST", "/v1/commands", people.lenderOne, {
        kind: "accept_loading",
        organisationId: orgIds.lenderOne,
        args: { intent, loan },
      });
    const before = w.chain.sent.length;

    rewrite(w, first, decodeLoan, (v) => getLoanEncoder().encode(v), { openExceptions: 1 });
    const excepted = await post(first);
    expect(excepted.statusCode, excepted.body).toBe(409);
    expect(errorOf(excepted)).toMatchObject({
      code: "LOAN_UNDER_EXCEPTION",
      detail: `loan: ${first}`,
    });

    const held = decodePosition(w.svm.getAccount(position) as never).data;
    rewrite(w, position, decodePosition, (v) => getPositionEncoder().encode(v), {
      revision: held.revision + 1n,
    });
    const superseded = await post(second);
    expect(superseded.statusCode, superseded.body).toBe(409);
    expect(errorOf(superseded)).toMatchObject({
      code: "LOADING_SUPERSEDED",
      detail: `intent: ${intent}`,
    });
    expect(w.chain.sent.length).toBe(before);
  }, 240_000);
});
