-- Phase 3, the loading part, of the chain read model (live-custody.md §6.6 and its T063d.4 pre-check
-- folds): the LoadingIntent and HandoffAcceptance tables, the write helpers that know them, who reads
-- a loading intent, and the loading arm of the custody events policy. Nothing else changes.

-- ---------------------------------------------------------------------------------------------
-- chain_loading_intents: one row per LoadingIntent, read from the account (indexer.md §6.2 common
-- columns). cancelled_by is the indexer's mark (live-custody.md §4.1.7), never read from the account.
-- chain_handoff_acceptances: one row per HandoffAcceptance; event_version comes from LoadingAccepted.
-- ---------------------------------------------------------------------------------------------
create table public.chain_loading_intents (
  network text not null check (network = 'devnet'),
  address text not null check (private.is_address(address)),
  protocol text not null check (private.is_address(protocol)),
  slot bigint not null check (slot >= 0),
  commitment public.chain_commitment not null,
  last_signature text,
  updated_at timestamptz not null default pg_catalog.now(),
  created_at timestamptz not null default pg_catalog.now(),
  lot text not null check (private.is_address(lot)),
  position text not null check (private.is_address(position)),
  owner text not null check (private.is_address(owner)),
  owner_org_id uuid not null,
  terminal text not null check (private.is_address(terminal)),
  terminal_org_id uuid not null,
  custodian_class text not null check (private.is_address(custodian_class)),
  nonce text not null check (private.is_u64(nonce)),
  quantity_kg text not null check (private.is_u64(quantity_kg)),
  locked_kg text not null check (private.is_u64(locked_kg)),
  document_sha256_hex text not null check (document_sha256_hex ~ '^[0-9a-f]{64}$'),
  position_revision text not null check (private.is_u64(position_revision)),
  expires_at text not null check (private.is_i64(expires_at)),
  status text not null check (status in ('Open', 'Executed')),
  executed_at text check (private.is_i64(executed_at)),
  cancelled_by text check (private.is_address(cancelled_by)),
  primary key (network, address)
);
create table public.chain_handoff_acceptances (
  network text not null check (network = 'devnet'),
  address text not null check (private.is_address(address)),
  protocol text not null check (private.is_address(protocol)),
  slot bigint not null check (slot >= 0),
  commitment public.chain_commitment not null,
  last_signature text,
  updated_at timestamptz not null default pg_catalog.now(),
  created_at timestamptz not null default pg_catalog.now(),
  intent text not null check (private.is_address(intent)),
  loan text not null check (private.is_address(loan)),
  lock text not null check (private.is_address(lock)),
  lender text not null check (private.is_address(lender)),
  lender_org_id uuid not null,
  lock_quantity_kg text not null check (private.is_u64(lock_quantity_kg)),
  loan_revision text not null check (private.is_u64(loan_revision)),
  principal text not null check (private.is_u64(principal)),
  booked_interest text not null check (private.is_u64(booked_interest)),
  accepted_at text not null check (private.is_i64(accepted_at)),
  version bigint not null check (version between 0 and 4294967295),
  event_version bigint not null check (event_version between 0 and 4294967295),
  primary key (network, address)
);
create index chain_loading_intents_lot on public.chain_loading_intents (lot);
create index chain_loading_intents_position on public.chain_loading_intents (position);
create index chain_handoff_acceptances_intent on public.chain_handoff_acceptances (intent);
create index chain_handoff_acceptances_loan on public.chain_handoff_acceptances (loan);

-- ---------------------------------------------------------------------------------------------
-- The write helpers know the tables; cancelled_by and event_version are extra columns.
-- ---------------------------------------------------------------------------------------------
create or replace function private.indexer_projection_table(name text)
returns boolean
language sql immutable set search_path = ''
as $$
  select name in ('chain_protocols', 'chain_class_policies', 'chain_organisations', 'chain_authorities',
    'chain_custodian_classes', 'chain_documents', 'chain_intakes', 'chain_lots', 'chain_positions',
    'chain_facilities', 'chain_valuations', 'chain_loans', 'chain_locks', 'chain_payments',
    'chain_release_intents', 'chain_pools', 'chain_pool_shares', 'chain_shipments', 'chain_batches',
    'chain_handovers', 'chain_loading_intents', 'chain_handoff_acceptances')
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
    when 'chain_handovers' then array['shipment', 'batch', 'sequence', 'from_organisation', 'from_org_id',
      'to_organisation', 'to_org_id', 'from_wallet', 'to_wallet', 'stage', 'quantity_kg',
      'manifest_digest_hex', 'at']
    when 'chain_loading_intents' then array['lot', 'position', 'owner', 'owner_org_id', 'terminal',
      'terminal_org_id', 'custodian_class', 'nonce', 'quantity_kg', 'locked_kg', 'document_sha256_hex',
      'position_revision', 'expires_at', 'status', 'executed_at']
    when 'chain_handoff_acceptances' then array['intent', 'loan', 'lock', 'lender', 'lender_org_id',
      'lock_quantity_kg', 'loan_revision', 'principal', 'booked_interest', 'accepted_at', 'version']
  end
$$;

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
    when 'chain_loading_intents' then array['cancelled_by']
    when 'chain_handoff_acceptances' then array['event_version']
    else array[]::text[]
  end
$$;

-- indexer_reset as 20261127000950's, deleting the stream's acceptances, then its loading intents,
-- first.
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

  delete from public.chain_handoff_acceptances where network = cp.network and protocol = cp.protocol;
  delete from public.chain_loading_intents where network = cp.network and protocol = cp.protocol;
  delete from public.chain_handovers where network = cp.network and protocol = cp.protocol;
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
alter table public.chain_loading_intents enable row level security;
alter table public.chain_handoff_acceptances enable row level security;
revoke all on table public.chain_loading_intents, public.chain_handoff_acceptances
  from public, anon, authenticated, service_role;
grant select on table public.chain_loading_intents, public.chain_handoff_acceptances
  to service_role, authenticated;

-- A loading intent is read by its lot's readers, its owner and its terminal (live-custody.md §6.2.6).
create function private.can_read_loading_intent(intent_address text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.chain_loading_intents i where i.address = intent_address
    and (private.can_read_lot(i.lot) or private.is_member(i.owner_org_id) or private.is_member(i.terminal_org_id)));
$$;
revoke all on function private.can_read_loading_intent(text) from public, anon, authenticated, service_role;
grant execute on function private.can_read_loading_intent(text) to authenticated;

create policy chain_loading_intents_select on public.chain_loading_intents
  for select to authenticated using (private.can_read_loading_intent(address));
-- An acceptance is read by the loan's facility parties (live-custody.md §8 decision 13).
create policy chain_handoff_acceptances_select on public.chain_handoff_acceptances
  for select to authenticated using (private.can_read_loan(loan));

-- The custody events policy gains its loading arm: LoadingIntentCreated (scope loading) is read by
-- the intent's readers. LoadingAccepted and LoanHandedOff are facility-scoped and LoadingRecorded is
-- lot-scoped, so chain_events_select already gives them their rows' readers (decision 6).
drop policy chain_events_custody_select on public.chain_events;
create policy chain_events_custody_select on public.chain_events
  for select to authenticated using (
    (shipment is not null and private.can_read_shipment(shipment))
    or (scope = 'loading' and private.can_read_loading_intent(created)));
