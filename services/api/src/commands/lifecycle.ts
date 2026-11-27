// The command lifecycle (live-lending.md §4.4, §5): create, collect signatures, submit through the
// sponsor, and record the outcome only from the chain. Every row change is a compare-and-set on
// `revision`; a losing writer re-reads and continues from the new row.
import { createHash } from "node:crypto";
import {
  type Address,
  getBase58Decoder,
  getBase58Encoder,
  getBase64Decoder,
  getBase64Encoder,
  getTransactionDecoder,
  type Transaction,
} from "@solana/kit";
import type { SupabaseClient } from "@supabase/supabase-js";
import * as contracts from "@thetis/contracts";
import {
  decodeAuthority,
  findAuthorityPda,
  findOrganisationPda,
  identifyThetisEvent,
  PaymentPurpose,
  ThetisEvent,
} from "@thetis/contracts";
import { verifyEd25519 } from "../ed25519.ts";
import { type ChainPort, ChainUnavailableError } from "./chain.ts";
import {
  admittedKeys,
  commandInstructions,
  compileCommandWire,
  MAX_TRANSACTION_BYTES,
  measureCommand,
  tableCandidates,
} from "./compile.ts";
import { sharedMessageInstruction } from "./ed25519.ts";
import { ensureTableKeys, LookupTableFullError } from "./lookup-table.ts";
import {
  buildInstruction,
  KIND_SPECS,
  type Prepared,
  poolToken,
  prepare,
  Reader,
  readProtocol,
  scopeBit,
  tableSignerAddresses,
  uuidBytes,
  validateArgs,
} from "./plan.ts";
import { type SponsorPort, SponsorUnavailableError } from "./sponsor.ts";
import { formatSast } from "./texts.ts";
import {
  type CommandKind,
  type CommandRow,
  type CommandView,
  RelayError,
  type SignerRole,
  type StoredSignature,
  toView,
} from "./views.ts";

export interface Relay {
  network: "devnet";
  programId: Address;
  protocol: Address;
  chain: ChainPort;
  sponsor: SponsorPort;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export interface Caller {
  userId: string;
  caller: SupabaseClient;
  service: SupabaseClient;
}

const EXPIRY_MARGIN = 30n;
const POLL_MS = 1_000;
const POLL_FOR_MS = 20_000;
const REBROADCAST_MS = 2_000;
const UNKNOWN_AFTER_MS = 60_000;
const MAX_SENDS = 3;

/** Per process: when each submitted command's status was last read successfully. */
const lastRead = new Map<string, number>();
const lastBroadcast = new Map<string, number>();

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function view(row: CommandRow): CommandView {
  return toView(row, formatSast);
}

// ---------------------------------------------------------------- rows

async function visibleRow(context: Caller, id: string): Promise<CommandRow> {
  const { data, error } = await context.caller
    .from("commands")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new RelayError("INTERNAL", error.message);
  if (!data) throw new RelayError("NOT_FOUND");
  return data as CommandRow;
}

async function reread(context: Caller, id: string): Promise<CommandRow> {
  const { data, error } = await context.service.from("commands").select("*").eq("id", id).single();
  if (error || !data) throw new RelayError("INTERNAL", error?.message);
  return data as CommandRow;
}

/** The open-command cap (fold 10) is the database's; any other write error is INTERNAL. */
function databaseError(error: { message: string }): RelayError {
  if (error.message === "TOO_MANY_OPEN_COMMANDS") return new RelayError("TOO_MANY_OPEN_COMMANDS");
  return new RelayError("INTERNAL", error.message);
}

/** Compare-and-set: null when another writer changed the row first. */
async function update(
  context: Caller,
  row: CommandRow,
  patch: Partial<CommandRow>,
): Promise<CommandRow | null> {
  const { data, error } = await context.service
    .from("commands")
    .update({ ...patch, revision: row.revision + 1, updated_at: new Date().toISOString() })
    .eq("id", row.id)
    .eq("revision", row.revision)
    .select("*");
  if (error) throw databaseError(error);
  return (data?.[0] as CommandRow | undefined) ?? null;
}

// ---------------------------------------------------------------- who may act

async function isMember(context: Caller, organisationId: string): Promise<boolean> {
  const { data, error } = await context.service
    .from("memberships")
    .select("id")
    .eq("user_id", context.userId)
    .eq("organisation_id", organisationId)
    .is("revoked_at", null)
    .limit(1);
  if (error) throw new RelayError("INTERNAL", error.message);
  return (data ?? []).length > 0;
}

async function linkedWallets(context: Caller, organisationId: string): Promise<string[]> {
  const { data, error } = await context.service
    .from("signer_links")
    .select("wallet")
    .eq("user_id", context.userId)
    .eq("organisation_id", organisationId)
    .is("revoked_at", null);
  if (error) throw new RelayError("INTERNAL", error.message);
  return (data ?? []).map((row) => row.wallet as string);
}

async function evidenceDigest(
  context: Caller,
  versionId: string,
  lenderOrgId: string,
): Promise<string> {
  const { data, error } = await context.caller
    .from("evidence_versions")
    .select("sha256, finalized_at, evidence_objects!inner(purpose, owner_organisation_id)")
    .eq("id", versionId)
    .maybeSingle();
  if (error) throw new RelayError("INTERNAL", error.message);
  const object = (data?.evidence_objects ?? null) as {
    purpose: string;
    owner_organisation_id: string;
  } | null;
  if (
    !data ||
    data.finalized_at === null ||
    typeof data.sha256 !== "string" ||
    !object ||
    object.purpose !== "bank" ||
    object.owner_organisation_id !== lenderOrgId
  ) {
    throw new RelayError("EVIDENCE_INVALID");
  }
  return data.sha256;
}

/** §4.4.1 "A signer": membership, the caller's own link, the Authority (unless the role skips
 * that pre-check), and not yet signed. */
async function checkSigner(
  relay: Relay,
  context: Caller,
  row: CommandRow,
  role: SignerRole,
  wallet: string,
  chainTime: bigint,
) {
  const signer = row.signers.find((s) => s.role === role);
  if (!signer) throw new RelayError("ROLE_INVALID");
  if (!(await isMember(context, signer.organisationId))) {
    throw new RelayError(
      "NOT_AUTHORISED",
      "the caller is not a member of the signer's organisation",
    );
  }
  if (!(await linkedWallets(context, signer.organisationId)).includes(wallet)) {
    throw new RelayError("WALLET_NOT_LINKED", wallet);
  }
  if (row.kind === "borrow" && wallet !== row.args.wallet) {
    throw new RelayError("WALLET_NOT_LINKED", `the borrower must sign with ${row.args.wallet}`);
  }
  const spec = KIND_SPECS[row.kind].signers.find((s) => s.role === role);
  if (spec?.preCheckAuthority) {
    const [authorityAddress] = await findAuthorityPda({
      protocol: relay.protocol,
      wallet: wallet as Address,
    });
    const [account] = await relay.chain.accounts([authorityAddress]);
    if (!account?.exists) throw new RelayError("AUTHORITY_INVALID", "no authority for this wallet");
    let authority: {
      organisation: Address;
      revokedAt: { __option: string };
      expiresAt: bigint;
      scopes: number;
      protocol: Address;
    };
    try {
      authority = decodeAuthority(account as never).data as never;
    } catch {
      throw new RelayError("AUTHORITY_INVALID", "the authority account does not decode");
    }
    const [organisation] = await findOrganisationPda({
      protocol: relay.protocol,
      orgId: uuidBytes(signer.organisationId),
    });
    if (authority.protocol !== relay.protocol || authority.organisation !== organisation) {
      throw new RelayError("AUTHORITY_INVALID", "organisation");
    }
    if (authority.revokedAt.__option !== "None")
      throw new RelayError("AUTHORITY_INVALID", "revoked");
    if (authority.expiresAt <= chainTime) throw new RelayError("AUTHORITY_INVALID", "expired");
    const bit = scopeBit(signer.scope);
    if (bit !== null && (authority.scopes & bit) === 0) {
      throw new RelayError("AUTHORITY_INVALID", `scope ${signer.scope} missing`);
    }
  }
  if (row.signatures.some((s) => s.role === role)) throw new RelayError("ALREADY_SIGNED");
}

// ---------------------------------------------------------------- create and renew

async function prepared(
  relay: Relay,
  context: Caller,
  kind: CommandKind,
  organisationId: string,
  args: Record<string, string>,
) {
  const { instanceId, settlementMode } = await readProtocol(relay.chain, relay.protocol);
  const simulation = settlementMode === contracts.SettlementMode.DevnetTokenSimulation;
  const mode = KIND_SPECS[kind].mode;
  if ((mode === "fiat" && simulation) || (mode === "simulation" && !simulation)) {
    throw new RelayError("WRONG_SETTLEMENT_MODE");
  }
  const reader = new Reader(relay.chain, relay.protocol);
  const chainTime = await relay.chain.chainTime();
  const initiator = await reader.organisationByUuid("organisation", organisationId);
  return prepare(kind, {
    reader,
    programId: relay.programId,
    protocol: relay.protocol,
    instanceId,
    settlementMode,
    chainTime,
    initiator,
    args,
    evidenceDigest: (versionId, lenderOrgId) => evidenceDigest(context, versionId, lenderOrgId),
    callerLinks: (org) => linkedWallets(context, org),
  });
}

function textColumns(p: Prepared, version: number) {
  return p.text
    ? {
        text_version: version,
        message_base64: getBase64Decoder().decode(p.text),
        message_sha256: sha256Hex(p.text),
        valid_until: String(p.validUntil),
      }
    : { text_version: 0, message_base64: null, message_sha256: null, valid_until: null };
}

export async function createCommand(
  relay: Relay,
  context: Caller,
  body: Record<string, unknown>,
): Promise<CommandView> {
  const kind = body.kind as CommandKind;
  if (typeof kind !== "string" || !Object.hasOwn(KIND_SPECS, kind))
    throw new RelayError("VALIDATION", "kind");
  const organisationId = body.organisationId;
  if (
    typeof organisationId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(organisationId)
  ) {
    throw new RelayError("VALIDATION", "organisationId");
  }
  const args = validateArgs(kind, body.args);
  if (!(await isMember(context, organisationId))) {
    throw new RelayError("NOT_AUTHORISED", "the caller is not a member of the organisation");
  }
  const p = await prepared(relay, context, kind, organisationId, args);
  const parties = [...new Set([organisationId, ...p.signers.map((s) => s.organisationId)])].sort();
  const { data, error } = await context.service
    .from("commands")
    .insert({
      network: relay.network,
      program_id: relay.programId,
      protocol: relay.protocol,
      kind,
      status: "awaiting_signatures",
      created_by: context.userId,
      initiator_org: organisationId,
      parties,
      lot: p.lot,
      facility: p.facility,
      loan: p.loan,
      intent: p.intent,
      payment: p.payment,
      args,
      plan: p.plan,
      fields: p.fields,
      signers: p.signers,
      signatures: [],
      revision: 0,
      ...textColumns(p, 1),
    })
    .select("*")
    .single();
  if (error) throw databaseError(error);
  if (!data) throw new RelayError("INTERNAL", "the command was not stored");
  return view(data as CommandRow);
}

export async function renewCommand(
  relay: Relay,
  context: Caller,
  id: string,
): Promise<CommandView> {
  let row = await visibleRow(context, id);
  row = await refresh(relay, context, row, false);
  if (row.status !== "expired") throw new RelayError("COMMAND_STATE");
  if (!(await isMember(context, row.initiator_org))) {
    throw new RelayError("NOT_AUTHORISED", "only the initiator renews");
  }
  const p = await prepared(relay, context, row.kind, row.initiator_org, row.args);
  const renewed = await update(context, row, {
    status: "awaiting_signatures",
    plan: p.plan,
    fields: p.fields,
    signers: p.signers,
    signatures: [],
    lot: p.lot,
    facility: p.facility,
    loan: p.loan,
    intent: p.intent,
    payment: p.payment,
    ...textColumns(p, row.text_version + 1),
    pending_message_base64: null,
    pending_wallet: null,
    pending_last_valid_block_height: null,
    transaction_base64: null,
    transaction_signature: null,
    last_valid_block_height: null,
    sends: 0,
    error_code: null,
    error_detail: null,
  });
  if (!renewed) return view(await reread(context, id));
  return view(renewed);
}

// ---------------------------------------------------------------- expiry and confirmation

function textExpired(row: CommandRow, chainTime: bigint) {
  return row.valid_until !== null && chainTime > BigInt(row.valid_until) - EXPIRY_MARGIN;
}

/** The expiry rule and the confirmation reads every call applies (§4.4.1). */
async function refresh(
  relay: Relay,
  context: Caller,
  row: CommandRow,
  wait: boolean,
): Promise<CommandRow> {
  let current = row;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (current.status === "awaiting_signatures" && current.valid_until !== null) {
      const chainTime = await relay.chain.chainTime();
      if (textExpired(current, chainTime)) {
        const expired = await update(context, current, { status: "expired" });
        current = expired ?? (await reread(context, current.id));
        continue;
      }
    }
    break;
  }
  if (current.status === "submitted" || current.status === "outcome_unknown") {
    current = await settle(relay, context, current, wait);
  }
  if (current.status === "confirmed") current = await afterConfirmed(relay, context, current);
  return current;
}

function errorName(code: number): string {
  if (code < 6000) return `Anchor${code}`;
  for (const [name, value] of Object.entries(contracts)) {
    if (name.startsWith("THETIS_ERROR__") && value === code) {
      return name
        .slice("THETIS_ERROR__".length)
        .toLowerCase()
        .replace(/(^|_)([a-z])/g, (_, __, letter: string) => letter.toUpperCase());
    }
  }
  return `Custom${code}`;
}

function failure(
  row: CommandRow,
  failed: unknown,
): { error_code: string; error_detail: string | null } {
  const thetisIndex = row.message_base64 ? 2 : 1;
  const instruction = (failed as { InstructionError?: [number, unknown] })?.InstructionError;
  if (instruction) {
    const [index, inner] = instruction;
    const custom = (inner as { Custom?: number } | null)?.Custom;
    if (index === thetisIndex && typeof custom === "number") {
      return { error_code: errorName(custom), error_detail: null };
    }
  }
  return { error_code: "TransactionError", error_detail: JSON.stringify(failed) };
}

async function transition(context: Caller, row: CommandRow, patch: Partial<CommandRow>) {
  return (await update(context, row, patch)) ?? (await reread(context, row.id));
}

/** Reads the chain for a submitted command until it is answered, or once when `wait` is false. */
async function settle(
  relay: Relay,
  context: Caller,
  row: CommandRow,
  wait: boolean,
): Promise<CommandRow> {
  let current = row;
  const deadline = POLL_FOR_MS / POLL_MS;
  for (let round = 0; ; round++) {
    if (current.status !== "submitted" && current.status !== "outcome_unknown") return current;
    const signature = current.transaction_signature as string;
    try {
      const status = await relay.chain.status(signature);
      lastRead.set(current.id, relay.now());
      if (
        status &&
        status.failed === null &&
        (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")
      ) {
        return transition(context, current, {
          status: "confirmed",
          confirmed_commitment: status.confirmationStatus,
          confirmed_slot: String(status.slot),
          error_code: null,
          error_detail: null,
        });
      }
      if (status && status.failed !== null) {
        return transition(context, current, {
          status: "failed",
          ...failure(current, status.failed),
        });
      }
      if (!status) {
        const height = await relay.chain.blockHeight();
        if (height <= BigInt(current.last_valid_block_height as string)) {
          if (current.status === "outcome_unknown")
            current = await transition(context, current, { status: "submitted" });
          const last = lastBroadcast.get(current.id) ?? 0;
          if (relay.now() - last >= REBROADCAST_MS && current.transaction_base64) {
            lastBroadcast.set(current.id, relay.now());
            await relay.chain.send(current.transaction_base64);
          }
        } else {
          current = await notLanded(relay, context, current);
          if (current.status !== "submitted") return current;
        }
      }
    } catch (error) {
      if (!(error instanceof ChainUnavailableError)) throw error;
      const since = lastRead.get(current.id) ?? Date.parse(current.updated_at);
      if (current.status === "submitted" && relay.now() - since >= UNKNOWN_AFTER_MS) {
        current = await transition(context, current, { status: "outcome_unknown" });
      }
    }
    if (!wait || round + 1 >= deadline) return current;
    await relay.sleep(POLL_MS);
  }
}

function hasTxSigner(kind: CommandKind) {
  return KIND_SPECS[kind].signers.some((s) => s.method === "transaction");
}

/** Proven not landed: the blockhash expired and the signature was never seen. */
async function notLanded(relay: Relay, context: Caller, row: CommandRow): Promise<CommandRow> {
  if (hasTxSigner(row.kind)) {
    const txRoles = new Set(
      row.signers.filter((s) => s.method === "transaction").map((s) => s.role),
    );
    return transition(context, row, {
      status: "awaiting_signatures",
      signatures: row.signatures.filter((s) => !txRoles.has(s.role)),
      pending_message_base64: null,
      pending_wallet: null,
      pending_last_valid_block_height: null,
      transaction_base64: null,
      transaction_signature: null,
      last_valid_block_height: null,
      // §5 caps sends for text kinds only; each new signed transaction counts afresh (fold 11).
      sends: 0,
    });
  }
  const chainTime = await relay.chain.chainTime();
  if (textExpired(row, chainTime) || row.sends >= MAX_SENDS) {
    return transition(context, row, { status: "expired" });
  }
  let built: Awaited<ReturnType<typeof compileCommand>>;
  try {
    built = await compileCommand(relay, context, row, walletsOf(row));
  } catch (error) {
    if (isTooLarge(error)) return transition(context, row, tooLargePatch(error));
    throw error;
  }
  const wire = await sponsorSign(relay, built.wire, built.table);
  const next = await update(context, row, {
    transaction_base64: wire,
    transaction_signature: feePayerSignature(wire, await relay.sponsor.address()),
    last_valid_block_height: String(built.lastValidBlockHeight),
    sends: row.sends + 1,
  });
  if (!next) return reread(context, row.id);
  lastBroadcast.set(next.id, relay.now());
  await relay.chain.send(wire);
  return next;
}

function eventData(name: string, value: Record<string, unknown>): Record<string, unknown> {
  const json = (field: string, v: unknown): unknown => {
    if (v && typeof v === "object" && "__option" in v) {
      const option = v as { __option: string; value?: unknown };
      return option.__option === "None" ? null : json(field, option.value);
    }
    if (typeof v === "bigint") return v.toString();
    if (v instanceof Uint8Array) return Buffer.from(v).toString("hex");
    if (typeof v === "number" && name === "PaymentConfirmed" && field === "purpose") {
      return (PaymentPurpose as unknown as Record<number, string>)[v];
    }
    return v;
  };
  return Object.fromEntries(Object.entries(value).map(([field, v]) => [field, json(field, v)]));
}

/** The Thetis `Program data:` lines of a transaction's logs (indexer.md §6.5 step 2). */
function thetisEventLines(logs: string[], programId: string): string[] {
  const stack: string[] = [];
  const lines: string[] = [];
  for (const line of logs) {
    const invoke = /^Program (\S+) invoke \[\d+\]$/.exec(line);
    if (invoke?.[1]) {
      stack.push(invoke[1]);
      continue;
    }
    if (/^Program (\S+) (success|failed)/.test(line)) {
      stack.pop();
      continue;
    }
    const data = /^Program data: (.*)$/.exec(line);
    if (data?.[1] !== undefined && stack[stack.length - 1] === programId) lines.push(data[1]);
  }
  return lines;
}

/** §4.4.3: the decoded event of the confirmed transaction; then a finalized commitment. */
async function afterConfirmed(relay: Relay, context: Caller, row: CommandRow): Promise<CommandRow> {
  let current = row;
  const signature = current.transaction_signature as string;
  if (current.outcome === null) {
    let patch: Partial<CommandRow> = { error_code: "OUTCOME_UNREADABLE", error_detail: null };
    try {
      const found = await relay.chain.transaction(signature);
      const lines = found ? thetisEventLines(found.logs, relay.programId) : [];
      const expected = KIND_SPECS[current.kind].event;
      if (found && lines.length === 1 && lines[0]) {
        const bytes = new Uint8Array(getBase64Encoder().encode(lines[0]));
        const name = ThetisEvent[identifyThetisEvent(bytes)] as string;
        const parse = (
          contracts as unknown as Record<string, (b: Uint8Array) => Record<string, unknown>>
        )[`parse${name}Event`];
        if (name === expected && parse) {
          patch = {
            outcome: { event: name, slot: String(found.slot), data: eventData(name, parse(bytes)) },
            confirmed_slot: String(found.slot),
            error_code: null,
            error_detail: null,
          };
        }
      }
    } catch (error) {
      if (!(error instanceof ChainUnavailableError)) throw error;
    }
    if (patch.outcome || current.error_code !== "OUTCOME_UNREADABLE")
      current = await transition(context, current, patch);
  }
  if (current.confirmed_commitment === "confirmed") {
    try {
      const status = await relay.chain.status(signature);
      if (status?.confirmationStatus === "finalized") {
        current = await transition(context, current, { confirmed_commitment: "finalized" });
      }
    } catch (error) {
      if (!(error instanceof ChainUnavailableError)) throw error;
    }
  }
  return current;
}

// ---------------------------------------------------------------- building and sending

function walletsOf(row: CommandRow, extra?: { role: SignerRole; wallet: string }) {
  const wallets: Partial<Record<SignerRole, Address>> = {};
  for (const s of row.signatures) wallets[s.role] = s.wallet as Address;
  if (extra) wallets[extra.role] = extra.wallet as Address;
  return wallets;
}

async function compileCommand(
  relay: Relay,
  context: Caller,
  row: CommandRow,
  wallets: Partial<Record<SignerRole, Address>>,
) {
  const sponsor = await relay.sponsor.address();
  const thetis = await buildInstruction({
    kind: row.kind,
    plan: row.plan,
    protocol: relay.protocol,
    sponsor,
    wallets,
  });
  let ed25519 = null;
  if (row.message_base64) {
    const message = new Uint8Array(getBase64Encoder().encode(row.message_base64));
    const textRoles = row.signers.filter((s) => s.method === "text");
    ed25519 = sharedMessageInstruction(
      textRoles.map((s) => {
        const signed = row.signatures.find((x) => x.role === s.role);
        if (!signed) throw new RelayError("COMMAND_STATE");
        return {
          wallet: signed.wallet as Address,
          signature: new Uint8Array(getBase58Encoder().encode(signed.signature)),
        };
      }),
      message,
    );
  }
  const instructions = commandInstructions(thetis, ed25519);
  // Table keys (compile.ts): every account except signers, the invoked programs and the
  // protocol, which stays static so the sponsor can check it; and only accounts that exist on
  // chain now, so an account the instruction creates stays static and unsigned requests can't
  // fill the table (fold 9). A kind's program-signer PDAs (field-app.md fold 25) and the fixed
  // program and sysvar addresses (PR #69 fold 27) are the exceptions.
  const candidates = tableCandidates(thetis, {
    protocol: relay.protocol,
    sponsor,
    signers: Object.values(wallets),
  });
  const onChain = await relay.chain.accounts(candidates);
  const keys = admittedKeys(
    candidates,
    candidates.map((_, index) => onChain[index]?.exists === true),
    tableSignerAddresses(row.kind, row.plan),
  );
  // PR #69 fold 26: refused before the sponsor signs, the table changes or anything is stored.
  tooLarge(measureCommand(instructions, sponsor, keys));
  let table: Awaited<ReturnType<typeof ensureTableKeys>>;
  try {
    table = await ensureTableKeys({ ...relay, service: context.service }, keys);
  } catch (error) {
    if (error instanceof LookupTableFullError) throw new RelayError("LOOKUP_TABLE_FULL");
    if (error instanceof SponsorUnavailableError)
      throw new RelayError("SPONSOR_UNAVAILABLE", error.detail);
    throw error;
  }
  const { blockhash, lastValidBlockHeight } = await relay.chain.latestBlockhash();
  const built = compileCommandWire(
    instructions,
    sponsor,
    { blockhash: blockhash as never, lastValidBlockHeight },
    { address: table.table, keys: table.addresses.filter((key) => key !== relay.protocol) },
  );
  tooLarge(built.bytes);
  return { wire: built.wire, table: table.table, lastValidBlockHeight };
}

function tooLarge(bytes: number) {
  if (bytes > MAX_TRANSACTION_BYTES)
    throw new RelayError("TRANSACTION_TOO_LARGE", `${bytes} bytes`);
}

function isTooLarge(error: unknown): error is RelayError {
  return error instanceof RelayError && error.code === "TRANSACTION_TOO_LARGE";
}

/** PR #69 fold 26: a text command that can't fit one transaction ends expired with the error,
 * nothing signed by the sponsor and nothing sent; renew clears the error. */
function tooLargePatch(error: RelayError, signatures?: StoredSignature[]): Partial<CommandRow> {
  return {
    status: "expired",
    ...(signatures ? { signatures } : {}),
    error_code: error.code,
    error_detail: error.detail ?? null,
  };
}

async function sponsorSign(relay: Relay, wire: string, table: Address): Promise<string> {
  try {
    return await relay.sponsor.sign(wire, table);
  } catch (error) {
    if (error instanceof SponsorUnavailableError)
      throw new RelayError("SPONSOR_UNAVAILABLE", error.detail);
    throw new RelayError("SPONSOR_UNAVAILABLE");
  }
}

function decodeWire(wire: string): Transaction {
  return getTransactionDecoder().decode(getBase64Encoder().encode(wire));
}

function feePayerSignature(wire: string, sponsor: Address): string {
  const signature = decodeWire(wire).signatures[sponsor];
  if (!signature) throw new RelayError("INTERNAL", "the sponsor did not sign");
  return getBase58Decoder().decode(signature);
}

/** One compare-and-set to submitted, written before the transaction is sent. */
async function submit(
  relay: Relay,
  context: Caller,
  row: CommandRow,
  wire: string,
  lastValidBlockHeight: bigint,
  signatures: StoredSignature[],
): Promise<CommandRow> {
  const sponsor = await relay.sponsor.address();
  const next = await update(context, row, {
    status: "submitted",
    signatures,
    transaction_base64: wire,
    transaction_signature: feePayerSignature(wire, sponsor),
    last_valid_block_height: String(lastValidBlockHeight),
    sends: row.sends + 1,
    pending_message_base64: null,
    pending_wallet: null,
    pending_last_valid_block_height: null,
  });
  if (!next) return reread(context, row.id);
  lastRead.set(next.id, relay.now());
  lastBroadcast.set(next.id, relay.now());
  await relay.chain.send(wire);
  const settled = await settle(relay, context, next, true);
  return settled.status === "confirmed" ? afterConfirmed(relay, context, settled) : settled;
}

// ---------------------------------------------------------------- the routes' operations

export async function getCommand(relay: Relay, context: Caller, id: string): Promise<CommandView> {
  return view(await refresh(relay, context, await visibleRow(context, id), false));
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

export async function postSignature(
  relay: Relay,
  context: Caller,
  id: string,
  body: Record<string, unknown>,
): Promise<CommandView> {
  const { role, wallet, messageSha256, signature } = body;
  if (
    typeof role !== "string" ||
    typeof wallet !== "string" ||
    !BASE58.test(wallet) ||
    typeof messageSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(messageSha256) ||
    typeof signature !== "string" ||
    !BASE58.test(signature) ||
    signature.length > 88
  ) {
    throw new RelayError("VALIDATION");
  }
  let row = await visibleRow(context, id);
  for (let attempt = 0; attempt < 8; attempt++) {
    const signer = row.signers.find((s) => s.role === role);
    if (!signer || signer.method !== "text") throw new RelayError("ROLE_INVALID");
    const chainTime = await relay.chain.chainTime();
    if (row.status === "awaiting_signatures" && textExpired(row, chainTime)) {
      await refresh(relay, context, row, false);
      throw new RelayError("TEXT_EXPIRED");
    }
    if (row.status !== "awaiting_signatures") {
      if (
        row.signatures.some(
          (s) => s.role === role && s.wallet === wallet && s.signature === signature,
        )
      ) {
        return view(await refresh(relay, context, row, true));
      }
      if (row.status === "expired") throw new RelayError("TEXT_EXPIRED");
      throw new RelayError("COMMAND_STATE");
    }
    await checkSigner(relay, context, row, role as SignerRole, wallet, chainTime);
    if (messageSha256 !== row.message_sha256) throw new RelayError("STALE_TEXT");
    const message = new Uint8Array(getBase64Encoder().encode(row.message_base64 as string));
    let signatureBytes: Uint8Array;
    let walletBytes: Uint8Array;
    try {
      signatureBytes = new Uint8Array(getBase58Encoder().encode(signature));
      walletBytes = new Uint8Array(getBase58Encoder().encode(wallet));
    } catch {
      throw new RelayError("BAD_SIGNATURE");
    }
    if (
      signatureBytes.length !== 64 ||
      walletBytes.length !== 32 ||
      !verifyEd25519(Buffer.from(walletBytes), Buffer.from(message), Buffer.from(signatureBytes))
    ) {
      throw new RelayError("BAD_SIGNATURE");
    }
    const signatures: StoredSignature[] = [
      ...row.signatures,
      { role: role as SignerRole, wallet, signature, signedAt: new Date().toISOString() },
    ];
    const textRoles = row.signers.filter((s) => s.method === "text");
    const complete = textRoles.every((s) => signatures.some((x) => x.role === s.role));
    if (complete && !hasTxSigner(row.kind)) {
      // The last text signature submits: build, sponsor-sign, then one compare-and-set.
      const withSignatures = { ...row, signatures };
      let built: Awaited<ReturnType<typeof compileCommand>>;
      try {
        built = await compileCommand(relay, context, withSignatures, walletsOf(withSignatures));
      } catch (error) {
        if (isTooLarge(error)) await update(context, row, tooLargePatch(error, signatures));
        throw error;
      }
      const wire = await sponsorSign(relay, built.wire, built.table);
      const fresh = await reread(context, row.id);
      if (fresh.revision !== row.revision) {
        row = fresh;
        continue;
      }
      return view(await submit(relay, context, row, wire, built.lastValidBlockHeight, signatures));
    }
    const next = await update(context, row, { signatures });
    if (next) return view(next);
    row = await reread(context, row.id);
  }
  throw new RelayError("INTERNAL", "the command kept changing");
}

function txSigner(row: CommandRow) {
  const signer = row.signers.find((s) => s.method === "transaction");
  if (!signer) throw new RelayError("COMMAND_STATE");
  return signer;
}

export async function requestTransaction(
  relay: Relay,
  context: Caller,
  id: string,
  body: Record<string, unknown>,
): Promise<{ transactionBase64: string; lastValidBlockHeight: string }> {
  const { wallet } = body;
  if (typeof wallet !== "string" || !BASE58.test(wallet)) throw new RelayError("VALIDATION");
  let row = await visibleRow(context, id);
  row = await refresh(relay, context, row, false);
  if (row.status === "expired") throw new RelayError("TEXT_EXPIRED");
  if (row.status !== "awaiting_signatures") throw new RelayError("COMMAND_STATE");
  const signer = txSigner(row);
  const textRoles = row.signers.filter((s) => s.method === "text");
  if (!textRoles.every((s) => row.signatures.some((x) => x.role === s.role))) {
    throw new RelayError("COMMAND_STATE");
  }
  const chainTime = await relay.chain.chainTime();
  if (textExpired(row, chainTime)) throw new RelayError("TEXT_EXPIRED");
  await checkSigner(relay, context, row, signer.role, wallet, chainTime);
  if (row.kind === "deposit" || row.kind === "withdraw" || row.kind === "repay_simulated") {
    const token = await poolToken(wallet as Address, row.plan.mint as Address);
    const [account] = await relay.chain.accounts([token]);
    if (!account?.exists) throw new RelayError("TOKEN_ACCOUNT_MISSING", token);
  }
  const built = await compileCommand(
    relay,
    context,
    row,
    walletsOf(row, { role: signer.role, wallet }),
  );
  const messageBytes = decodeWire(built.wire).messageBytes;
  for (let attempt = 0; attempt < 5; attempt++) {
    const next = await update(context, row, {
      pending_message_base64: getBase64Decoder().decode(new Uint8Array(messageBytes)),
      pending_wallet: wallet,
      pending_last_valid_block_height: String(built.lastValidBlockHeight),
    });
    if (next)
      return {
        transactionBase64: built.wire,
        lastValidBlockHeight: String(built.lastValidBlockHeight),
      };
    row = await reread(context, row.id);
    if (row.status !== "awaiting_signatures") throw new RelayError("COMMAND_STATE");
  }
  throw new RelayError("INTERNAL", "the command kept changing");
}

export async function postTransaction(
  relay: Relay,
  context: Caller,
  id: string,
  body: Record<string, unknown>,
): Promise<CommandView> {
  const { transactionBase64 } = body;
  if (typeof transactionBase64 !== "string" || transactionBase64.length > 4000)
    throw new RelayError("VALIDATION");
  let row = await visibleRow(context, id);
  row = await refresh(relay, context, row, false);
  if (row.status !== "awaiting_signatures" || !row.pending_message_base64 || !row.pending_wallet) {
    throw new RelayError("COMMAND_STATE");
  }
  let transaction: Transaction;
  try {
    transaction = decodeWire(transactionBase64);
  } catch {
    throw new RelayError("TRANSACTION_MISMATCH");
  }
  const messageBytes = new Uint8Array(transaction.messageBytes);
  const pending = new Uint8Array(getBase64Encoder().encode(row.pending_message_base64));
  if (!Buffer.from(messageBytes).equals(Buffer.from(pending)))
    throw new RelayError("TRANSACTION_MISMATCH");
  const sponsor = await relay.sponsor.address();
  const walletSignature = transaction.signatures[row.pending_wallet as Address];
  if (
    !walletSignature ||
    !verifyEd25519(
      Buffer.from(getBase58Encoder().encode(row.pending_wallet)),
      Buffer.from(messageBytes),
      Buffer.from(walletSignature),
    ) ||
    transaction.signatures[sponsor] !== null
  ) {
    throw new RelayError("TRANSACTION_MISMATCH");
  }
  if ((await relay.chain.blockHeight()) > BigInt(row.pending_last_valid_block_height as string)) {
    throw new RelayError("BLOCKHASH_EXPIRED");
  }
  const table = await tableAddress(context, row);
  const wire = await sponsorSign(relay, transactionBase64, table);
  const signer = txSigner(row);
  const signatures: StoredSignature[] = [
    ...row.signatures.filter((s) => s.role !== signer.role),
    {
      role: signer.role,
      wallet: row.pending_wallet,
      signature: getBase58Decoder().decode(walletSignature),
      signedAt: new Date().toISOString(),
    },
  ];
  return view(
    await submit(
      relay,
      context,
      row,
      wire,
      BigInt(row.pending_last_valid_block_height as string),
      signatures,
    ),
  );
}

async function tableAddress(context: Caller, row: CommandRow): Promise<Address> {
  const { data, error } = await context.service
    .from("relay_lookup_tables")
    .select("address")
    .eq("network", row.network)
    .eq("program_id", row.program_id)
    .eq("protocol", row.protocol)
    .single();
  if (error || !data) throw new RelayError("INTERNAL", "no lookup table for this instance");
  return data.address as Address;
}
