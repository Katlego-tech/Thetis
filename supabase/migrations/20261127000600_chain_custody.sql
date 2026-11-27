-- Phase 3 of the chain read model, part two (live-custody.md §3.1, §6.2): shipments and their
-- manifest batches, the lot, restriction and document variants the custody instructions write, the
-- event keys of the custody streams, the write functions that carry them, and who reads them.
-- Rules for every value: as 20261126000100_chain_read_model.sql (canonical decimal text for u64
-- and i64, base58 addresses, lowercase hex bytes, enums by variant name).

-- ---------------------------------------------------------------------------------------------
-- The CHECKs widen to exactly the program's variants.
-- ---------------------------------------------------------------------------------------------
alter table public.chain_documents drop constraint chain_documents_kind_check;
alter table public.chain_documents add constraint chain_documents_kind_check
  check (kind in ('Origin', 'Departure'));
alter table public.chain_lots drop constraint chain_lots_state_check;
alter table public.chain_lots add constraint chain_lots_state_check
  check (state in ('Stored', 'Redeemed', 'Prepared', 'InTransit', 'Loaded'));
alter table public.chain_lots drop constraint chain_lots_restriction_check;
alter table public.chain_lots add constraint chain_lots_restriction_check
  check (restriction in ('Normal', 'ReviewRequired', 'Disputed', 'Frozen'));

-- ---------------------------------------------------------------------------------------------
-- Columns on existing tables. A Departure document's subject is its lot's address bytes; the
-- worker writes that address beside them. No Departure row can exist before this migration (the
-- old CHECK refused one), so the new constraint holds on every existing row. A release intent
-- carries the shipment that cancelled it while it was effectively open, else null.
-- ---------------------------------------------------------------------------------------------
alter table public.chain_documents
  add column subject_address text check (private.is_address(subject_address)),
  add constraint chain_documents_subject_address
    check ((kind = 'Departure') = (subject_address is not null));
alter table public.chain_release_intents
  add column cancelled_by text check (private.is_address(cancelled_by));

-- ---------------------------------------------------------------------------------------------
-- Projection tables, one per account kind, with the common first columns.
-- ---------------------------------------------------------------------------------------------
create table public.chain_shipments (
  network text not null check (network = 'devnet'),
  address text not null check (private.is_address(address)),
  protocol text not null check (private.is_address(protocol)),
  slot bigint not null check (slot >= 0),
  commitment public.chain_commitment not null,
  last_signature text,
  updated_at timestamptz not null default pg_catalog.now(),
  created_at timestamptz not null default pg_catalog.now(),
  shipment_id_hex text not null check (shipment_id_hex ~ '^[0-9a-f]{32}$'),
  lot text not null check (private.is_address(lot)),
  position text not null check (private.is_address(position)),
  owner text not null check (private.is_address(owner)),
  owner_org_id uuid not null,
  source text not null check (private.is_address(source)),
  source_custodian text not null check (private.is_address(source_custodian)),
  source_custodian_org_id uuid not null,
  destination text not null check (private.is_address(destination)),
  destination_custodian text not null check (private.is_address(destination_custodian)),
  destination_custodian_org_id uuid not null,
  committed_kg text not null check (private.is_u64(committed_kg)),
  locked_kg text not null check (private.is_u64(locked_kg)),
  batch_count bigint not null check (batch_count between 0 and 255),
  manifest_root_hex text not null check (manifest_root_hex ~ '^[0-9a-f]{64}$'),
  departure_document text not null check (private.is_address(departure_document)),
  registered_count bigint not null check (registered_count between 0 and 255),
  registered_kg text not null check (private.is_u64(registered_kg)),
  departed_count bigint not null check (departed_count between 0 and 255),
  departed_kg text not null check (private.is_u64(departed_kg)),
  arrived_count bigint not null check (arrived_count between 0 and 255),
  arrived_kg text not null check (private.is_u64(arrived_kg)),
  status text not null check (status in ('Prepared', 'InTransit', 'Arrived', 'Cancelled')),
  prepared_at text not null check (private.is_i64(prepared_at)),
  revision text not null check (private.is_u64(revision)),
  event_revision text not null check (private.is_u64(event_revision)),
  event_registered bigint not null check (event_registered between 0 and 255),
  primary key (network, address)
);
create table public.chain_batches (
  network text not null check (network = 'devnet'),
  address text not null check (private.is_address(address)),
  protocol text not null check (private.is_address(protocol)),
  slot bigint not null check (slot >= 0),
  commitment public.chain_commitment not null,
  last_signature text,
  updated_at timestamptz not null default pg_catalog.now(),
  created_at timestamptz not null default pg_catalog.now(),
  shipment text not null check (private.is_address(shipment)),
  lot text not null check (private.is_address(lot)),
  batch_index bigint not null check (batch_index between 0 and 255),
  batch_count bigint not null check (batch_count between 0 and 255),
  quantity_kg text not null check (private.is_u64(quantity_kg)),
  carrier text not null check (private.is_address(carrier)),
  load_digest_hex text not null check (load_digest_hex ~ '^[0-9a-f]{64}$'),
  manifest_digest_hex text not null check (manifest_digest_hex ~ '^[0-9a-f]{64}$'),
  holder text not null check (private.is_address(holder)),
  holder_org_id uuid not null,
  stage text not null check (stage in ('AtSource', 'InTransit', 'Arrived')),
  sequence text not null check (private.is_u64(sequence)),
  observation_count bigint not null check (observation_count between 0 and 4294967295),
  departed_at text check (private.is_i64(departed_at)),
  arrived_at text check (private.is_i64(arrived_at)),
  event_sequence text not null check (private.is_u64(event_sequence)),
  event_observations bigint not null check (event_observations between 0 and 4294967295),
  primary key (network, address)
);

create index chain_shipments_lot on public.chain_shipments (lot);
create index chain_shipments_departure_document on public.chain_shipments (departure_document);
create index chain_batches_shipment on public.chain_batches (shipment);
create index chain_batches_carrier on public.chain_batches (carrier);
create index chain_release_intents_position on public.chain_release_intents (position);

-- ---------------------------------------------------------------------------------------------
-- The event keys of the custody streams, all seven now, so no later custody migration changes the
-- event row's shape.
-- ---------------------------------------------------------------------------------------------
alter table public.chain_events
  add column shipment text check (private.is_address(shipment)),
  add column shipment_revision text check (private.is_u64(shipment_revision)),
  add column batch text check (private.is_address(batch)),
  add column batch_sequence text check (private.is_u64(batch_sequence)),
  add column observation_index bigint check (observation_index between 0 and 4294967295),
  add column acceptance text check (private.is_address(acceptance)),
  add column acceptance_version bigint check (acceptance_version between 0 and 4294967295),
  add constraint chain_events_shipment_scope check (scope <> 'shipment' or shipment is not null),
  add constraint chain_events_shipment_pair check (shipment_revision is null or shipment is not null),
  add constraint chain_events_batch_pair
    check ((batch_sequence is null and observation_index is null) or batch is not null),
  add constraint chain_events_batch_one_key check (batch_sequence is null or observation_index is null),
  add constraint chain_events_acceptance_pair check ((acceptance is null) = (acceptance_version is null)),
  add constraint chain_events_custody_created
    check (scope not in ('loading', 'incident') or created is not null);
create unique index chain_events_shipment_revision
  on public.chain_events (network, program_id, shipment, shipment_revision) where shipment_revision is not null;
create unique index chain_events_batch_sequence
  on public.chain_events (network, program_id, batch, batch_sequence) where batch_sequence is not null;
create unique index chain_events_observation_index
  on public.chain_events (network, program_id, batch, observation_index) where observation_index is not null;
create unique index chain_events_acceptance_version
  on public.chain_events (network, program_id, acceptance, acceptance_version) where acceptance is not null;
create index chain_events_shipment on public.chain_events (shipment, slot);

-- ---------------------------------------------------------------------------------------------
-- The write helpers know the two tables and the new columns.
-- ---------------------------------------------------------------------------------------------
create or replace function private.indexer_projection_table(name text)
returns boolean
language sql immutable set search_path = ''
as $$
  select name in ('chain_protocols', 'chain_class_policies', 'chain_organisations', 'chain_authorities',
    'chain_custodian_classes', 'chain_documents', 'chain_intakes', 'chain_lots', 'chain_positions',
    'chain_facilities', 'chain_valuations', 'chain_loans', 'chain_locks', 'chain_payments',
    'chain_release_intents', 'chain_pools', 'chain_pool_shares', 'chain_shipments', 'chain_batches')
$$;

-- The columns read from the account itself, by table.
create or replace function private.indexer_account_columns(name text)
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
      'valid_until', 'revoked_at', 'subject_address']
    when 'chain_intakes' then array['custodian', 'custodian_org_id', 'intake_digest_hex', 'lot', 'retired']
    when 'chain_lots' then array['lot_id', 'class_policy', 'class_version', 'grade', 'custodian_class',
      'custodian', 'custodian_org_id', 'intake', 'parent', 'root', 'mint', 'supply_kg', 'state', 'restriction',
      'expires_at', 'revision', 'live_children']
    when 'chain_positions' then array['lot', 'owner', 'owner_org_id', 'quantity_kg', 'locked_kg', 'reserved_kg',
      'revision']
    when 'chain_facilities' then array['lender', 'lender_org_id', 'borrower', 'borrower_org_id', 'facility_id_hex', 'currency',
      'currency_decimals', 'terms_version', 'rate_bps', 'max_ltv_bps', 'terms_digest_hex',
      'loan_count']
    when 'chain_valuations' then array['facility', 'class_policy', 'grade', 'custodian_class', 'value_per_kg', 'haircut_bps',
      'valid_until', 'source_digest_hex', 'version', 'set_at']
    when 'chain_loans' then array['facility', 'lender_org_id', 'borrower', 'borrower_org_id', 'lot', 'position', 'loan_index',
      'status', 'rate_bps', 'terms_version', 'principal', 'booked_interest', 'accrual_remainder',
      'accrued_at', 'open_exceptions', 'revision']
    when 'chain_locks' then array['loan', 'position', 'quantity_kg', 'control']
    when 'chain_payments' then array['lender', 'lender_org_id', 'loan', 'payment_id_hex', 'purpose', 'subject', 'amount',
      'currency', 'evidence_digest_hex', 'observed_at', 'status', 'applied', 'surplus']
    when 'chain_release_intents' then array['loan', 'lot', 'position', 'seller', 'seller_org_id', 'buyer', 'buyer_org_id', 'lender',
      'lender_org_id', 'currency_decimals', 'nonce', 'quantity_kg', 'price', 'top_up', 'currency',
      'expires_at', 'position_revision', 'status']
    when 'chain_pools' then array['mint', 'vault', 'currency', 'currency_decimals', 'cash_minor', 'total_shares', 'lent_minor',
      'income_minor', 'revision']
    when 'chain_pool_shares' then array['pool', 'organisation', 'org_id', 'shares', 'lent_minor']
    when 'chain_shipments' then array['shipment_id_hex', 'lot', 'position', 'owner', 'owner_org_id', 'source',
      'source_custodian', 'source_custodian_org_id', 'destination', 'destination_custodian',
      'destination_custodian_org_id', 'committed_kg', 'locked_kg', 'batch_count', 'manifest_root_hex',
      'departure_document', 'registered_count', 'registered_kg', 'departed_count', 'departed_kg',
      'arrived_count', 'arrived_kg', 'status', 'prepared_at', 'revision']
    when 'chain_batches' then array['shipment', 'lot', 'batch_index', 'batch_count', 'quantity_kg', 'carrier',
      'load_digest_hex', 'manifest_digest_hex', 'holder', 'holder_org_id', 'stage', 'sequence',
      'observation_count', 'departed_at', 'arrived_at']
  end
$$;

-- The columns that come from events or from Supabase rather than from the account read. A
-- release intent's cancelled_by is a mark the worker sets from a ShipmentPrepared.
create or replace function private.indexer_extra_columns(name text)
returns text[]
language sql immutable set search_path = ''
as $$
  select case name
    when 'chain_organisations' then array['slug', 'synthetic']
    when 'chain_lots' then array['event_revision', 'issued_owner', 'issued_owner_org_id', 'issued_at']
    when 'chain_loans' then array['event_revision']
    when 'chain_pools' then array['event_revision']
    when 'chain_valuations' then array['event_version']
    when 'chain_shipments' then array['event_revision', 'event_registered']
    when 'chain_batches' then array['event_sequence', 'event_observations']
    when 'chain_release_intents' then array['cancelled_by']
    else array[]::text[]
  end
$$;

create or replace function private.indexer_translate_error(state text, message text, constraint_name text)
returns void
language plpgsql set search_path = ''
as $$
begin
  if state = '23505' then
    case constraint_name
      when 'chain_events_lot_revision' then
        perform private.indexer_fail('REVISION_SEQUENCE', 'a lot revision is already stored under another signature');
      when 'chain_events_loan_revision' then
        perform private.indexer_fail('REVISION_SEQUENCE', 'a loan revision is already stored under another signature');
      when 'chain_events_pool_revision' then
        perform private.indexer_fail('REVISION_SEQUENCE', 'a pool revision is already stored under another signature');
      when 'chain_events_valuation_version' then
        perform private.indexer_fail('REVISION_SEQUENCE',
          'a valuation version is already stored under another signature');
      when 'chain_events_shipment_revision' then
        perform private.indexer_fail('REVISION_SEQUENCE',
          'a shipment revision is already stored under another signature');
      when 'chain_events_batch_sequence' then
        perform private.indexer_fail('REVISION_SEQUENCE',
          'a batch sequence is already stored under another signature');
      when 'chain_events_observation_index' then
        perform private.indexer_fail('REVISION_SEQUENCE',
          'an observation index is already stored under another signature');
      when 'chain_events_acceptance_version' then
        perform private.indexer_fail('REVISION_SEQUENCE',
          'an acceptance version is already stored under another signature');
      when 'chain_events_created' then
        perform private.indexer_fail('REVISION_SEQUENCE',
          'a created account is already stored under another signature');
      else
        null;
    end case;
  end if;
  if state like '22%' or state in ('23502', '23503', '23505', '23514') then
    perform private.indexer_fail('ROW_INVALID', message);
  end if;
end;
$$;

-- indexer_apply as 20261127000200's, with the custody keys checked and written beside the others.
create or replace function public.indexer_apply(batch jsonb)
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
        is distinct from array['block_time', 'event_count', 'network', 'other_instance', 'program_id', 'protocol',
          'signature', 'slot', 'succeeded']
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

  insert into public.chain_transactions (network, program_id, signature, slot, block_time, succeeded, protocol,
    event_count, other_instance)
  select r.network, r.program_id, r.signature, r.slot, r.block_time, r.succeeded, r.protocol, r.event_count,
    r.other_instance
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
    if item ->> 'loan_revision' is not null then
      select e.signature into other_signature from public.chain_events e
      where e.network = cp.network and e.program_id = cp.program_id
        and e.loan = item ->> 'loan' and e.loan_revision = item ->> 'loan_revision'
      limit 1;
      if found then
        perform private.indexer_fail('REVISION_SEQUENCE', pg_catalog.format(
          'loan %s revision %s is stored under %s, batch has %s',
          item ->> 'loan', item ->> 'loan_revision', other_signature, item ->> 'signature'));
      end if;
    end if;
    if item ->> 'pool_revision' is not null then
      select e.signature into other_signature from public.chain_events e
      where e.network = cp.network and e.program_id = cp.program_id
        and e.pool = item ->> 'pool' and e.pool_revision = item ->> 'pool_revision'
      limit 1;
      if found then
        perform private.indexer_fail('REVISION_SEQUENCE', pg_catalog.format(
          'pool %s revision %s is stored under %s, batch has %s',
          item ->> 'pool', item ->> 'pool_revision', other_signature, item ->> 'signature'));
      end if;
    end if;
    if item ->> 'valuation' is not null then
      select e.signature into other_signature from public.chain_events e
      where e.network = cp.network and e.program_id = cp.program_id
        and e.valuation = item ->> 'valuation'
        and e.valuation_version = (item ->> 'valuation_version')::bigint
      limit 1;
      if found then
        perform private.indexer_fail('REVISION_SEQUENCE', pg_catalog.format(
          'valuation %s version %s is stored under %s, batch has %s',
          item ->> 'valuation', item ->> 'valuation_version', other_signature, item ->> 'signature'));
      end if;
    end if;
    if item ->> 'shipment_revision' is not null then
      select e.signature into other_signature from public.chain_events e
      where e.network = cp.network and e.program_id = cp.program_id
        and e.shipment = item ->> 'shipment' and e.shipment_revision = item ->> 'shipment_revision'
      limit 1;
      if found then
        perform private.indexer_fail('REVISION_SEQUENCE', pg_catalog.format(
          'shipment %s revision %s is stored under %s, batch has %s',
          item ->> 'shipment', item ->> 'shipment_revision', other_signature, item ->> 'signature'));
      end if;
    end if;
    if item ->> 'batch_sequence' is not null then
      select e.signature into other_signature from public.chain_events e
      where e.network = cp.network and e.program_id = cp.program_id
        and e.batch = item ->> 'batch' and e.batch_sequence = item ->> 'batch_sequence'
      limit 1;
      if found then
        perform private.indexer_fail('REVISION_SEQUENCE', pg_catalog.format(
          'batch %s sequence %s is stored under %s, batch has %s',
          item ->> 'batch', item ->> 'batch_sequence', other_signature, item ->> 'signature'));
      end if;
    end if;
    if item ->> 'observation_index' is not null then
      select e.signature into other_signature from public.chain_events e
      where e.network = cp.network and e.program_id = cp.program_id
        and e.batch = item ->> 'batch'
        and e.observation_index = (item ->> 'observation_index')::bigint
      limit 1;
      if found then
        perform private.indexer_fail('REVISION_SEQUENCE', pg_catalog.format(
          'batch %s observation %s is stored under %s, batch has %s',
          item ->> 'batch', item ->> 'observation_index', other_signature, item ->> 'signature'));
      end if;
    end if;
    if item ->> 'acceptance' is not null then
      select e.signature into other_signature from public.chain_events e
      where e.network = cp.network and e.program_id = cp.program_id
        and e.acceptance = item ->> 'acceptance'
        and e.acceptance_version = (item ->> 'acceptance_version')::bigint
      limit 1;
      if found then
        perform private.indexer_fail('REVISION_SEQUENCE', pg_catalog.format(
          'acceptance %s version %s is stored under %s, batch has %s',
          item ->> 'acceptance', item ->> 'acceptance_version', other_signature, item ->> 'signature'));
      end if;
    end if;
    if item ->> 'created' is not null then
      select e.signature into other_signature from public.chain_events e
      where e.network = cp.network and e.program_id = cp.program_id
        and e.created = item ->> 'created'
      limit 1;
      if found then
        perform private.indexer_fail('REVISION_SEQUENCE', pg_catalog.format(
          'created account %s is stored under %s, batch has %s',
          item ->> 'created', other_signature, item ->> 'signature'));
      end if;
    end if;
    insert into public.chain_events (network, program_id, signature, event_index, slot, block_time, protocol,
      instruction, event, scope, lot, lot_revision, org_id, data, facility, loan, loan_revision, pool,
      pool_revision, valuation, valuation_version, created, shipment, shipment_revision, batch, batch_sequence,
      observation_index, acceptance, acceptance_version)
    select r.network, r.program_id, r.signature, r.event_index, r.slot, r.block_time, r.protocol,
      r.instruction, r.event, r.scope, r.lot, r.lot_revision, r.org_id, r.data, r.facility, r.loan,
      r.loan_revision, r.pool, r.pool_revision, r.valuation, r.valuation_version, r.created, r.shipment,
      r.shipment_revision, r.batch, r.batch_sequence, r.observation_index, r.acceptance, r.acceptance_version
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

revoke all on function public.indexer_apply(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.indexer_apply(jsonb) to service_role;

-- indexer_reset as before, deleting the two custody tables' rows of the stream first.
create or replace function public.indexer_reset(stream jsonb)
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

  delete from public.chain_batches where network = cp.network and protocol = cp.protocol;
  delete from public.chain_shipments where network = cp.network and protocol = cp.protocol;
  delete from public.chain_pool_shares where network = cp.network and protocol = cp.protocol;
  delete from public.chain_pools where network = cp.network and protocol = cp.protocol;
  delete from public.chain_payments where network = cp.network and protocol = cp.protocol;
  delete from public.chain_release_intents where network = cp.network and protocol = cp.protocol;
  delete from public.chain_locks where network = cp.network and protocol = cp.protocol;
  delete from public.chain_loans where network = cp.network and protocol = cp.protocol;
  delete from public.chain_valuations where network = cp.network and protocol = cp.protocol;
  delete from public.chain_facilities where network = cp.network and protocol = cp.protocol;
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

revoke all on function public.indexer_reset(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.indexer_reset(jsonb) to service_role;

-- ---------------------------------------------------------------------------------------------
-- Access: row-level security, nothing for anon, writes only through the functions.
-- ---------------------------------------------------------------------------------------------
alter table public.chain_shipments enable row level security;
alter table public.chain_batches enable row level security;
revoke all on table public.chain_shipments, public.chain_batches
  from public, anon, authenticated, service_role;
grant select on table public.chain_shipments, public.chain_batches to service_role, authenticated;

-- A shipment is read by whoever reads its lot (custodian, every holder, the lot's lenders, release
-- buyers), its owner, both custodians, and the carrier or current holder of any of its batches.
create function private.can_read_shipment(shipment_address text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.chain_shipments s
    where s.address = shipment_address
      and (private.is_member(s.owner_org_id)
        or private.is_member(s.source_custodian_org_id)
        or private.is_member(s.destination_custodian_org_id)
        or private.can_read_lot(s.lot)
        or exists (select 1 from public.chain_batches b
                   where b.shipment = s.address
                     and (private.is_member(b.holder_org_id)
                       or exists (select 1 from public.chain_organisations o
                                  where o.network = b.network and o.protocol = b.protocol
                                    and o.address = b.carrier and private.is_member(o.org_id))))));
$$;
revoke all on function private.can_read_shipment(text) from public, anon, authenticated, service_role;
grant execute on function private.can_read_shipment(text) to authenticated;

create policy chain_shipments_select on public.chain_shipments
  for select to authenticated using (private.can_read_shipment(address));
create policy chain_batches_select on public.chain_batches
  for select to authenticated using (private.can_read_shipment(shipment));

-- A second, permissive policy: a Departure document is read by its lot's readers and by the
-- readers of a shipment it is bound to. The Origin policy of 20261126000100 is unchanged.
create policy chain_documents_departure_select on public.chain_documents
  for select to authenticated using (
    kind = 'Departure'
    and (private.can_read_lot(subject_address)
      or exists (select 1 from public.chain_shipments s
                 where s.network = chain_documents.network
                   and s.departure_document = chain_documents.address
                   and private.can_read_shipment(s.address))));

-- A second, permissive policy on chain_events, owned by the custody migrations. An event that
-- describes a shipment (lot-scoped ShipmentPrepared and ShipmentCancelled, shipment-scoped
-- registrations) is read by the shipment's readers. chain_events_select is not touched.
create policy chain_events_custody_select on public.chain_events
  for select to authenticated using (shipment is not null and private.can_read_shipment(shipment));
