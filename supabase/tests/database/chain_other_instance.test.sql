-- Transactions of another protocol instance on the same program: recorded as other-instance,
-- never as events or projection rows; and the MIXED_INSTANCE halt reason.
-- SYNTHETIC: every address, signature and slot below is made up (base58 of repeated bytes);
-- only the program id is the real devnet program.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(26);

delete from public.chain_events;
delete from public.chain_transactions;
delete from public.chain_protocols;
delete from public.chain_class_policies;
delete from public.chain_organisations;
delete from public.chain_authorities;
delete from public.chain_custodian_classes;
delete from public.chain_documents;
delete from public.chain_intakes;
delete from public.chain_lots;
delete from public.chain_positions;
delete from public.indexer_checkpoints;

create function pg_temp.program() returns text language sql immutable as $$
  select 'jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3'
$$;

create function pg_temp.protocol() returns text language sql immutable as $$
  select '7porTR32j7zt69GG4AwoPQx3f3FL2RLpSDKGtPXWTeaQ'
$$;

create function pg_temp.sig(n int) returns text language sql immutable as $$
  select case n
    when 1 then '52zhWrwRGfoWgwtvtZmu5eKsq4UbpkQxsAFnxxj7PkpepSb6ndoSNsVgbovfdmNPzfzSRtEqGSqLCjspzZsGViJU'
    when 2 then '54ADj8UrVjTYZw1pov8u3wFMVgGubiKbnnwyajSaqYvNZPFeZJMzFBveCcL22TQp4RU8xJjU9tMaj6aUk8vh6mgV'
    when 3 then '55KjwQ2Hio7aSv8ijGVu2EAqAJ5DNgEEiReACWA4HM26JKvCKxvY7WMboQjNR9TE8AwqUjE73KsqFTH8Vhz7hq4W'
    when 4 then '56VG9fZiwrmcKuFcecrtzX6JpusX9e8se4LLpGsXj97p3Gak6dV5ypnZQD8ioqVeBvRY19ijvmQ5moynFH3YJtSX'
  end
$$;

create function pg_temp.stream() returns jsonb language sql immutable as $$
  select jsonb_build_object('network', 'devnet', 'programId', pg_temp.program(),
    'protocol', pg_temp.protocol())
$$;

create function pg_temp.at(slot bigint) returns text language sql immutable as $$
  select to_char(timestamptz '2026-11-26 00:00:00+00' + make_interval(secs => slot), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
$$;

create function pg_temp.tx(n int, slot bigint, other boolean, protocol text, events int,
  succeeded boolean default true) returns jsonb language sql immutable as $$
  select jsonb_build_object('network', 'devnet', 'program_id', pg_temp.program(),
    'signature', pg_temp.sig(n), 'slot', slot, 'block_time', pg_temp.at(slot),
    'succeeded', succeeded, 'protocol', protocol, 'event_count', events, 'other_instance', other)
$$;

create function pg_temp.ev(n int, slot bigint) returns jsonb language sql immutable as $$
  select jsonb_build_object('network', 'devnet', 'program_id', pg_temp.program(),
    'signature', pg_temp.sig(n), 'event_index', 0, 'slot', slot, 'block_time', pg_temp.at(slot),
    'protocol', pg_temp.protocol(), 'instruction', 'InitializeProtocol',
    'event', 'ProtocolInitialized', 'scope', 'registry', 'lot', null, 'lot_revision', null,
    'org_id', null, 'data', jsonb_build_object('protocol', pg_temp.protocol()),
    'facility', null, 'loan', null, 'loan_revision', null, 'pool', null, 'pool_revision', null,
    'valuation', null, 'valuation_version', null, 'created', null,
    'shipment', null, 'shipment_revision', null, 'batch', null, 'batch_sequence', null,
    'observation_index', null, 'acceptance', null, 'acceptance_version', null)
$$;

create function pg_temp.batch(expected bigint, through bigint, txs jsonb,
  evs jsonb default '[]'::jsonb) returns jsonb language sql immutable as $$
  select jsonb_build_object('stream', pg_temp.stream(), 'expectedThroughSlot', expected,
    'throughSlot', through, 'transactions', txs, 'events', evs, 'upserts', '[]'::jsonb)
$$;

create function pg_temp.cursor() returns bigint language sql stable as $$
  select indexed_through_slot from public.indexer_checkpoints
$$;

-- The column and the halt reason.
select has_column('public', 'chain_transactions', 'other_instance',
  'chain_transactions has other_instance');
select col_type_is('public', 'chain_transactions', 'other_instance', 'boolean',
  'other_instance is a boolean');
select col_not_null('public', 'chain_transactions', 'other_instance',
  'other_instance is not null');
select col_default_is('public', 'chain_transactions', 'other_instance', 'false',
  'other_instance defaults to false');
select ok('MIXED_INSTANCE' = any (enum_range(null::public.indexer_halt_reason)::text[]),
  'MIXED_INSTANCE is a halt reason');
select ok(not has_table_privilege('authenticated', 'public.chain_transactions', 'SELECT')
  and not has_any_column_privilege('authenticated', 'public.chain_transactions', 'SELECT'),
  'authenticated still cannot select chain_transactions');

-- An other-instance row through indexer_apply.
set local role service_role;
select lives_ok($$select public.indexer_checkpoint(pg_temp.stream(), null, '{}'::jsonb)$$,
  'the checkpoint row is created');
select lives_ok(
  $$select public.indexer_apply(pg_temp.batch(null, 100,
    jsonb_build_array(pg_temp.tx(1, 100, true, null, 0))))$$,
  'indexer_apply stores an other-instance transaction');
reset role;
select is(pg_temp.cursor(), 100::bigint, 'the other-instance batch moves the cursor');
select is(
  (select row(succeeded, protocol, event_count, other_instance, commitment::text)
   from public.chain_transactions where signature = pg_temp.sig(1)),
  row(true, null::text, 0, true, 'confirmed'::text),
  'the row is succeeded, without protocol or events, other-instance, confirmed');
select is((select count(*)::int from public.chain_events), 0, 'no event row was written');

-- What indexer_apply refuses, writing nothing.
set local role service_role;
select throws_ok(
  $$select public.indexer_apply(pg_temp.batch(100, 200,
    jsonb_build_array(pg_temp.tx(2, 200, true, pg_temp.protocol(), 0))))$$,
  'P0001', 'ROW_INVALID', 'an other-instance row with a protocol is ROW_INVALID');
select throws_ok(
  $$select public.indexer_apply(pg_temp.batch(100, 200,
    jsonb_build_array(pg_temp.tx(2, 200, true, pg_temp.protocol(), 1)),
    jsonb_build_array(pg_temp.ev(2, 200))))$$,
  'P0001', 'ROW_INVALID', 'an other-instance row with events is ROW_INVALID');
select throws_ok(
  $$select public.indexer_apply(pg_temp.batch(100, 200,
    jsonb_build_array(pg_temp.tx(2, 200, true, null, 0, false))))$$,
  'P0001', 'ROW_INVALID', 'a failed other-instance row is ROW_INVALID');
select throws_ok(
  $$select public.indexer_apply(pg_temp.batch(100, 200,
    jsonb_build_array(pg_temp.tx(2, 200, false, pg_temp.protocol(), 0) - 'other_instance')))$$,
  'P0001', 'ROW_INVALID', 'a transaction row without other_instance is ROW_INVALID');
select throws_ok(
  $$select public.indexer_apply(pg_temp.batch(100, 200,
    jsonb_build_array(jsonb_set(pg_temp.tx(2, 200, false, pg_temp.protocol(), 0),
      '{other_instance}', 'null'))))$$,
  'P0001', 'ROW_INVALID', 'a null other_instance is ROW_INVALID');
reset role;
select is(pg_temp.cursor(), 100::bigint, 'the refused batches left the cursor');
select is((select count(*)::int from public.chain_transactions), 1,
  'the refused batches wrote no transaction');

-- A replay of the stored other-instance row changes nothing, not even the cursor; own rows
-- still apply with other_instance false.
set local role service_role;
select lives_ok(
  $$select public.indexer_apply(pg_temp.batch(100, 200,
    jsonb_build_array(pg_temp.tx(1, 100, true, null, 0))))$$,
  'the stored other-instance row sent again is a replay');
reset role;
select is(pg_temp.cursor(), 100::bigint, 'the replay did not move the cursor');
set local role service_role;
select lives_ok(
  $$select public.indexer_apply(pg_temp.batch(100, 200,
    jsonb_build_array(pg_temp.tx(2, 200, false, pg_temp.protocol(), 1)),
    jsonb_build_array(pg_temp.ev(2, 200))))$$,
  'an own transaction with other_instance false and its event applies');

-- Finalization, the halt and the reset treat it like any transaction.
select lives_ok($$select public.indexer_finalize(pg_temp.stream(), 200, array[pg_temp.sig(1)])$$,
  'indexer_finalize runs on the other-instance row');
reset role;
select is((select commitment::text from public.chain_transactions where signature = pg_temp.sig(1)),
  'finalized', 'the other-instance row is finalized');
set local role service_role;
select is(
  (select public.indexer_halt(pg_temp.stream(), 200, 'MIXED_INSTANCE',
    'decode: synthetic mixed instances', pg_temp.sig(3)) ->> 'reason'),
  'MIXED_INSTANCE', 'indexer_halt takes MIXED_INSTANCE');
select is((select public.indexer_reset(pg_temp.stream()) ->> 'reason'), 'MIXED_INSTANCE',
  'indexer_reset clears the MIXED_INSTANCE halt');
reset role;
select is((select count(*)::int from public.chain_transactions), 0,
  'indexer_reset removes the other-instance row');

select * from finish();
rollback;
