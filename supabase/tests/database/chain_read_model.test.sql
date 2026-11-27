-- The chain read model: access rules, the write functions and the value checks.
-- SYNTHETIC: every address, signature and slot below is made up (base58 of repeated bytes);
-- only the program id is the real devnet program.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(96);

-- A clean slate inside this transaction (rolled back at the end).
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

-- Synthetic addresses by name.
create function pg_temp.a(name text) returns text language sql immutable as $$
  select case name
    when 'program' then 'jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3'
    when 'protocol' then '7porTR32j7zt69GG4AwoPQx3f3FL2RLpSDKGtPXWTeaQ'
    when 'khunou' then '7tj9biW3KRJ7EEWmVUGigHiouCTXhV2dzcyvwma7Cyu7'
    when 'kopano' then '7xeSk1y3uibLNKmGvmbdyAVa9MfjNYiTZ2eb19chxKDp'
    when 'buyer' then '82ZjtKS4W1tZWR1nN4vZG3GLPWsw3cQH7SKF4XfJheYX'
    when 'lender2' then '86V32cu56KBneWGHoNFUYv36dg68ig66fqyu7uhuSysE'
    when 'class' then '8AQLAvN5gcV1nbWoEfaPqnorsqJLPjmvEFeZBHkWCKBw'
    when 'site' then '8EKdKDq6GunEvgmJfxuK8fad7zWY4oTjnfKDEfo6weWe'
    when 'lotA' then '8JEvTXJ6sD5U4n1p7GEERYMPN9ijjs9ZM4ysJ3qhgyqM'
    when 'intakeA' then '8NADbpm7TWNhCsGKYZZ9iR89cJvwQvqNuUeXMRtJSKA4'
    when 'posAk' then '8S5Wk8E83ofvLxWpyrt51HturU995zXCTtKBQovuBeUm'
    when 'posAb' then '8VzotRh8e6y9V3mLRACzJAfg6dMLm4D22HyqUByVvyoU'
    when 'lotB' then '8Zv72jA9EQGNd91qrTXub3SSLnZYS7tqaheVXa26gK8B'
    when 'intakeB' then '8dqQB2d9phZbmEGMHkrpsvDCawmk7Baf97K9ax4hReSt'
    when 'posBk' then '8hkhKL6AQzrpuKWrj4BkAnyxq6ywnFGUhWyoeL7JAymb'
    when 'lotC' then '8mfzTdZB1JA43QmNAMWfTfkj5GC9TJxJFveThi9tvK6J'
    when 'posCk' then '8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR1'
    when 'posCb' then '8uWakEVCBtkWKbGP2xAW3RJFZacYoSKwNjympUF6Qyji'
    when 'authK' then '8yRstXxCnC3jTgWtUFVRLJ51ojpkUW1kw9eRsrHhAK4R'
    when 'authKop' then '93MB2qRDNVLxbmmPuYpLdAqn3u2x9ZhaVZK5wELHueP8'
    when 'walletK' then '97GUB8tDxneBjs1uLr9Fv3cYJ4F9pdPQ3xyjzcNteyhq'
    when 'walletKop' then '9BBmKSMEZ5wQsxGQn9UBCvPJYDTMVh5DcNeQ3zRVQK2Y'
    when 'mintA' then '9F74TjpF9PEe23WvDSo6VoA4nNfZAkm3AnK47NU69eMF'
    when 'mintB' then '9K2Mc3HFjgXsA8mRek81nfvq2XskqpSrjByiAkWgtyfx'
    when 'mintC' then '9NwekLkGKyq6JE1w63Sw5YhbGh5xWt8gHbeNE8ZHeJzf'
    when 'otherProtocol' then '9SrwteDGvH8KSKGSXLmrNRUMWrJABwpVr1K2HWbtPeKN'
  end
$$;

create function pg_temp.sig(n int) returns text language sql immutable as $$
  select case n
    when 1 then '52zhWrwRGfoWgwtvtZmu5eKsq4UbpkQxsAFnxxj7PkpepSb6ndoSNsVgbovfdmNPzfzSRtEqGSqLCjspzZsGViJU'
    when 2 then '54ADj8UrVjTYZw1pov8u3wFMVgGubiKbnnwyajSaqYvNZPFeZJMzFBveCcL22TQp4RU8xJjU9tMaj6aUk8vh6mgV'
    when 3 then '55KjwQ2Hio7aSv8ijGVu2EAqAJ5DNgEEiReACWA4HM26JKvCKxvY7WMboQjNR9TE8AwqUjE73KsqFTH8Vhz7hq4W'
    when 4 then '56VG9fZiwrmcKuFcecrtzX6JpusX9e8se4LLpGsXj97p3Gak6dV5ypnZQD8ioqVeBvRY19ijvmQ5moynFH3YJtSX'
    when 5 then '57enMw7AAvReCtNWZyDtxp1nVXfpvc3WZh2XS3b1AwDXnDFHsJ3dr9DX11Y5CXY4FfuEXaDNpCvLJAgRzr6xuwpY'
    when 6 then '58pJaCebPz5g5sVQVKatw6wGA9U8hZx9VKii3pJUcjKFX9uqdxcBiTeUbowRbDaUKRNw3zi1heSapXP5kRAPX1CZ'
    when 7 then '59ypnUC2d3jhxrcJQfwtuPrjpmGSUXrnQxQtfb1x4XQyG6aPQdAjan5SCcLmyuctPArdaRCeb5xqLt5jVzDp84aa'
    when 8 then '5B9LzjjTr7PjqqjCL2JtsgnDVP4kFVmRLb75HMjRWKWh13EwBHjHT6WPoQk8NbfJSvLL6qhHUXV5sEnPFZHEj7xb'
  end
$$;

create function pg_temp.org(slug text) returns text language sql stable as $$
  select id::text from public.organisations where organisations.slug = org.slug
$$;

create function pg_temp.stream(protocol text default null) returns jsonb language sql immutable as $$
  select jsonb_build_object('network', 'devnet', 'programId', pg_temp.a('program'),
    'protocol', coalesce(protocol, pg_temp.a('protocol')))
$$;

create function pg_temp.at(slot bigint) returns text language sql immutable as $$
  select to_char(timestamptz '2026-11-26 00:00:00+00' + make_interval(secs => slot), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
$$;

create function pg_temp.tx(n int, slot bigint, events int) returns jsonb language sql immutable as $$
  select jsonb_build_object('network', 'devnet', 'program_id', pg_temp.a('program'),
    'signature', pg_temp.sig(n), 'slot', slot, 'block_time', pg_temp.at(slot), 'succeeded', true,
    'protocol', pg_temp.a('protocol'), 'event_count', events, 'other_instance', false)
$$;

create function pg_temp.ev(n int, idx int, slot bigint, instruction text, event text, scope text,
  lot text, revision text, org text, data jsonb) returns jsonb language sql immutable as $$
  select jsonb_build_object('network', 'devnet', 'program_id', pg_temp.a('program'),
    'signature', pg_temp.sig(n), 'event_index', idx, 'slot', slot, 'block_time', pg_temp.at(slot),
    'protocol', pg_temp.a('protocol'), 'instruction', instruction, 'event', event, 'scope', scope,
    'lot', lot, 'lot_revision', revision, 'org_id', org, 'data', data,
    'facility', null, 'loan', null, 'loan_revision', null, 'pool', null, 'pool_revision', null,
    'valuation', null, 'valuation_version', null, 'created', null,
    'shipment', null, 'shipment_revision', null, 'batch', null, 'batch_sequence', null,
    'observation_index', null, 'acceptance', null, 'acceptance_version', null)
$$;

-- {table, row} with the common columns; `fields` holds the account columns.
create function pg_temp.up(tbl text, address text, slot bigint, n int, fields jsonb) returns jsonb
language sql immutable as $$
  select jsonb_build_object('table', tbl, 'row', jsonb_build_object('network', 'devnet',
    'address', address, 'protocol', pg_temp.a('protocol'), 'slot', slot,
    'commitment', 'confirmed', 'last_signature', pg_temp.sig(n)) || fields)
$$;

create function pg_temp.lot(address text, lot_id text, intake text, parent text, mint text,
  supply text, revision text, slot bigint, n int, issued_owner text, issued_at bigint) returns jsonb
language sql stable as $$
  select pg_temp.up('chain_lots', address, slot, n, jsonb_build_object(
    'lot_id', lot_id, 'class_policy', pg_temp.a('class'), 'class_version', 1, 'grade', 'G1',
    'custodian_class', pg_temp.a('site'), 'custodian', pg_temp.a('kopano'),
    'custodian_org_id', pg_temp.org('kopano'), 'intake', intake, 'parent', parent,
    'root', coalesce(parent, address), 'mint', mint, 'supply_kg', supply, 'state', 'Stored',
    'restriction', 'Normal', 'expires_at', '1772000000', 'revision', revision, 'live_children', 0,
    'event_revision', revision, 'issued_owner', pg_temp.a(issued_owner),
    'issued_owner_org_id', pg_temp.org(case issued_owner when 'buyer' then 'buyer-smelter' else issued_owner end),
    'issued_at', pg_temp.at(issued_at)))
$$;

create function pg_temp.pos(address text, lot text, owner text, quantity text, slot bigint, n int)
returns jsonb language sql stable as $$
  select pg_temp.up('chain_positions', address, slot, n, jsonb_build_object(
    'lot', lot, 'owner', pg_temp.a(owner),
    'owner_org_id', pg_temp.org(case owner when 'buyer' then 'buyer-smelter' else owner end),
    'quantity_kg', quantity, 'locked_kg', '0', 'reserved_kg', '0', 'revision', '0'))
$$;

create function pg_temp.intake(address text, lot text, digest text, slot bigint, n int) returns jsonb
language sql stable as $$
  select pg_temp.up('chain_intakes', address, slot, n, jsonb_build_object(
    'custodian', pg_temp.a('kopano'), 'custodian_org_id', pg_temp.org('kopano'),
    'intake_digest_hex', digest, 'lot', lot, 'retired', false))
$$;

create function pg_temp.organisation(slug text, name text, role text, slot bigint, n int) returns jsonb
language sql stable as $$
  select pg_temp.up('chain_organisations', pg_temp.a(case slug when 'buyer-smelter' then 'buyer'
    when 'lender-two' then 'lender2' else slug end), slot, n, jsonb_build_object(
    'org_id', pg_temp.org(slug), 'slug', slug, 'synthetic', true, 'role', role,
    'display_name', name, 'admin', pg_temp.a('walletK'), 'related', '[]'::jsonb))
$$;

create function pg_temp.authority(address text, organisation text, wallet text, slot bigint, n int)
returns jsonb language sql stable as $$
  select pg_temp.up('chain_authorities', pg_temp.a(address), slot, n, jsonb_build_object(
    'organisation', pg_temp.a(organisation), 'org_id', pg_temp.org(organisation),
    'wallet', pg_temp.a(wallet), 'scopes', 3, 'expires_at', '1800000000', 'revoked_at', null))
$$;

create function pg_temp.batch(expected bigint, through bigint, txs jsonb, evs jsonb, ups jsonb)
returns jsonb language sql immutable as $$
  select jsonb_build_object('stream', pg_temp.stream(), 'expectedThroughSlot', expected,
    'throughSlot', through, 'transactions', txs, 'events', evs, 'upserts', ups)
$$;

create function pg_temp.cursor() returns bigint language sql stable as $$
  select indexed_through_slot from public.indexer_checkpoints
$$;

-- The batches, built as postgres and kept as settings.
select set_config('t.b1', pg_temp.batch(null, 100,
  jsonb_build_array(pg_temp.tx(1, 100, 2)),
  jsonb_build_array(
    pg_temp.ev(1, 0, 100, 'InitializeProtocol', 'ProtocolInitialized', 'registry', null, null, null,
      jsonb_build_object('protocol', pg_temp.a('protocol'))),
    pg_temp.ev(1, 1, 100, 'AccreditOrganisation', 'OrganisationAccredited', 'organisation', null, null,
      pg_temp.org('khunou'), jsonb_build_object('organisation', pg_temp.a('khunou'), 'role', 'Exporter'))),
  jsonb_build_array(
    pg_temp.up('chain_protocols', pg_temp.a('protocol'), 100, 1, jsonb_build_object(
      'instance_id_hex', '666961742d6174746573746174696f6e', 'settlement_mode', 'FiatAttestationTest',
      'admin', pg_temp.a('walletK'), 'accreditor', pg_temp.a('walletKop'), 'pause_flags', 0)),
    pg_temp.up('chain_class_policies', pg_temp.a('class'), 100, 1, jsonb_build_object(
      'class_code', 'CHROME', 'version', 1, 'unit', 'Kilogram', 'grades', '["G1"]'::jsonb,
      'origin_required', false, 'lot_validity_secs', '7776000', 'split_inherits_expiry', true)),
    pg_temp.organisation('khunou', 'Khunou Ore Exports', 'Exporter', 100, 1),
    pg_temp.organisation('kopano', 'Kopano Stockyard Custody', 'Custodian', 100, 1),
    pg_temp.organisation('buyer-smelter', 'Buyer Smelter Co', 'Buyer', 100, 1),
    pg_temp.organisation('lender-two', 'Lender Two Bank', 'Lender', 100, 1),
    pg_temp.up('chain_custodian_classes', pg_temp.a('site'), 100, 1, jsonb_build_object(
      'custodian', pg_temp.a('kopano'), 'custodian_org_id', pg_temp.org('kopano'),
      'class_policy', pg_temp.a('class'), 'site_code', 'PORT-STOCKYARD',
      'approved_capacity_kg', '10000000', 'occupied_kg', '0', 'reserved_inbound_kg', '0')),
    pg_temp.authority('authK', 'khunou', 'walletK', 100, 1),
    pg_temp.authority('authKop', 'kopano', 'walletKop', 100, 1)))::text, true);

-- Lot A: issued to khunou (slot 200), 2,000 kg transferred to buyer-smelter (slot 300).
select set_config('t.b2', pg_temp.batch(100, 200,
  jsonb_build_array(pg_temp.tx(2, 200, 1)),
  jsonb_build_array(pg_temp.ev(2, 0, 200, 'IssueLot', 'LotIssued', 'lot', pg_temp.a('lotA'), '0', null,
    jsonb_build_object('lot', pg_temp.a('lotA')))),
  jsonb_build_array(
    pg_temp.lot(pg_temp.a('lotA'), 'CR-0001', pg_temp.a('intakeA'), null, pg_temp.a('mintA'), '5000', '0', 200, 2, 'khunou', 200),
    pg_temp.intake(pg_temp.a('intakeA'), pg_temp.a('lotA'), repeat('01', 32), 200, 2),
    pg_temp.pos(pg_temp.a('posAk'), pg_temp.a('lotA'), 'khunou', '5000', 200, 2)))::text, true);
select set_config('t.b3', pg_temp.batch(200, 300,
  jsonb_build_array(pg_temp.tx(3, 300, 1)),
  jsonb_build_array(pg_temp.ev(3, 0, 300, 'Transfer', 'UnitsTransferred', 'lot', pg_temp.a('lotA'), '1', null,
    jsonb_build_object('lot', pg_temp.a('lotA')))),
  jsonb_build_array(
    pg_temp.lot(pg_temp.a('lotA'), 'CR-0001', pg_temp.a('intakeA'), null, pg_temp.a('mintA'), '5000', '1', 300, 3, 'khunou', 200),
    pg_temp.pos(pg_temp.a('posAk'), pg_temp.a('lotA'), 'khunou', '3000', 300, 3),
    pg_temp.pos(pg_temp.a('posAb'), pg_temp.a('lotA'), 'buyer', '2000', 300, 3)))::text, true);

-- Lot B: issued to khunou (400), split into child C (500), the child's whole position
-- transferred to buyer-smelter (600), who never held B.
select set_config('t.b4', pg_temp.batch(300, 400,
  jsonb_build_array(pg_temp.tx(4, 400, 1)),
  jsonb_build_array(pg_temp.ev(4, 0, 400, 'IssueLot', 'LotIssued', 'lot', pg_temp.a('lotB'), '0', null,
    jsonb_build_object('lot', pg_temp.a('lotB')))),
  jsonb_build_array(
    pg_temp.lot(pg_temp.a('lotB'), 'CR-0002', pg_temp.a('intakeB'), null, pg_temp.a('mintB'), '4000', '0', 400, 4, 'khunou', 400),
    pg_temp.intake(pg_temp.a('intakeB'), pg_temp.a('lotB'), repeat('02', 32), 400, 4),
    pg_temp.pos(pg_temp.a('posBk'), pg_temp.a('lotB'), 'khunou', '4000', 400, 4)))::text, true);
select set_config('t.b5', pg_temp.batch(400, 500,
  jsonb_build_array(pg_temp.tx(5, 500, 1)),
  jsonb_build_array(pg_temp.ev(5, 0, 500, 'Split', 'LotSplit', 'lot', pg_temp.a('lotB'), '1', null,
    jsonb_build_object('parent', pg_temp.a('lotB'), 'child', pg_temp.a('lotC')))),
  jsonb_build_array(
    pg_temp.lot(pg_temp.a('lotB'), 'CR-0002', pg_temp.a('intakeB'), null, pg_temp.a('mintB'), '3000', '1', 500, 5, 'khunou', 400),
    pg_temp.lot(pg_temp.a('lotC'), 'CR-0002-A', pg_temp.a('intakeB'), pg_temp.a('lotB'), pg_temp.a('mintC'), '1000', '0', 500, 5, 'khunou', 500),
    pg_temp.pos(pg_temp.a('posBk'), pg_temp.a('lotB'), 'khunou', '3000', 500, 5),
    pg_temp.pos(pg_temp.a('posCk'), pg_temp.a('lotC'), 'khunou', '1000', 500, 5)))::text, true);
select set_config('t.b6', pg_temp.batch(500, 600,
  jsonb_build_array(pg_temp.tx(6, 600, 1)),
  jsonb_build_array(pg_temp.ev(6, 0, 600, 'Transfer', 'UnitsTransferred', 'lot', pg_temp.a('lotC'), '1', null,
    jsonb_build_object('lot', pg_temp.a('lotC')))),
  jsonb_build_array(
    pg_temp.lot(pg_temp.a('lotC'), 'CR-0002-A', pg_temp.a('intakeB'), pg_temp.a('lotB'), pg_temp.a('mintC'), '1000', '1', 600, 6, 'khunou', 500),
    pg_temp.pos(pg_temp.a('posCk'), pg_temp.a('lotC'), 'khunou', '0', 600, 6),
    pg_temp.pos(pg_temp.a('posCb'), pg_temp.a('lotC'), 'buyer', '1000', 600, 6)))::text, true);

insert into auth.users (id, email, email_confirmed_at, aud, role) values
  ('40000000-0000-4000-8000-000000000001', 'chain-khunou@example.test', now(), 'authenticated', 'authenticated'),
  ('40000000-0000-4000-8000-000000000002', 'chain-kopano@example.test', now(), 'authenticated', 'authenticated'),
  ('40000000-0000-4000-8000-000000000003', 'chain-buyer@example.test', now(), 'authenticated', 'authenticated'),
  ('40000000-0000-4000-8000-000000000004', 'chain-lender@example.test', now(), 'authenticated', 'authenticated'),
  ('40000000-0000-4000-8000-000000000005', 'chain-nobody@example.test', now(), 'authenticated', 'authenticated');
insert into public.memberships (organisation_id, user_id, member_role)
select organisations.id, fixture.user_id::uuid, 'member'
from (values
  ('khunou', '40000000-0000-4000-8000-000000000001'),
  ('kopano', '40000000-0000-4000-8000-000000000002'),
  ('buyer-smelter', '40000000-0000-4000-8000-000000000003'),
  ('lender-two', '40000000-0000-4000-8000-000000000004')
) as fixture(slug, user_id)
join public.organisations on organisations.slug = fixture.slug;

create function pg_temp.as_user(n int) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', '40000000-0000-4000-8000-00000000000' || n,
    'role', 'authenticated')::text, true)
$$;

-- ---------------------------------------------------------------------------------------------
-- 1. RLS on every new table; anon selects nothing.
select is(
  (select count(*)::int from pg_catalog.pg_class
    where relnamespace = 'public'::regnamespace and relrowsecurity
      and relname in ('indexer_checkpoints', 'chain_transactions', 'chain_events', 'chain_protocols',
        'chain_class_policies', 'chain_organisations', 'chain_authorities', 'chain_custodian_classes',
        'chain_documents', 'chain_intakes', 'chain_lots', 'chain_positions')),
  12, '1. RLS is enabled on all twelve read-model tables');
select is_empty(
  $$select relname from pg_catalog.pg_class
    where relnamespace = 'public'::regnamespace and (relname like 'chain\_%' or relname = 'indexer_checkpoints')
      and relkind = 'r'
      and (has_table_privilege('anon', oid, 'SELECT') or has_any_column_privilege('anon', oid, 'SELECT'))$$,
  '1. anon has no SELECT on any read-model table');

-- 2. No role writes directly; authenticated and anon cannot execute the write functions.
select is_empty(
  $$select relname || ' ' || role || ' ' || privilege from pg_catalog.pg_class,
      unnest(array['anon', 'authenticated', 'service_role']) as role,
      unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) as privilege
    where relnamespace = 'public'::regnamespace and (relname like 'chain\_%' or relname = 'indexer_checkpoints')
      and relkind = 'r' and has_table_privilege(role, oid, privilege)$$,
  '2. no API role may insert, update, delete or truncate a read-model table');
select is_empty(
  $$select p.proname || ' ' || role from pg_catalog.pg_proc p,
      unnest(array['anon', 'authenticated']) as role
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('indexer_checkpoint', 'indexer_apply', 'indexer_halt', 'indexer_finalize',
        'indexer_reconcile', 'indexer_reset')
      and has_function_privilege(role, p.oid, 'EXECUTE')$$,
  '2. anon and authenticated cannot execute the write functions');
select is(
  (select count(*)::int from pg_catalog.pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('indexer_checkpoint', 'indexer_apply', 'indexer_halt', 'indexer_finalize',
        'indexer_reconcile', 'indexer_reset')
      and p.prosecdef and has_function_privilege('service_role', p.oid, 'EXECUTE')),
  6, '2. the six write functions are security definer and executable by service_role');
select is_empty(
  $$select p.proname from pg_catalog.pg_proc p
    where p.pronamespace = 'private'::regnamespace
      and p.proname in ('is_u64', 'is_i64', 'is_address', 'are_addresses')
      and (has_function_privilege('anon', p.oid, 'EXECUTE')
        or has_function_privilege('authenticated', p.oid, 'EXECUTE'))$$,
  '2. the value-check functions are not executable by anon or authenticated');

-- 3. authenticated cannot read transactions or the operator-only checkpoint columns.
select ok(not has_table_privilege('authenticated', 'public.chain_transactions', 'SELECT')
  and not has_any_column_privilege('authenticated', 'public.chain_transactions', 'SELECT'),
  '3. authenticated cannot select chain_transactions');
select ok(not has_column_privilege('authenticated', 'public.indexer_checkpoints', 'halt_detail', 'SELECT')
  and not has_column_privilege('authenticated', 'public.indexer_checkpoints', 'halted_signature', 'SELECT')
  and not has_column_privilege('authenticated', 'public.indexer_checkpoints', 'consecutive_rpc_errors', 'SELECT'),
  '3. authenticated cannot select halt_detail, halted_signature or the error count');
select ok(has_column_privilege('authenticated', 'public.indexer_checkpoints', 'status', 'SELECT')
  and has_column_privilege('authenticated', 'public.indexer_checkpoints', 'halt_reason', 'SELECT')
  and has_column_privilege('authenticated', 'public.indexer_checkpoints', 'last_success_at', 'SELECT'),
  '3. authenticated can select the freshness columns');

-- Write the fixtures through the functions, as the worker does.
set local role service_role;
select lives_ok($$select public.indexer_checkpoint(pg_temp.stream(), null, '{}'::jsonb)$$,
  'indexer_checkpoint creates the stream row');
select lives_ok($$select public.indexer_apply(current_setting('t.b1')::jsonb)$$, 'batch 1 applies');
select lives_ok($$select public.indexer_apply(current_setting('t.b2')::jsonb)$$, 'batch 2 applies');
select lives_ok($$select public.indexer_apply(current_setting('t.b3')::jsonb)$$, 'batch 3 applies');
select lives_ok($$select public.indexer_apply(current_setting('t.b4')::jsonb)$$, 'batch 4 applies');
select lives_ok($$select public.indexer_apply(current_setting('t.b5')::jsonb)$$, 'batch 5 applies');
select lives_ok($$select public.indexer_apply(current_setting('t.b6')::jsonb)$$, 'batch 6 applies');
select is(pg_temp.cursor(), 600::bigint, 'the cursor is at the last batch');
select lives_ok($$select public.indexer_checkpoint(pg_temp.stream(), 600, '{"status":"live","lastPollAt":"2026-11-26T00:10:00Z","lastSuccessAt":"2026-11-26T00:10:01Z","consecutiveRpcErrors":0}'::jsonb)$$,
  'indexer_checkpoint patches status and times');
reset role;
select is((select status::text from public.indexer_checkpoints), 'live', 'the stream is live');
select is((select count(*)::int from public.chain_events), 7, 'seven events stored');

-- 4. Lot visibility.
set local role authenticated;
select pg_temp.as_user(1); -- khunou
select set_eq($$select address from public.chain_lots$$,
  array[pg_temp.a('lotA'), pg_temp.a('lotB'), pg_temp.a('lotC')], '4. khunou reads every lot it held');
select set_eq($$select address from public.chain_positions where lot = pg_temp.a('lotA')$$,
  array[pg_temp.a('posAk'), pg_temp.a('posAb')], '4. khunou reads both positions on lot A');
select set_eq($$select lot_revision from public.chain_events where lot = pg_temp.a('lotA')$$,
  array['0', '1'], '4. khunou reads lot A''s events');
select is((select count(*)::int from public.chain_events where scope = 'organisation'), 1,
  '4. khunou reads its own organisation event');

select pg_temp.as_user(2); -- kopano, the custodian
select set_eq($$select address from public.chain_lots$$,
  array[pg_temp.a('lotA'), pg_temp.a('lotB'), pg_temp.a('lotC')], '4. the custodian reads every lot it stores');
select set_eq($$select address from public.chain_positions where lot = pg_temp.a('lotA')$$,
  array[pg_temp.a('posAk'), pg_temp.a('posAb')], '4. the custodian reads lot A''s positions');
select set_eq($$select address from public.chain_intakes$$,
  array[pg_temp.a('intakeA'), pg_temp.a('intakeB')], '4. the custodian reads both intakes');
select is((select count(*)::int from public.chain_events where scope = 'organisation'), 0,
  '4. kopano does not read khunou''s organisation event');

select pg_temp.as_user(3); -- buyer-smelter
select set_eq($$select address from public.chain_lots$$,
  array[pg_temp.a('lotA'), pg_temp.a('lotC')], '4. buyer-smelter reads lot A and the child, not lot B');
select set_eq($$select address from public.chain_positions$$,
  array[pg_temp.a('posAk'), pg_temp.a('posAb'), pg_temp.a('posCk'), pg_temp.a('posCb')],
  '4. buyer-smelter reads the positions of the lots it reads');
select set_eq($$select address from public.chain_intakes$$,
  array[pg_temp.a('intakeA'), pg_temp.a('intakeB')], '4. buyer-smelter reads B''s intake through the child');
select set_eq($$select lot || ':' || lot_revision from public.chain_events where scope = 'lot'$$,
  array[pg_temp.a('lotA') || ':0', pg_temp.a('lotA') || ':1', pg_temp.a('lotC') || ':1'],
  '4. buyer-smelter reads the events of lot A and the child only');

select pg_temp.as_user(4); -- lender-two, a member with no part in any lot
select is_empty($$select address from public.chain_lots$$, '4. lender-two reads no lot');
select is_empty($$select address from public.chain_positions$$, '4. lender-two reads no position');
select is_empty($$select address from public.chain_intakes$$, '4. lender-two reads no intake');
select is_empty($$select 1 from public.chain_events where scope <> 'registry'$$,
  '4. lender-two reads no lot or organisation event');
select is((select count(*)::int from public.chain_events where scope = 'registry'), 1,
  '4. lender-two reads the registry event');
select is((select count(*)::int from public.chain_organisations), 4, '4. members read the directory');
select is((select count(*)::int from public.chain_protocols), 1, '4. members read the protocol');
select is((select status::text from public.indexer_checkpoints), 'live', '4. members read the stream status');

select pg_temp.as_user(5); -- no membership
select is_empty($$select 1 from public.indexer_checkpoints$$, '4. a user with no membership reads no checkpoint');
select is_empty($$select 1 from public.chain_organisations$$, '4. a user with no membership reads no organisation');
select is_empty($$select 1 from public.chain_protocols$$, '4. a user with no membership reads no protocol');
select is_empty($$select 1 from public.chain_events$$, '4. a user with no membership reads no event');
select is_empty($$select 1 from public.chain_lots$$, '4. a user with no membership reads no lot');
select throws_ok($$select 1 from public.chain_transactions$$, '42501', null,
  '3. selecting chain_transactions is refused');
select throws_ok($$select halt_detail from public.indexer_checkpoints$$, '42501', null,
  '3. selecting halt_detail is refused');

-- 5. Authorities are their organisation's own.
select pg_temp.as_user(1);
select set_eq($$select address from public.chain_authorities$$, array[pg_temp.a('authK')],
  '5. khunou reads only its own authority');
select pg_temp.as_user(2);
select set_eq($$select address from public.chain_authorities$$, array[pg_temp.a('authKop')],
  '5. kopano reads only its own authority');
reset role;

-- 6. A stale expected_through_slot is CURSOR_MOVED and writes nothing.
set local role service_role;
select throws_ok($$select public.indexer_checkpoint(pg_temp.stream(), 500, '{"status":"backfilling"}'::jsonb)$$,
  'P0001', 'CURSOR_MOVED', '6. indexer_checkpoint refuses a stale cursor');
select throws_ok($$select public.indexer_apply(pg_temp.batch(500, 700, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb))$$,
  'P0001', 'CURSOR_MOVED', '6. indexer_apply refuses a stale cursor');
select throws_ok($$select public.indexer_halt(pg_temp.stream(), 500, 'UNKNOWN_EVENT', 'decode: synthetic', pg_temp.sig(8))$$,
  'P0001', 'CURSOR_MOVED', '6. indexer_halt refuses a stale cursor');
select throws_ok($$select public.indexer_finalize(pg_temp.stream(), 500, array[pg_temp.sig(1)])$$,
  'P0001', 'CURSOR_MOVED', '6. indexer_finalize refuses a stale cursor');
select throws_ok($$select public.indexer_reconcile(pg_temp.stream(), 500, '[]'::jsonb, '[]'::jsonb)$$,
  'P0001', 'CURSOR_MOVED', '6. indexer_reconcile refuses a stale cursor');
reset role;
select is((select row(status::text, indexed_through_slot, halt_reason) from public.indexer_checkpoints),
  row('live'::text, 600::bigint, null::public.indexer_halt_reason), '6. the checkpoint is unchanged');
select is((select count(*)::int from public.chain_transactions where commitment = 'finalized'), 0,
  '6. nothing was finalized');

-- 7. (lot, lot_revision) is unique; a replay changes nothing.
set local role service_role;
select throws_ok(
  $$select public.indexer_apply(pg_temp.batch(600, 700, jsonb_build_array(pg_temp.tx(7, 700, 1)),
    jsonb_build_array(pg_temp.ev(7, 0, 700, 'Transfer', 'UnitsTransferred', 'lot', pg_temp.a('lotA'), '1', null,
      jsonb_build_object('lot', pg_temp.a('lotA')))), '[]'::jsonb))$$,
  'P0001', 'REVISION_SEQUENCE', '7. another signature repeating (lot A, 1) is REVISION_SEQUENCE');
select throws_ok($$select public.indexer_apply(current_setting('t.b3')::jsonb)$$,
  'P0001', 'CURSOR_MOVED', '7. a batch sent again with its old cursor is CURSOR_MOVED');
select lives_ok(
  $$select public.indexer_apply(jsonb_set(jsonb_set(current_setting('t.b3')::jsonb,
    '{expectedThroughSlot}', '600'), '{throughSlot}', '600'))$$,
  '7. the same rows sent again with the current cursor are accepted');
reset role;
select is((select count(*)::int from public.chain_events), 7, '7. no event was added');
select is((select count(*)::int from public.chain_transactions), 6, '7. no transaction was added');
select is((select supply_kg from public.chain_lots where address = pg_temp.a('lotA')), '5000',
  '7. the replay changed no projection');
select is(pg_temp.cursor(), 600::bigint, '7. the replay did not move the cursor');

-- 8. The upsert rule.
update public.chain_lots set created_at = timestamptz '2026-01-01 00:00:00+00'
  where address = pg_temp.a('lotA');
set local role service_role;
select lives_ok(
  $$select public.indexer_apply(pg_temp.batch(600, 700, jsonb_build_array(pg_temp.tx(8, 700, 0)),
    '[]'::jsonb, jsonb_build_array(jsonb_set(jsonb_set(
      pg_temp.lot(pg_temp.a('lotA'), 'CR-0001', pg_temp.a('intakeA'), null, pg_temp.a('mintA'), '1', '0', 250, 8, 'khunou', 200),
      '{row,event_revision}', '"9"'), '{row,live_children}', '7'))))$$,
  '8. an older read of lot A applies');
reset role;
select is((select row(slot, supply_kg, revision, live_children, last_signature)
    from public.chain_lots where address = pg_temp.a('lotA')),
  row(300::bigint, '5000'::text, '1'::text, 0::bigint, pg_temp.sig(3)),
  '8. a lower slot keeps the account columns, slot and last_signature');
select is((select event_revision from public.chain_lots where address = pg_temp.a('lotA')), '9',
  '8. a lower slot still writes event_revision');
select is((select created_at from public.chain_lots where address = pg_temp.a('lotA')),
  timestamptz '2026-01-01 00:00:00+00', '8. created_at is kept');
select ok((select updated_at from public.chain_lots where address = pg_temp.a('lotA')) > timestamptz '2026-01-02',
  '8. updated_at is refreshed');
set local role service_role;
select lives_ok(
  $$select public.indexer_reconcile(pg_temp.stream(), 700, jsonb_build_array(jsonb_set(jsonb_set(jsonb_set(
      pg_temp.lot(pg_temp.a('lotA'), 'CR-0001', pg_temp.a('intakeA'), null, pg_temp.a('mintA'), '5000', '1', 650, 3, 'khunou', 200),
      '{row,commitment}', '"finalized"'), '{row,last_signature}', 'null'), '{row,event_revision}', '"0"')),
    '[]'::jsonb)$$,
  '8. reconcile promotes lot A at slot 650');
reset role;
select is((select row(slot, commitment::text, last_signature, event_revision)
    from public.chain_lots where address = pg_temp.a('lotA')),
  row(650::bigint, 'finalized'::text, null::text, '9'::text),
  '8. reconcile wrote slot and commitment, cleared last_signature, kept the event columns');
set local role service_role;
select lives_ok(
  $$select public.indexer_apply(pg_temp.batch(700, 800, jsonb_build_array(jsonb_set(pg_temp.tx(8, 800, 0),
      '{signature}', to_jsonb(pg_temp.sig(7)))),
    '[]'::jsonb, jsonb_build_array(
      pg_temp.lot(pg_temp.a('lotA'), 'CR-0001', pg_temp.a('intakeA'), null, pg_temp.a('mintA'), '5000', '1', 650, 7, 'khunou', 200))))$$,
  '8. a confirmed read at the same slot applies');
reset role;
select is((select commitment::text from public.chain_lots where address = pg_temp.a('lotA')), 'finalized',
  '8. at an equal slot, finalized wins');

-- 10. indexer_reconcile never inserts.
set local role service_role;
select throws_ok(
  $$select public.indexer_reconcile(pg_temp.stream(), 800, jsonb_build_array(
      pg_temp.pos(pg_temp.a('mintA'), pg_temp.a('lotA'), 'khunou', '1', 650, 3)), '[]'::jsonb)$$,
  'P0001', 'EVENT_GAP', '10. reconcile raises EVENT_GAP for a row it would have to insert');
select throws_ok(
  $$select public.indexer_reconcile(pg_temp.stream(), 800, '[]'::jsonb,
      jsonb_build_array(jsonb_build_object('address', pg_temp.a('mintB'), 'slug', 'x', 'synthetic', true)))$$,
  'P0001', 'EVENT_GAP', '10. reconcile raises EVENT_GAP for an unknown organisation');
reset role;
select is((select count(*)::int from public.chain_positions), 5, '10. no position was inserted');

-- 11. u64 checks are false, never a cast error.
select is(private.is_u64('01'), false, '11. is_u64 refuses 01');
select is(private.is_u64('-0'), false, '11. is_u64 refuses -0');
select is(private.is_u64('abc'), false, '11. is_u64 refuses abc');
select is(private.is_u64('18446744073709551616'), false, '11. is_u64 refuses 2^64');
select is(private.is_u64('18446744073709551615'), true, '11. is_u64 accepts 2^64 - 1');
select is(private.is_i64('-9223372036854775809'), false, '11. is_i64 refuses -2^63 - 1');
set local role service_role;
select throws_ok(
  $$select public.indexer_apply(pg_temp.batch(800, 900, jsonb_build_array(jsonb_set(pg_temp.tx(8, 900, 0),
      '{signature}', to_jsonb(pg_temp.sig(6) || 'x'))), '[]'::jsonb, jsonb_build_array(
      pg_temp.pos(pg_temp.a('posAk'), pg_temp.a('lotA'), 'khunou', '01', 900, 8))))$$,
  'P0001', 'ROW_INVALID', '11. a u64 column refuses 01 as ROW_INVALID');
select throws_ok(
  $$select public.indexer_apply(pg_temp.batch(800, 900, jsonb_build_array(jsonb_set(pg_temp.tx(8, 900, 0),
      '{signature}', to_jsonb(pg_temp.sig(6) || 'y'))), '[]'::jsonb, jsonb_build_array(
      pg_temp.pos(pg_temp.a('posAk'), pg_temp.a('lotA'), 'khunou', '18446744073709551616', 900, 8))))$$,
  'P0001', 'ROW_INVALID', '11. a u64 column refuses 2^64 as ROW_INVALID');
reset role;
select is((select quantity_kg from public.chain_positions where address = pg_temp.a('posAk')), '3000',
  '11. the refused rows changed nothing');

-- 9. The halted state, reset and the one-stream rule.
set local role service_role;
select throws_ok($$select public.indexer_reset(pg_temp.stream())$$, 'P0001', 'INDEXER_TRANSITION',
  '9. indexer_reset refuses a stream that is not halted');
select throws_ok($$select public.indexer_checkpoint(pg_temp.stream(), 800, '{"status":"halted"}'::jsonb)$$,
  'P0001', 'INDEXER_TRANSITION', '9. indexer_checkpoint never enters halted');
select is(
  (select public.indexer_halt(pg_temp.stream(), 800, 'UNKNOWN_EVENT', 'decode: synthetic', pg_temp.sig(8)) - 'haltedAt'),
  jsonb_build_object('reason', 'UNKNOWN_EVENT', 'detail', 'decode: synthetic', 'signature', pg_temp.sig(8)),
  '9. indexer_halt returns the persisted halt');
select is(
  (select public.indexer_halt(pg_temp.stream(), 800, 'EVENT_GAP', 'sequence: other', null) ->> 'reason'),
  'UNKNOWN_EVENT', '9. a second halt keeps the first reason');
select throws_ok($$select public.indexer_checkpoint(pg_temp.stream(), 800, '{"status":"live"}'::jsonb)$$,
  'P0001', 'INDEXER_HALTED', '9. indexer_checkpoint never leaves halted');
select throws_ok($$select public.indexer_apply(pg_temp.batch(800, 900, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb))$$,
  'P0001', 'INDEXER_HALTED', '9. indexer_apply refuses a halted stream');
select is((select public.indexer_reset(pg_temp.stream()) ->> 'reason'), 'UNKNOWN_EVENT',
  '9. indexer_reset returns the cleared halt');
reset role;
select is(
  (select count(*)::int from (
    select 1 from public.chain_transactions union all select 1 from public.chain_events
    union all select 1 from public.chain_protocols union all select 1 from public.chain_class_policies
    union all select 1 from public.chain_organisations union all select 1 from public.chain_authorities
    union all select 1 from public.chain_custodian_classes union all select 1 from public.chain_documents
    union all select 1 from public.chain_intakes union all select 1 from public.chain_lots
    union all select 1 from public.chain_positions) as everything),
  0, '9. reset leaves no transaction, event or projection row');
select is(
  (select row(count(*), min(status::text), min(indexed_through_slot), bool_and(halt_reason is null
      and halt_detail is null and halted_signature is null and halted_at is null
      and last_poll_at is null and last_success_at is null and consecutive_rpc_errors = 0))
    from public.indexer_checkpoints),
  row(1::bigint, 'backfilling'::text, null::bigint, true),
  '9. reset leaves one cleared backfilling checkpoint');
set local role service_role;
select throws_ok($$select public.indexer_checkpoint(pg_temp.stream(pg_temp.a('otherProtocol')), null, '{}'::jsonb)$$,
  'P0001', 'STREAM_INVALID', '9. a second stream''s checkpoint is refused');
select throws_ok($$select public.indexer_checkpoint('{"network":"mainnet"}'::jsonb, null, '{}'::jsonb)$$,
  'P0001', 'STREAM_INVALID', '9. a malformed stream is refused');
reset role;
select is((select count(*)::int from public.indexer_checkpoints), 1, '9. still one checkpoint row');

select * from finish();
rollback;
