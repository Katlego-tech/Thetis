-- Transactions of another protocol instance on the same program.
--
-- Several protocol instances share one program, and the program's address listing returns all of
-- them. A transaction whose Thetis instructions all belong to another instance is recorded with
-- other_instance = true and nothing else: no events, no projection rows, no protocol. One that mixes
-- this stream's instance with another halts the stream with MIXED_INSTANCE.

alter type public.indexer_halt_reason add value 'MIXED_INSTANCE';

alter table public.chain_transactions
  add column other_instance boolean not null default false,
  add constraint chain_transactions_other_instance
    check (not other_instance or (succeeded and protocol is null and event_count = 0));

-- indexer_apply as before; a transaction row now carries other_instance as well.
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


revoke all on function public.indexer_apply(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.indexer_apply(jsonb) to service_role;
