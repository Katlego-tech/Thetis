-- Phase 3, the handover part, of the chain read model: chain_handovers and the handover-party arm of
-- can_read_shipment (live-custody.md §6.4, §9.2 and its T063d.2 pre-check fold 5).
-- SYNTHETIC: every address, signature and slot below is made up (base58 of repeated bytes); only the
-- program id is the real devnet program. Quantities and sites are demo.md §2–§4's. Haulier Two Test
-- Org and Custodian Two Test Org are test-only organisations, never in the demo cast.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(29);

-- A clean slate inside this transaction (rolled back at the end).
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
    when 'class' then '6p2RJu3sreYUznWeWh422HNbzf6JvU3X46KS1grXFeiS'
    when 'site' then '6swiTCWtSwqi8sm9wzNwKA9NEpJWbXjLcVz654u7zz38'
    when 'lot' then '6ws1bVyu3F8wGy1fPHhrc2v8UyWiGbRAAuek8SwikKMp'
    when 'intake' then '71nJjoSudYSAR4GApb2mtugtj8iuwf6yjKKQBpzKVegW'
    when 'posK' then '75hbt6uvDqjPZ9WgFtMhBnTeyHw7cinoHiz4FD2vEz1C'
    when 'mint' then '7DYCAhqwQSKqqL1h8V1XmY1BTcMWxrASQYKNMy87jeea'
    when 'walletK' then '86V32cu56KBneWGHoNFUYv36dg68ig66fqyu7uhuSyqY'
    when 'port' then 'AjKZcN4U9wmd6325p1yJu48r9sHyz9s5TkyVPjTGaySo'
    when 'mosela' then 'AoErkfXUkF4rE8GbFKJEBvucQ2WBfDYu2Ae9T7VsLJmW'
    when 'portSite' then 'AsA9txzVLYN5NDX6gcd9UogNeBiPLHEiaaJoWVYU5e6D'
    when 'doc' then 'Aw5T3GTVvqfJWJmc7ux4mgT8tLvb1LvY8yyTZsb4pyQv'
    when 's1' then 'AzzkBZvWX8xXeQ27ZDGz4ZDu8W8ngQcMhPe7dFdfaJjd'
    when 'b1' then 'B4v3KsPX7SFknVGczWbuMRzfNfLzMUJBFoJmgdgGKe4L'
    when 'haulier2' then '9iY8Tr5KHUKDzgGUGY5XXvZQVV8xtCZn5dyeX2nHNycC'
    when 'h0' then '9nTRc9YKsmcT8mWyhqQSpoLAjeMAZGFbe3eJaQpt8Jvu'
    when 'h1' then '9rNikT1LU4ugGrmV98jN7g6vyoZNEKwRCTJxdnsUseFc'
    when 'h2' then '9vJ1tkUM4NCuQx1zaS4HQYshDxmZuPdEkrychAv5cyaK'
    when 'walletM' then '9zDK33wMefW8Z3GW1jPChReTU7ymaTK4KGeGkYxgNJu2'
    when 'walletH' then 'A48cBMQNExoMh8X1T2i7zJRDiHByFWzssgJvow1H7eDj'
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

-- A test-only Transporter (T063d.2 pre-check fold 3) and a test-only custodian with no role here.
insert into public.organisations (id, slug, name, kind, synthetic) values
  ('11000000-0000-4000-8000-000000000009', 'haulier-two-test', 'Haulier Two Test Org', 'transporter', true),
  ('11000000-0000-4000-8000-0000000000c2', 'custodian-two-test', 'Custodian Two Test Org', 'custodian', true);

create function pg_temp.org(slug text) returns text language sql stable as $$
  select id::text from public.organisations where organisations.slug = org.slug
$$;

create function pg_temp.slug(name text) returns text language sql immutable as $$
  select case name when 'port' then 'port-t1' when 'haulier2' then 'haulier-two-test' else name end
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

-- An event row: every key null, then `keys` over them.
create function pg_temp.ev(n int, slot bigint, instruction text, event text, scope text, keys jsonb)
returns jsonb language sql immutable as $$
  select jsonb_build_object('network', 'devnet', 'program_id', pg_temp.a('program'),
    'signature', pg_temp.sig(n), 'event_index', 0, 'slot', slot, 'block_time', pg_temp.at(slot),
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

create function pg_temp.lot(revision text, state text, slot bigint, n int) returns jsonb
language sql stable as $$
  select pg_temp.up('chain_lots', pg_temp.a('lot'), slot, n, jsonb_build_object(
    'lot_id', 'CR-0001', 'class_policy', pg_temp.a('class'), 'class_version', 1, 'grade', 'G1',
    'custodian_class', pg_temp.a('site'), 'custodian', pg_temp.a('kopano'),
    'custodian_org_id', pg_temp.org('kopano'), 'intake', pg_temp.a('intake'), 'parent', null,
    'root', pg_temp.a('lot'), 'mint', pg_temp.a('mint'), 'supply_kg', '5000000', 'state', state,
    'restriction', 'Normal', 'expires_at', '1800000000', 'revision', revision, 'live_children', 0,
    'event_revision', revision, 'issued_owner', pg_temp.a('khunou'),
    'issued_owner_org_id', pg_temp.org('khunou'), 'issued_at', pg_temp.at(200)))
$$;

create function pg_temp.shipment(status text, revision text, departed int, slot bigint, n int)
returns jsonb language sql stable as $$
  select pg_temp.up('chain_shipments', pg_temp.a('s1'), slot, n, jsonb_build_object(
    'shipment_id_hex', repeat('22', 16), 'lot', pg_temp.a('lot'), 'position', pg_temp.a('posK'),
    'owner', pg_temp.a('khunou'), 'owner_org_id', pg_temp.org('khunou'),
    'source', pg_temp.a('site'), 'source_custodian', pg_temp.a('kopano'),
    'source_custodian_org_id', pg_temp.org('kopano'),
    'destination', pg_temp.a('portSite'), 'destination_custodian', pg_temp.a('port'),
    'destination_custodian_org_id', pg_temp.org('port-t1'),
    'committed_kg', '5000000', 'locked_kg', '0', 'batch_count', 1,
    'manifest_root_hex', '8df721d308bd44a37494f5362fff9cb0ac090efc83e7f2cb152177dc7b602486',
    'departure_document', pg_temp.a('doc'), 'registered_count', 1, 'registered_kg', '5000000',
    'departed_count', departed, 'departed_kg', case when departed = 0 then '0' else '5000000' end,
    'arrived_count', 0, 'arrived_kg', '0', 'status', status, 'prepared_at', '1795000000',
    'revision', revision, 'event_revision', revision, 'event_registered', 1))
$$;

create function pg_temp.batch_row(holder text, stage text, sequence text, slot bigint, n int)
returns jsonb language sql stable as $$
  select pg_temp.up('chain_batches', pg_temp.a('b1'), slot, n, jsonb_build_object(
    'shipment', pg_temp.a('s1'), 'lot', pg_temp.a('lot'), 'batch_index', 0, 'batch_count', 1,
    'quantity_kg', '5000000', 'carrier', pg_temp.a('mosela'),
    'load_digest_hex', repeat('33', 32), 'manifest_digest_hex', repeat('44', 32),
    'holder', pg_temp.a(holder), 'holder_org_id', pg_temp.org(pg_temp.slug(holder)), 'stage', stage,
    'sequence', sequence, 'observation_count', 0,
    'departed_at', case when stage = 'AtSource' then null else '1795000500' end, 'arrived_at', null,
    'event_sequence', sequence, 'event_observations', 0))
$$;

create function pg_temp.handover(address text, sequence text, from_org text, from_wallet text,
  to_org text, to_wallet text, stage text, slot bigint, n int) returns jsonb
language sql stable as $$
  select pg_temp.up('chain_handovers', pg_temp.a(address), slot, n, jsonb_build_object(
    'shipment', pg_temp.a('s1'), 'batch', pg_temp.a('b1'), 'sequence', sequence,
    'from_organisation', pg_temp.a(from_org), 'from_org_id', pg_temp.org(pg_temp.slug(from_org)),
    'to_organisation', pg_temp.a(to_org), 'to_org_id', pg_temp.org(pg_temp.slug(to_org)),
    'from_wallet', pg_temp.a(from_wallet), 'to_wallet', pg_temp.a(to_wallet), 'stage', stage,
    'quantity_kg', '5000000', 'manifest_digest_hex', repeat('44', 32), 'at', slot::text))
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

-- The fixtures, built as postgres and kept as settings.
-- 100: the registry (protocol, class, the organisations of S1 and Haulier Two, both sites).
select set_config('t.b1', pg_temp.batch(null, 100,
  jsonb_build_array(pg_temp.tx(1, 100, 1)),
  jsonb_build_array(pg_temp.ev(1, 100, 'InitializeProtocol', 'ProtocolInitialized', 'registry', '{}')),
  jsonb_build_array(
    pg_temp.up('chain_protocols', pg_temp.a('protocol'), 100, 1, jsonb_build_object(
      'instance_id_hex', '666961742d6174746573746174696f6e', 'settlement_mode', 'FiatAttestationTest',
      'admin', pg_temp.a('walletK'), 'accreditor', pg_temp.a('walletK'), 'pause_flags', 0)),
    pg_temp.up('chain_class_policies', pg_temp.a('class'), 100, 1, jsonb_build_object(
      'class_code', 'CHROME', 'version', 1, 'unit', 'Kilogram', 'grades', '["G1"]'::jsonb,
      'origin_required', false, 'lot_validity_secs', '7776000', 'split_inherits_expiry', true)),
    pg_temp.organisation('khunou', 'Khunou Ore Exports', 'Exporter'),
    pg_temp.organisation('kopano', 'Kopano Stockyard Custody', 'Custodian'),
    pg_temp.organisation('port', 'Port Terminal T1', 'Terminal'),
    pg_temp.organisation('mosela', 'Mosela Haulage', 'Transporter'),
    pg_temp.organisation('haulier2', 'Haulier Two Test Org', 'Transporter'),
    pg_temp.site('site', 'kopano', 'KOPANO-YARD-1', '5000000', 100, 1),
    pg_temp.site('portSite', 'port', 'PORT-T1', '0', 100, 1)))::text, true);
-- 200: CR-0001 issued to Khunou at Kopano.
select set_config('t.b2', pg_temp.one(100, 200, 2,
  pg_temp.ev(2, 200, 'IssueLot', 'LotIssued', 'lot',
    jsonb_build_object('lot', pg_temp.a('lot'), 'lot_revision', '0')),
  jsonb_build_array(
    pg_temp.lot('0', 'Stored', 200, 2),
    pg_temp.up('chain_intakes', pg_temp.a('intake'), 200, 2, jsonb_build_object(
      'custodian', pg_temp.a('kopano'), 'custodian_org_id', pg_temp.org('kopano'),
      'intake_digest_hex', repeat('01', 32), 'lot', pg_temp.a('lot'), 'retired', false)),
    pg_temp.up('chain_positions', pg_temp.a('posK'), 200, 2, jsonb_build_object(
      'lot', pg_temp.a('lot'), 'owner', pg_temp.a('khunou'), 'owner_org_id', pg_temp.org('khunou'),
      'quantity_kg', '5000000', 'locked_kg', '0', 'reserved_kg', '0', 'revision', '0'))))::text, true);
-- 300: S1 prepared to PORT-T1, lot-scoped.
select set_config('t.b3', pg_temp.one(200, 300, 3,
  pg_temp.ev(3, 300, 'PrepareShipment', 'ShipmentPrepared', 'lot', jsonb_build_object(
    'lot', pg_temp.a('lot'), 'lot_revision', '1', 'shipment', pg_temp.a('s1'),
    'shipment_revision', '0', 'created', pg_temp.a('s1'))),
  jsonb_build_array(pg_temp.shipment('Prepared', '0', 0, 300, 3),
    pg_temp.lot('1', 'Prepared', 300, 3)))::text, true);
-- 400: B1 registered, carried by Mosela Haulage.
select set_config('t.b4', pg_temp.one(300, 400, 4,
  pg_temp.ev(4, 400, 'RegisterBatch', 'BatchRegistered', 'shipment', jsonb_build_object(
    'shipment', pg_temp.a('s1'), 'batch', pg_temp.a('b1'), 'created', pg_temp.a('b1'))),
  jsonb_build_array(pg_temp.batch_row('kopano', 'AtSource', '0', 400, 4)))::text, true);
-- 500: the departure, Kopano → Mosela, sequence 0, lot-scoped (lot revision 2).
select set_config('t.b5', pg_temp.one(400, 500, 5,
  pg_temp.ev(5, 500, 'Handover', 'CustodyHandedOver', 'lot', jsonb_build_object(
    'lot', pg_temp.a('lot'), 'lot_revision', '2', 'shipment', pg_temp.a('s1'),
    'shipment_revision', '1', 'batch', pg_temp.a('b1'), 'batch_sequence', '0',
    'created', pg_temp.a('h0'))),
  jsonb_build_array(
    pg_temp.handover('h0', '0', 'kopano', 'walletK', 'mosela', 'walletM', 'Departure', 500, 5),
    pg_temp.batch_row('mosela', 'InTransit', '1', 500, 5),
    pg_temp.shipment('InTransit', '1', 1, 500, 5),
    pg_temp.lot('2', 'InTransit', 500, 5),
    pg_temp.site('site', 'kopano', 'KOPANO-YARD-1', '0', 500, 5)))::text, true);
-- 600: a transfer, Mosela → Haulier Two Test Org, sequence 1, shipment-scoped.
select set_config('t.b6', pg_temp.one(500, 600, 6,
  pg_temp.ev(6, 600, 'Handover', 'CustodyHandedOver', 'shipment', jsonb_build_object(
    'shipment', pg_temp.a('s1'), 'shipment_revision', '2', 'batch', pg_temp.a('b1'),
    'batch_sequence', '1', 'created', pg_temp.a('h1'))),
  jsonb_build_array(
    pg_temp.handover('h1', '1', 'mosela', 'walletM', 'haulier2', 'walletH', 'Transfer', 600, 6),
    pg_temp.batch_row('haulier2', 'InTransit', '2', 600, 6),
    pg_temp.shipment('InTransit', '2', 1, 600, 6)))::text, true);
-- 700: a transfer back, Haulier Two Test Org → Mosela, sequence 2: Haulier Two holds nothing now.
select set_config('t.b7', pg_temp.one(600, 700, 7,
  pg_temp.ev(7, 700, 'Handover', 'CustodyHandedOver', 'shipment', jsonb_build_object(
    'shipment', pg_temp.a('s1'), 'shipment_revision', '3', 'batch', pg_temp.a('b1'),
    'batch_sequence', '2', 'created', pg_temp.a('h2'))),
  jsonb_build_array(
    pg_temp.handover('h2', '2', 'haulier2', 'walletH', 'mosela', 'walletM', 'Transfer', 700, 7),
    pg_temp.batch_row('mosela', 'InTransit', '3', 700, 7),
    pg_temp.shipment('InTransit', '3', 1, 700, 7)))::text, true);

-- Members: khunou (1), kopano (2), port-t1 (3), mosela (4), Haulier Two (5), Custodian Two (6).
insert into auth.users (id, email, email_confirmed_at, aud, role) values
  ('43000000-0000-4000-8000-000000000001', 'hand-khunou@example.test', now(), 'authenticated', 'authenticated'),
  ('43000000-0000-4000-8000-000000000002', 'hand-kopano@example.test', now(), 'authenticated', 'authenticated'),
  ('43000000-0000-4000-8000-000000000003', 'hand-port@example.test', now(), 'authenticated', 'authenticated'),
  ('43000000-0000-4000-8000-000000000004', 'hand-mosela@example.test', now(), 'authenticated', 'authenticated'),
  ('43000000-0000-4000-8000-000000000005', 'hand-haulier@example.test', now(), 'authenticated', 'authenticated'),
  ('43000000-0000-4000-8000-000000000006', 'hand-two@example.test', now(), 'authenticated', 'authenticated');
insert into public.memberships (organisation_id, user_id, member_role)
select organisations.id, fixture.user_id::uuid, 'member'
from (values
  ('khunou', '43000000-0000-4000-8000-000000000001'),
  ('kopano', '43000000-0000-4000-8000-000000000002'),
  ('port-t1', '43000000-0000-4000-8000-000000000003'),
  ('mosela', '43000000-0000-4000-8000-000000000004'),
  ('haulier-two-test', '43000000-0000-4000-8000-000000000005'),
  ('custodian-two-test', '43000000-0000-4000-8000-000000000006')
) as fixture(slug, user_id)
join public.organisations on organisations.slug = fixture.slug;

create function pg_temp.as_user(n int) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', '43000000-0000-4000-8000-00000000000' || n,
    'role', 'authenticated')::text, true)
$$;

-- What a member reads of S1: the shipment, its batch, its handovers and the events that describe it.
create function pg_temp.handover_view() returns setof text language sql stable as $$
  select 'shipment ' || address from public.chain_shipments
  union all select 'batch ' || address from public.chain_batches
  union all select 'handover ' || address from public.chain_handovers
  union all select 'event ' || event || ' ' || coalesce(batch_sequence, '-') from public.chain_events
    where shipment is not null
$$;

create function pg_temp.full_view() returns text[] language sql immutable as $$
  select array['shipment ' || pg_temp.a('s1'), 'batch ' || pg_temp.a('b1'),
    'handover ' || pg_temp.a('h0'), 'handover ' || pg_temp.a('h1'), 'handover ' || pg_temp.a('h2'),
    'event ShipmentPrepared -', 'event BatchRegistered -', 'event CustodyHandedOver 0',
    'event CustodyHandedOver 1', 'event CustodyHandedOver 2']
$$;

-- ---------------------------------------------------------------------------------------------
-- RLS on chain_handovers; anon selects nothing; no role writes it directly.
select ok(
  (select relrowsecurity from pg_catalog.pg_class
    where relnamespace = 'public'::regnamespace and relname = 'chain_handovers'),
  'RLS is enabled on chain_handovers');
select ok(
  not has_table_privilege('anon', 'public.chain_handovers', 'SELECT')
    and not has_any_column_privilege('anon', 'public.chain_handovers', 'SELECT'),
  'anon has no SELECT on chain_handovers');
select is_empty(
  $$select role || ' ' || privilege
    from unnest(array['anon', 'authenticated', 'service_role']) as role,
      unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) as privilege
    where has_table_privilege(role, 'public.chain_handovers', privilege)$$,
  'no API role may insert, update, delete or truncate chain_handovers');
select ok(
  has_table_privilege('authenticated', 'public.chain_handovers', 'SELECT')
    and has_table_privilege('service_role', 'public.chain_handovers', 'SELECT'),
  'authenticated and service_role may select chain_handovers');
select ok(
  has_function_privilege('authenticated', 'private.can_read_shipment(text)', 'EXECUTE')
    and not has_function_privilege('anon', 'private.can_read_shipment(text)', 'EXECUTE')
    and not has_function_privilege('service_role', 'private.can_read_shipment(text)', 'EXECUTE'),
  'can_read_shipment keeps its grants: authenticated only');

-- Up to the departure, through the functions as the worker writes.
set local role service_role;
select lives_ok($$select public.indexer_checkpoint(pg_temp.stream(), null, '{}'::jsonb)$$,
  'indexer_checkpoint creates the stream row');
select lives_ok($$select public.indexer_apply(current_setting('t.b1')::jsonb)$$, 'batch 1 applies');
select lives_ok($$select public.indexer_apply(current_setting('t.b2')::jsonb)$$, 'batch 2 applies');
select lives_ok($$select public.indexer_apply(current_setting('t.b3')::jsonb)$$, 'batch 3 applies');
select lives_ok($$select public.indexer_apply(current_setting('t.b4')::jsonb)$$, 'batch 4 applies');
select lives_ok($$select public.indexer_apply(current_setting('t.b5')::jsonb)$$,
  'the departure applies with its handover row');
reset role;

-- Before its handovers, Haulier Two Test Org is no party of S1 and reads none of it.
set local role authenticated;
select pg_temp.as_user(5);
select is_empty('select * from pg_temp.handover_view()',
  'before its handovers, the Haulier Two Test Org member reads nothing of S1');
reset role;

set local role service_role;
select lives_ok($$select public.indexer_apply(current_setting('t.b6')::jsonb)$$,
  'the transfer to Haulier Two applies');
select lives_ok($$select public.indexer_apply(current_setting('t.b7')::jsonb)$$,
  'the transfer back to Mosela applies');
select throws_ok(
  $$select public.indexer_apply(pg_temp.one(700, 800, 8, null, jsonb_build_array(
    pg_temp.handover('h2', '2', 'haulier2', 'walletH', 'mosela', 'walletM', 'Shipped', 800, 8))))$$,
  'P0001', 'ROW_INVALID', 'a handover stage outside the IDL''s variants is ROW_INVALID');
select throws_ok(
  $$select public.indexer_apply(pg_temp.one(700, 800, 8, null, jsonb_build_array(
    pg_temp.handover('h2', '02', 'haulier2', 'walletH', 'mosela', 'walletM', 'Transfer', 800, 8))))$$,
  'P0001', 'ROW_INVALID', 'a handover sequence ''02'' is ROW_INVALID');
reset role;
select is((select count(*)::int from public.chain_handovers), 3, 'three handovers are stored');
select is(
  (select row(holder, sequence, event_sequence) from public.chain_batches),
  row(pg_temp.a('mosela'), '3'::text, '3'::text), 'B1 is held by Mosela again at sequence 3');
select is(
  (select row(from_organisation, from_org_id::text, to_organisation, to_org_id::text, stage)
     from public.chain_handovers where address = pg_temp.a('h1')),
  row(pg_temp.a('mosela'), pg_temp.org('mosela'), pg_temp.a('haulier2'),
    pg_temp.org('haulier-two-test'), 'Transfer'::text),
  'the transfer row names both organisations and their org_ids');

-- Who reads what.
set local role authenticated;
select pg_temp.as_user(5); -- Haulier Two: a handover party only (neither holder nor carrier now)
select set_eq('select * from pg_temp.handover_view()', pg_temp.full_view(),
  'the Haulier Two member reads S1, B1, the three handovers and S1''s events');
select is_empty($$select 1 from public.chain_lots union all select 1 from public.chain_positions$$,
  'the Haulier Two member reads no lot or position row');
select pg_temp.as_user(1); -- khunou, the owner
select set_eq('select * from pg_temp.handover_view()', pg_temp.full_view(),
  'khunou reads S1, B1, the three handovers and S1''s events');
select pg_temp.as_user(2); -- kopano, the source custodian
select set_eq('select * from pg_temp.handover_view()', pg_temp.full_view(),
  'kopano reads S1, B1, the three handovers and S1''s events');
select pg_temp.as_user(3); -- port-t1, the destination custodian
select set_eq('select * from pg_temp.handover_view()', pg_temp.full_view(),
  'port-t1 reads S1, B1, the three handovers and S1''s events');
select pg_temp.as_user(4); -- mosela, the carrier and holder
select set_eq('select * from pg_temp.handover_view()', pg_temp.full_view(),
  'mosela reads S1, B1, the three handovers and S1''s events');
select pg_temp.as_user(6); -- Custodian Two Test Org, no role in any of them
select is_empty('select * from pg_temp.handover_view()',
  'the Custodian Two Test Org member reads none of S1, B1, the handovers or the events');
reset role;

-- indexer_reset clears the table.
set local role service_role;
select lives_ok($$select public.indexer_halt(pg_temp.stream(), 700, 'EVENT_GAP', 'sequence: synthetic', null)$$,
  'the stream halts');
select lives_ok($$select public.indexer_reset(pg_temp.stream())$$, 'indexer_reset clears the stream');
reset role;
select is((select count(*)::int from public.chain_handovers), 0, 'no row is left in chain_handovers');

select * from finish();
rollback;
