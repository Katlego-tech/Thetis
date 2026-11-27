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
  decodeCustodianClass,
  decodeLoan,
  decodeLot,
  decodeManifestBatch,
  decodePaymentAttestation,
  findAuthorityPda,
  findHandoverPda,
  findIntakePda,
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
  getDelegateAuthorityInstruction,
  getInitializeProtocolInstruction,
  getIssueLotInstruction,
  getOpenPoolInstruction,
  getPrepareShipmentInstructionAsync,
  getRegisterBatchInstructionAsync,
  getRegisterClassInstruction,
  Role,
  SettlementMode,
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
  | "moselaNoAuthority";
const SCOPE = {
  ISSUE: 1,
  TRANSFER: 2,
  PLEDGE: 32,
  BUY: 64,
  LEND: 128,
  POOL: 256,
  SHIP: 512,
  CARRY: 1024,
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
    scopes: SCOPE.ISSUE | SCOPE.CARRY | SCOPE.ATTEST_TRANSPORT,
    linked: true,
  },
  kopanoNoAuthority: { org: "kopano", scopes: 0, linked: true, delegated: false },
  khunouShip: { org: "khunou", scopes: SCOPE.SHIP, linked: false },
  // Phone 2: Mosela's carrier wallet, and the second wallet with no Authority (the refused driver).
  mosela: { org: "mosela", scopes: SCOPE.CARRY, linked: true },
  moselaNoAuthority: { org: "mosela", scopes: 0, linked: true, delegated: false },
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

async function classPolicyPda(protocol: Address) {
  const version = new Uint8Array(4);
  new DataView(version.buffer).setUint32(0, 1, true);
  const [found] = await getProgramDerivedAddress({
    programAddress: THETIS_PROGRAM_ADDRESS,
    seeds: ["class", getAddressEncoder().encode(protocol), "CHROME", version],
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

async function world(mode: "fiat" | "simulation" = "fiat"): Promise<World> {
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
          organisationName: await orgNamePda(protocol, ORGS[key].name),
          accreditor,
          payer,
          orgId: uuidBytes(orgIds[key]),
          role: ORGS[key].role as never,
          displayName: ORGS[key].name,
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
      ["Owner", ORGS.khunou.name],
      ["Custodian", ORGS.kopano.name],
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
      failed: { InstructionError: [2, { Custom: expect.any(Number) }] },
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
    // Every lending role keeps the Authority pre-check (fold 1); repay_simulated's payer names no scope.
    for (const [kind, spec] of Object.entries(KIND_SPECS)) {
      for (const role of spec.signers) {
        expect(role.preCheckAuthority, `${kind}.${role.role}`).toBe(kind !== "repay_simulated");
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
