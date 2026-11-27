-- Phase 3, the shortfall and restriction part, of the chain read model: chain_incidents,
-- can_read_incident and the incident arm of the custody events policy (live-custody.md §6.7, §9.2 and
-- its T063d.5 pre-check folds).
-- SYNTHETIC: every address, signature and slot below is made up (base58 of repeated bytes); only the
-- program id is the real devnet program. Quantities and sites are demo.md §2–§4's. Inspector Test Org
-- and Custodian Two Test Org are test-only organisations, never in the demo cast.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(34);

-- A clean slate inside this transaction (rolled back at the end).
delete from public.chain_incidents;
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

create function pg_temp.a(name text) returns text language sql immutable as $$
  select case name
    when 'program' then 'jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3'
    when 'protocol' then '6QWeT6FpJrm8AF1btu6WH2k2Xhq6t5vbheKVfQavmenJ'
    when 'khunou' then '6URwbPipuA4MJLG7LCRRZuWnms3JZ9cRG3z9indXWz6z'
    when 'kopano' then '6YMEjhBqVTMaSRWcmVkLrnHZ22FWEDJEpTeonAg8GKRg'
    when 'lender1' then '6gBq2J7rg3x2ic1de6QBSXq5WLfuaLfswGz7tvmKkz54'
    when 'class' then '6p2RJu3sreYUznWeWh422HNbzf6JvU3X46KS1grXFeiS'
    when 'site' then '6swiTCWtSwqi8sm9wzNwKA9NEpJWbXjLcVz654u7zz38'
    when 'lot' then '6ws1bVyu3F8wGy1fPHhrc2v8UyWiGbRAAuek8SwikKMp'
    when 'intake' then '71nJjoSudYSAR4GApb2mtugtj8iuwf6yjKKQBpzKVegW'
    when 'posK' then '75hbt6uvDqjPZ9WgFtMhBnTeyHw7cinoHiz4FD2vEz1C'
    when 'mint' then '7DYCAhqwQSKqqL1h8V1XmY1BTcMWxrASQYKNMy87jeea'
    when 'fac1' then '7HTVK1Jwzjd4yRGCZnLT4QmwhmZidurFxwz2RMAiUyyG'
    when 'walletK' then '86V32cu56KBneWGHoNFUYv36dg68ig66fqyu7uhuSyqY'
    when 'port' then 'AjKZcN4U9wmd6325p1yJu48r9sHyz9s5TkyVPjTGaySo'
    when 'mosela' then 'AoErkfXUkF4rE8GbFKJEBvucQ2WBfDYu2Ae9T7VsLJmW'
    when 'portSite' then 'AsA9txzVLYN5NDX6gcd9UogNeBiPLHEiaaJoWVYU5e6D'
    when 'doc' then 'Aw5T3GTVvqfJWJmc7ux4mgT8tLvb1LvY8yyTZsb4pyQv'
    when 's1' then 'AzzkBZvWX8xXeQ27ZDGz4ZDu8W8ngQcMhPe7dFdfaJjd'
    when 'b1' then 'B4v3KsPX7SFknVGczWbuMRzfNfLzMUJBFoJmgdgGKe4L'
    when 'inspector' then 'E3M3d7sy8ZKivUGxBexL9wxE7ebqzGWFqkdeFMedCJFS'
    when 'inc1' then 'E7GLmRLyircx4ZXTcxHFSpizMop3fLC5QAJJJjhDwda9'
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
  end
$$;

create function pg_temp.org(slug text) returns text language sql stable as $$
  select id::text from public.organisations where organisations.slug = org.slug
$$;

create function pg_temp.slug(name text) returns text language sql immutable as $$
  select case name when 'lender1' then 'lender-one' when 'port' then 'port-t1'
    when 'inspector' then 'inspector-test' else name end
$$;

create function pg_temp.stream() returns jsonb language sql immutable as $$
  select jsonb_build_object('network', 'devnet', 'programId', pg_temp.a('program'),
    'protocol', pg_temp.a('protocol'))
$$;

create function pg_temp.at(slot bigint) returns text language sql immutable as $$
  select to_char(timestamptz '2026-11-28 00:00:00+00' + make_interval(secs => slot), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
$$;

create function pg_temp.tx(n int, slot bigint, events int) returns jsonb language sql immutable as $$
  select jsonb_build_object('network', 'devnet', 'program_id', pg_temp.a('program'),
    'signature', pg_temp.sig(n), 'slot', slot, 'block_time', pg_temp.at(slot), 'succeeded', true,
    'protocol', pg_temp.a('protocol'), 'event_count', events, 'other_instance', false)
$$;

create function pg_temp.ev(n int, idx int, slot bigint, instruction text, event text, scope text,
  keys jsonb) returns jsonb language sql immutable as $$
  select jsonb_build_object('network', 'devnet', 'program_id', pg_temp.a('program'),
    'signature', pg_temp.sig(n), 'event_index', idx, 'slot', slot, 'block_time', pg_temp.at(slot),
    'protocol', pg_temp.a('protocol'), 'instruction', instruction, 'event', event, 'scope', scope,
    'lot', null, 'lot_revision', null, 'org_id', null, 'data', jsonb_build_object('synthetic', true),
    'facility', null, 'loan', null, 'loan_revision', null, 'pool', null, 'pool_revision', null,
    'valuation', null, 'valuation_version', null, 'created', null,
    'shipment', null, 'shipment_revision', null, 'batch', null, 'batch_sequence', null,
    'observation_index', null, 'acceptance', null, 'acceptance_version', null) || keys
$$;

create function pg_temp.up(tbl text, address text, slot bigint, n int, fields jsonb) returns jsonb
language sql immutable as $$
  select jsonb_build_object('table', tbl, 'row', jsonb_build_object('network', 'devnet',
    'address', address, 'protocol', pg_temp.a('protocol'), 'slot', slot,
    'commitment', 'confirmed', 'last_signature', pg_temp.sig(n)) || fields)
$$;

create function pg_temp.organisation(name text, display text, role text) returns jsonb
language sql stable as $$
  select pg_temp.up('chain_organisations', pg_temp.a(name), 100, 1, jsonb_build_object(
    'org_id', pg_temp.org(pg_temp.slug(name)), 'slug', pg_temp.slug(name), 'synthetic', true,
    'role', role, 'display_name', display, 'admin', pg_temp.a('walletK'), 'related', '[]'::jsonb))
$$;

create function pg_temp.site(address text, custodian text, site text, occupied text, slot bigint, n int)
returns jsonb language sql stable as $$
  select pg_temp.up('chain_custodian_classes', pg_temp.a(address), slot, n, jsonb_build_object(
    'custodian', pg_temp.a(custodian), 'custodian_org_id', pg_temp.org(pg_temp.slug(custodian)),
    'class_policy', pg_temp.a('class'), 'site_code', site, 'approved_capacity_kg', '10000000',
    'occupied_kg', occupied, 'reserved_inbound_kg', '0'))
$$;

create function pg_temp.batch(expected bigint, through bigint, txs jsonb, evs jsonb, ups jsonb)
returns jsonb language sql immutable as $$
  select jsonb_build_object('stream', pg_temp.stream(), 'expectedThroughSlot', expected,
    'throughSlot', through, 'transactions', txs, 'events', evs, 'upserts', ups)
$$;

create function pg_temp.one(expected bigint, through bigint, n int, ev jsonb, ups jsonb) returns jsonb
language sql immutable as $$
  select pg_temp.batch(expected, through,
    jsonb_build_array(pg_temp.tx(n, through, case when ev is null then 0 else 1 end)),
    case when ev is null then '[]'::jsonb else jsonb_build_array(ev) end, ups)
$$;

-- CR-0001 stored at Kopano, held by Khunou.
create function pg_temp.lot(revision text, restriction text, slot bigint, n int) returns jsonb
language sql stable as $$
  select pg_temp.up('chain_lots', pg_temp.a('lot'), slot, n, jsonb_build_object(
    'lot_id', 'CR-0001', 'class_policy', pg_temp.a('class'), 'class_version', 1, 'grade', 'G1',
    'custodian_class', pg_temp.a('site'), 'custodian', pg_temp.a('kopano'),
    'custodian_org_id', pg_temp.org('kopano'), 'intake', pg_temp.a('intake'), 'parent', null,
    'root', pg_temp.a('lot'), 'mint', pg_temp.a('mint'), 'supply_kg', '5000000', 'state', 'Stored',
    'restriction', restriction, 'expires_at', '1800000000', 'revision', revision, 'live_children', 0,
    'event_revision', revision, 'issued_owner', pg_temp.a('khunou'),
    'issued_owner_org_id', pg_temp.org('khunou'), 'issued_at', pg_temp.at(200)))
$$;

-- B1's incident: observed 4,990,000 of 5,000,000 kg at 0 bps, so the lot becomes ReviewRequired.
create function pg_temp.incident(slot bigint, n int) returns jsonb language sql stable as $$
  select pg_temp.up('chain_incidents', pg_temp.a('inc1'), slot, n, jsonb_build_object(
    'incident_id_hex', repeat('89', 16), 'lot', pg_temp.a('lot'), 'batch', pg_temp.a('b1'),
    'inspector', pg_temp.a('inspector'), 'inspector_org_id', pg_temp.org('inspector-test'),
    'method_code', 'WEIGH', 'expected_kg', '5000000', 'observed_kg', '4990000', 'tolerance_bps', 0,
    'within_tolerance', false, 'evidence_digest_hex', repeat('99', 32), 'observed_at', '1795000500',
    'restriction_after', 'ReviewRequired', 'status', 'Open'))
$$;

-- Members: khunou (1), kopano (2), port-t1 (3), mosela (4), lender-one (5), Inspector Test Org (6),
-- Custodian Two Test Org (7). The tenancy kind of the test-only inspector is accreditor: public.org_kind
-- has no inspector, and RLS reads memberships, not kinds (T063d.5 pre-check fold 8).
insert into public.organisations (id, slug, name, kind, synthetic) values
  ('11000000-0000-4000-8000-000000000008', 'inspector-test', 'Inspector Test Org', 'accreditor', true),
  ('11000000-0000-4000-8000-0000000000c2', 'custodian-two-test', 'Custodian Two Test Org', 'custodian', true);

-- The fixtures, built as postgres and kept as settings.
-- 100: the registry (protocol, class, the organisations, both sites).
select set_config('t.b1', pg_temp.batch(null, 100,
  jsonb_build_array(pg_temp.tx(1, 100, 1)),
  jsonb_build_array(pg_temp.ev(1, 0, 100, 'InitializeProtocol', 'ProtocolInitialized', 'registry', '{}')),
  jsonb_build_array(
    pg_temp.up('chain_protocols', pg_temp.a('protocol'), 100, 1, jsonb_build_object(
      'instance_id_hex', '666961742d6174746573746174696f6e', 'settlement_mode', 'FiatAttestationTest',
      'admin', pg_temp.a('walletK'), 'accreditor', pg_temp.a('walletK'), 'pause_flags', 0)),
    pg_temp.up('chain_class_policies', pg_temp.a('class'), 100, 1, jsonb_build_object(
      'class_code', 'CHROME', 'version', 1, 'unit', 'Kilogram', 'grades', '["G1"]'::jsonb,
      'origin_required', false, 'lot_validity_secs', '7776000', 'split_inherits_expiry', true)),
    pg_temp.organisation('khunou', 'Khunou Ore Exports', 'Exporter'),
    pg_temp.organisation('kopano', 'Kopano Stockyard Custody', 'Custodian'),
    pg_temp.organisation('lender1', 'Lender One Bank', 'Lender'),
    pg_temp.organisation('port', 'Port Terminal T1', 'Terminal'),
    pg_temp.organisation('mosela', 'Mosela Haulage', 'Transporter'),
    pg_temp.organisation('inspector', 'Inspector Test Org', 'Inspector'),
    pg_temp.site('site', 'kopano', 'KOPANO-YARD-1', '5000000', 100, 1),
    pg_temp.site('portSite', 'port', 'PORT-T1', '0', 100, 1)))::text, true);
-- 200: CR-0001 issued to Khunou at Kopano; Lender One's facility to Khunou.
select set_config('t.b2', pg_temp.batch(100, 200,
  jsonb_build_array(pg_temp.tx(2, 200, 2)),
  jsonb_build_array(
    pg_temp.ev(2, 0, 200, 'IssueLot', 'LotIssued', 'lot',
      jsonb_build_object('lot', pg_temp.a('lot'), 'lot_revision', '0')),
    pg_temp.ev(2, 1, 200, 'OpenFacility', 'FacilityOpened', 'facility',
      jsonb_build_object('facility', pg_temp.a('fac1'), 'created', pg_temp.a('fac1')))),
  jsonb_build_array(
    pg_temp.lot('0', 'Normal', 200, 2),
    pg_temp.up('chain_intakes', pg_temp.a('intake'), 200, 2, jsonb_build_object(
      'custodian', pg_temp.a('kopano'), 'custodian_org_id', pg_temp.org('kopano'),
      'intake_digest_hex', repeat('01', 32), 'lot', pg_temp.a('lot'), 'retired', false)),
    pg_temp.up('chain_positions', pg_temp.a('posK'), 200, 2, jsonb_build_object(
      'lot', pg_temp.a('lot'), 'owner', pg_temp.a('khunou'), 'owner_org_id', pg_temp.org('khunou'),
      'quantity_kg', '5000000', 'locked_kg', '0', 'reserved_kg', '0', 'revision', '0')),
    pg_temp.up('chain_facilities', pg_temp.a('fac1'), 200, 2, jsonb_build_object(
      'lender', pg_temp.a('lender1'), 'lender_org_id', pg_temp.org('lender-one'),
      'borrower', pg_temp.a('khunou'), 'borrower_org_id', pg_temp.org('khunou'),
      'facility_id_hex', repeat('11', 16), 'currency', 'USD', 'currency_decimals', 2,
      'terms_version', 1, 'rate_bps', 1200, 'max_ltv_bps', 6000,
      'terms_digest_hex', repeat('21', 32), 'loan_count', 0))))::text, true);
-- 300: S1 to PORT-T1 with B1 carried by Mosela, already Cancelled (the owner's 27 Nov answer: a
-- shortfall on a batch of a Cancelled shipment stays allowed). The rows only, shipment-scoped.
select set_config('t.b3', pg_temp.one(200, 300, 3,
  pg_temp.ev(3, 0, 300, 'RegisterBatch', 'BatchRegistered', 'shipment', jsonb_build_object(
    'shipment', pg_temp.a('s1'), 'batch', pg_temp.a('b1'), 'created', pg_temp.a('b1'))),
  jsonb_build_array(
    pg_temp.up('chain_shipments', pg_temp.a('s1'), 300, 3, jsonb_build_object(
      'shipment_id_hex', repeat('22', 16), 'lot', pg_temp.a('lot'), 'position', pg_temp.a('posK'),
      'owner', pg_temp.a('khunou'), 'owner_org_id', pg_temp.org('khunou'),
      'source', pg_temp.a('site'), 'source_custodian', pg_temp.a('kopano'),
      'source_custodian_org_id', pg_temp.org('kopano'),
      'destination', pg_temp.a('portSite'), 'destination_custodian', pg_temp.a('port'),
      'destination_custodian_org_id', pg_temp.org('port-t1'),
      'committed_kg', '5000000', 'locked_kg', '0', 'batch_count', 1,
      'manifest_root_hex', '8df721d308bd44a37494f5362fff9cb0ac090efc83e7f2cb152177dc7b602486',
      'departure_document', pg_temp.a('doc'), 'registered_count', 1, 'registered_kg', '5000000',
      'departed_count', 0, 'departed_kg', '0', 'arrived_count', 0, 'arrived_kg', '0',
      'status', 'Cancelled', 'prepared_at', '1795000000', 'revision', '1', 'event_revision', '1',
      'event_registered', 1)),
    pg_temp.up('chain_batches', pg_temp.a('b1'), 300, 3, jsonb_build_object(
      'shipment', pg_temp.a('s1'), 'lot', pg_temp.a('lot'), 'batch_index', 0, 'batch_count', 1,
      'quantity_kg', '5000000', 'carrier', pg_temp.a('mosela'),
      'load_digest_hex', repeat('33', 32), 'manifest_digest_hex', repeat('44', 32),
      'holder', pg_temp.a('kopano'), 'holder_org_id', pg_temp.org('kopano'), 'stage', 'AtSource',
      'sequence', '0', 'observation_count', 0, 'departed_at', null, 'arrived_at', null,
      'event_sequence', '0', 'event_observations', 0))))::text, true);
-- 400: the inspector's shortfall on B1, outside tolerance: incident-scoped, created = the incident,
-- the batch named, no shipment and no lot key (live-custody.md §4.1.3); the lot goes ReviewRequired.
select set_config('t.b4', pg_temp.one(300, 400, 4,
  pg_temp.ev(4, 0, 400, 'AttestShortfall', 'ShortfallAttested', 'incident', jsonb_build_object(
    'created', pg_temp.a('inc1'), 'batch', pg_temp.a('b1'))),
  jsonb_build_array(pg_temp.incident(400, 4), pg_temp.lot('1', 'ReviewRequired', 400, 4)))::text, true);
-- 500: the accreditor freezes the lot: lot-scoped at revision 2.
select set_config('t.b5', pg_temp.one(400, 500, 5,
  pg_temp.ev(5, 0, 500, 'SetRestriction', 'RestrictionSet', 'lot',
    jsonb_build_object('lot', pg_temp.a('lot'), 'lot_revision', '2')),
  jsonb_build_array(pg_temp.lot('2', 'Frozen', 500, 5)))::text, true);

insert into auth.users (id, email, email_confirmed_at, aud, role) values
  ('45000000-0000-4000-8000-000000000001', 'short-khunou@example.test', now(), 'authenticated', 'authenticated'),
  ('45000000-0000-4000-8000-000000000002', 'short-kopano@example.test', now(), 'authenticated', 'authenticated'),
  ('45000000-0000-4000-8000-000000000003', 'short-port@example.test', now(), 'authenticated', 'authenticated'),
  ('45000000-0000-4000-8000-000000000004', 'short-mosela@example.test', now(), 'authenticated', 'authenticated'),
  ('45000000-0000-4000-8000-000000000005', 'short-lender-one@example.test', now(), 'authenticated', 'authenticated'),
  ('45000000-0000-4000-8000-000000000006', 'short-inspector@example.test', now(), 'authenticated', 'authenticated'),
  ('45000000-0000-4000-8000-000000000007', 'short-two@example.test', now(), 'authenticated', 'authenticated');
insert into public.memberships (organisation_id, user_id, member_role)
select organisations.id, fixture.user_id::uuid, 'member'
from (values
  ('khunou', '45000000-0000-4000-8000-000000000001'),
  ('kopano', '45000000-0000-4000-8000-000000000002'),
  ('port-t1', '45000000-0000-4000-8000-000000000003'),
  ('mosela', '45000000-0000-4000-8000-000000000004'),
  ('lender-one', '45000000-0000-4000-8000-000000000005'),
  ('inspector-test', '45000000-0000-4000-8000-000000000006'),
  ('custodian-two-test', '45000000-0000-4000-8000-000000000007')
) as fixture(slug, user_id)
join public.organisations on organisations.slug = fixture.slug;

create function pg_temp.as_user(n int) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', '45000000-0000-4000-8000-00000000000' || n,
    'role', 'authenticated')::text, true)
$$;

-- What a member reads of the shortfall: the incident and its event.
create function pg_temp.incident_view() returns setof text language sql stable as $$
  select 'incident ' || address from public.chain_incidents
  union all select 'event ' || event from public.chain_events where event = 'ShortfallAttested'
$$;
-- And of the restriction: the lot row and its RestrictionSet event.
create function pg_temp.restriction_view() returns setof text language sql stable as $$
  select 'lot ' || restriction from public.chain_lots
  union all select 'event ' || event from public.chain_events where event = 'RestrictionSet'
$$;

-- ---------------------------------------------------------------------------------------------
-- RLS on chain_incidents; anon selects nothing; no role writes it directly.
select ok(
  (select relrowsecurity from pg_catalog.pg_class
    where relnamespace = 'public'::regnamespace and relname = 'chain_incidents'),
  'RLS is enabled on chain_incidents');
select ok(
  not has_table_privilege('anon', 'public.chain_incidents', 'SELECT')
    and not has_any_column_privilege('anon', 'public.chain_incidents', 'SELECT'),
  'anon has no SELECT on chain_incidents');
select is_empty(
  $$select role || ' ' || privilege
    from unnest(array['anon', 'authenticated', 'service_role']) as role,
      unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) as privilege
    where has_table_privilege(role, 'public.chain_incidents', privilege)$$,
  'no API role may insert, update, delete or truncate chain_incidents');
select ok(
  has_table_privilege('authenticated', 'public.chain_incidents', 'SELECT')
    and has_table_privilege('service_role', 'public.chain_incidents', 'SELECT'),
  'authenticated and service_role may select chain_incidents');
select ok(
  has_function_privilege('authenticated', 'private.can_read_incident(text)', 'EXECUTE')
    and not has_function_privilege('anon', 'private.can_read_incident(text)', 'EXECUTE')
    and not has_function_privilege('service_role', 'private.can_read_incident(text)', 'EXECUTE'),
  'can_read_incident is granted to authenticated only');

-- Through the functions, as the worker writes.
set local role service_role;
select lives_ok($$select public.indexer_checkpoint(pg_temp.stream(), null, '{}'::jsonb)$$,
  'indexer_checkpoint creates the stream row');
select lives_ok($$select public.indexer_apply(current_setting('t.b1')::jsonb)$$, 'batch 1 applies');
select lives_ok($$select public.indexer_apply(current_setting('t.b2')::jsonb)$$, 'batch 2 applies');
select lives_ok($$select public.indexer_apply(current_setting('t.b3')::jsonb)$$, 'batch 3 applies');
select lives_ok($$select public.indexer_apply(current_setting('t.b4')::jsonb)$$,
  'the incident applies with its incident-scoped event naming the batch');
select lives_ok($$select public.indexer_apply(current_setting('t.b5')::jsonb)$$,
  'the restriction applies with its lot-scoped event');
-- The CHECKs mirror the program's field rules (program-custody.md §3).
select throws_ok(
  $$select public.indexer_apply(pg_temp.one(500, 600, 6, null, jsonb_build_array(
    jsonb_set(pg_temp.incident(600, 6), '{row,method_code}', '"weigh"'))))$$,
  'P0001', 'ROW_INVALID', 'a method code with lowercase letters is ROW_INVALID');
select throws_ok(
  $$select public.indexer_apply(pg_temp.one(500, 600, 6, null, jsonb_build_array(
    jsonb_set(pg_temp.incident(600, 6), '{row,tolerance_bps}', '10001'))))$$,
  'P0001', 'ROW_INVALID', 'a tolerance above 10,000 bps is ROW_INVALID');
select throws_ok(
  $$select public.indexer_apply(pg_temp.one(500, 600, 6, null, jsonb_build_array(
    jsonb_set(pg_temp.incident(600, 6), '{row,restriction_after}', '"Hold"'))))$$,
  'P0001', 'ROW_INVALID', 'a restriction outside the IDL''s variants is ROW_INVALID');
select throws_ok(
  $$select public.indexer_apply(pg_temp.one(500, 600, 6, null, jsonb_build_array(
    jsonb_set(pg_temp.incident(600, 6), '{row,status}', '"Resolved"'))))$$,
  'P0001', 'ROW_INVALID', 'an incident status other than Open is ROW_INVALID');
select throws_ok(
  $$select public.indexer_apply(pg_temp.one(500, 600, 6, null, jsonb_build_array(
    jsonb_set(pg_temp.incident(600, 6), '{row,observed_kg}', '"01"'))))$$,
  'P0001', 'ROW_INVALID', 'a non-canonical observed_kg is ROW_INVALID');
select lives_ok(
  $$select public.indexer_apply(pg_temp.one(500, 600, 6, null, jsonb_build_array(
    jsonb_set(jsonb_set(pg_temp.incident(600, 6), '{row,batch}', 'null'), '{row,tolerance_bps}', '10000'))))$$,
  'a whole-lot incident (no batch) at the 10,000 bps bound applies');
reset role;
select is(
  (select row(inspector_org_id::text, batch, restriction_after, status) from public.chain_incidents),
  row(pg_temp.org('inspector-test'), null::text, 'ReviewRequired'::text, 'Open'::text),
  'the incident row names the inspector''s org_id, ReviewRequired and Open');
set local role service_role;
select lives_ok(
  $$select public.indexer_apply(pg_temp.one(600, 700, 7, null, jsonb_build_array(pg_temp.incident(700, 7))))$$,
  'the incident names its batch again');
reset role;

-- Who reads what.
set local role authenticated;
select pg_temp.as_user(6); -- the inspector: no lot reader, reads its incident through its own arm
select set_eq('select * from pg_temp.incident_view()',
  array['incident ' || pg_temp.a('inc1'), 'event ShortfallAttested'],
  'the Inspector Test Org member reads the incident and its event');
select is_empty('select * from pg_temp.restriction_view()',
  'the inspector reads neither the lot nor the RestrictionSet event');
select pg_temp.as_user(1); -- khunou, the holder
select set_eq('select * from pg_temp.incident_view()',
  array['incident ' || pg_temp.a('inc1'), 'event ShortfallAttested'],
  'khunou, a lot reader, reads the incident and its event');
select set_eq('select * from pg_temp.restriction_view()',
  array['lot Frozen', 'event RestrictionSet'],
  'khunou reads the frozen lot and the RestrictionSet event');
select pg_temp.as_user(2); -- kopano, the lot's custodian
select set_eq('select * from pg_temp.incident_view()',
  array['incident ' || pg_temp.a('inc1'), 'event ShortfallAttested'],
  'kopano, the custodian, reads the incident and its event');
select pg_temp.as_user(5); -- lender-one, a facility to Khunou
select set_eq('select * from pg_temp.incident_view()',
  array['incident ' || pg_temp.a('inc1'), 'event ShortfallAttested'],
  'lender-one, a lot reader through its facility (decision 3), reads the incident and its event');
select set_eq('select * from pg_temp.restriction_view()',
  array['lot Frozen', 'event RestrictionSet'],
  'lender-one reads the frozen lot and the RestrictionSet event');
select pg_temp.as_user(4); -- mosela, the batch's carrier: reads the shipment, never the incident
select set_eq('select address from public.chain_batches', array[pg_temp.a('b1')],
  'mosela reads B1 as its carrier');
select is_empty('select * from pg_temp.incident_view()',
  'mosela, the carrier of the incident''s batch, reads neither the incident nor its event');
select is_empty('select * from pg_temp.restriction_view()',
  'mosela reads neither the lot nor the RestrictionSet event');
select pg_temp.as_user(3); -- port-t1, the cancelled shipment's destination, no lot reader
select is_empty('select * from pg_temp.incident_view() union all select * from pg_temp.restriction_view()',
  'port-t1 reads nothing of the shortfall or the restriction');
select pg_temp.as_user(7); -- Custodian Two Test Org, no role in any of them
select is_empty('select * from pg_temp.incident_view() union all select * from pg_temp.restriction_view()',
  'the Custodian Two Test Org member reads nothing of the shortfall or the restriction');
reset role;

-- indexer_reset clears the table.
set local role service_role;
select lives_ok($$select public.indexer_halt(pg_temp.stream(), 700, 'EVENT_GAP', 'sequence: synthetic', null)$$,
  'the stream halts');
select lives_ok($$select public.indexer_reset(pg_temp.stream())$$, 'indexer_reset clears the stream');
reset role;
select is((select count(*)::int from public.chain_incidents), 0, 'no row is left in chain_incidents');

select * from finish();
rollback;
