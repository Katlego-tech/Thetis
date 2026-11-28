-- The public judge page's read surface (docs/design/judge-page.md §6.1). One configured protocol
-- instance, set by the driver in private.judge_run; anon reads it only through public.judge_run().
-- Nothing here grants anon any table, and no caller argument chooses the instance.

create table private.judge_run (
  only_row boolean primary key default true check (only_row),
  network text not null check (network = 'devnet'),
  program_id text not null check (private.is_address(program_id)),
  protocol text not null check (private.is_address(protocol)),
  instance_label text not null check (instance_label ~ '^fiat-demo-run-[0-9]{2}$'),
  expected_transactions integer not null check (expected_transactions > 0),
  created_at timestamptz not null default pg_catalog.now()
);

create table private.judge_refusals (
  signature text primary key check (signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
  beat text not null unique check (beat in ('second_lender', 'refused_driver', 'duplicate_intake')),
  error_name text not null check (error_name ~ '^[A-Za-z][A-Za-z0-9]{0,63}$'),
  created_at timestamptz not null default pg_catalog.now()
);

alter table private.judge_run enable row level security;
alter table private.judge_refusals enable row level security;
revoke all on table private.judge_run, private.judge_refusals
  from public, anon, authenticated, service_role;

create function public.judge_run()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  with cfg as (select * from private.judge_run),
  cp as (
    select c.* from public.indexer_checkpoints c, cfg
    where c.network = cfg.network and c.program_id = cfg.program_id and c.protocol = cfg.protocol
  ),
  txs as (
    select t.signature, t.slot, t.block_time, t.commitment
    from public.chain_transactions t, cfg
    where exists (select 1 from cp)
      and t.network = cfg.network and t.program_id = cfg.program_id
      and t.protocol = cfg.protocol and t.succeeded and not t.other_instance
  )
  select case when not exists (select 1 from cfg) then jsonb_build_object('configured', false)
  else jsonb_build_object(
    'configured', true,
    'streamMatches', exists (select 1 from cp),
    'network', (select network from cfg),
    'programId', (select program_id from cfg),
    'protocol', (select protocol from cfg),
    'instanceLabel', (select instance_label from cfg),
    'expectedTransactions', (select expected_transactions from cfg),
    'expectedRefusals', (select pg_catalog.count(*) from private.judge_refusals),
    'checkpoint', (select jsonb_build_object('status', status, 'indexedThroughSlot', indexed_through_slot,
        'lastSuccessAt', last_success_at, 'haltReason', halt_reason, 'haltedAt', halted_at) from cp),
    'organisations', coalesce((select jsonb_agg(jsonb_build_object('address', o.address,
        'displayName', o.display_name, 'role', o.role, 'synthetic', o.synthetic) order by o.address)
      from public.chain_organisations o, cfg
      where exists (select 1 from cp) and o.network = cfg.network and o.protocol = cfg.protocol), '[]'),
    'transactions', coalesce((select jsonb_agg(jsonb_build_object('signature', x.signature,
        'slot', x.slot, 'blockTime', x.block_time, 'commitment', x.commitment,
        'events', (select jsonb_agg(jsonb_build_object('index', e.event_index,
            'instruction', e.instruction, 'event', e.event, 'data', e.data) order by e.event_index)
          from public.chain_events e, cfg
          where e.network = cfg.network and e.program_id = cfg.program_id
            and e.signature = x.signature and e.protocol = cfg.protocol))
        order by x.slot, x.signature) from txs x), '[]'),
    'refusals', coalesce((select jsonb_agg(jsonb_build_object('beat', r.beat,
        'signature', r.signature, 'slot', t.slot, 'blockTime', t.block_time,
        'commitment', t.commitment, 'errorName', r.error_name) order by t.slot, r.signature)
      from private.judge_refusals r
      join public.chain_transactions t on t.signature = r.signature
      cross join cfg
      where exists (select 1 from cp) and t.network = cfg.network
        and t.program_id = cfg.program_id and not t.succeeded), '[]'))
  end
$$;

revoke all on function public.judge_run() from public, anon, authenticated, service_role;
grant execute on function public.judge_run() to anon;
