-- Phase 2 of the chain read model (live-lending.md §3.1, §6.2): facilities, valuations, loans,
-- locks, payments, release intents, the simulation pool and its shares, the event keys the
-- program's lending streams carry, the write functions that carry them, and who reads them.
-- Rules for every value: as 20261126000100_chain_read_model.sql (canonical decimal text for u64
-- and i64, base58 addresses, lowercase hex bytes, enums by variant name). A currency is its three
-- capital letters.

-- ---------------------------------------------------------------------------------------------
-- Projection tables, one per account kind, with the common first columns.
-- ---------------------------------------------------------------------------------------------
create table public.chain_facilities (
  network text not null check (network = 'devnet'),
  address text not null check (private.is_address(address)),
  protocol text not null check (private.is_address(protocol)),
  slot bigint not null check (slot >= 0),
  commitment public.chain_commitment not null,
  last_signature text,
  updated_at timestamptz not null default pg_catalog.now(),
  created_at timestamptz not null default pg_catalog.now(),
  lender text not null check (private.is_address(lender)),
  lender_org_id uuid not null,
  borrower text not null check (private.is_address(borrower)),
  borrower_org_id uuid not null,
  facility_id_hex text not null check (facility_id_hex ~ '^[0-9a-f]{32}$'),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  currency_decimals bigint not null check (currency_decimals between 0 and 255),
  terms_version bigint not null check (terms_version between 0 and 4294967295),
  rate_bps bigint not null check (rate_bps between 0 and 65535),
  max_ltv_bps bigint not null check (max_ltv_bps between 0 and 65535),
  terms_digest_hex text not null check (terms_digest_hex ~ '^[0-9a-f]{64}$'),
  loan_count bigint not null check (loan_count between 0 and 4294967295),
  primary key (network, address)
);
create table public.chain_valuations (
  network text not null check (network = 'devnet'),
  address text not null check (private.is_address(address)),
  protocol text not null check (private.is_address(protocol)),
  slot bigint not null check (slot >= 0),
  commitment public.chain_commitment not null,
  last_signature text,
  updated_at timestamptz not null default pg_catalog.now(),
  created_at timestamptz not null default pg_catalog.now(),
  facility text not null check (private.is_address(facility)),
  class_policy text not null check (private.is_address(class_policy)),
  grade text not null,
  custodian_class text not null check (private.is_address(custodian_class)),
  value_per_kg text not null check (private.is_u64(value_per_kg)),
  haircut_bps bigint not null check (haircut_bps between 0 and 65535),
  valid_until text not null check (private.is_i64(valid_until)),
  source_digest_hex text not null check (source_digest_hex ~ '^[0-9a-f]{64}$'),
  version bigint not null check (version between 0 and 4294967295),
  set_at text not null check (private.is_i64(set_at)),
  event_version bigint not null check (event_version between 0 and 4294967295),
  primary key (network, address)
);
create table public.chain_loans (
  network text not null check (network = 'devnet'),
  address text not null check (private.is_address(address)),
  protocol text not null check (private.is_address(protocol)),
  slot bigint not null check (slot >= 0),
  commitment public.chain_commitment not null,
  last_signature text,
  updated_at timestamptz not null default pg_catalog.now(),
  created_at timestamptz not null default pg_catalog.now(),
  facility text not null check (private.is_address(facility)),
  lender_org_id uuid not null,
  borrower text not null check (private.is_address(borrower)),
  borrower_org_id uuid not null,
  lot text not null check (private.is_address(lot)),
  position text not null check (private.is_address(position)),
  loan_index bigint not null check (loan_index between 0 and 4294967295),
  status text not null check (status in ('Active', 'Recovery', 'ExternalHandoff', 'Closed')),
  rate_bps bigint not null check (rate_bps between 0 and 65535),
  terms_version bigint not null check (terms_version between 0 and 4294967295),
  principal text not null check (private.is_u64(principal)),
  booked_interest text not null check (private.is_u64(booked_interest)),
  accrual_remainder text not null check (private.is_u64(accrual_remainder)),
  accrued_at text not null check (private.is_i64(accrued_at)),
  open_exceptions bigint not null check (open_exceptions between 0 and 65535),
  revision text not null check (private.is_u64(revision)),
  event_revision text not null check (private.is_u64(event_revision)),
  primary key (network, address)
);
create table public.chain_locks (
  network text not null check (network = 'devnet'),
  address text not null check (private.is_address(address)),
  protocol text not null check (private.is_address(protocol)),
  slot bigint not null check (slot >= 0),
  commitment public.chain_commitment not null,
  last_signature text,
  updated_at timestamptz not null default pg_catalog.now(),
  created_at timestamptz not null default pg_catalog.now(),
  loan text not null check (private.is_address(loan)),
  position text not null check (private.is_address(position)),
  quantity_kg text not null check (private.is_u64(quantity_kg)),
  control text not null check (control in ('Pledged', 'Recovery')),
  primary key (network, address)
);
create table public.chain_payments (
  network text not null check (network = 'devnet'),
  address text not null check (private.is_address(address)),
  protocol text not null check (private.is_address(protocol)),
  slot bigint not null check (slot >= 0),
  commitment public.chain_commitment not null,
  last_signature text,
  updated_at timestamptz not null default pg_catalog.now(),
  created_at timestamptz not null default pg_catalog.now(),
  lender text not null check (private.is_address(lender)),
  lender_org_id uuid not null,
  loan text not null check (private.is_address(loan)),
  payment_id_hex text not null check (payment_id_hex ~ '^[0-9a-f]{64}$'),
  purpose text not null check (purpose in ('Repayment', 'Release', 'Correction')),
  subject text not null check (private.is_address(subject)),
  amount text not null check (private.is_u64(amount)),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  evidence_digest_hex text not null check (evidence_digest_hex ~ '^[0-9a-f]{64}$'),
  observed_at text not null check (private.is_i64(observed_at)),
  status text not null check (status in ('Unconsumed', 'Consumed', 'Voided')),
  applied text not null check (private.is_u64(applied)),
  surplus text not null check (private.is_u64(surplus)),
  primary key (network, address)
);
create table public.chain_release_intents (
  network text not null check (network = 'devnet'),
  address text not null check (private.is_address(address)),
  protocol text not null check (private.is_address(protocol)),
  slot bigint not null check (slot >= 0),
  commitment public.chain_commitment not null,
  last_signature text,
  updated_at timestamptz not null default pg_catalog.now(),
  created_at timestamptz not null default pg_catalog.now(),
  loan text not null check (private.is_address(loan)),
  lot text not null check (private.is_address(lot)),
  position text not null check (private.is_address(position)),
  seller text not null check (private.is_address(seller)),
  seller_org_id uuid not null,
  buyer text not null check (private.is_address(buyer)),
  buyer_org_id uuid not null,
  lender text not null check (private.is_address(lender)),
  lender_org_id uuid not null,
  currency_decimals bigint not null check (currency_decimals between 0 and 255),
  nonce text not null check (private.is_u64(nonce)),
  quantity_kg text not null check (private.is_u64(quantity_kg)),
  price text not null check (private.is_u64(price)),
  top_up text not null check (private.is_u64(top_up)),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  expires_at text not null check (private.is_i64(expires_at)),
  position_revision text not null check (private.is_u64(position_revision)),
  status text not null check (status in ('Open', 'Executed')),
  primary key (network, address)
);
create table public.chain_pools (
  network text not null check (network = 'devnet'),
  address text not null check (private.is_address(address)),
  protocol text not null check (private.is_address(protocol)),
  slot bigint not null check (slot >= 0),
  commitment public.chain_commitment not null,
  last_signature text,
  updated_at timestamptz not null default pg_catalog.now(),
  created_at timestamptz not null default pg_catalog.now(),
  mint text not null check (private.is_address(mint)),
  vault text not null check (private.is_address(vault)),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  currency_decimals bigint not null check (currency_decimals between 0 and 255),
  cash_minor text not null check (private.is_u64(cash_minor)),
  total_shares text not null check (private.is_u64(total_shares)),
  lent_minor text not null check (private.is_u64(lent_minor)),
  income_minor text not null check (private.is_u64(income_minor)),
  revision text not null check (private.is_u64(revision)),
  event_revision text not null check (private.is_u64(event_revision)),
  primary key (network, address)
);
create table public.chain_pool_shares (
  network text not null check (network = 'devnet'),
  address text not null check (private.is_address(address)),
  protocol text not null check (private.is_address(protocol)),
  slot bigint not null check (slot >= 0),
  commitment public.chain_commitment not null,
  last_signature text,
  updated_at timestamptz not null default pg_catalog.now(),
  created_at timestamptz not null default pg_catalog.now(),
  pool text not null check (private.is_address(pool)),
  organisation text not null check (private.is_address(organisation)),
  org_id uuid not null,
  shares text not null check (private.is_u64(shares)),
  lent_minor text not null check (private.is_u64(lent_minor)),
  primary key (network, address)
);

create index chain_valuations_facility on public.chain_valuations (facility);
create index chain_loans_lot on public.chain_loans (lot);
create index chain_loans_facility on public.chain_loans (facility);
create index chain_locks_loan on public.chain_locks (loan);
create index chain_locks_position on public.chain_locks (position);
create index chain_payments_loan on public.chain_payments (loan);
create index chain_payments_subject on public.chain_payments (subject);
create index chain_release_intents_lot on public.chain_release_intents (lot);
create index chain_release_intents_loan on public.chain_release_intents (loan);
create index chain_pool_shares_pool on public.chain_pool_shares (pool);

-- ---------------------------------------------------------------------------------------------
-- The event keys of the lending streams. An event on two streams is one row with both keys.
-- ---------------------------------------------------------------------------------------------
alter table public.chain_events
  add column facility text check (private.is_address(facility)),
  add column loan text check (private.is_address(loan)),
  add column loan_revision text check (private.is_u64(loan_revision)),
  add column pool text check (private.is_address(pool)),
  add column pool_revision text check (private.is_u64(pool_revision)),
  add column valuation text check (private.is_address(valuation)),
  add column valuation_version bigint check (valuation_version between 0 and 4294967295),
  add column created text check (private.is_address(created)),
  add constraint chain_events_facility_scope check ((scope = 'facility') = (facility is not null)),
  add constraint chain_events_pool_scope check (scope <> 'pool' or pool is not null),
  add constraint chain_events_loan_pair check (loan_revision is null or loan is not null),
  add constraint chain_events_pool_pair check (pool_revision is null or pool is not null),
  add constraint chain_events_valuation_pair check ((valuation is null) = (valuation_version is null));
-- Phase 1's anonymous `(scope = 'organisation') = (org_id is not null)` check widens: an
-- organisation-scoped event has org_id, a pool-scoped event has it exactly when it names a
-- depositor (Deposited, Withdrawn), and any other event has none. A depositor event without its
-- organisation is refused, so it can never fall back to the every-member pool arm (live-lending.md,
-- T063c fold 12).
alter table public.chain_events drop constraint chain_events_check2;
alter table public.chain_events add constraint chain_events_org_scope check (
  case when scope = 'organisation' then org_id is not null
       when scope = 'pool' then (org_id is not null) = (event in ('Deposited', 'Withdrawn'))
       else org_id is null end);
create unique index chain_events_loan_revision
  on public.chain_events (network, program_id, loan, loan_revision) where loan_revision is not null;
create unique index chain_events_pool_revision
  on public.chain_events (network, program_id, pool, pool_revision) where pool_revision is not null;
create unique index chain_events_valuation_version
  on public.chain_events (network, program_id, valuation, valuation_version) where valuation is not null;
create unique index chain_events_created
  on public.chain_events (network, program_id, created) where created is not null;
create index chain_events_loan on public.chain_events (loan, slot);
create index chain_events_facility on public.chain_events (facility, slot);

-- ---------------------------------------------------------------------------------------------
-- The write helpers know the eight tables.
-- ---------------------------------------------------------------------------------------------
create or replace function private.indexer_projection_table(name text)
returns boolean
language sql immutable set search_path = ''
as $$
  select name in ('chain_protocols', 'chain_class_policies', 'chain_organisations', 'chain_authorities',
    'chain_custodian_classes', 'chain_documents', 'chain_intakes', 'chain_lots', 'chain_positions',
    'chain_facilities', 'chain_valuations', 'chain_loans', 'chain_locks', 'chain_payments',
    'chain_release_intents', 'chain_pools', 'chain_pool_shares')
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
      'valid_until', 'revoked_at']
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
  end
$$;

-- The columns that come from events or from Supabase rather than from the account read.
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

-- indexer_apply as 20261126000200's, with the lending keys checked and written beside the lot's.
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
      pool_revision, valuation, valuation_version, created)
    select r.network, r.program_id, r.signature, r.event_index, r.slot, r.block_time, r.protocol,
      r.instruction, r.event, r.scope, r.lot, r.lot_revision, r.org_id, r.data, r.facility, r.loan,
      r.loan_revision, r.pool, r.pool_revision, r.valuation, r.valuation_version, r.created
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

-- indexer_reset as before, deleting the eight lending tables' rows of the stream first.
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
alter table public.chain_facilities enable row level security;
alter table public.chain_valuations enable row level security;
alter table public.chain_loans enable row level security;
alter table public.chain_locks enable row level security;
alter table public.chain_payments enable row level security;
alter table public.chain_release_intents enable row level security;
alter table public.chain_pools enable row level security;
alter table public.chain_pool_shares enable row level security;

revoke all on table public.chain_facilities, public.chain_valuations, public.chain_loans,
  public.chain_locks, public.chain_payments, public.chain_release_intents, public.chain_pools,
  public.chain_pool_shares from public, anon, authenticated, service_role;
grant select on table public.chain_facilities, public.chain_valuations, public.chain_loans,
  public.chain_locks, public.chain_payments, public.chain_release_intents, public.chain_pools,
  public.chain_pool_shares to service_role, authenticated;

-- A facility is read by its lender and its borrower; a loan by whoever reads its facility.
create function private.can_read_facility(facility_address text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.chain_facilities f where f.address = facility_address
    and (private.is_member(f.lender_org_id) or private.is_member(f.borrower_org_id)));
$$;
create function private.can_read_loan(loan_address text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.chain_loans l where l.address = loan_address
    and private.can_read_facility(l.facility));
$$;
-- Replaces 20261126000100's: the custodian, every holder past or present, any lender with any
-- facility (with or without a loan) to a current or former holder of a position on the lot (a
-- loan's borrower is always its position's owner, so this includes every lender with a loan on
-- the lot), and the buyer of any release intent on the lot.
create or replace function private.can_read_lot(lot_address text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.chain_lots l
    where l.address = lot_address
      and (private.is_member(l.custodian_org_id)
        or exists (select 1 from public.chain_positions p
                   where p.lot = l.address and private.is_member(p.owner_org_id))
        or exists (select 1 from public.chain_positions p
                   join public.chain_facilities f on f.borrower = p.owner and f.network = p.network
                     and f.protocol = p.protocol
                   where p.lot = l.address and private.is_member(f.lender_org_id))
        or exists (select 1 from public.chain_release_intents i
                   where i.lot = l.address and private.is_member(i.buyer_org_id))));
$$;

revoke all on function private.can_read_facility(text), private.can_read_loan(text)
  from public, anon, authenticated, service_role;
grant execute on function private.can_read_facility(text), private.can_read_loan(text) to authenticated;

create policy chain_facilities_select on public.chain_facilities
  for select to authenticated using (private.can_read_facility(address));
create policy chain_valuations_select on public.chain_valuations
  for select to authenticated using (private.can_read_facility(facility));
create policy chain_loans_select on public.chain_loans
  for select to authenticated using (private.can_read_facility(facility));
create policy chain_locks_select on public.chain_locks
  for select to authenticated using (private.can_read_loan(loan));
create policy chain_payments_select on public.chain_payments
  for select to authenticated using (
    private.can_read_loan(loan)
    or (purpose = 'Release' and exists (
      select 1 from public.chain_release_intents i
      where i.address = subject and private.is_member(i.buyer_org_id))));
create policy chain_release_intents_select on public.chain_release_intents
  for select to authenticated using (private.can_read_loan(loan) or private.is_member(buyer_org_id));
create policy chain_pools_member_select on public.chain_pools
  for select to authenticated using (private.has_membership());
create policy chain_pool_shares_select on public.chain_pool_shares
  for select to authenticated using (private.is_member(org_id));

-- PledgedSold is lot-scoped, so every lot reader reads its loan figures in chain_events.data
-- (public on devnet); the lending tables stay facility-scoped. A pool event naming a depositor
-- (Deposited, Withdrawn: org_id set) is read by that organisation's members only, as its
-- chain_pool_shares row; PoolOpened (org_id null) by every member, as chain_pools.
drop policy chain_events_select on public.chain_events;
create policy chain_events_select on public.chain_events
  for select to authenticated using (
    (scope = 'lot' and private.can_read_lot(lot))
    or (scope = 'organisation' and private.is_member(org_id))
    or (scope = 'registry' and private.has_membership())
    or (scope = 'facility' and private.can_read_facility(facility))
    or (scope = 'pool' and org_id is null and private.has_membership())
    or (scope = 'pool' and org_id is not null and private.is_member(org_id)));
