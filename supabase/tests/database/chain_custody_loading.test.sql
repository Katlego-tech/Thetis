-- Phase 3, the loading part, of the chain read model: chain_loading_intents, chain_handoff_acceptances,
-- can_read_loading_intent and the loading arm of the custody events policy (live-custody.md §6.6, §9.2
-- and its T063d.4 pre-check folds).
-- SYNTHETIC: every address, signature and slot below is made up (base58 of repeated bytes); only the
-- program id is the real devnet program. Quantities and sites are demo.md §2–§4's. Custodian Two Test
-- Org is a test-only organisation, never in the demo cast.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(39);

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

create function pg_temp.a(name text) returns text language sql immutable as $$
  select case name
    when 'program' then 'jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3'
    when 'protocol' then '6QWeT6FpJrm8AF1btu6WH2k2Xhq6t5vbheKVfQavmenJ'
    when 'khunou' then '6URwbPipuA4MJLG7LCRRZuWnms3JZ9cRG3z9indXWz6z'
    when 'kopano' then '6YMEjhBqVTMaSRWcmVkLrnHZ22FWEDJEpTeonAg8GKRg'
    when 'buyer' then '6cGXszer5keoaWm8Co5G9f4KGBThuGz4NsKTqYij1ekN'
    when 'lender1' then '6gBq2J7rg3x2ic1de6QBSXq5WLfuaLfswGz7tvmKkz54'
    when 'lender2' then '6k78AbasGMFFrhG95Pj6jQbqkVt7FQMhVgemxJovWKPk'
    when 'class' then '6p2RJu3sreYUznWeWh422HNbzf6JvU3X46KS1grXFeiS'
    when 'site' then '6swiTCWtSwqi8sm9wzNwKA9NEpJWbXjLcVz654u7zz38'
    when 'lot' then '6ws1bVyu3F8wGy1fPHhrc2v8UyWiGbRAAuek8SwikKMp'
    when 'intake' then '71nJjoSudYSAR4GApb2mtugtj8iuwf6yjKKQBpzKVegW'
    when 'posK' then '75hbt6uvDqjPZ9WgFtMhBnTeyHw7cinoHiz4FD2vEz1C'
    when 'mint' then '7DYCAhqwQSKqqL1h8V1XmY1BTcMWxrASQYKNMy87jeea'
    when 'fac1' then '7HTVK1Jwzjd4yRGCZnLT4QmwhmZidurFxwz2RMAiUyyG'
    when 'fac2' then '7MNnTJmxb2vJ7WWi15fNMHYhwvmvJyY5XMegUjDKEKHx'
    when 'loan1' then '7VDNjuhymdWkPh1isgKCw36ESFCKf6uieAyzbVJWiywL'
    when 'lock1' then '7Z8ftDAzMvoyXnGEJye8DurzgQQXLAbYCaeeesM7UKG2'
    when 'intent1' then '7ktZK7a28phex41kcsct6YBHQt38MMezsoecq1UuiKE6'
    when 'walletK' then '86V32cu56KBneWGHoNFUYv36dg68ig66fqyu7uhuSyqY'
    when 'port' then 'AjKZcN4U9wmd6325p1yJu48r9sHyz9s5TkyVPjTGaySo'
    when 'mosela' then 'AoErkfXUkF4rE8GbFKJEBvucQ2WBfDYu2Ae9T7VsLJmW'
    when 'portSite' then 'AsA9txzVLYN5NDX6gcd9UogNeBiPLHEiaaJoWVYU5e6D'
    when 'doc' then 'Aw5T3GTVvqfJWJmc7ux4mgT8tLvb1LvY8yyTZsb4pyQv'
    when 's1' then 'AzzkBZvWX8xXeQ27ZDGz4ZDu8W8ngQcMhPe7dFdfaJjd'
    when 'b1' then 'B4v3KsPX7SFknVGczWbuMRzfNfLzMUJBFoJmgdgGKe4L'
    when 's2' then 'B8qLUArXhjYyvaX8RovpeJmRcpZC2XyzpCyRk1is4yP3'
    when 'acc1' then 'BCkdcUKYJ2rD4fmds7FjwBYBrymPhbfpNce5oPmTpJhk'
    when 'li1' then '8Zv72jA9EQGNd91qrTXub3SSLnZYS7tqaheVXa26gK8B'
    when 's3' then '8dqQB2d9phZbmEGMHkrpsvDCawmk7Baf97K9ax4hReSt'
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
    when 10 then 'CeD7gRMFdZKnrBxCWczhvDmfAz4ke5NFKvqAi9jSwzCQReUhecVgBJb112WuuR9eVmzFDwMsQDWEa1WWhbF3aoB'
    when 11 then 'DojKwxnUhDMfqJr7ryzgD9FKnnNXbz1Axd1nUsCtk5v9NK2UKB3YVjYboRsJbTZiFFgmeRzkqjkkviAGGefeeBC'
    when 12 then 'EyFYDWDhksPYpRk3DLzeW4izQagJZte6bKCQFagLYBdtJyaEyjbQpAWCbqDhHVymzjPJ4vdeHG1HHQp1qi6FhZD'
    when 13 then 'G8mkV3evpXRRoYdxZhzcnzCf2Nz5XoH2E1P22J9nLHMdFe81eJ9H8bToQEa5yYPqkD5pVRGXinFoe7TmQmWrkwE'
    when 14 then 'HJHxkb69tBTJnfXsv4zb5ugKeBHrVhuwrhZdo1dE8P5NCJfnJrh9T2RQCdvUfaouVgnLuuuRAJWKzp7WypwTpKF'
    when 15 then 'JTpB28XNwqVBmnRoGRzZNq9zFybdTcYsVPkFZj6fvUo78yDYyRF1mTP113GsMdDyFAUsLQYJbpkrMWmGYtN4shG'
    when 16 then 'KdLPHfxc1VX4kuKicnzXfkdesmuQRXBo85vsLSa7iaWr5dmKdynt5tLboSdG3fe2zeBPkuBC3M1NiDR27wnfw5H'
  end
$$;

create function pg_temp.org(slug text) returns text language sql stable as $$
  select id::text from public.organisations where organisations.slug = org.slug
$$;

create function pg_temp.slug(name text) returns text language sql immutable as $$
  select case name when 'buyer' then 'buyer-smelter' when 'lender1' then 'lender-one'
    when 'lender2' then 'lender-two' when 'port' then 'port-t1' else name end
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

create function pg_temp.site(address text, custodian text, site text, occupied text, reserved text,
  slot bigint, n int) returns jsonb language sql stable as $$
  select pg_temp.up('chain_custodian_classes', pg_temp.a(address), slot, n, jsonb_build_object(
    'custodian', pg_temp.a(custodian), 'custodian_org_id', pg_temp.org(pg_temp.slug(custodian)),
    'class_policy', pg_temp.a('class'), 'site_code', site, 'approved_capacity_kg', '10000000',
    'occupied_kg', occupied, 'reserved_inbound_kg', reserved))
$$;

create function pg_temp.facility(address text, lender text, loan_count int, slot bigint, n int)
returns jsonb language sql stable as $$
  select pg_temp.up('chain_facilities', pg_temp.a(address), slot, n, jsonb_build_object(
    'lender', pg_temp.a(lender), 'lender_org_id', pg_temp.org(pg_temp.slug(lender)),
    'borrower', pg_temp.a('khunou'), 'borrower_org_id', pg_temp.org('khunou'),
    'facility_id_hex', repeat(case address when 'fac1' then '11' else '12' end, 16),
    'currency', 'USD', 'currency_decimals', 2, 'terms_version', 1, 'rate_bps', 1200,
    'max_ltv_bps', 6000, 'terms_digest_hex', repeat('21', 32), 'loan_count', loan_count))
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

-- CR-0001 stored at PORT-T1 after its arrival: Port Terminal T1 is its custodian.
create function pg_temp.lot(revision text, slot bigint, n int) returns jsonb
language sql stable as $$
  select pg_temp.up('chain_lots', pg_temp.a('lot'), slot, n, jsonb_build_object(
    'lot_id', 'CR-0001', 'class_policy', pg_temp.a('class'), 'class_version', 1, 'grade', 'G1',
    'custodian_class', pg_temp.a('portSite'), 'custodian', pg_temp.a('port'),
    'custodian_org_id', pg_temp.org('port-t1'), 'intake', pg_temp.a('intake'), 'parent', null,
    'root', pg_temp.a('lot'), 'mint', pg_temp.a('mint'), 'supply_kg', '5000000', 'state', 'Stored',
    'restriction', 'Normal', 'expires_at', '1800000000', 'revision', revision, 'live_children', 0,
    'event_revision', revision, 'issued_owner', pg_temp.a('khunou'),
    'issued_owner_org_id', pg_temp.org('khunou'), 'issued_at', pg_temp.at(200)))
$$;

create function pg_temp.pos(revision text, slot bigint, n int) returns jsonb
language sql stable as $$
  select pg_temp.up('chain_positions', pg_temp.a('posK'), slot, n, jsonb_build_object(
    'lot', pg_temp.a('lot'), 'owner', pg_temp.a('khunou'), 'owner_org_id', pg_temp.org('khunou'),
    'quantity_kg', '5000000', 'locked_kg', '5000000', 'reserved_kg', '0', 'revision', revision))
$$;

create function pg_temp.loading_intent(status text, cancelled_by text, slot bigint, n int)
returns jsonb language sql stable as $$
  select pg_temp.up('chain_loading_intents', pg_temp.a('li1'), slot, n, jsonb_build_object(
    'lot', pg_temp.a('lot'), 'position', pg_temp.a('posK'),
    'owner', pg_temp.a('khunou'), 'owner_org_id', pg_temp.org('khunou'),
    'terminal', pg_temp.a('port'), 'terminal_org_id', pg_temp.org('port-t1'),
    'custodian_class', pg_temp.a('portSite'), 'nonce', '1', 'quantity_kg', '5000000',
    'locked_kg', '5000000', 'document_sha256_hex', repeat('aa', 32), 'position_revision', '2',
    'expires_at', '1800000000', 'status', status,
    'executed_at', case when status = 'Executed' then '1795000900' else null end,
    'cancelled_by', cancelled_by))
$$;

create function pg_temp.acceptance(version int, event_version int, slot bigint, n int)
returns jsonb language sql stable as $$
  select pg_temp.up('chain_handoff_acceptances', pg_temp.a('acc1'), slot, n, jsonb_build_object(
    'intent', pg_temp.a('li1'), 'loan', pg_temp.a('loan1'), 'lock', pg_temp.a('lock1'),
    'lender', pg_temp.a('lender1'), 'lender_org_id', pg_temp.org('lender-one'),
    'lock_quantity_kg', '5000000', 'loan_revision', '1', 'principal', '60000000',
    'booked_interest', '0', 'accepted_at', '1795000800', 'version', version,
    'event_version', event_version))
$$;

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
    pg_temp.organisation('lender2', 'Lender Two Bank', 'Lender'),
    pg_temp.organisation('port', 'Port Terminal T1', 'Terminal'),
    pg_temp.organisation('mosela', 'Mosela Haulage', 'Transporter'),
    pg_temp.site('site', 'kopano', 'KOPANO-YARD-1', '0', '0', 100, 1),
    pg_temp.site('portSite', 'port', 'PORT-T1', '5000000', '0', 100, 1)))::text, true);
-- 200: CR-0001 at PORT-T1, held by Khunou.
select set_config('t.b2', pg_temp.one(100, 200, 2,
  pg_temp.ev(2, 0, 200, 'IssueLot', 'LotIssued', 'lot',
    jsonb_build_object('lot', pg_temp.a('lot'), 'lot_revision', '0')),
  jsonb_build_array(
    pg_temp.lot('0', 200, 2),
    pg_temp.up('chain_intakes', pg_temp.a('intake'), 200, 2, jsonb_build_object(
      'custodian', pg_temp.a('kopano'), 'custodian_org_id', pg_temp.org('kopano'),
      'intake_digest_hex', repeat('01', 32), 'lot', pg_temp.a('lot'), 'retired', false)),
    pg_temp.pos('0', 200, 2)))::text, true);
-- 300: Lender One's and Lender Two's facilities to Khunou (Lender Two never lends).
select set_config('t.b3', pg_temp.batch(200, 300,
  jsonb_build_array(pg_temp.tx(3, 300, 2)),
  jsonb_build_array(
    pg_temp.ev(3, 0, 300, 'OpenFacility', 'FacilityOpened', 'facility',
      jsonb_build_object('facility', pg_temp.a('fac1'), 'created', pg_temp.a('fac1'))),
    pg_temp.ev(3, 1, 300, 'OpenFacility', 'FacilityOpened', 'facility',
      jsonb_build_object('facility', pg_temp.a('fac2'), 'created', pg_temp.a('fac2')))),
  jsonb_build_array(
    pg_temp.facility('fac1', 'lender1', 0, 300, 3),
    pg_temp.facility('fac2', 'lender2', 0, 300, 3)))::text, true);
-- 400: loan 0 pledged with its lock.
select set_config('t.b4', pg_temp.one(300, 400, 4,
  pg_temp.ev(4, 0, 400, 'Pledge', 'Pledged', 'facility',
    jsonb_build_object('facility', pg_temp.a('fac1'), 'loan', pg_temp.a('loan1'), 'loan_revision', '0')),
  jsonb_build_array(
    pg_temp.up('chain_loans', pg_temp.a('loan1'), 400, 4, jsonb_build_object(
      'facility', pg_temp.a('fac1'), 'lender_org_id', pg_temp.org('lender-one'),
      'borrower', pg_temp.a('khunou'), 'borrower_org_id', pg_temp.org('khunou'),
      'lot', pg_temp.a('lot'), 'position', pg_temp.a('posK'), 'loan_index', 0, 'status', 'Active',
      'rate_bps', 1200, 'terms_version', 1, 'principal', '60000000', 'booked_interest', '0',
      'accrual_remainder', '0', 'accrued_at', '1795000000', 'open_exceptions', 0,
      'revision', '0', 'event_revision', '0')),
    pg_temp.up('chain_locks', pg_temp.a('lock1'), 400, 4, jsonb_build_object(
      'loan', pg_temp.a('loan1'), 'position', pg_temp.a('posK'), 'quantity_kg', '5000000',
      'control', 'Pledged')),
    pg_temp.pos('1', 400, 4),
    pg_temp.facility('fac1', 'lender1', 1, 400, 4)))::text, true);
-- 500: Khunou's loading intent at PORT-T1 (scope loading, created = the intent).
select set_config('t.b5', pg_temp.one(400, 500, 5,
  pg_temp.ev(5, 0, 500, 'CreateLoadingIntent', 'LoadingIntentCreated', 'loading',
    jsonb_build_object('created', pg_temp.a('li1'))),
  jsonb_build_array(pg_temp.loading_intent('Open', null, 500, 5), pg_temp.pos('2', 500, 5)))::text, true);
-- 600: Lender One accepts the hand-off of loan 0 (facility-scoped, acceptance version 1).
select set_config('t.b6', pg_temp.one(500, 600, 6,
  pg_temp.ev(6, 0, 600, 'AcceptLoading', 'LoadingAccepted', 'facility', jsonb_build_object(
    'facility', pg_temp.a('fac1'), 'loan', pg_temp.a('loan1'), 'acceptance', pg_temp.a('acc1'),
    'acceptance_version', 1)),
  jsonb_build_array(pg_temp.acceptance(1, 1, 600, 6)))::text, true);

-- Members: khunou (1), kopano (2), port-t1 (3), mosela (4), lender-one (5), lender-two (6),
-- Custodian Two Test Org (7).
insert into public.organisations (id, slug, name, kind, synthetic) values
  ('11000000-0000-4000-8000-0000000000c2', 'custodian-two-test', 'Custodian Two Test Org', 'custodian', true);
insert into auth.users (id, email, email_confirmed_at, aud, role) values
  ('44000000-0000-4000-8000-000000000001', 'load-khunou@example.test', now(), 'authenticated', 'authenticated'),
  ('44000000-0000-4000-8000-000000000002', 'load-kopano@example.test', now(), 'authenticated', 'authenticated'),
  ('44000000-0000-4000-8000-000000000003', 'load-port@example.test', now(), 'authenticated', 'authenticated'),
  ('44000000-0000-4000-8000-000000000004', 'load-mosela@example.test', now(), 'authenticated', 'authenticated'),
  ('44000000-0000-4000-8000-000000000005', 'load-lender-one@example.test', now(), 'authenticated', 'authenticated'),
  ('44000000-0000-4000-8000-000000000006', 'load-lender-two@example.test', now(), 'authenticated', 'authenticated'),
  ('44000000-0000-4000-8000-000000000007', 'load-two@example.test', now(), 'authenticated', 'authenticated');
insert into public.memberships (organisation_id, user_id, member_role)
select organisations.id, fixture.user_id::uuid, 'member'
from (values
  ('khunou', '44000000-0000-4000-8000-000000000001'),
  ('kopano', '44000000-0000-4000-8000-000000000002'),
  ('port-t1', '44000000-0000-4000-8000-000000000003'),
  ('mosela', '44000000-0000-4000-8000-000000000004'),
  ('lender-one', '44000000-0000-4000-8000-000000000005'),
  ('lender-two', '44000000-0000-4000-8000-000000000006'),
  ('custodian-two-test', '44000000-0000-4000-8000-000000000007')
) as fixture(slug, user_id)
join public.organisations on organisations.slug = fixture.slug;

create function pg_temp.as_user(n int) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', '44000000-0000-4000-8000-00000000000' || n,
    'role', 'authenticated')::text, true)
$$;

-- What a member reads of the loading: the intent and its event, the acceptance and its event.
create function pg_temp.intent_view() returns setof text language sql stable as $$
  select 'intent ' || address from public.chain_loading_intents
  union all select 'event ' || event from public.chain_events where event = 'LoadingIntentCreated'
$$;
create function pg_temp.acceptance_view() returns setof text language sql stable as $$
  select 'acceptance ' || address from public.chain_handoff_acceptances
  union all select 'event ' || event from public.chain_events where event = 'LoadingAccepted'
$$;

-- ---------------------------------------------------------------------------------------------
-- RLS on both tables; anon selects nothing; no role writes them directly.
select ok(
  (select bool_and(relrowsecurity) from pg_catalog.pg_class
    where relnamespace = 'public'::regnamespace
      and relname in ('chain_loading_intents', 'chain_handoff_acceptances'))
  and (select count(*) from pg_catalog.pg_class
    where relnamespace = 'public'::regnamespace
      and relname in ('chain_loading_intents', 'chain_handoff_acceptances')) = 2,
  'RLS is enabled on chain_loading_intents and chain_handoff_acceptances');
select ok(
  not has_table_privilege('anon', 'public.chain_loading_intents', 'SELECT')
    and not has_any_column_privilege('anon', 'public.chain_loading_intents', 'SELECT')
    and not has_table_privilege('anon', 'public.chain_handoff_acceptances', 'SELECT')
    and not has_any_column_privilege('anon', 'public.chain_handoff_acceptances', 'SELECT'),
  'anon has no SELECT on either table');
select is_empty(
  $$select tbl || ' ' || role || ' ' || privilege
    from unnest(array['public.chain_loading_intents', 'public.chain_handoff_acceptances']) as tbl,
      unnest(array['anon', 'authenticated', 'service_role']) as role,
      unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) as privilege
    where has_table_privilege(role, tbl, privilege)$$,
  'no API role may insert, update, delete or truncate either table');
select ok(
  has_table_privilege('authenticated', 'public.chain_loading_intents', 'SELECT')
    and has_table_privilege('service_role', 'public.chain_loading_intents', 'SELECT')
    and has_table_privilege('authenticated', 'public.chain_handoff_acceptances', 'SELECT')
    and has_table_privilege('service_role', 'public.chain_handoff_acceptances', 'SELECT'),
  'authenticated and service_role may select both tables');
select ok(
  has_function_privilege('authenticated', 'private.can_read_loading_intent(text)', 'EXECUTE')
    and not has_function_privilege('anon', 'private.can_read_loading_intent(text)', 'EXECUTE')
    and not has_function_privilege('service_role', 'private.can_read_loading_intent(text)', 'EXECUTE'),
  'can_read_loading_intent is granted to authenticated only');

-- Through the functions, as the worker writes.
set local role service_role;
select lives_ok($$select public.indexer_checkpoint(pg_temp.stream(), null, '{}'::jsonb)$$,
  'indexer_checkpoint creates the stream row');
select lives_ok($$select public.indexer_apply(current_setting('t.b1')::jsonb)$$, 'batch 1 applies');
select lives_ok($$select public.indexer_apply(current_setting('t.b2')::jsonb)$$, 'batch 2 applies');
select lives_ok($$select public.indexer_apply(current_setting('t.b3')::jsonb)$$, 'batch 3 applies');
select lives_ok($$select public.indexer_apply(current_setting('t.b4')::jsonb)$$, 'batch 4 applies');
select lives_ok($$select public.indexer_apply(current_setting('t.b5')::jsonb)$$,
  'the loading intent applies with its loading-scoped event');
select lives_ok($$select public.indexer_apply(current_setting('t.b6')::jsonb)$$,
  'the acceptance applies with its facility-scoped event');
-- The CHECKs mirror the program's values.
select throws_ok(
  $$select public.indexer_apply(pg_temp.one(600, 700, 7, null, jsonb_build_array(
    pg_temp.loading_intent('Cancelled', null, 700, 7))))$$,
  'P0001', 'ROW_INVALID', 'a loading intent status outside the IDL''s variants is ROW_INVALID');
select throws_ok(
  $$select public.indexer_apply(pg_temp.one(600, 700, 7, null, jsonb_build_array(
    jsonb_set(pg_temp.loading_intent('Open', null, 700, 7), '{row,document_sha256_hex}', '"AA"'))))$$,
  'P0001', 'ROW_INVALID', 'a document digest that is not 64 lowercase hex is ROW_INVALID');
select throws_ok(
  $$select public.indexer_apply(pg_temp.one(600, 700, 7, null, jsonb_build_array(
    jsonb_set(pg_temp.acceptance(1, 1, 700, 7), '{row,version}', '4294967296'))))$$,
  'P0001', 'ROW_INVALID', 'an acceptance version above u32 is ROW_INVALID');
select throws_ok(
  $$select public.indexer_apply(pg_temp.one(600, 700, 7,
    pg_temp.ev(7, 0, 700, 'CreateLoadingIntent', 'LoadingIntentCreated', 'loading', '{}'), '[]'::jsonb))$$,
  'P0001', 'ROW_INVALID', 'a loading-scoped event without created is ROW_INVALID');
select throws_ok(
  $$select public.indexer_apply(pg_temp.one(600, 700, 7,
    pg_temp.ev(7, 0, 700, 'AcceptLoading', 'LoadingAccepted', 'facility', jsonb_build_object(
      'facility', pg_temp.a('fac1'), 'loan', pg_temp.a('loan1'), 'acceptance', pg_temp.a('acc1'),
      'acceptance_version', 1)), '[]'::jsonb))$$,
  'P0001', 'REVISION_SEQUENCE', 'acceptance version 1 again under another signature is REVISION_SEQUENCE');
reset role;
select is(
  (select row(owner_org_id::text, terminal_org_id::text, status, cancelled_by)
     from public.chain_loading_intents),
  row(pg_temp.org('khunou'), pg_temp.org('port-t1'), 'Open'::text, null::text),
  'the intent row names its owner and terminal org_ids, Open and unmarked');
select is(
  (select row(lender_org_id::text, version, event_version) from public.chain_handoff_acceptances),
  row(pg_temp.org('lender-one'), 1::bigint, 1::bigint), 'the acceptance row is Lender One''s, version 1');

-- Who reads what.
set local role authenticated;
select pg_temp.as_user(1); -- khunou, the owner (and the loan's borrower)
select set_eq('select * from pg_temp.intent_view()',
  array['intent ' || pg_temp.a('li1'), 'event LoadingIntentCreated'],
  'khunou reads the intent and its event');
select set_eq('select * from pg_temp.acceptance_view()',
  array['acceptance ' || pg_temp.a('acc1'), 'event LoadingAccepted'],
  'khunou reads the acceptance and its event');
select pg_temp.as_user(3); -- port-t1, the terminal and the lot's custodian
select set_eq('select * from pg_temp.intent_view()',
  array['intent ' || pg_temp.a('li1'), 'event LoadingIntentCreated'],
  'port-t1 reads the intent and its event');
select is_empty('select * from pg_temp.acceptance_view()',
  'port-t1 reads neither the acceptance nor its event');
select pg_temp.as_user(5); -- lender-one, the loan's lender
select set_eq('select * from pg_temp.intent_view()',
  array['intent ' || pg_temp.a('li1'), 'event LoadingIntentCreated'],
  'lender-one reads the intent and its event');
select set_eq('select * from pg_temp.acceptance_view()',
  array['acceptance ' || pg_temp.a('acc1'), 'event LoadingAccepted'],
  'lender-one reads the acceptance and its event');
select pg_temp.as_user(6); -- lender-two, a facility to Khunou and no loan
select is_empty('select * from pg_temp.acceptance_view()',
  'lender-two reads neither the acceptance nor its event');
select pg_temp.as_user(4); -- mosela, no party of the lot or the loading
select is_empty('select * from pg_temp.intent_view() union all select * from pg_temp.acceptance_view()',
  'mosela reads nothing of the loading');
select pg_temp.as_user(7); -- Custodian Two Test Org, no role in any of them
select is_empty('select * from pg_temp.intent_view() union all select * from pg_temp.acceptance_view()',
  'the Custodian Two Test Org member reads nothing of the loading');
reset role;

-- The intent's owner and terminal arms, apart from the lot's readers: with the lot row gone, khunou
-- and port-t1 still read the intent and its event, lender-one no longer does.
set local role service_role;
select lives_ok(
  $$select public.indexer_apply(pg_temp.one(600, 700, 7, null, jsonb_build_array(
    jsonb_set(pg_temp.lot('1', 700, 7), '{row,custodian_org_id}', to_jsonb(pg_temp.org('kopano'))))))$$,
  'the lot names another custodian org_id');
reset role;
delete from public.chain_positions;
set local role authenticated;
select pg_temp.as_user(1);
select set_eq('select * from pg_temp.intent_view()',
  array['intent ' || pg_temp.a('li1'), 'event LoadingIntentCreated'],
  'khunou reads the intent as its owner');
select pg_temp.as_user(3);
select set_eq('select * from pg_temp.intent_view()',
  array['intent ' || pg_temp.a('li1'), 'event LoadingIntentCreated'],
  'port-t1 reads the intent as its terminal');
select pg_temp.as_user(5);
select is_empty('select * from pg_temp.intent_view()',
  'lender-one, no lot reader now, reads neither the intent nor its event');
reset role;

-- cancelled_by and event_version come from indexer_apply and survive reconcile.
set local role service_role;
select lives_ok(
  $$select public.indexer_apply(pg_temp.one(700, 800, 8, null, jsonb_build_array(
    pg_temp.loading_intent('Open', pg_temp.a('s3'), 800, 8), pg_temp.acceptance(1, 2, 800, 8))))$$,
  'the intent takes a cancelled_by mark and the acceptance an event_version');
select lives_ok(
  $$select public.indexer_reconcile(pg_temp.stream(), 800, jsonb_build_array(
    jsonb_set(pg_temp.loading_intent('Open', null, 800, 8), '{row,commitment}', '"finalized"'),
    jsonb_set(pg_temp.acceptance(1, 9, 800, 8), '{row,commitment}', '"finalized"')), '[]'::jsonb)$$,
  'indexer_reconcile promotes the intent and the acceptance');
reset role;
select is((select row(cancelled_by, commitment::text) from public.chain_loading_intents),
  row(pg_temp.a('s3'), 'finalized'::text), 'cancelled_by survives reconcile');
select is((select row(event_version, commitment::text) from public.chain_handoff_acceptances),
  row(2::bigint, 'finalized'::text), 'reconcile does not change event_version');

-- indexer_reset clears both tables.
set local role service_role;
select lives_ok($$select public.indexer_halt(pg_temp.stream(), 800, 'EVENT_GAP', 'sequence: synthetic', null)$$,
  'the stream halts');
select lives_ok($$select public.indexer_reset(pg_temp.stream())$$, 'indexer_reset clears the stream');
reset role;
select is((select count(*)::int from public.chain_loading_intents)
  + (select count(*)::int from public.chain_handoff_acceptances), 0,
  'no row is left in chain_loading_intents or chain_handoff_acceptances');

select * from finish();
rollback;
