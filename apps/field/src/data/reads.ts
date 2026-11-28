// The phone's reads of the read model and access tables, under the person's RLS. The read
// model is for choosing and showing; it is never the evidence that something happened.
import type { SupabaseClient } from "@supabase/supabase-js";
import { SIGNER_ROLES, type SignerRole } from "../api/commands";
import { type CheckpointRow, type ProtocolResult, resolveProtocol } from "../protocol";
import { SupabaseTimeout } from "../supabase";

/** A read that failed or did not answer. Screens show their list error with Retry. */
export class ReadError extends Error {
  constructor(
    readonly timeout: boolean,
    message: string,
  ) {
    super(message);
    this.name = "ReadError";
  }
}

type Result = { data: unknown; error: { message: string } | null };

async function run<T>(query: PromiseLike<Result>): Promise<T> {
  let result: Result;
  try {
    result = await query;
  } catch (error) {
    throw new ReadError(error instanceof SupabaseTimeout, String(error));
  }
  if (result.error) {
    const timeout = /SupabaseTimeout|did not answer/.test(result.error.message);
    throw new ReadError(timeout, result.error.message);
  }
  return result.data as T;
}

export interface Membership {
  organisationId: string;
  memberRole: string;
  name: string;
  slug: string;
  kind: string;
  synthetic: boolean;
}

export async function readMemberships(db: SupabaseClient, userId: string): Promise<Membership[]> {
  const rows = await run<
    {
      organisation_id: string;
      member_role: string;
      organisations: { name: string; slug: string; kind: string; synthetic: boolean } | null;
    }[]
  >(
    db
      .from("memberships")
      .select("organisation_id, member_role, organisations(id, slug, name, kind, synthetic)")
      .eq("user_id", userId)
      .is("revoked_at", null),
  );
  return rows
    .filter((row) => row.organisations !== null)
    .map((row) => ({
      organisationId: row.organisation_id,
      memberRole: row.member_role,
      name: row.organisations?.name ?? "",
      slug: row.organisations?.slug ?? "",
      kind: row.organisations?.kind ?? "",
      synthetic: row.organisations?.synthetic ?? false,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function readProtocol(db: SupabaseClient, program: string): Promise<ProtocolResult> {
  const checkpoints = await run<CheckpointRow[]>(
    db
      .from("indexer_checkpoints")
      .select("protocol, status, indexed_through_slot, last_success_at, halt_reason")
      .eq("network", "devnet")
      .eq("program_id", program),
  );
  if (checkpoints.length !== 1) return resolveProtocol(checkpoints, null);
  const protocolRow = await run<{ instance_id_hex: string; settlement_mode: string } | null>(
    db
      .from("chain_protocols")
      .select("instance_id_hex, settlement_mode")
      .eq("address", checkpoints[0]?.protocol ?? "")
      .maybeSingle(),
  );
  return resolveProtocol(checkpoints, protocolRow);
}

export interface ChainOrganisation {
  address: string;
  role: string;
  displayName: string;
}

export async function readChainOrganisation(
  db: SupabaseClient,
  protocol: string,
  orgId: string,
): Promise<ChainOrganisation | null> {
  const row = await run<{ address: string; role: string; display_name: string } | null>(
    db
      .from("chain_organisations")
      .select("address, org_id, role, display_name")
      .eq("protocol", protocol)
      .eq("org_id", orgId)
      .maybeSingle(),
  );
  return row && { address: row.address, role: row.role, displayName: row.display_name };
}

/** The organisation behind a chain Organisation address, for a handover's `to`. */
export async function readOrganisationAt(
  db: SupabaseClient,
  protocol: string,
  address: string,
): Promise<{ orgId: string; displayName: string } | null> {
  const row = await run<{ org_id: string; display_name: string } | null>(
    db
      .from("chain_organisations")
      .select("org_id, display_name")
      .eq("protocol", protocol)
      .eq("address", address)
      .maybeSingle(),
  );
  return row && { orgId: row.org_id, displayName: row.display_name };
}

export interface WaitingCommand {
  id: string;
  kind: "handover" | "record_loading";
  intent: string | null;
  createdAt: string;
  fields: { label: string; value: string }[];
  role: SignerRole;
}

interface WaitingRow {
  id: string;
  kind: "handover" | "record_loading";
  intent: string | null;
  fields: unknown;
  signers: unknown;
  signatures: unknown;
  created_at: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function readFields(value: unknown): { label: string; value: string }[] | null {
  if (!Array.isArray(value)) return null;
  const out: { label: string; value: string }[] = [];
  for (const item of value) {
    if (!isObject(item) || typeof item.label !== "string" || typeof item.value !== "string") {
      return null;
    }
    out.push({ label: item.label, value: item.value });
  }
  return out;
}

/** The role of this organisation's signer that has not signed yet, or null (also for bad jsonb). */
function unsignedRole(row: WaitingRow, organisationId: string): SignerRole | null {
  if (!Array.isArray(row.signers) || !Array.isArray(row.signatures)) return null;
  const signed = new Set<string>();
  for (const item of row.signatures) {
    if (!isObject(item) || typeof item.role !== "string") return null;
    signed.add(item.role);
  }
  let mine: SignerRole | null = null;
  for (const item of row.signers) {
    if (
      !isObject(item) ||
      typeof item.role !== "string" ||
      !(SIGNER_ROLES as readonly string[]).includes(item.role) ||
      typeof item.organisationId !== "string"
    ) {
      return null;
    }
    if (mine === null && item.organisationId === organisationId && !signed.has(item.role)) {
      mine = item.role as SignerRole;
    }
  }
  return mine;
}

/** Open handovers and loadings where this organisation's signer has not signed yet. */
export async function readWaiting(
  db: SupabaseClient,
  protocol: string,
  organisationId: string,
): Promise<WaitingCommand[]> {
  const rows = await run<WaitingRow[]>(
    db
      .from("commands")
      .select("id, kind, intent, fields, signers, signatures, created_at")
      .eq("protocol", protocol)
      .eq("status", "awaiting_signatures")
      .in("kind", ["handover", "record_loading"])
      .order("created_at", { ascending: false }),
  );
  const waiting: WaitingCommand[] = [];
  for (const row of rows) {
    const fields = readFields(row.fields);
    const role = unsignedRole(row, organisationId);
    if (fields === null || role === null) continue;
    waiting.push({
      id: row.id,
      kind: row.kind,
      intent: row.intent,
      createdAt: row.created_at,
      fields,
      role,
    });
  }
  return waiting;
}

/** An open record_loading for this intent: the screen links to it and never prepares a second. */
export async function readOpenLoadingCommand(
  db: SupabaseClient,
  protocol: string,
  intent: string,
): Promise<string | null> {
  const rows = await run<{ id: string }[]>(
    db
      .from("commands")
      .select("id")
      .eq("protocol", protocol)
      .eq("kind", "record_loading")
      .eq("intent", intent)
      .in("status", ["awaiting_signatures", "submitted", "outcome_unknown"])
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(1),
  );
  return rows[0]?.id ?? null;
}

export interface SignerLink {
  userId: string;
  organisationId: string;
  wallet: string;
}

export async function readSignerLinks(db: SupabaseClient, wallet: string): Promise<SignerLink[]> {
  const rows = await run<{ user_id: string; organisation_id: string; wallet: string }[]>(
    db
      .from("signer_links")
      .select("id, user_id, organisation_id, wallet, linked_at")
      .eq("wallet", wallet)
      .is("revoked_at", null),
  );
  return rows.map((row) => ({
    userId: row.user_id,
    organisationId: row.organisation_id,
    wallet: row.wallet,
  }));
}

export interface AuthorityView {
  address: string;
  organisation: string;
  orgId: string;
  scopes: number;
  expiresAt: string;
  revokedAt: string | null;
}

export async function readAuthority(
  db: SupabaseClient,
  protocol: string,
  wallet: string,
): Promise<AuthorityView | null> {
  const row = await run<{
    address: string;
    organisation: string;
    org_id: string;
    scopes: number;
    expires_at: string;
    revoked_at: string | null;
  } | null>(
    db
      .from("chain_authorities")
      .select("address, organisation, org_id, scopes, expires_at, revoked_at")
      .eq("protocol", protocol)
      .eq("wallet", wallet)
      .maybeSingle(),
  );
  return (
    row && {
      address: row.address,
      organisation: row.organisation,
      orgId: row.org_id,
      scopes: Number(row.scopes),
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
    }
  );
}

export interface Site {
  address: string;
  classPolicy: string;
  siteCode: string;
  roomKg: bigint;
  classCode: string;
  classVersion: number;
  grades: string[];
  originRequired: boolean;
}

export async function readSites(
  db: SupabaseClient,
  protocol: string,
  orgId: string,
): Promise<Site[]> {
  const sites = await run<
    {
      address: string;
      class_policy: string;
      site_code: string;
      approved_capacity_kg: string;
      occupied_kg: string;
      reserved_inbound_kg: string;
    }[]
  >(
    db
      .from("chain_custodian_classes")
      .select(
        "address, class_policy, site_code, approved_capacity_kg, occupied_kg, reserved_inbound_kg",
      )
      .eq("protocol", protocol)
      .eq("custodian_org_id", orgId)
      .order("site_code"),
  );
  if (sites.length === 0) return [];
  const classes = await run<
    {
      address: string;
      class_code: string;
      version: number;
      grades: string[];
      origin_required: boolean;
    }[]
  >(
    db
      .from("chain_class_policies")
      .select("address, class_code, version, grades, origin_required")
      .in(
        "address",
        sites.map((site) => site.class_policy),
      ),
  );
  return sites.flatMap((site) => {
    const policy = classes.find((c) => c.address === site.class_policy);
    if (!policy) return [];
    const room =
      BigInt(site.approved_capacity_kg) -
      BigInt(site.occupied_kg) -
      BigInt(site.reserved_inbound_kg);
    return [
      {
        address: site.address,
        classPolicy: site.class_policy,
        siteCode: site.site_code,
        roomKg: room > 0n ? room : 0n,
        classCode: policy.class_code,
        classVersion: Number(policy.version),
        grades: policy.grades,
        originRequired: policy.origin_required,
      },
    ];
  });
}

export interface Owner {
  address: string;
  orgId: string;
  displayName: string;
  synthetic: boolean;
}

export async function readOwners(db: SupabaseClient, protocol: string): Promise<Owner[]> {
  const rows = await run<
    { address: string; org_id: string; display_name: string; synthetic: boolean | null }[]
  >(
    db
      .from("chain_organisations")
      .select("address, org_id, display_name, synthetic")
      .eq("protocol", protocol)
      .eq("role", "Exporter")
      .order("display_name"),
  );
  return rows.map((row) => ({
    address: row.address,
    orgId: row.org_id,
    displayName: row.display_name,
    synthetic: row.synthetic === true,
  }));
}

export interface IssuedIntake {
  lot: string;
  lotId: string | null;
}

export async function readIssuedIntake(
  db: SupabaseClient,
  protocol: string,
  orgId: string,
  digest: string,
): Promise<IssuedIntake | null> {
  const row = await run<{ address: string; lot: string; retired: boolean } | null>(
    db
      .from("chain_intakes")
      .select("address, lot, retired")
      .eq("protocol", protocol)
      .eq("custodian_org_id", orgId)
      .eq("intake_digest_hex", digest)
      .maybeSingle(),
  );
  if (!row) return null;
  const lot = await run<{ lot_id: string } | null>(
    db
      .from("chain_lots")
      .select("lot_id")
      .eq("protocol", protocol)
      .eq("address", row.lot)
      .maybeSingle(),
  );
  return { lot: row.lot, lotId: lot?.lot_id ?? null };
}

export async function readLotIdUsed(
  db: SupabaseClient,
  protocol: string,
  lotId: string,
): Promise<boolean> {
  const rows = await run<{ address: string }[]>(
    db.from("chain_lots").select("address").eq("protocol", protocol).eq("lot_id", lotId).limit(1),
  );
  return rows.length > 0;
}

export interface LotRow {
  address: string;
  lotId: string;
  grade: string;
  supplyKg: bigint;
  state: string;
  siteCode: string | null;
}

export async function readLotsAtSites(
  db: SupabaseClient,
  protocol: string,
  orgId: string,
  sites: readonly Site[],
): Promise<LotRow[]> {
  const rows = await run<
    {
      address: string;
      lot_id: string;
      grade: string;
      supply_kg: string;
      state: string;
      custodian_class: string;
    }[]
  >(
    db
      .from("chain_lots")
      .select("address, lot_id, grade, supply_kg, state, issued_at, custodian_class")
      .eq("protocol", protocol)
      .eq("custodian_org_id", orgId)
      .order("issued_at", { ascending: false })
      .limit(20),
  );
  return rows.map((row) => ({
    address: row.address,
    lotId: row.lot_id,
    grade: row.grade,
    supplyKg: BigInt(row.supply_kg),
    state: row.state,
    siteCode: sites.find((site) => site.address === row.custodian_class)?.siteCode ?? null,
  }));
}

/** Freshness of the index for the protocol, re-read on foreground. */
export async function readCheckpoint(
  db: SupabaseClient,
  program: string,
  protocol: string,
): Promise<{ status: string; lastSuccessAt: string | null } | null> {
  const row = await run<{ status: string; last_success_at: string | null } | null>(
    db
      .from("indexer_checkpoints")
      .select("status, last_success_at")
      .eq("network", "devnet")
      .eq("program_id", program)
      .eq("protocol", protocol)
      .maybeSingle(),
  );
  return row && { status: row.status, lastSuccessAt: row.last_success_at };
}
