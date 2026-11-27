-- Relay bookkeeping (live-lending.md §3.2, §6.3): one row per command the API builds, signs
-- and sends, and the address lookup table of each instance. Written only by the API's service
-- client (compare-and-set on revision); parties read their commands under RLS. Nothing here is
-- authority: the program checks every signature, revision and limit.
create type public.command_kind as enum ('open_facility', 'set_valuation', 'pledge', 'record_advance',
  'confirm_payment', 'correct_payment', 'repay', 'create_release_intent', 'sell_pledged', 'liquidate',
  'close_loan', 'deposit', 'withdraw', 'borrow', 'repay_simulated');
create type public.command_status as enum ('awaiting_signatures', 'submitted', 'confirmed', 'failed',
  'outcome_unknown', 'expired');

create table public.commands (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  network text not null check (network = 'devnet'),
  program_id text not null check (private.is_address(program_id)),
  protocol text not null check (private.is_address(protocol)),
  kind public.command_kind not null,
  status public.command_status not null,
  created_by uuid not null references auth.users (id),
  initiator_org uuid not null references public.organisations (id),
  parties uuid[] not null check (pg_catalog.cardinality(parties) between 1 and 3),
  lot text check (private.is_address(lot)),
  facility text check (private.is_address(facility)),
  loan text check (private.is_address(loan)),
  intent text check (private.is_address(intent)),
  payment text check (private.is_address(payment)),
  args jsonb not null check (pg_catalog.jsonb_typeof(args) = 'object'),
  plan jsonb not null check (pg_catalog.jsonb_typeof(plan) = 'object'),
  fields jsonb not null check (pg_catalog.jsonb_typeof(fields) = 'array'),
  text_version integer not null default 0 check (text_version >= 0),
  message_base64 text,
  message_sha256 text check (message_sha256 ~ '^[0-9a-f]{64}$'),
  valid_until text check (private.is_i64(valid_until)),
  signers jsonb not null check (pg_catalog.jsonb_typeof(signers) = 'array'),
  signatures jsonb not null default '[]' check (pg_catalog.jsonb_typeof(signatures) = 'array'),
  pending_message_base64 text,
  pending_wallet text check (private.is_address(pending_wallet)),
  pending_last_valid_block_height text check (private.is_u64(pending_last_valid_block_height)),
  transaction_base64 text,
  transaction_signature text check (transaction_signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
  last_valid_block_height text check (private.is_u64(last_valid_block_height)),
  sends integer not null default 0 check (sends between 0 and 3),
  error_code text,
  error_detail text,
  outcome jsonb check (outcome is null or pg_catalog.jsonb_typeof(outcome) = 'object'),
  confirmed_slot bigint check (confirmed_slot >= 0),
  confirmed_commitment text check (confirmed_commitment in ('confirmed', 'finalized')),
  revision integer not null default 0 check (revision >= 0),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  check ((text_version = 0) = (message_base64 is null)),
  check ((message_base64 is null) = (message_sha256 is null) and (message_base64 is null) = (valid_until is null)),
  check ((pending_message_base64 is null) = (pending_wallet is null)
    and (pending_message_base64 is null) = (pending_last_valid_block_height is null)),
  check ((transaction_signature is null) = (transaction_base64 is null)
    and (transaction_signature is null) = (last_valid_block_height is null)),
  check (status not in ('submitted', 'confirmed', 'failed', 'outcome_unknown') or transaction_signature is not null),
  check ((status = 'confirmed') = (confirmed_commitment is not null)),
  check (status <> 'failed' or error_code is not null)
);
create index commands_open on public.commands (protocol, status) where status in
  ('awaiting_signatures', 'submitted', 'outcome_unknown');
create index commands_parties on public.commands using gin (parties);

create table public.relay_lookup_tables (
  network text not null check (network = 'devnet'),
  program_id text not null check (private.is_address(program_id)),
  protocol text not null check (private.is_address(protocol)),
  address text not null unique check (private.is_address(address)),
  authority text not null check (private.is_address(authority)),
  created_at timestamptz not null default pg_catalog.now(),
  primary key (network, program_id, protocol)
);

alter table public.commands enable row level security;
alter table public.relay_lookup_tables enable row level security;
revoke all on table public.commands, public.relay_lookup_tables from public, anon, authenticated, service_role;
grant select, insert, update on table public.commands, public.relay_lookup_tables to service_role;
grant select on table public.commands to authenticated;
create policy commands_party_select on public.commands for select to authenticated using (
  exists (select 1 from pg_catalog.unnest(parties) as p where private.is_member(p)));
