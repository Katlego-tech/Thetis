-- The public judge page's read surface: private.judge_run, private.judge_refusals and
-- public.judge_run() (judge-page.md §6.1, §6.2).
-- SYNTHETIC: every address, signature and slot below is made up (base58 of repeated bytes); only the
-- program id is the real devnet program. P1 is the judged instance, P2 another instance on the same
-- program. Rows are inserted directly as postgres; the indexer's own checks are tested elsewhere.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(37);

-- A clean slate inside this transaction (rolled back at the end).
delete from public.chain_handoff_acceptances;
delete from public.chain_loading_intents;
delete from public.chain_handovers;
delete from public.chain_batches;
delete from public.chain_shipments;
delete from public.chain_pool_shares;
delete from public.chain_pools;
delete from public.chain_payments;
delete from public.chain_release_intents;
delete from public.chain_locks;
delete from public.chain_loans;
delete from public.chain_valuations;
delete from public.chain_facilities;
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
delete from private.judge_refusals;
delete from private.judge_run;

create function pg_temp.a(name text) returns text language sql immutable as $$
  select case name
    when 'program' then 'jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3'
    when 'p1' then '6QWeT6FpJrm8AF1btu6WH2k2Xhq6t5vbheKVfQavmenJ'
    when 'p2' then '6URwbPipuA4MJLG7LCRRZuWnms3JZ9cRG3z9indXWz6z'
    when 'orgA' then '6YMEjhBqVTMaSRWcmVkLrnHZ22FWEDJEpTeonAg8GKRg'
    when 'orgB' then '6cGXszer5keoaWm8Co5G9f4KGBThuGz4NsKTqYij1ekN'
    when 'orgC' then '6gBq2J7rg3x2ic1de6QBSXq5WLfuaLfswGz7tvmKkz54'
    when 'admin' then '86V32cu56KBneWGHoNFUYv36dg68ig66fqyu7uhuSyqY'
  end
$$;

create function pg_temp.sig(n int) returns text language sql immutable as $$
  select case n
    when 1 then '2AXDGYSE4f2sz7tvMMzyHvUfcoJmxudvdhBcmiUSo6ijwfYmfZYsKRxboQMPh3R4kUhXRVdtSXFXMheka4Rc4P2'
    when 2 then '3L3RY5sT8K4kyEnqhizwaqxLEbcYvpGrGPNEYRwtbCSUtL6YL86jdrvCbohnP5q8VxQ3qzGmt3W3iQJW97rD7m3'
    when 3 then '4VZdodJgBy6dxMgm45zusmRzrPvKtiumu5YrK9RLPJADpzeJzgebxHsoQD4B58FCFS6aGUufKZka56xFiBGpB94'
    when 4 then '5f5r5AjuFd8WwUagQSztAgufUCE6rdYhXmjU5rtnBPsxmfC5fFCUGiqQCcQZmAfFzuo6gyYYm616Roc1HEhREX5'
    when 5 then '6pc4LiB8KHAPvbUbkozrTcPL5zXspYBdATv5raNDyVbhiKjrKokLb9o111kxTD5KkPVd7UBSCcFcnWFkrJ82Hu6'
    when 6 then '7z8GcFcMNwCGuiNX7AzpkXrzhnqenSpYoA6hdHqfmbKSezHczNJCuakboR7M9FVPVsC9XxpKe8W99CuWRMYdMH7'
    when 7 then '99eUso3aSbE9tqGSTXzo3TLfKb9RkMTURrHKQ1K7Zh3BbeqPevr5E1iCbpTjqHuTFLtfxTTD5ekfVuZFzQyEQf8'
    when 8 then 'AKAh9LUoWFG2sxAMotzmLNpKwPTCiG6Q4YTwAinZMnkvYKPAKVPwYSfoQDp8XLKWzpbCNx66XB1BrcD1ZUPqU39'
    when 9 then 'BUguQsv2ZuHus54HAFzjdJHzZBkygAjKhEeYwSG19tUfUyvvz3worsdQCdAXDNjakJHioSiyxhFiDJrm8XpSXRA'
  end
$$;

create function pg_temp.at(slot bigint) returns timestamptz language sql immutable as $$
  select timestamptz '2026-11-28 00:00:00+00' + make_interval(secs => slot)
$$;

create function pg_temp.tx(n int, slot bigint, succeeded boolean, protocol text, events int,
  other boolean) returns void language sql as $$
  insert into public.chain_transactions (network, program_id, signature, slot, block_time, succeeded,
    protocol, event_count, other_instance)
  values ('devnet', pg_temp.a('program'), pg_temp.sig(n), slot, pg_temp.at(slot), succeeded,
    protocol, events, other)
$$;

create function pg_temp.ev(n int, idx int, slot bigint, protocol text, instruction text, event text)
returns void language sql as $$
  insert into public.chain_events (network, program_id, signature, event_index, slot, block_time,
    protocol, instruction, event, scope, data)
  values ('devnet', pg_temp.a('program'), pg_temp.sig(n), idx, slot, pg_temp.at(slot), protocol,
    instruction, event, 'registry', jsonb_build_object('synthetic', true, 'index', idx))
$$;

create function pg_temp.organisation(name text, protocol text, display text, role text, slug text)
returns void language sql as $$
  insert into public.chain_organisations (network, address, protocol, slot, commitment,
    last_signature, org_id, slug, synthetic, role, display_name, admin)
  values ('devnet', pg_temp.a(name), protocol, 100, 'confirmed', pg_temp.sig(1),
    (select id from public.organisations o where o.slug = organisation.slug), slug, true, role,
    display, pg_temp.a('admin'))
$$;

create function pg_temp.checkpoint(protocol text) returns void language sql as $$
  insert into public.indexer_checkpoints (network, program_id, protocol, status, indexed_through_slot,
    last_success_at)
  values ('devnet', pg_temp.a('program'), protocol, 'live', 900, pg_temp.at(900))
$$;

-- The fixture rows. P1: two successful transactions (slot 300 has two events, inserted out of
-- order), a failed one with a refusal record (F1, sig 5), a failed one without (sig 6). Another
-- instance's transaction (sig 3) and a P2 transaction (sig 4).
select pg_temp.tx(1, 300, true, pg_temp.a('p1'), 2, false);
select pg_temp.ev(1, 1, 300, pg_temp.a('p1'), 'Pledge', 'Pledged');
select pg_temp.ev(1, 0, 300, pg_temp.a('p1'), 'IssueLot', 'LotIssued');
select pg_temp.tx(2, 200, true, pg_temp.a('p1'), 1, false);
select pg_temp.ev(2, 0, 200, pg_temp.a('p1'), 'IssueLot', 'LotIssued');
select pg_temp.tx(3, 250, true, null, 0, true);
select pg_temp.tx(4, 260, true, pg_temp.a('p2'), 1, false);
select pg_temp.ev(4, 0, 260, pg_temp.a('p2'), 'IssueLot', 'LotIssued');
select pg_temp.tx(5, 400, false, null, 0, false);
select pg_temp.tx(6, 410, false, null, 0, false);
select pg_temp.organisation('orgA', pg_temp.a('p1'), 'Khunou Chrome Test Org', 'Exporter', 'khunou');
select pg_temp.organisation('orgB', pg_temp.a('p1'), 'Lender One Test Org', 'Lender', 'lender-one');
select pg_temp.organisation('orgC', pg_temp.a('p2'), 'Kopano Test Org', 'Custodian', 'kopano');

-- 1. The function.
select has_function('public', 'judge_run', '{}'::name[], 'public.judge_run() exists');
select is_definer('public', 'judge_run', '{}'::name[], 'judge_run is security definer');
select function_returns('public', 'judge_run', '{}'::name[], 'jsonb', 'judge_run returns jsonb');

-- 2. Only anon may execute it.
select function_privs_are('public', 'judge_run', '{}'::name[], 'anon', array['EXECUTE'],
  'anon may execute judge_run');
select function_privs_are('public', 'judge_run', '{}'::name[], 'authenticated', '{}'::text[],
  'authenticated may not execute judge_run');
select ok(not exists (select 1 from pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) x
    where p.oid = 'public.judge_run()'::regprocedure and x.grantee = 0),
  'PUBLIC has no privilege on judge_run');

-- 3. Nobody but the owner reads the private tables.
select table_privs_are('private', 'judge_run', 'anon', '{}'::text[], 'anon: nothing on judge_run');
select table_privs_are('private', 'judge_run', 'authenticated', '{}'::text[],
  'authenticated: nothing on judge_run');
select table_privs_are('private', 'judge_run', 'service_role', '{}'::text[],
  'service_role: nothing on judge_run');
select table_privs_are('private', 'judge_refusals', 'anon', '{}'::text[],
  'anon: nothing on judge_refusals');
select table_privs_are('private', 'judge_refusals', 'authenticated', '{}'::text[],
  'authenticated: nothing on judge_refusals');
select table_privs_are('private', 'judge_refusals', 'service_role', '{}'::text[],
  'service_role: nothing on judge_refusals');

-- 4. anon reads no base table.
set local role anon;
select throws_ok($$select 1 from public.chain_transactions$$, '42501', null,
  'anon cannot read chain_transactions');
select throws_ok($$select 1 from public.chain_events$$, '42501', null, 'anon cannot read chain_events');
select throws_ok($$select 1 from public.chain_organisations$$, '42501', null,
  'anon cannot read chain_organisations');
select throws_ok($$select 1 from public.indexer_checkpoints$$, '42501', null,
  'anon cannot read indexer_checkpoints');
select throws_ok($$select 1 from public.organisations$$, '42501', null, 'anon cannot read organisations');
select throws_ok($$select 1 from public.memberships$$, '42501', null, 'anon cannot read memberships');
select throws_ok($$select 1 from public.commands$$, '42501', null, 'anon cannot read commands');
select throws_ok($$select 1 from public.evidence_objects$$, '42501', null,
  'anon cannot read evidence_objects');

-- 5. No config row: exactly {"configured": false}, as anon.
select is(public.judge_run(), '{"configured": false}'::jsonb, 'unconfigured: configured false only');
reset role;

-- 6. Config for P1, checkpoint for P2 only: nothing of either instance is shown.
insert into private.judge_run (network, program_id, protocol, instance_label, expected_transactions)
values ('devnet', pg_temp.a('program'), pg_temp.a('p1'), 'fiat-demo-run-01', 2);
insert into private.judge_refusals (signature, beat, error_name) values
  (pg_temp.sig(5), 'second_lender', 'InsufficientAvailable'),
  (pg_temp.sig(7), 'refused_driver', 'Anchor3012'),
  (pg_temp.sig(2), 'duplicate_intake', 'Anchor0');
select pg_temp.checkpoint(pg_temp.a('p2'));

set local role anon;
select is((select jsonb_build_object('configured', r->'configured', 'streamMatches', r->'streamMatches',
    'checkpoint', r->'checkpoint')
  from (select public.judge_run() as r) s),
  '{"configured": true, "streamMatches": false, "checkpoint": null}'::jsonb,
  'checkpoint of another instance: configured, stream does not match');
select is((select jsonb_build_array(r->'transactions', r->'organisations', r->'refusals')
  from (select public.judge_run() as r) s),
  '[[], [], []]'::jsonb, 'checkpoint of another instance: no transactions, organisations or refusals');
reset role;

-- 7. Config and checkpoint for P1.
delete from public.indexer_checkpoints;
select pg_temp.checkpoint(pg_temp.a('p1'));
set local role anon;
select set_config('t.view', public.judge_run()::text, true);
reset role;

select is((select array_agg(x->>'signature' order by o)
    from jsonb_array_elements(current_setting('t.view')::jsonb->'transactions') with ordinality t(x, o)),
  array[pg_temp.sig(2), pg_temp.sig(1)],
  'transactions: only the two P1 signatures, in (slot, signature) order');
select is((select jsonb_agg(e->'index' order by o)
    from jsonb_array_elements(current_setting('t.view')::jsonb->'transactions'->1->'events')
      with ordinality t(e, o)),
  '[0, 1]'::jsonb, 'events of a transaction in event_index order');
select is(current_setting('t.view')::jsonb->'transactions'->1->'events'->0,
  jsonb_build_object('index', 0, 'instruction', 'IssueLot', 'event', 'LotIssued',
    'data', jsonb_build_object('synthetic', true, 'index', 0)),
  'an event carries index, instruction, event and data');
select is((current_setting('t.view')::jsonb->'transactions'->0) - 'events',
  jsonb_build_object('signature', pg_temp.sig(2), 'slot', 200, 'blockTime', pg_temp.at(200),
    'commitment', 'confirmed'),
  'a transaction carries signature, slot, blockTime and commitment');
select is(current_setting('t.view')::jsonb->'streamMatches', 'true'::jsonb,
  'checkpoint of the configured instance: stream matches');

-- 8. Refusals: only a failed transaction with a refusal record.
select is(current_setting('t.view')::jsonb->'refusals',
  jsonb_build_array(jsonb_build_object('beat', 'second_lender', 'signature', pg_temp.sig(5),
    'slot', 400, 'blockTime', pg_temp.at(400), 'commitment', 'confirmed',
    'errorName', 'InsufficientAvailable')),
  'refusals: only F1, with its error name; no record without a transaction, no failure without a '
  'record, no record of a succeeded transaction');

-- 9. Counts echoed from the config.
select is(current_setting('t.view')::jsonb->'expectedRefusals', '3'::jsonb,
  'expectedRefusals counts the judge_refusals rows');
select is(current_setting('t.view')::jsonb->'expectedTransactions', '2'::jsonb,
  'expectedTransactions echoes the config');

-- 10. Organisations of P1 only, four keys each.
select is((select array_agg(x->>'address' order by o)
    from jsonb_array_elements(current_setting('t.view')::jsonb->'organisations') with ordinality t(x, o)),
  array(select v from unnest(array[pg_temp.a('orgA'), pg_temp.a('orgB')]) v order by v),
  'organisations: only P1''s, by address');
select is((select array_agg(distinct k order by k)
    from jsonb_array_elements(current_setting('t.view')::jsonb->'organisations') x,
      jsonb_object_keys(x) k),
  array['address', 'displayName', 'role', 'synthetic'], 'organisations: exactly four keys');

-- 11. The top-level keys when configured.
select is((select array_agg(k order by k) from jsonb_object_keys(current_setting('t.view')::jsonb) k),
  array['checkpoint', 'configured', 'expectedRefusals', 'expectedTransactions', 'instanceLabel',
    'network', 'organisations', 'programId', 'protocol', 'refusals', 'streamMatches',
    'transactions'],
  'configured view: exactly the twelve keys');
select is(current_setting('t.view')::jsonb->'checkpoint',
  jsonb_build_object('status', 'live', 'indexedThroughSlot', 900, 'lastSuccessAt', pg_temp.at(900),
    'haltReason', null, 'haltedAt', null),
  'checkpoint: status, slot, last success and halt fields');

-- 12. One config row, and only a demo run label.
select throws_ok($$insert into private.judge_run (network, program_id, protocol, instance_label,
    expected_transactions) values ('devnet', 'jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3',
    '6QWeT6FpJrm8AF1btu6WH2k2Xhq6t5vbheKVfQavmenJ', 'fiat-demo-run-02', 5)$$,
  '23505', null, 'a second config row is refused');
delete from private.judge_run;
select throws_ok($$insert into private.judge_run (network, program_id, protocol, instance_label,
    expected_transactions) values ('devnet', 'jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3',
    '6QWeT6FpJrm8AF1btu6WH2k2Xhq6t5vbheKVfQavmenJ', 'fiat-lend-run-01', 5)$$,
  '23514', null, 'an instance label that is not a demo run is refused');

select * from finish();
rollback;
