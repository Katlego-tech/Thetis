-- The chain read model: a cache of what the Thetis program confirmed. The indexer writes it through
-- the functions below (the only write path); members read it through row-level security.
--
-- Rules for every value (binding on the worker, this file and the web):
--   * every program u64 and i64 is canonical decimal text, so it never loses precision as JSON;
--   * addresses are base58 text; byte arrays are lowercase hex; org_id is a uuid;
--   * enums are stored by their variant name, and each column lists the known variants;
--   * a null from the program is SQL null.

-- ---------------------------------------------------------------------------------------------
-- Value checks. STRICT: null in, null out; a check constraint accepts null, so nullability is each
-- column's own rule. The pattern is tested before the cast, so malformed text is false, never an
-- error.
-- ---------------------------------------------------------------------------------------------
create function private.is_u64(v text) returns boolean language sql immutable strict set search_path = ''
as $$ select case when v ~ '^(0|[1-9][0-9]{0,19})$' then v::numeric <= 18446744073709551615 else false end $$;

create function private.is_i64(v text) returns boolean language sql immutable strict set search_path = ''
as $$ select case when v ~ '^(0|-?[1-9][0-9]{0,18})$'
             then v::numeric between -9223372036854775808 and 9223372036854775807 else false end $$;

create function private.is_address(v text) returns boolean language sql immutable strict set search_path = ''
as $$ select v ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' $$;

create function private.are_addresses(v text[]) returns boolean language sql immutable set search_path = ''
as $$ select coalesce(bool_and(x is not null and private.is_address(x)), true) from unnest(v) as x $$;

revoke all on function private.is_u64(text), private.is_i64(text), private.is_address(text),
  private.are_addresses(text[]) from public, anon, authenticated, service_role;

create type public.chain_commitment as enum ('confirmed', 'finalized');
create type public.indexer_status as enum ('backfilling', 'live', 'halted');
create type public.indexer_halt_reason as enum (
  'UNKNOWN_INSTRUCTION', 'UNKNOWN_EVENT', 'UNKNOWN_ENUM', 'EVENT_DECODE_FAILED', 'EVENT_MISMATCH',
  'TRANSACTION_UNREADABLE', 'REVISION_SEQUENCE', 'EVENT_GAP', 'ACCOUNT_DECODE_FAILED',
  'ACCOUNT_VANISHED', 'CONFIRMED_DROPPED', 'HISTORY_INCOMPLETE');
create type public.chain_event_scope as enum ('registry', 'organisation', 'lot');

-- ---------------------------------------------------------------------------------------------
-- Stream state, transactions, events
-- ---------------------------------------------------------------------------------------------
create table public.indexer_checkpoints (
  network text not null check (network = 'devnet'),
  program_id text not null check (private.is_address(program_id)),
  protocol text not null check (private.is_address(protocol)),
  status public.indexer_status not null default 'backfilling',
  indexed_through_slot bigint check (indexed_through_slot >= 0),
  last_poll_at timestamptz,
  last_success_at timestamptz,
  consecutive_rpc_errors integer not null default 0 check (consecutive_rpc_errors >= 0),
  halt_reason public.indexer_halt_reason,
  halt_detail text,
  halted_signature text,
  halted_at timestamptz,
  updated_at timestamptz not null default pg_catalog.now(),
  created_at timestamptz not null default pg_catalog.now(),
  primary key (network, program_id, protocol),
  check (case when status = 'halted'
    then halt_reason is not null and halt_detail is not null and halted_at is not null
    else halt_reason is null and halt_detail is null and halted_signature is null and halted_at is null end)
);
-- Phase 1 binds one stream per database:
create unique index indexer_checkpoints_one_stream on public.indexer_checkpoints ((true));

create table public.chain_transactions (
  network text not null check (network = 'devnet'),
  program_id text not null check (private.is_address(program_id)),
  signature text not null,
  slot bigint not null check (slot >= 0),
  block_time timestamptz not null,
  succeeded boolean not null,
  protocol text check (private.is_address(protocol)),
  event_count integer not null default 0 check (event_count >= 0),
  commitment public.chain_commitment not null default 'confirmed',
  created_at timestamptz not null default pg_catalog.now(),
  primary key (network, program_id, signature)
);

create table public.chain_events (
  network text not null,
  program_id text not null,
  signature text not null,
  event_index integer not null check (event_index >= 0),
  slot bigint not null,
  block_time timestamptz not null,
  protocol text not null check (private.is_address(protocol)),
  instruction text not null,
  event text not null,
  scope public.chain_event_scope not null,
  lot text check (private.is_address(lot)),
  lot_revision text check (private.is_u64(lot_revision)),
  org_id uuid,
  data jsonb not null,
  commitment public.chain_commitment not null default 'confirmed',
  created_at timestamptz not null default pg_catalog.now(),
  primary key (network, program_id, signature, event_index),
  foreign key (network, program_id, signature)
    references public.chain_transactions (network, program_id, signature),
  check ((scope = 'lot') = (lot is not null)),
  check ((scope = 'lot') = (lot_revision is not null)),
  check ((scope = 'organisation') = (org_id is not null))
);
create unique index chain_events_lot_revision
  on public.chain_events (network, program_id, lot, lot_revision) where lot is not null;
create index chain_events_lot on public.chain_events (lot, slot);

-- ---------------------------------------------------------------------------------------------
-- Projection tables, one per account kind. Every one carries the same first columns and ends with
-- the primary key (network, address).
-- ---------------------------------------------------------------------------------------------
create table public.chain_protocols (
  network text not null check (network = 'devnet'),
  address text not null check (private.is_address(address)),
  protocol text not null check (private.is_address(protocol)),
  slot bigint not null check (slot >= 0),
  commitment public.chain_commitment not null,
  last_signature text,
  updated_at timestamptz not null default pg_catalog.now(),
  created_at timestamptz not null default pg_catalog.now(),
  instance_id_hex text not null check (instance_id_hex ~ '^[0-9a-f]{32}$'),
  settlement_mode text not null check (settlement_mode in ('FiatAttestationTest', 'DevnetTokenSimulation')),
  admin text not null check (private.is_address(admin)),
  accreditor text not null check (private.is_address(accreditor)),
  pause_flags bigint not null check (pause_flags between 0 and 65535),
  primary key (network, address)
);

create table public.chain_class_policies (
  network text not null check (network = 'devnet'),
  address text not null check (private.is_address(address)),
  protocol text not null check (private.is_address(protocol)),
  slot bigint not null check (slot >= 0),
  commitment public.chain_commitment not null,
  last_signature text,
  updated_at timestamptz not null default pg_catalog.now(),
  created_at timestamptz not null default pg_catalog.now(),
  class_code text not null,
  version bigint not null check (version between 0 and 4294967295),
  unit text not null check (unit in ('Kilogram')),
  grades text[] not null,
  origin_required boolean not null,
  lot_validity_secs text not null check (private.is_i64(lot_validity_secs)),
  split_inherits_expiry boolean not null,
  primary key (network, address)
);

create table public.chain_organisations (
  network text not null check (network = 'devnet'),
  address text not null check (private.is_address(address)),
  protocol text not null check (private.is_address(protocol)),
  slot bigint not null check (slot >= 0),
  commitment public.chain_commitment not null,
  last_signature text,
  updated_at timestamptz not null default pg_catalog.now(),
  created_at timestamptz not null default pg_catalog.now(),
  org_id uuid not null,
  slug text,
  synthetic boolean,
  role text not null check (role in ('Exporter', 'Buyer', 'Custodian', 'Transporter', 'Terminal',
    'Lender', 'Inspector', 'DocumentIssuer')),
  display_name text not null,
  admin text not null check (private.is_address(admin)),
  related text[] not null default '{}' check (private.are_addresses(related)),
  primary key (network, address)
);
create unique index chain_organisations_org on public.chain_organisations (network, protocol, org_id);

create table public.chain_authorities (
  network text not null check (network = 'devnet'),
  address text not null check (private.is_address(address)),
  protocol text not null check (private.is_address(protocol)),
  slot bigint not null check (slot >= 0),
  commitment public.chain_commitment not null,
  last_signature text,
  updated_at timestamptz not null default pg_catalog.now(),
  created_at timestamptz not null default pg_catalog.now(),
  organisation text not null check (private.is_address(organisation)),
  org_id uuid not null,
  wallet text not null check (private.is_address(wallet)),
  scopes bigint not null check (scopes between 0 and 65535),
  expires_at text not null check (private.is_i64(expires_at)),
  revoked_at text check (private.is_i64(revoked_at)),
  primary key (network, address)
);

create table public.chain_custodian_classes (
  network text not null check (network = 'devnet'),
  address text not null check (private.is_address(address)),
  protocol text not null check (private.is_address(protocol)),
  slot bigint not null check (slot >= 0),
  commitment public.chain_commitment not null,
  last_signature text,
  updated_at timestamptz not null default pg_catalog.now(),
  created_at timestamptz not null default pg_catalog.now(),
  custodian text not null check (private.is_address(custodian)),
  custodian_org_id uuid not null,
  class_policy text not null check (private.is_address(class_policy)),
  site_code text not null,
  approved_capacity_kg text not null check (private.is_u64(approved_capacity_kg)),
  occupied_kg text not null check (private.is_u64(occupied_kg)),
  reserved_inbound_kg text not null check (private.is_u64(reserved_inbound_kg)),
  primary key (network, address)
);

create table public.chain_documents (
  network text not null check (network = 'devnet'),
  address text not null check (private.is_address(address)),
  protocol text not null check (private.is_address(protocol)),
  slot bigint not null check (slot >= 0),
  commitment public.chain_commitment not null,
  last_signature text,
  updated_at timestamptz not null default pg_catalog.now(),
  created_at timestamptz not null default pg_catalog.now(),
  kind text not null check (kind in ('Origin')),
  subject_hex text not null check (subject_hex ~ '^[0-9a-f]{64}$'),
  version bigint not null check (version between 0 and 4294967295),
  issuer text not null check (private.is_address(issuer)),
  issuer_org_id uuid not null,
  sha256_hex text not null check (sha256_hex ~ '^[0-9a-f]{64}$'),
  valid_until text not null check (private.is_i64(valid_until)),
  revoked_at text check (private.is_i64(revoked_at)),
  primary key (network, address)
);

create table public.chain_intakes (
  network text not null check (network = 'devnet'),
  address text not null check (private.is_address(address)),
  protocol text not null check (private.is_address(protocol)),
  slot bigint not null check (slot >= 0),
  commitment public.chain_commitment not null,
  last_signature text,
  updated_at timestamptz not null default pg_catalog.now(),
  created_at timestamptz not null default pg_catalog.now(),
  custodian text not null check (private.is_address(custodian)),
  custodian_org_id uuid not null,
  intake_digest_hex text not null check (intake_digest_hex ~ '^[0-9a-f]{64}$'),
  lot text not null check (private.is_address(lot)),
  retired boolean not null,
  primary key (network, address)
);

create table public.chain_lots (
  network text not null check (network = 'devnet'),
  address text not null check (private.is_address(address)),
  protocol text not null check (private.is_address(protocol)),
  slot bigint not null check (slot >= 0),
  commitment public.chain_commitment not null,
  last_signature text,
  updated_at timestamptz not null default pg_catalog.now(),
  created_at timestamptz not null default pg_catalog.now(),
  lot_id text not null,
  class_policy text not null check (private.is_address(class_policy)),
  class_version bigint not null check (class_version between 0 and 4294967295),
  grade text not null,
  custodian_class text not null check (private.is_address(custodian_class)),
  custodian text not null check (private.is_address(custodian)),
  custodian_org_id uuid not null,
  intake text not null check (private.is_address(intake)),
  parent text check (private.is_address(parent)),
  root text not null check (private.is_address(root)),
  mint text not null check (private.is_address(mint)),
  supply_kg text not null check (private.is_u64(supply_kg)),
  state text not null check (state in ('Stored', 'Redeemed')),
  restriction text not null check (restriction in ('Normal')),
  expires_at text not null check (private.is_i64(expires_at)),
  revision text not null check (private.is_u64(revision)),
  live_children bigint not null check (live_children between 0 and 4294967295),
  event_revision text not null check (private.is_u64(event_revision)),
  issued_owner text not null check (private.is_address(issued_owner)),
  issued_owner_org_id uuid not null,
  issued_at timestamptz not null,
  primary key (network, address)
);
create unique index chain_lots_lot_id on public.chain_lots (network, protocol, lot_id);

create table public.chain_positions (
  network text not null check (network = 'devnet'),
  address text not null check (private.is_address(address)),
  protocol text not null check (private.is_address(protocol)),
  slot bigint not null check (slot >= 0),
  commitment public.chain_commitment not null,
  last_signature text,
  updated_at timestamptz not null default pg_catalog.now(),
  created_at timestamptz not null default pg_catalog.now(),
  lot text not null check (private.is_address(lot)),
  owner text not null check (private.is_address(owner)),
  owner_org_id uuid not null,
  quantity_kg text not null check (private.is_u64(quantity_kg)),
  locked_kg text not null check (private.is_u64(locked_kg)),
  reserved_kg text not null check (private.is_u64(reserved_kg)),
  revision text not null check (private.is_u64(revision)),
  primary key (network, address)
);
create index chain_positions_lot on public.chain_positions (lot);

-- ---------------------------------------------------------------------------------------------
-- Access: row-level security on every table, nothing for anon, writes only through the functions.
-- ---------------------------------------------------------------------------------------------
alter table public.indexer_checkpoints enable row level security;
alter table public.chain_transactions enable row level security;
alter table public.chain_events enable row level security;
alter table public.chain_protocols enable row level security;
alter table public.chain_class_policies enable row level security;
alter table public.chain_organisations enable row level security;
alter table public.chain_authorities enable row level security;
alter table public.chain_custodian_classes enable row level security;
alter table public.chain_documents enable row level security;
alter table public.chain_intakes enable row level security;
alter table public.chain_lots enable row level security;
alter table public.chain_positions enable row level security;

revoke all on table public.indexer_checkpoints, public.chain_transactions, public.chain_events,
  public.chain_protocols, public.chain_class_policies, public.chain_organisations,
  public.chain_authorities, public.chain_custodian_classes, public.chain_documents,
  public.chain_intakes, public.chain_lots, public.chain_positions
  from public, anon, authenticated, service_role;

grant select on table public.indexer_checkpoints, public.chain_transactions, public.chain_events,
  public.chain_protocols, public.chain_class_policies, public.chain_organisations,
  public.chain_authorities, public.chain_custodian_classes, public.chain_documents,
  public.chain_intakes, public.chain_lots, public.chain_positions to service_role;

grant select on table public.chain_events, public.chain_protocols, public.chain_class_policies,
  public.chain_organisations, public.chain_authorities, public.chain_custodian_classes,
  public.chain_documents, public.chain_intakes, public.chain_lots, public.chain_positions
  to authenticated;
-- Freshness for every member; the detail, the signature and the counters stay operator-only.
grant select (network, program_id, protocol, status, indexed_through_slot, last_success_at,
  halt_reason, halted_at) on public.indexer_checkpoints to authenticated;

create function private.has_membership()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m
    where m.user_id = (select auth.uid()) and m.revoked_at is null
  );
$$;

-- A lot is read by its custodian and by every holder, past or present (a position is never closed
-- in Phase 1, so a former holder still reads the lot it sold).
create function private.can_read_lot(lot_address text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.chain_lots l
    where l.address = lot_address
      and (private.is_member(l.custodian_org_id)
        or exists (
          select 1 from public.chain_positions p
          where p.lot = l.address and private.is_member(p.owner_org_id)))
  );
$$;

-- An intake is read by its custodian and by whoever reads a lot of its family (a split child
-- points at its family's intake, so a holder of only the child still reads it).
create function private.can_read_intake(intake_address text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.chain_intakes i
    where i.address = intake_address and private.is_member(i.custodian_org_id)
  ) or exists (
    select 1 from public.chain_lots l
    where l.intake = intake_address and private.can_read_lot(l.address)
  );
$$;

revoke all on function private.has_membership(), private.can_read_lot(text), private.can_read_intake(text)
  from public, anon, authenticated, service_role;
grant execute on function private.has_membership(), private.can_read_lot(text), private.can_read_intake(text)
  to authenticated;

create policy indexer_checkpoints_member_select on public.indexer_checkpoints
  for select to authenticated using (private.has_membership());

create policy chain_events_select on public.chain_events
  for select to authenticated using (
    (scope = 'lot' and private.can_read_lot(lot))
    or (scope = 'organisation' and private.is_member(org_id))
    or (scope = 'registry' and private.has_membership()));

create policy chain_protocols_member_select on public.chain_protocols
  for select to authenticated using (private.has_membership());
create policy chain_class_policies_member_select on public.chain_class_policies
  for select to authenticated using (private.has_membership());
create policy chain_organisations_member_select on public.chain_organisations
  for select to authenticated using (private.has_membership());
create policy chain_custodian_classes_member_select on public.chain_custodian_classes
  for select to authenticated using (private.has_membership());

create policy chain_authorities_member_select on public.chain_authorities
  for select to authenticated using (private.is_member(org_id));

create policy chain_documents_select on public.chain_documents
  for select to authenticated using (
    private.is_member(issuer_org_id)
    or exists (
      select 1 from public.chain_intakes i
      where i.intake_digest_hex = subject_hex and private.can_read_intake(i.address)));

create policy chain_intakes_select on public.chain_intakes
  for select to authenticated using (private.can_read_intake(address));
create policy chain_lots_select on public.chain_lots
  for select to authenticated using (private.can_read_lot(address));
create policy chain_positions_select on public.chain_positions
  for select to authenticated using (private.can_read_lot(lot));

-- ---------------------------------------------------------------------------------------------
-- Write functions. The only write path: no role has insert, update or delete on the tables.
-- Errors are P0001 with the code as the message and, where it helps, a detail.
-- ---------------------------------------------------------------------------------------------
create function private.indexer_fail(code text, detail text default null)
returns void
language plpgsql set search_path = ''
as $$
begin
  if detail is null then
    raise exception using errcode = 'P0001', message = code;
  end if;
  raise exception using errcode = 'P0001', message = code, detail = detail;
end;
$$;

-- Checks the shape of a stream document: {network, programId, protocol}.
create function private.indexer_check_stream(stream jsonb)
returns void
language plpgsql set search_path = ''
as $$
begin
  if stream is null or pg_catalog.jsonb_typeof(stream) <> 'object'
    or (select pg_catalog.array_agg(k order by k collate "C") from pg_catalog.jsonb_object_keys(stream) as k)
      is distinct from array['network', 'programId', 'protocol']
    or pg_catalog.jsonb_typeof(stream -> 'network') <> 'string' or stream ->> 'network' <> 'devnet'
    or pg_catalog.jsonb_typeof(stream -> 'programId') <> 'string'
    or not private.is_address(stream ->> 'programId')
    or pg_catalog.jsonb_typeof(stream -> 'protocol') <> 'string'
    or not private.is_address(stream ->> 'protocol')
  then
    perform private.indexer_fail('STREAM_INVALID', 'the stream must be {network, programId, protocol}');
  end if;
end;
$$;

-- The cursor guard every worker write starts with: locks the one checkpoint row, then refuses a
-- missing row or a moved cursor (CURSOR_MOVED), a row of another stream (STREAM_INVALID) and a
-- halted row (INDEXER_HALTED, unless the caller is the halt itself).
create function private.indexer_guard(stream jsonb, expected bigint, allow_halted boolean default false)
returns public.indexer_checkpoints
language plpgsql set search_path = ''
as $$
declare
  cp public.indexer_checkpoints;
begin
  perform private.indexer_check_stream(stream);
  select * into cp from public.indexer_checkpoints for update;
  if not found then
    perform private.indexer_fail('CURSOR_MOVED', 'there is no checkpoint row');
  end if;
  if cp.network <> stream ->> 'network' or cp.program_id <> stream ->> 'programId'
    or cp.protocol <> stream ->> 'protocol'
  then
    perform private.indexer_fail('STREAM_INVALID', 'the stream is not the stored one');
  end if;
  if cp.indexed_through_slot is distinct from expected then
    perform private.indexer_fail('CURSOR_MOVED',
      pg_catalog.format('the cursor is %s, expected %s', cp.indexed_through_slot, expected));
  end if;
  if cp.status = 'halted' and not allow_halted then
    perform private.indexer_fail('INDEXER_HALTED');
  end if;
  return cp;
end;
$$;

-- Checks a JSON row against a table: exactly its columns (minus `skip`), each value of its
-- column's JSON type, null only where the column is nullable.
create function private.indexer_check_row(tbl text, doc jsonb, skip text[])
returns void
language plpgsql set search_path = ''
as $$
declare
  expected text[];
  actual text[];
  col record;
  value jsonb;
  kind text;
begin
  if doc is null or pg_catalog.jsonb_typeof(doc) <> 'object' then
    perform private.indexer_fail('ROW_INVALID', pg_catalog.format('a %s row must be an object', tbl));
  end if;
  select pg_catalog.array_agg(a.attname::text order by a.attname::text collate "C") into expected
  from pg_catalog.pg_attribute a
  where a.attrelid = pg_catalog.format('public.%I', tbl)::pg_catalog.regclass
    and a.attnum > 0 and not a.attisdropped and a.attname::text <> all (skip);
  select pg_catalog.array_agg(k order by k collate "C") into actual from pg_catalog.jsonb_object_keys(doc) as k;
  if expected is distinct from actual then
    perform private.indexer_fail('ROW_INVALID', pg_catalog.format('a %s row has the wrong columns', tbl));
  end if;
  for col in
    select a.attname::text as name, a.attnotnull as required, t.typname::text as typname, t.typtype::text as typtype
    from pg_catalog.pg_attribute a
    join pg_catalog.pg_type t on t.oid = a.atttypid
    where a.attrelid = pg_catalog.format('public.%I', tbl)::pg_catalog.regclass
      and a.attnum > 0 and not a.attisdropped and a.attname::text <> all (skip)
  loop
    value := doc -> col.name;
    kind := pg_catalog.jsonb_typeof(value);
    if kind = 'null' then
      if col.required then
        perform private.indexer_fail('ROW_INVALID', pg_catalog.format('%s.%s must not be null', tbl, col.name));
      end if;
      continue;
    end if;
    if col.typname in ('int8', 'int4') then
      if kind <> 'number' or value::text !~ '^-?[0-9]+$' then
        perform private.indexer_fail('ROW_INVALID', pg_catalog.format('%s.%s must be an integer', tbl, col.name));
      end if;
    elsif col.typname = 'bool' then
      if kind <> 'boolean' then
        perform private.indexer_fail('ROW_INVALID', pg_catalog.format('%s.%s must be a boolean', tbl, col.name));
      end if;
    elsif col.typname = '_text' then
      if kind <> 'array' or exists (
        select 1 from pg_catalog.jsonb_array_elements(value) as e where pg_catalog.jsonb_typeof(e) <> 'string')
      then
        perform private.indexer_fail('ROW_INVALID', pg_catalog.format('%s.%s must be a list of strings', tbl, col.name));
      end if;
    elsif col.typname = 'jsonb' then
      if kind <> 'object' then
        perform private.indexer_fail('ROW_INVALID', pg_catalog.format('%s.%s must be an object', tbl, col.name));
      end if;
    else
      -- text, uuid, timestamptz and the enums are all written as JSON strings.
      if kind <> 'string' then
        perform private.indexer_fail('ROW_INVALID', pg_catalog.format('%s.%s must be a string', tbl, col.name));
      end if;
    end if;
  end loop;
end;
$$;

create function private.indexer_projection_table(name text)
returns boolean
language sql immutable set search_path = ''
as $$
  select name in ('chain_protocols', 'chain_class_policies', 'chain_organisations', 'chain_authorities',
    'chain_custodian_classes', 'chain_documents', 'chain_intakes', 'chain_lots', 'chain_positions')
$$;

-- The columns read from the account itself, by table.
create function private.indexer_account_columns(name text)
returns text[]
language sql immutable set search_path = ''
as $$
  select case name
    when 'chain_protocols' then array['instance_id_hex', 'settlement_mode', 'admin', 'accreditor', 'pause_flags']
    when 'chain_class_policies' then array['class_code', 'version', 'unit', 'grades', 'origin_required',
      'lot_validity_secs', 'split_inherits_expiry']
    when 'chain_organisations' then array['org_id', 'role', 'display_name', 'admin', 'related']
    when 'chain_authorities' then array['organisation', 'org_id', 'wallet', 'scopes', 'expires_at', 'revoked_at']
    when 'chain_custodian_classes' then array['custodian', 'custodian_org_id', 'class_policy', 'site_code',
      'approved_capacity_kg', 'occupied_kg', 'reserved_inbound_kg']
    when 'chain_documents' then array['kind', 'subject_hex', 'version', 'issuer', 'issuer_org_id', 'sha256_hex',
      'valid_until', 'revoked_at']
    when 'chain_intakes' then array['custodian', 'custodian_org_id', 'intake_digest_hex', 'lot', 'retired']
    when 'chain_lots' then array['lot_id', 'class_policy', 'class_version', 'grade', 'custodian_class',
      'custodian', 'custodian_org_id', 'intake', 'parent', 'root', 'mint', 'supply_kg', 'state', 'restriction',
      'expires_at', 'revision', 'live_children']
    when 'chain_positions' then array['lot', 'owner', 'owner_org_id', 'quantity_kg', 'locked_kg', 'reserved_kg',
      'revision']
  end
$$;

-- The columns that come from events or from Supabase rather than from the account read.
create function private.indexer_extra_columns(name text)
returns text[]
language sql immutable set search_path = ''
as $$
  select case name
    when 'chain_organisations' then array['slug', 'synthetic']
    when 'chain_lots' then array['event_revision', 'issued_owner', 'issued_owner_org_id', 'issued_at']
    else array[]::text[]
  end
$$;

-- Validates one {table, row} element of a batch against the stream, and returns the table name.
create function private.indexer_check_upsert(entry jsonb, stream jsonb)
returns text
language plpgsql set search_path = ''
as $$
declare
  tbl text;
begin
  if pg_catalog.jsonb_typeof(entry) <> 'object'
    or (select pg_catalog.array_agg(k order by k collate "C") from pg_catalog.jsonb_object_keys(entry) as k)
      is distinct from array['row', 'table']
    or pg_catalog.jsonb_typeof(entry -> 'table') <> 'string'
  then
    perform private.indexer_fail('ROW_INVALID', 'an upsert must be {table, row}');
  end if;
  tbl := entry ->> 'table';
  if not private.indexer_projection_table(tbl) then
    perform private.indexer_fail('TABLE_INVALID', tbl);
  end if;
  perform private.indexer_check_row(tbl, entry -> 'row', array['created_at', 'updated_at']);
  if entry -> 'row' ->> 'network' <> stream ->> 'network' or entry -> 'row' ->> 'protocol' <> stream ->> 'protocol' then
    perform private.indexer_fail('STREAM_INVALID', pg_catalog.format('a %s row belongs to another stream', tbl));
  end if;
  return tbl;
end;
$$;

-- The upsert rule. In 'apply' mode a row is inserted or merged; in 'reconcile' mode it only
-- merges (a missing row is EVENT_GAP, checked by the caller) and never touches the event or
-- Supabase columns.
create function private.indexer_upsert(tbl text, doc jsonb, mode text)
returns void
language plpgsql set search_path = ''
as $$
declare
  account_columns text[] := private.indexer_account_columns(tbl);
  extra_columns text[] := private.indexer_extra_columns(tbl);
  all_columns text;
  account_set text;
  extra_set text;
begin
  select pg_catalog.string_agg(pg_catalog.format('%I', c), ', ') into all_columns
  from pg_catalog.unnest(array['network', 'address', 'protocol', 'slot', 'commitment', 'last_signature']
    || account_columns || extra_columns) as c;

  if mode = 'apply' then
    select pg_catalog.string_agg(
      pg_catalog.format('%I = case when excluded.slot > t.slot then excluded.%I else t.%I end', c, c, c), ', ')
    into account_set from pg_catalog.unnest(account_columns) as c;
    select pg_catalog.string_agg(pg_catalog.format('%I = excluded.%I', c, c), ', ') into extra_set
    from pg_catalog.unnest(extra_columns) as c;
    execute pg_catalog.format($sql$
      insert into public.%1$I as t (%2$s)
      select %2$s from pg_catalog.jsonb_populate_record(null::public.%1$I, $1)
      on conflict (network, address) do update set
        %3$s,
        slot = case when excluded.slot > t.slot then excluded.slot else t.slot end,
        commitment = case when excluded.slot > t.slot then excluded.commitment
          when excluded.slot = t.slot and excluded.commitment = 'finalized' then excluded.commitment
          else t.commitment end,
        last_signature = case when excluded.slot > t.slot then excluded.last_signature else t.last_signature end,
        %4$supdated_at = pg_catalog.now()
    $sql$, tbl, all_columns, account_set,
      case when extra_set is null then '' else extra_set || ', ' end)
    using doc;
  else
    select pg_catalog.string_agg(
      pg_catalog.format('%I = case when incoming.slot > t.slot then incoming.%I else t.%I end', c, c, c), ', ')
    into account_set from pg_catalog.unnest(account_columns) as c;
    execute pg_catalog.format($sql$
      update public.%1$I as t set
        %2$s,
        slot = case when incoming.slot > t.slot then incoming.slot else t.slot end,
        commitment = case when incoming.slot >= t.slot then 'finalized'::public.chain_commitment
          else t.commitment end,
        last_signature = case when incoming.slot >= t.slot then null else t.last_signature end,
        updated_at = pg_catalog.now()
      from (select * from pg_catalog.jsonb_populate_record(null::public.%1$I, $1)) as incoming
      where t.network = incoming.network and t.address = incoming.address
    $sql$, tbl, account_set)
    using doc;
  end if;
end;
$$;

revoke all on function private.indexer_fail(text, text), private.indexer_check_stream(jsonb),
  private.indexer_guard(jsonb, bigint, boolean), private.indexer_check_row(text, jsonb, text[]),
  private.indexer_projection_table(text), private.indexer_account_columns(text),
  private.indexer_extra_columns(text), private.indexer_check_upsert(jsonb, jsonb),
  private.indexer_upsert(text, jsonb, text)
  from public, anon, authenticated, service_role;

-- Turns a database error raised while writing a row into the code the worker understands.
-- Called from each function's handler, which then re-raises anything this does not recognise.
create function private.indexer_translate_error(state text, message text, constraint_name text)
returns void
language plpgsql set search_path = ''
as $$
begin
  if state = '23505' and constraint_name = 'chain_events_lot_revision' then
    perform private.indexer_fail('REVISION_SEQUENCE', 'a lot revision is already stored under another signature');
  end if;
  if state like '22%' or state in ('23502', '23503', '23505', '23514') then
    perform private.indexer_fail('ROW_INVALID', message);
  end if;
end;
$$;

revoke all on function private.indexer_translate_error(text, text, text)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
create function public.indexer_checkpoint(stream jsonb, expected_through_slot bigint, patch jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  cp public.indexer_checkpoints;
  key text;
  value jsonb;
  failed_constraint text;
begin
  perform private.indexer_check_stream(stream);
  if expected_through_slot is null then
    insert into public.indexer_checkpoints (network, program_id, protocol)
    values (stream ->> 'network', stream ->> 'programId', stream ->> 'protocol')
    on conflict do nothing;
  end if;
  cp := private.indexer_guard(stream, expected_through_slot);

  if patch is null or pg_catalog.jsonb_typeof(patch) <> 'object' then
    perform private.indexer_fail('ROW_INVALID', 'the patch must be an object');
  end if;
  for key, value in select * from pg_catalog.jsonb_each(patch) loop
    if key in ('lastPollAt', 'lastSuccessAt') then
      if pg_catalog.jsonb_typeof(value) <> 'string' then
        perform private.indexer_fail('ROW_INVALID', key || ' must be a time string');
      end if;
    elsif key = 'consecutiveRpcErrors' then
      if pg_catalog.jsonb_typeof(value) <> 'number' or value::text !~ '^[0-9]+$' then
        perform private.indexer_fail('ROW_INVALID', key || ' must be a non-negative integer');
      end if;
    elsif key = 'status' then
      if pg_catalog.jsonb_typeof(value) <> 'string' then
        perform private.indexer_fail('ROW_INVALID', 'status must be a string');
      end if;
      if value #>> '{}' not in ('backfilling', 'live') then
        perform private.indexer_fail('INDEXER_TRANSITION', 'status ' || (value #>> '{}') || ' cannot be set');
      end if;
    else
      perform private.indexer_fail('ROW_INVALID', 'the patch key ' || key || ' is not accepted');
    end if;
  end loop;

  update public.indexer_checkpoints set
    last_poll_at = case when patch ? 'lastPollAt' then (patch ->> 'lastPollAt')::timestamptz else last_poll_at end,
    last_success_at = case when patch ? 'lastSuccessAt' then (patch ->> 'lastSuccessAt')::timestamptz else last_success_at end,
    consecutive_rpc_errors = case when patch ? 'consecutiveRpcErrors'
      then (patch ->> 'consecutiveRpcErrors')::integer else consecutive_rpc_errors end,
    status = case when patch ? 'status' then (patch ->> 'status')::public.indexer_status else status end,
    updated_at = pg_catalog.now()
  where network = cp.network and program_id = cp.program_id and protocol = cp.protocol;
exception when others then
  get stacked diagnostics failed_constraint = constraint_name;
  if sqlstate = 'P0001' then raise; end if;
  perform private.indexer_translate_error(sqlstate, sqlerrm, failed_constraint);
  raise;
end;
$$;

-- ---------------------------------------------------------------------------------------------
create function public.indexer_apply(batch jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  stream jsonb;
  expected bigint;
  through bigint;
  txs jsonb;
  evs jsonb;
  ups jsonb;
  cp public.indexer_checkpoints;
  item jsonb;
  tbl text;
  tx_count integer;
  stored_count integer;
  other_signature text;
  failed_constraint text;
begin
  -- (1) The envelope, the guard, and each transaction's keys and stream.
  if batch is null or pg_catalog.jsonb_typeof(batch) <> 'object'
    or (select pg_catalog.array_agg(k order by k collate "C") from pg_catalog.jsonb_object_keys(batch) as k)
      is distinct from array['events', 'expectedThroughSlot', 'stream', 'throughSlot', 'transactions', 'upserts']
    or pg_catalog.jsonb_typeof(batch -> 'stream') <> 'object'
    or pg_catalog.jsonb_typeof(batch -> 'transactions') <> 'array'
    or pg_catalog.jsonb_typeof(batch -> 'events') <> 'array'
    or pg_catalog.jsonb_typeof(batch -> 'upserts') <> 'array'
    or pg_catalog.jsonb_typeof(batch -> 'throughSlot') <> 'number'
    or batch ->> 'throughSlot' !~ '^[0-9]+$'
    or (pg_catalog.jsonb_typeof(batch -> 'expectedThroughSlot') not in ('number', 'null'))
    or (pg_catalog.jsonb_typeof(batch -> 'expectedThroughSlot') = 'number'
      and batch ->> 'expectedThroughSlot' !~ '^[0-9]+$')
  then
    perform private.indexer_fail('ROW_INVALID', 'the batch envelope is malformed');
  end if;
  stream := batch -> 'stream';
  expected := (batch ->> 'expectedThroughSlot')::bigint;
  through := (batch ->> 'throughSlot')::bigint;
  txs := batch -> 'transactions';
  evs := batch -> 'events';
  ups := batch -> 'upserts';

  cp := private.indexer_guard(stream, expected);

  for item in select * from pg_catalog.jsonb_array_elements(txs) loop
    if pg_catalog.jsonb_typeof(item) <> 'object'
      or (select pg_catalog.array_agg(k order by k collate "C") from pg_catalog.jsonb_object_keys(item) as k)
        is distinct from array['block_time', 'event_count', 'network', 'program_id', 'protocol', 'signature',
          'slot', 'succeeded']
    then
      perform private.indexer_fail('ROW_INVALID', 'a transaction row has the wrong columns');
    end if;
    if item ->> 'network' is distinct from stream ->> 'network'
      or item ->> 'program_id' is distinct from stream ->> 'programId'
      or (item ->> 'protocol' is not null and item ->> 'protocol' <> stream ->> 'protocol')
    then
      perform private.indexer_fail('STREAM_INVALID', 'a transaction row belongs to another stream');
    end if;
  end loop;

  -- Duplicates are refused before a replay is recognised.
  if (select pg_catalog.count(*) <> pg_catalog.count(distinct x ->> 'signature')
      from pg_catalog.jsonb_array_elements(txs) as x) then
    perform private.indexer_fail('ROW_INVALID', 'a transaction signature is repeated');
  end if;
  if (select pg_catalog.count(*) <> pg_catalog.count(distinct (x ->> 'signature') || ':' || (x ->> 'event_index'))
      from pg_catalog.jsonb_array_elements(evs) as x) then
    perform private.indexer_fail('ROW_INVALID', 'an event key is repeated');
  end if;
  if (select pg_catalog.count(*) <> pg_catalog.count(distinct (x ->> 'table') || ':' || (x -> 'row' ->> 'address'))
      from pg_catalog.jsonb_array_elements(ups) as x) then
    perform private.indexer_fail('ROW_INVALID', 'a projection row is repeated');
  end if;

  -- (2) Replay classification: a replay changes nothing, not even the cursor.
  tx_count := pg_catalog.jsonb_array_length(txs);
  if tx_count = 0 then
    if pg_catalog.jsonb_array_length(evs) > 0 or pg_catalog.jsonb_array_length(ups) > 0 then
      perform private.indexer_fail('ROW_INVALID', 'events or projection rows without a transaction');
    end if;
  else
    select pg_catalog.count(*) into stored_count
    from pg_catalog.jsonb_array_elements(txs) as x
    join public.chain_transactions t
      on t.network = cp.network and t.program_id = cp.program_id and t.signature = x ->> 'signature';
    if stored_count = tx_count then
      return;
    elsif stored_count > 0 then
      perform private.indexer_fail('ROW_INVALID', 'a batch mixes stored and new transactions');
    end if;
  end if;

  -- (3) The rules for new rows.
  if expected is not null and through < expected then
    perform private.indexer_fail('ROW_INVALID', 'throughSlot is below the cursor');
  end if;
  for item in select * from pg_catalog.jsonb_array_elements(txs) loop
    perform private.indexer_check_row('chain_transactions', item, array['commitment', 'created_at']);
    if (item ->> 'slot')::bigint > through or (expected is not null and (item ->> 'slot')::bigint <= expected) then
      perform private.indexer_fail('ROW_INVALID', 'a transaction slot is outside the batch range');
    end if;
    if item ->> 'protocol' is null and (item ->> 'event_count')::integer > 0 then
      perform private.indexer_fail('ROW_INVALID', 'a transaction without a protocol has events');
    end if;
  end loop;
  for item in select * from pg_catalog.jsonb_array_elements(evs) loop
    perform private.indexer_check_row('chain_events', item, array['commitment', 'created_at']);
    if item ->> 'network' <> stream ->> 'network' or item ->> 'program_id' <> stream ->> 'programId'
      or item ->> 'protocol' <> stream ->> 'protocol'
    then
      perform private.indexer_fail('STREAM_INVALID', 'an event row belongs to another stream');
    end if;
    if (item ->> 'slot')::bigint > through or (expected is not null and (item ->> 'slot')::bigint <= expected) then
      perform private.indexer_fail('ROW_INVALID', 'an event slot is outside the batch range');
    end if;
    if not exists (
      select 1 from pg_catalog.jsonb_array_elements(txs) as x
      where x ->> 'signature' = item ->> 'signature'
        and (x ->> 'slot')::bigint = (item ->> 'slot')::bigint
        and (x ->> 'block_time')::timestamptz = (item ->> 'block_time')::timestamptz)
    then
      perform private.indexer_fail('ROW_INVALID', 'an event names a transaction that is not in the batch or disagrees with it');
    end if;
  end loop;
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(txs) as x
    where (x ->> 'event_count')::integer <> (
      select pg_catalog.count(*) from pg_catalog.jsonb_array_elements(evs) as e
      where e ->> 'signature' = x ->> 'signature')
  ) then
    perform private.indexer_fail('ROW_INVALID', 'a transaction has the wrong event_count');
  end if;
  for item in select * from pg_catalog.jsonb_array_elements(ups) loop
    perform private.indexer_check_upsert(item, stream);
  end loop;

  insert into public.chain_transactions (network, program_id, signature, slot, block_time, succeeded, protocol, event_count)
  select r.network, r.program_id, r.signature, r.slot, r.block_time, r.succeeded, r.protocol, r.event_count
  from pg_catalog.jsonb_populate_recordset(null::public.chain_transactions, txs) as r
  on conflict (network, program_id, signature) do nothing;

  for item in select * from pg_catalog.jsonb_array_elements(evs) loop
    if item ->> 'lot' is not null then
      select e.signature into other_signature from public.chain_events e
      where e.network = cp.network and e.program_id = cp.program_id
        and e.lot = item ->> 'lot' and e.lot_revision = item ->> 'lot_revision'
      limit 1;
      if found then
        perform private.indexer_fail('REVISION_SEQUENCE', pg_catalog.format(
          'lot %s revision %s is stored under %s, batch has %s',
          item ->> 'lot', item ->> 'lot_revision', other_signature, item ->> 'signature'));
      end if;
    end if;
    insert into public.chain_events (network, program_id, signature, event_index, slot, block_time, protocol,
      instruction, event, scope, lot, lot_revision, org_id, data)
    select r.network, r.program_id, r.signature, r.event_index, r.slot, r.block_time, r.protocol,
      r.instruction, r.event, r.scope, r.lot, r.lot_revision, r.org_id, r.data
    from pg_catalog.jsonb_populate_record(null::public.chain_events, item) as r
    on conflict (network, program_id, signature, event_index) do nothing;
  end loop;

  for item in select * from pg_catalog.jsonb_array_elements(ups) loop
    perform private.indexer_upsert(item ->> 'table', item -> 'row', 'apply');
  end loop;

  update public.indexer_checkpoints set indexed_through_slot = through, updated_at = pg_catalog.now()
  where network = cp.network and program_id = cp.program_id and protocol = cp.protocol;
exception when others then
  get stacked diagnostics failed_constraint = constraint_name;
  if sqlstate = 'P0001' then raise; end if;
  perform private.indexer_translate_error(sqlstate, sqlerrm, failed_constraint);
  raise;
end;
$$;

-- ---------------------------------------------------------------------------------------------
create function public.indexer_halt(
  stream jsonb, expected_through_slot bigint, reason public.indexer_halt_reason, detail text,
  signature text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  cp public.indexer_checkpoints;
  failed_constraint text;
begin
  cp := private.indexer_guard(stream, expected_through_slot, true);
  if cp.status <> 'halted' then
    update public.indexer_checkpoints set
      status = 'halted', halt_reason = reason, halt_detail = detail, halted_signature = signature,
      halted_at = pg_catalog.now(), updated_at = pg_catalog.now()
    where network = cp.network and program_id = cp.program_id and protocol = cp.protocol;
    select * into cp from public.indexer_checkpoints c
    where c.network = cp.network and c.program_id = cp.program_id and c.protocol = cp.protocol;
  end if;
  return pg_catalog.jsonb_build_object('reason', cp.halt_reason, 'detail', cp.halt_detail,
    'signature', cp.halted_signature, 'haltedAt', cp.halted_at);
exception when others then
  get stacked diagnostics failed_constraint = constraint_name;
  if sqlstate = 'P0001' then raise; end if;
  perform private.indexer_translate_error(sqlstate, sqlerrm, failed_constraint);
  raise;
end;
$$;

-- ---------------------------------------------------------------------------------------------
create function public.indexer_finalize(stream jsonb, expected_through_slot bigint, signatures text[])
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  cp public.indexer_checkpoints;
begin
  cp := private.indexer_guard(stream, expected_through_slot);
  if signatures is null then
    perform private.indexer_fail('ROW_INVALID', 'signatures must be a list');
  end if;
  update public.chain_transactions set commitment = 'finalized'
  where network = cp.network and program_id = cp.program_id and signature = any (signatures);
  update public.chain_events set commitment = 'finalized'
  where network = cp.network and program_id = cp.program_id and signature = any (signatures);
end;
$$;

-- ---------------------------------------------------------------------------------------------
create function public.indexer_reconcile(
  stream jsonb, expected_through_slot bigint, upserts jsonb, organisations jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  cp public.indexer_checkpoints;
  item jsonb;
  tbl text;
  row_address text;
  present bigint;
  failed_constraint text;
begin
  cp := private.indexer_guard(stream, expected_through_slot);
  if upserts is null or pg_catalog.jsonb_typeof(upserts) <> 'array'
    or organisations is null or pg_catalog.jsonb_typeof(organisations) <> 'array'
  then
    perform private.indexer_fail('ROW_INVALID', 'upserts and organisations must be lists');
  end if;
  if (select pg_catalog.count(*) <> pg_catalog.count(distinct (x ->> 'table') || ':' || (x -> 'row' ->> 'address'))
      from pg_catalog.jsonb_array_elements(upserts) as x) then
    perform private.indexer_fail('ROW_INVALID', 'a projection row is repeated');
  end if;

  for item in select * from pg_catalog.jsonb_array_elements(upserts) loop
    tbl := private.indexer_check_upsert(item, stream);
    row_address := item -> 'row' ->> 'address';
    execute pg_catalog.format('select pg_catalog.count(*) from public.%I where network = $1 and address = $2', tbl)
      into present using cp.network, row_address;
    if present = 0 then
      perform private.indexer_fail('EVENT_GAP', pg_catalog.format('no %s row for %s', tbl, row_address));
    end if;
    perform private.indexer_upsert(tbl, item -> 'row', 'reconcile');
  end loop;

  for item in select * from pg_catalog.jsonb_array_elements(organisations) loop
    if pg_catalog.jsonb_typeof(item) <> 'object'
      or (select pg_catalog.array_agg(k order by k collate "C") from pg_catalog.jsonb_object_keys(item) as k)
        is distinct from array['address', 'slug', 'synthetic']
      or pg_catalog.jsonb_typeof(item -> 'address') <> 'string'
      or pg_catalog.jsonb_typeof(item -> 'slug') not in ('string', 'null')
      or pg_catalog.jsonb_typeof(item -> 'synthetic') not in ('boolean', 'null')
    then
      perform private.indexer_fail('ROW_INVALID', 'an organisations entry must be {address, slug, synthetic}');
    end if;
  end loop;
  if (select pg_catalog.count(*) <> pg_catalog.count(distinct x ->> 'address')
      from pg_catalog.jsonb_array_elements(organisations) as x) then
    perform private.indexer_fail('ROW_INVALID', 'an organisation address is repeated');
  end if;
  for item in select * from pg_catalog.jsonb_array_elements(organisations) loop
    perform 1 from public.chain_organisations o
    where o.network = cp.network and o.protocol = cp.protocol and o.address = item ->> 'address';
    if not found then
      perform private.indexer_fail('EVENT_GAP', 'no organisation row for ' || (item ->> 'address'));
    end if;
    update public.chain_organisations set
      slug = item ->> 'slug', synthetic = (item ->> 'synthetic')::boolean, updated_at = pg_catalog.now()
    where network = cp.network and protocol = cp.protocol and address = item ->> 'address';
  end loop;
exception when others then
  get stacked diagnostics failed_constraint = constraint_name;
  if sqlstate = 'P0001' then raise; end if;
  perform private.indexer_translate_error(sqlstate, sqlerrm, failed_constraint);
  raise;
end;
$$;

-- ---------------------------------------------------------------------------------------------
create function public.indexer_reset(stream jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  cp public.indexer_checkpoints;
  cleared jsonb;
begin
  perform private.indexer_check_stream(stream);
  select * into cp from public.indexer_checkpoints for update;
  if found and (cp.program_id <> stream ->> 'programId' or cp.protocol <> stream ->> 'protocol') then
    perform private.indexer_fail('STREAM_INVALID', 'the stream is not the stored one');
  end if;
  if not found or cp.status <> 'halted' then
    perform private.indexer_fail('INDEXER_TRANSITION', 'only a halted stream can be reset');
  end if;
  cleared := pg_catalog.jsonb_build_object('reason', cp.halt_reason, 'detail', cp.halt_detail,
    'signature', cp.halted_signature, 'haltedAt', cp.halted_at);

  delete from public.chain_positions where network = cp.network and protocol = cp.protocol;
  delete from public.chain_lots where network = cp.network and protocol = cp.protocol;
  delete from public.chain_intakes where network = cp.network and protocol = cp.protocol;
  delete from public.chain_documents where network = cp.network and protocol = cp.protocol;
  delete from public.chain_custodian_classes where network = cp.network and protocol = cp.protocol;
  delete from public.chain_authorities where network = cp.network and protocol = cp.protocol;
  delete from public.chain_organisations where network = cp.network and protocol = cp.protocol;
  delete from public.chain_class_policies where network = cp.network and protocol = cp.protocol;
  delete from public.chain_protocols where network = cp.network and protocol = cp.protocol;
  delete from public.chain_events where network = cp.network and program_id = cp.program_id;
  delete from public.chain_transactions where network = cp.network and program_id = cp.program_id;

  update public.indexer_checkpoints set
    status = 'backfilling', indexed_through_slot = null, last_poll_at = null, last_success_at = null,
    consecutive_rpc_errors = 0, halt_reason = null, halt_detail = null, halted_signature = null,
    halted_at = null, updated_at = pg_catalog.now()
  where network = cp.network and program_id = cp.program_id and protocol = cp.protocol;
  return cleared;
end;
$$;

revoke all on function public.indexer_checkpoint(jsonb, bigint, jsonb), public.indexer_apply(jsonb),
  public.indexer_halt(jsonb, bigint, public.indexer_halt_reason, text, text),
  public.indexer_finalize(jsonb, bigint, text[]), public.indexer_reconcile(jsonb, bigint, jsonb, jsonb),
  public.indexer_reset(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.indexer_checkpoint(jsonb, bigint, jsonb), public.indexer_apply(jsonb),
  public.indexer_halt(jsonb, bigint, public.indexer_halt_reason, text, text),
  public.indexer_finalize(jsonb, bigint, text[]), public.indexer_reconcile(jsonb, bigint, jsonb, jsonb),
  public.indexer_reset(jsonb) to service_role;
