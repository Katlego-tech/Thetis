-- Phase 3, the shipment part, of the chain read model: shipments and batches, the widened CHECKs, the
-- custody event keys, Departure documents and who reads them (live-custody.md §6.1, §6.2, §9.2).
-- SYNTHETIC: every address, signature and slot below is made up (base58 of repeated bytes); only
-- the program id is the real devnet program. Quantities and sites are demo.md §2–§4's.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(68);

-- A clean slate inside this transaction (rolled back at the end).
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
  end
$$;

-- The 32 bytes behind pg_temp.a('lot'), as chain_documents.subject_hex holds them.
create function pg_temp.lot_hex() returns text language sql immutable as $$
  select '5858585858585858585858585858585858585858585858585858585858585807'
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

-- An event row: the Phase 1 keys, the eight Phase 2 keys and the seven Phase 3 keys as null, then
-- `keys` over them.
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

create function pg_temp.pos(revision text, locked text, slot bigint, n int) returns jsonb
language sql stable as $$
  select pg_temp.up('chain_positions', pg_temp.a('posK'), slot, n, jsonb_build_object(
    'lot', pg_temp.a('lot'), 'owner', pg_temp.a('khunou'), 'owner_org_id', pg_temp.org('khunou'),
    'quantity_kg', '5000000', 'locked_kg', locked, 'reserved_kg', '0', 'revision', revision))
$$;

create function pg_temp.lot(revision text, state text, restriction text, slot bigint, n int)
returns jsonb language sql stable as $$
  select pg_temp.up('chain_lots', pg_temp.a('lot'), slot, n, jsonb_build_object(
    'lot_id', 'CR-0001', 'class_policy', pg_temp.a('class'), 'class_version', 1, 'grade', 'G1',
    'custodian_class', pg_temp.a('site'), 'custodian', pg_temp.a('kopano'),
    'custodian_org_id', pg_temp.org('kopano'), 'intake', pg_temp.a('intake'), 'parent', null,
    'root', pg_temp.a('lot'), 'mint', pg_temp.a('mint'), 'supply_kg', '5000000', 'state', state,
    'restriction', restriction, 'expires_at', '1800000000', 'revision', revision, 'live_children', 0,
    'event_revision', revision, 'issued_owner', pg_temp.a('khunou'),
    'issued_owner_org_id', pg_temp.org('khunou'), 'issued_at', pg_temp.at(200)))
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

create function pg_temp.intent(cancelled_by text, slot bigint, n int) returns jsonb
language sql stable as $$
  select pg_temp.up('chain_release_intents', pg_temp.a('intent1'), slot, n, jsonb_build_object(
    'loan', pg_temp.a('loan1'), 'lot', pg_temp.a('lot'), 'position', pg_temp.a('posK'),
    'seller', pg_temp.a('khunou'), 'seller_org_id', pg_temp.org('khunou'),
    'buyer', pg_temp.a('buyer'), 'buyer_org_id', pg_temp.org('buyer-smelter'),
    'lender', pg_temp.a('lender1'), 'lender_org_id', pg_temp.org('lender-one'),
    'currency_decimals', 2, 'nonce', '1', 'quantity_kg', '2000000', 'price', '40000000',
    'top_up', '0', 'currency', 'USD', 'expires_at', '1800000000', 'position_revision', '1',
    'status', 'Open', 'cancelled_by', cancelled_by))
$$;

create function pg_temp.document(kind text, subject_address text, slot bigint, n int) returns jsonb
language sql stable as $$
  select pg_temp.up('chain_documents', pg_temp.a('doc'), slot, n, jsonb_build_object(
    'kind', kind, 'subject_hex', pg_temp.lot_hex(), 'version', 1, 'issuer', pg_temp.a('kopano'),
    'issuer_org_id', pg_temp.org('kopano'), 'sha256_hex', repeat('dd', 32),
    'valid_until', '1800000000', 'revoked_at', null, 'subject_address', subject_address))
$$;

create function pg_temp.shipment(registered int, event_revision text, event_registered int,
  slot bigint, n int, committed text default '5000000', prepared_at text default '1795000000')
returns jsonb language sql stable as $$
  select pg_temp.up('chain_shipments', pg_temp.a('s1'), slot, n, jsonb_build_object(
    'shipment_id_hex', repeat('22', 16), 'lot', pg_temp.a('lot'), 'position', pg_temp.a('posK'),
    'owner', pg_temp.a('khunou'), 'owner_org_id', pg_temp.org('khunou'),
    'source', pg_temp.a('site'), 'source_custodian', pg_temp.a('kopano'),
    'source_custodian_org_id', pg_temp.org('kopano'),
    'destination', pg_temp.a('portSite'), 'destination_custodian', pg_temp.a('port'),
    'destination_custodian_org_id', pg_temp.org('port-t1'),
    'committed_kg', committed, 'locked_kg', '5000000', 'batch_count', 1,
    'manifest_root_hex', '8df721d308bd44a37494f5362fff9cb0ac090efc83e7f2cb152177dc7b602486',
    'departure_document', pg_temp.a('doc'), 'registered_count', registered,
    'registered_kg', case when registered = 0 then '0' else '5000000' end,
    'departed_count', 0, 'departed_kg', '0', 'arrived_count', 0, 'arrived_kg', '0',
    'status', 'Prepared', 'prepared_at', prepared_at, 'revision', '0',
    'event_revision', event_revision, 'event_registered', event_registered))
$$;

create function pg_temp.batch_row(event_sequence text, event_observations int, slot bigint, n int)
returns jsonb language sql stable as $$
  select pg_temp.up('chain_batches', pg_temp.a('b1'), slot, n, jsonb_build_object(
    'shipment', pg_temp.a('s1'), 'lot', pg_temp.a('lot'), 'batch_index', 0, 'batch_count', 1,
    'quantity_kg', '5000000', 'carrier', pg_temp.a('mosela'),
    'load_digest_hex', repeat('33', 32), 'manifest_digest_hex', repeat('44', 32),
    'holder', pg_temp.a('kopano'), 'holder_org_id', pg_temp.org('kopano'), 'stage', 'AtSource',
    'sequence', '0', 'observation_count', 0, 'departed_at', null, 'arrived_at', null,
    'event_sequence', event_sequence, 'event_observations', event_observations))
$$;

create function pg_temp.batch(expected bigint, through bigint, txs jsonb, evs jsonb, ups jsonb)
returns jsonb language sql immutable as $$
  select jsonb_build_object('stream', pg_temp.stream(), 'expectedThroughSlot', expected,
    'throughSlot', through, 'transactions', txs, 'events', evs, 'upserts', ups)
$$;

-- One transaction with one event (or none) and these upserts, from the cursor `expected`.
create function pg_temp.one(expected bigint, through bigint, n int, ev jsonb, ups jsonb) returns jsonb
language sql immutable as $$
  select pg_temp.batch(expected, through,
    jsonb_build_array(pg_temp.tx(n, through, case when ev is null then 0 else 1 end)),
    case when ev is null then '[]'::jsonb else jsonb_build_array(ev) end, ups)
$$;

create function pg_temp.cursor() returns bigint language sql stable as $$
  select indexed_through_slot from public.indexer_checkpoints
$$;

-- The fixtures, built as postgres and kept as settings.
-- 100: the registry (protocol, class, seven organisations, Kopano's and Port Terminal T1's sites).
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
    pg_temp.organisation('buyer', 'Buyer Smelter Co', 'Buyer'),
    pg_temp.organisation('lender1', 'Lender One Bank', 'Lender'),
    pg_temp.organisation('lender2', 'Lender Two Bank', 'Lender'),
    pg_temp.organisation('port', 'Port Terminal T1', 'Terminal'),
    pg_temp.organisation('mosela', 'Mosela Haulage', 'Transporter'),
    pg_temp.site('site', 'kopano', 'KOPANO-YARD-1', '5000000', '0', 100, 1),
    pg_temp.site('portSite', 'port', 'PORT-T1', '0', '0', 100, 1)))::text, true);
-- 200: CR-0001 issued to Khunou at Kopano.
select set_config('t.b2', pg_temp.one(100, 200, 2,
  pg_temp.ev(2, 0, 200, 'IssueLot', 'LotIssued', 'lot',
    jsonb_build_object('lot', pg_temp.a('lot'), 'lot_revision', '0')),
  jsonb_build_array(
    pg_temp.lot('0', 'Stored', 'Normal', 200, 2),
    pg_temp.up('chain_intakes', pg_temp.a('intake'), 200, 2, jsonb_build_object(
      'custodian', pg_temp.a('kopano'), 'custodian_org_id', pg_temp.org('kopano'),
      'intake_digest_hex', repeat('01', 32), 'lot', pg_temp.a('lot'), 'retired', false)),
    pg_temp.pos('0', '0', 200, 2)))::text, true);
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
      'rate_bps', 1200, 'terms_version', 1, 'principal', '0', 'booked_interest', '0',
      'accrual_remainder', '0', 'accrued_at', '1795000000', 'open_exceptions', 0,
      'revision', '0', 'event_revision', '0')),
    pg_temp.up('chain_locks', pg_temp.a('lock1'), 400, 4, jsonb_build_object(
      'loan', pg_temp.a('loan1'), 'position', pg_temp.a('posK'), 'quantity_kg', '5000000',
      'control', 'Pledged')),
    pg_temp.pos('1', '5000000', 400, 4),
    pg_temp.facility('fac1', 'lender1', 1, 400, 4)))::text, true);
-- 500: a release intent to Buyer Smelter.
select set_config('t.b5', pg_temp.one(400, 500, 5,
  pg_temp.ev(5, 0, 500, 'CreateReleaseIntent', 'ReleaseIntentCreated', 'facility', jsonb_build_object(
    'facility', pg_temp.a('fac1'), 'loan', pg_temp.a('loan1'), 'created', pg_temp.a('intent1'))),
  jsonb_build_array(pg_temp.intent(null, 500, 5)))::text, true);
-- 600: Kopano attests the Departure document of CR-0001.
select set_config('t.b6', pg_temp.one(500, 600, 6,
  pg_temp.ev(6, 0, 600, 'AttestDocument', 'DocumentAttested', 'organisation',
    jsonb_build_object('org_id', pg_temp.org('kopano'))),
  jsonb_build_array(pg_temp.document('Departure', pg_temp.a('lot'), 600, 6)))::text, true);
-- 700: S1 prepared to PORT-T1, lot-scoped; the open intent marked cancelled by it.
select set_config('t.b7', pg_temp.one(600, 700, 7,
  pg_temp.ev(7, 0, 700, 'PrepareShipment', 'ShipmentPrepared', 'lot', jsonb_build_object(
    'lot', pg_temp.a('lot'), 'lot_revision', '1', 'shipment', pg_temp.a('s1'),
    'shipment_revision', '0', 'created', pg_temp.a('s1'))),
  jsonb_build_array(
    pg_temp.shipment(0, '0', 0, 700, 7),
    pg_temp.lot('1', 'Prepared', 'Normal', 700, 7),
    pg_temp.pos('2', '5000000', 700, 7),
    pg_temp.site('portSite', 'port', 'PORT-T1', '0', '5000000', 700, 7),
    pg_temp.intent(pg_temp.a('s1'), 500, 5)))::text, true);
-- 800: B1 registered, carried by Mosela Haulage, shipment-scoped.
select set_config('t.b8', pg_temp.one(700, 800, 8,
  pg_temp.ev(8, 0, 800, 'RegisterBatch', 'BatchRegistered', 'shipment', jsonb_build_object(
    'shipment', pg_temp.a('s1'), 'batch', pg_temp.a('b1'), 'created', pg_temp.a('b1'))),
  jsonb_build_array(pg_temp.batch_row('0', 0, 800, 8), pg_temp.shipment(1, '0', 1, 800, 8)))::text, true);

-- Eight members: one of each fixture organisation, and one of a test-only custodian with no role in
-- any of them.
insert into public.organisations (id, slug, name, kind, synthetic) values
  ('11000000-0000-4000-8000-0000000000c2', 'custodian-two-test', 'Custodian Two Test Org', 'custodian', true);
insert into auth.users (id, email, email_confirmed_at, aud, role) values
  ('42000000-0000-4000-8000-000000000001', 'cust-khunou@example.test', now(), 'authenticated', 'authenticated'),
  ('42000000-0000-4000-8000-000000000002', 'cust-kopano@example.test', now(), 'authenticated', 'authenticated'),
  ('42000000-0000-4000-8000-000000000003', 'cust-port@example.test', now(), 'authenticated', 'authenticated'),
  ('42000000-0000-4000-8000-000000000004', 'cust-mosela@example.test', now(), 'authenticated', 'authenticated'),
  ('42000000-0000-4000-8000-000000000005', 'cust-lender-one@example.test', now(), 'authenticated', 'authenticated'),
  ('42000000-0000-4000-8000-000000000006', 'cust-lender-two@example.test', now(), 'authenticated', 'authenticated'),
  ('42000000-0000-4000-8000-000000000007', 'cust-buyer@example.test', now(), 'authenticated', 'authenticated'),
  ('42000000-0000-4000-8000-000000000008', 'cust-two@example.test', now(), 'authenticated', 'authenticated');
insert into public.memberships (organisation_id, user_id, member_role)
select organisations.id, fixture.user_id::uuid, 'member'
from (values
  ('khunou', '42000000-0000-4000-8000-000000000001'),
  ('kopano', '42000000-0000-4000-8000-000000000002'),
  ('port-t1', '42000000-0000-4000-8000-000000000003'),
  ('mosela', '42000000-0000-4000-8000-000000000004'),
  ('lender-one', '42000000-0000-4000-8000-000000000005'),
  ('lender-two', '42000000-0000-4000-8000-000000000006'),
  ('buyer-smelter', '42000000-0000-4000-8000-000000000007'),
  ('custodian-two-test', '42000000-0000-4000-8000-000000000008')
) as fixture(slug, user_id)
join public.organisations on organisations.slug = fixture.slug;

create function pg_temp.as_user(n int) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', '42000000-0000-4000-8000-00000000000' || n,
    'role', 'authenticated')::text, true)
$$;

-- What a member reads of S1: the shipment, its batch, the events that describe it and its
-- Departure document.
create function pg_temp.custody_view() returns setof text language sql stable as $$
  select 'shipment ' || address from public.chain_shipments
  union all select 'batch ' || address from public.chain_batches
  union all select 'event ' || event from public.chain_events where shipment is not null
  union all select 'document ' || address from public.chain_documents where kind = 'Departure'
$$;

-- ---------------------------------------------------------------------------------------------
-- 1. RLS on chain_shipments and chain_batches; anon selects nothing; no role writes them directly.
select is(
  (select count(*)::int from pg_catalog.pg_class
    where relnamespace = 'public'::regnamespace and relrowsecurity
      and relname in ('chain_shipments', 'chain_batches')),
  2, '1. RLS is enabled on chain_shipments and chain_batches');
select is_empty(
  $$select relname from pg_catalog.pg_class
    where relnamespace = 'public'::regnamespace and relkind = 'r'
      and relname in ('chain_shipments', 'chain_batches')
      and (has_table_privilege('anon', oid, 'SELECT') or has_any_column_privilege('anon', oid, 'SELECT'))$$,
  '1. anon has no SELECT on a custody table');
select is_empty(
  $$select relname || ' ' || role || ' ' || privilege from pg_catalog.pg_class,
      unnest(array['anon', 'authenticated', 'service_role']) as role,
      unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) as privilege
    where relnamespace = 'public'::regnamespace and relkind = 'r'
      and relname in ('chain_shipments', 'chain_batches')
      and has_table_privilege(role, oid, privilege)$$,
  '1. no API role may insert, update, delete or truncate a custody table');
select is(
  (select count(*)::int from pg_catalog.pg_class
    where relnamespace = 'public'::regnamespace and relkind = 'r'
      and relname in ('chain_shipments', 'chain_batches')
      and has_table_privilege('authenticated', oid, 'SELECT')
      and has_table_privilege('service_role', oid, 'SELECT')),
  2, '1. authenticated and service_role may select the two tables');
select ok(
  has_function_privilege('authenticated', 'private.can_read_shipment(text)', 'EXECUTE')
    and not has_function_privilege('anon', 'private.can_read_shipment(text)', 'EXECUTE')
    and not has_function_privilege('service_role', 'private.can_read_shipment(text)', 'EXECUTE'),
  '1. only authenticated executes can_read_shipment');

-- Write the fixtures through the functions, as the worker does.
set local role service_role;
select lives_ok($$select public.indexer_checkpoint(pg_temp.stream(), null, '{}'::jsonb)$$,
  'indexer_checkpoint creates the stream row');
select lives_ok($$select public.indexer_apply(current_setting('t.b1')::jsonb)$$, 'batch 1 applies');
select lives_ok($$select public.indexer_apply(current_setting('t.b2')::jsonb)$$, 'batch 2 applies');
select lives_ok($$select public.indexer_apply(current_setting('t.b3')::jsonb)$$, 'batch 3 applies');
select lives_ok($$select public.indexer_apply(current_setting('t.b4')::jsonb)$$, 'batch 4 applies');
select lives_ok($$select public.indexer_apply(current_setting('t.b5')::jsonb)$$, 'batch 5 applies');
select lives_ok($$select public.indexer_apply(current_setting('t.b6')::jsonb)$$,
  '2. indexer_apply accepts document kind Departure');
select lives_ok($$select public.indexer_apply(current_setting('t.b7')::jsonb)$$,
  '2. indexer_apply accepts lot state Prepared');
select lives_ok($$select public.indexer_apply(current_setting('t.b8')::jsonb)$$, 'batch 8 applies');
reset role;
select is(pg_temp.cursor(), 800::bigint, 'the cursor is at the last batch');
select is((select row(registered_count, event_registered, event_revision) from public.chain_shipments),
  row(1::bigint, 1::bigint, '0'::text), 'S1 is stored with one registration');
select is((select cancelled_by from public.chain_release_intents), pg_temp.a('s1'),
  'the re-sent intent row carries the mark');
select is((select row(slot, position_revision) from public.chain_release_intents),
  row(500::bigint, '1'::text), 'the re-sent intent keeps its slot and account columns');

-- 3. Who reads what.
set local role authenticated;
select pg_temp.as_user(1); -- khunou, the owner
select set_eq('select * from pg_temp.custody_view()', array['shipment ' || pg_temp.a('s1'),
  'batch ' || pg_temp.a('b1'), 'event ShipmentPrepared', 'event BatchRegistered',
  'document ' || pg_temp.a('doc')], '3. khunou reads S1, B1, both events and the Departure document');
select pg_temp.as_user(2); -- kopano, the source custodian and the document's issuer
select set_eq('select * from pg_temp.custody_view()', array['shipment ' || pg_temp.a('s1'),
  'batch ' || pg_temp.a('b1'), 'event ShipmentPrepared', 'event BatchRegistered',
  'document ' || pg_temp.a('doc')], '3. kopano reads S1, B1, both events and the Departure document');
select pg_temp.as_user(3); -- port-t1, the destination custodian
select set_eq('select * from pg_temp.custody_view()', array['shipment ' || pg_temp.a('s1'),
  'batch ' || pg_temp.a('b1'), 'event ShipmentPrepared', 'event BatchRegistered',
  'document ' || pg_temp.a('doc')], '3. port-t1 reads S1, B1, both events and the Departure document');
select is_empty($$select 1 from public.chain_lots union all select 1 from public.chain_positions$$,
  '3. port-t1 reads no lot or position row before arrival');
select pg_temp.as_user(4); -- mosela, the carrier
select set_eq('select * from pg_temp.custody_view()', array['shipment ' || pg_temp.a('s1'),
  'batch ' || pg_temp.a('b1'), 'event ShipmentPrepared', 'event BatchRegistered',
  'document ' || pg_temp.a('doc')], '3. mosela reads S1, B1, both events and the Departure document');
select is_empty($$select 1 from public.chain_lots union all select 1 from public.chain_positions
  union all select 1 from public.chain_loans union all select 1 from public.chain_locks
  union all select 1 from public.chain_release_intents union all select 1 from public.chain_facilities$$,
  '3. mosela reads no lot, position, loan, lock, release intent or facility row');
select is_empty($$select 1 from public.chain_events where scope in ('facility', 'organisation')$$,
  '3. mosela reads no facility- or organisation-scoped event');
select pg_temp.as_user(5); -- lender-one, the lender with the loan
select set_eq('select * from pg_temp.custody_view()', array['shipment ' || pg_temp.a('s1'),
  'batch ' || pg_temp.a('b1'), 'event ShipmentPrepared', 'event BatchRegistered',
  'document ' || pg_temp.a('doc')], '3. lender-one reads S1, B1, both events and the Departure document');
select pg_temp.as_user(6); -- lender-two, a facility to the holder and no loan
select set_eq('select * from pg_temp.custody_view()', array['shipment ' || pg_temp.a('s1'),
  'batch ' || pg_temp.a('b1'), 'event ShipmentPrepared', 'event BatchRegistered',
  'document ' || pg_temp.a('doc')], '3. lender-two reads S1, B1, both events and the Departure document');
select pg_temp.as_user(7); -- buyer-smelter, the buyer of a release intent on the lot
select set_eq('select * from pg_temp.custody_view()', array['shipment ' || pg_temp.a('s1'),
  'batch ' || pg_temp.a('b1'), 'event ShipmentPrepared', 'event BatchRegistered',
  'document ' || pg_temp.a('doc')], '3. buyer-smelter reads S1, B1, both events and the Departure document');
select pg_temp.as_user(8); -- Custodian Two Test Org, no role in any of them
select is_empty('select * from pg_temp.custody_view()',
  '3. the Custodian Two Test Org member reads none of S1, B1, the document or the two events');
reset role;

-- 4. A stored custody key repeated under another signature is REVISION_SEQUENCE, writing nothing.
set local role service_role;
select lives_ok(
  $$select public.indexer_apply(pg_temp.batch(800, 900, jsonb_build_array(pg_temp.tx(9, 900, 3)),
    jsonb_build_array(
      pg_temp.ev(9, 0, 900, 'Handover', 'CustodyHandedOver', 'shipment', jsonb_build_object(
        'shipment', pg_temp.a('s1'), 'shipment_revision', '1', 'batch', pg_temp.a('b1'),
        'batch_sequence', '0')),
      pg_temp.ev(9, 1, 900, 'RecordObservation', 'ObservationRecorded', 'shipment', jsonb_build_object(
        'shipment', pg_temp.a('s1'), 'batch', pg_temp.a('b1'), 'observation_index', 0)),
      pg_temp.ev(9, 2, 900, 'AcceptLoading', 'LoadingAccepted', 'facility', jsonb_build_object(
        'facility', pg_temp.a('fac1'), 'loan', pg_temp.a('loan1'), 'acceptance', pg_temp.a('acc1'),
        'acceptance_version', 1))),
    '[]'::jsonb))$$,
  '4. events with a batch sequence, an observation index and an acceptance version apply');
select throws_ok(
  $$select public.indexer_apply(pg_temp.one(900, 1000, 10,
    pg_temp.ev(10, 0, 1000, 'CancelShipment', 'ShipmentCancelled', 'lot', jsonb_build_object(
      'lot', pg_temp.a('lot'), 'lot_revision', '2', 'shipment', pg_temp.a('s1'),
      'shipment_revision', '0')), '[]'::jsonb))$$,
  'P0001', 'REVISION_SEQUENCE', '4. a repeated (shipment, shipment_revision) is REVISION_SEQUENCE');
select throws_ok(
  $$select public.indexer_apply(pg_temp.one(900, 1000, 10,
    pg_temp.ev(10, 0, 1000, 'Handover', 'CustodyHandedOver', 'shipment', jsonb_build_object(
      'shipment', pg_temp.a('s1'), 'batch', pg_temp.a('b1'), 'batch_sequence', '0')), '[]'::jsonb))$$,
  'P0001', 'REVISION_SEQUENCE', '4. a repeated (batch, batch_sequence) is REVISION_SEQUENCE');
select throws_ok(
  $$select public.indexer_apply(pg_temp.one(900, 1000, 10,
    pg_temp.ev(10, 0, 1000, 'RecordObservation', 'ObservationRecorded', 'shipment', jsonb_build_object(
      'shipment', pg_temp.a('s1'), 'batch', pg_temp.a('b1'), 'observation_index', 0)), '[]'::jsonb))$$,
  'P0001', 'REVISION_SEQUENCE', '4. a repeated (batch, observation_index) is REVISION_SEQUENCE');
select throws_ok(
  $$select public.indexer_apply(pg_temp.one(900, 1000, 10,
    pg_temp.ev(10, 0, 1000, 'AcceptLoading', 'LoadingAccepted', 'facility', jsonb_build_object(
      'facility', pg_temp.a('fac1'), 'loan', pg_temp.a('loan1'), 'acceptance', pg_temp.a('acc1'),
      'acceptance_version', 1)), '[]'::jsonb))$$,
  'P0001', 'REVISION_SEQUENCE', '4. a repeated (acceptance, acceptance_version) is REVISION_SEQUENCE');
reset role;
select is(pg_temp.cursor(), 900::bigint, '4. the cursor did not move');
select is((select count(*)::int from public.chain_events), 12, '4. no event was written');

-- 5. Row shape: the custody key pairs, the created rule and the Departure subject.
set local role service_role;
select throws_ok(
  $$select public.indexer_apply(pg_temp.one(900, 1000, 10,
    pg_temp.ev(10, 0, 1000, 'RegisterBatch', 'BatchRegistered', 'shipment', jsonb_build_object(
      'batch', pg_temp.a('b1'))), '[]'::jsonb))$$,
  'P0001', 'ROW_INVALID', '5. a shipment-scoped event without shipment is ROW_INVALID');
select throws_ok(
  $$select public.indexer_apply(pg_temp.one(900, 1000, 10,
    pg_temp.ev(10, 0, 1000, 'CancelShipment', 'ShipmentCancelled', 'lot', jsonb_build_object(
      'lot', pg_temp.a('lot'), 'lot_revision', '2', 'shipment_revision', '1')), '[]'::jsonb))$$,
  'P0001', 'ROW_INVALID', '5. a shipment_revision without shipment is ROW_INVALID');
select throws_ok(
  $$select public.indexer_apply(pg_temp.one(900, 1000, 10,
    pg_temp.ev(10, 0, 1000, 'Handover', 'CustodyHandedOver', 'shipment', jsonb_build_object(
      'shipment', pg_temp.a('s1'), 'batch_sequence', '1')), '[]'::jsonb))$$,
  'P0001', 'ROW_INVALID', '5. a batch_sequence without batch is ROW_INVALID');
select throws_ok(
  $$select public.indexer_apply(pg_temp.one(900, 1000, 10,
    pg_temp.ev(10, 0, 1000, 'RecordObservation', 'ObservationRecorded', 'shipment', jsonb_build_object(
      'shipment', pg_temp.a('s1'), 'observation_index', 1)), '[]'::jsonb))$$,
  'P0001', 'ROW_INVALID', '5. an observation_index without batch is ROW_INVALID');
select throws_ok(
  $$select public.indexer_apply(pg_temp.one(900, 1000, 10,
    pg_temp.ev(10, 0, 1000, 'Handover', 'CustodyHandedOver', 'shipment', jsonb_build_object(
      'shipment', pg_temp.a('s1'), 'batch', pg_temp.a('b1'), 'batch_sequence', '1',
      'observation_index', 1)), '[]'::jsonb))$$,
  'P0001', 'ROW_INVALID', '5. a batch_sequence and an observation_index on one row is ROW_INVALID');
select throws_ok(
  $$select public.indexer_apply(pg_temp.one(900, 1000, 10,
    pg_temp.ev(10, 0, 1000, 'AcceptLoading', 'LoadingAccepted', 'facility', jsonb_build_object(
      'facility', pg_temp.a('fac1'), 'loan', pg_temp.a('loan1'), 'acceptance', pg_temp.a('acc1'))),
    '[]'::jsonb))$$,
  'P0001', 'ROW_INVALID', '5. an acceptance without its version is ROW_INVALID');
select throws_ok(
  $$select public.indexer_apply(pg_temp.one(900, 1000, 10,
    pg_temp.ev(10, 0, 1000, 'CreateLoadingIntent', 'LoadingIntentCreated', 'loading', '{}'), '[]'::jsonb))$$,
  'P0001', 'ROW_INVALID', '5. a loading event without created is ROW_INVALID');
select throws_ok(
  $$select public.indexer_apply(pg_temp.one(900, 1000, 10,
    pg_temp.ev(10, 0, 1000, 'AttestShortfall', 'ShortfallAttested', 'incident', '{}'), '[]'::jsonb))$$,
  'P0001', 'ROW_INVALID', '5. an incident event without created is ROW_INVALID');
select throws_ok(
  $$select public.indexer_apply(pg_temp.one(900, 1000, 10,
    pg_temp.ev(10, 0, 1000, 'Pause', 'PauseChanged', 'registry', '{}')
      - array['shipment', 'shipment_revision', 'batch', 'batch_sequence', 'observation_index',
        'acceptance', 'acceptance_version'], '[]'::jsonb))$$,
  'P0001', 'ROW_INVALID', '5. an event row without the seven new keys is ROW_INVALID');
select throws_ok(
  $$select public.indexer_apply(pg_temp.one(900, 1000, 10, null,
    jsonb_build_array(pg_temp.document('Departure', null, 1000, 10))))$$,
  'P0001', 'ROW_INVALID', '5. a Departure document without subject_address is ROW_INVALID');
select throws_ok(
  $$select public.indexer_apply(pg_temp.one(900, 1000, 10, null,
    jsonb_build_array(pg_temp.document('Origin', pg_temp.a('lot'), 1000, 10))))$$,
  'P0001', 'ROW_INVALID', '5. an Origin document with a subject_address is ROW_INVALID');
reset role;

-- 6. The event and mark columns come from indexer_apply even at a lower slot, and
-- indexer_reconcile never changes them.
set local role service_role;
select lives_ok(
  $$select public.indexer_apply(pg_temp.one(900, 1000, 11, null, jsonb_build_array(
    pg_temp.shipment(0, '1', 2, 650, 11),
    pg_temp.batch_row('2', 3, 650, 11),
    pg_temp.intent(pg_temp.a('s2'), 450, 11))))$$,
  '6. a batch with older account reads applies');
reset role;
select is((select row(registered_count, event_revision, event_registered, slot) from public.chain_shipments),
  row(1::bigint, '1'::text, 2::bigint, 800::bigint),
  '6. the shipment keeps its newer account columns and takes its event columns');
select is((select row(event_sequence, event_observations, slot) from public.chain_batches),
  row('2'::text, 3::bigint, 800::bigint), '6. the batch takes event_sequence and event_observations');
select is((select row(cancelled_by, slot) from public.chain_release_intents),
  row(pg_temp.a('s2'), 500::bigint), '6. the intent takes cancelled_by and keeps its slot');
set local role service_role;
select lives_ok(
  $$select public.indexer_reconcile(pg_temp.stream(), 1000, jsonb_build_array(
    jsonb_set(pg_temp.shipment(1, '9', 9, 1000, 11), '{row,commitment}', '"finalized"'),
    jsonb_set(pg_temp.batch_row('9', 9, 1000, 11), '{row,commitment}', '"finalized"'),
    jsonb_set(pg_temp.intent(pg_temp.a('b1'), 1000, 11), '{row,commitment}', '"finalized"')), '[]'::jsonb)$$,
  '6. indexer_reconcile promotes the shipment, the batch and the intent');
reset role;
select is((select row(event_revision, event_registered, commitment::text) from public.chain_shipments),
  row('1'::text, 2::bigint, 'finalized'::text), '6. reconcile does not change the shipment''s event columns');
select is((select row(event_sequence, event_observations, commitment::text) from public.chain_batches),
  row('2'::text, 3::bigint, 'finalized'::text), '6. reconcile does not change the batch''s event columns');
select is((select row(cancelled_by, commitment::text) from public.chain_release_intents),
  row(pg_temp.a('s2'), 'finalized'::text), '6. reconcile does not change cancelled_by');

-- 8. The new u64 and i64 columns refuse non-canonical and out-of-range text as ROW_INVALID.
set local role service_role;
select throws_ok(
  $$select public.indexer_apply(pg_temp.one(1000, 1100, 12, null,
    jsonb_build_array(pg_temp.shipment(1, '1', 2, 1100, 12, '01'))))$$,
  'P0001', 'ROW_INVALID', '8. committed_kg ''01'' is ROW_INVALID');
select throws_ok(
  $$select public.indexer_apply(pg_temp.one(1000, 1100, 12, null,
    jsonb_build_array(pg_temp.shipment(1, '1', 2, 1100, 12, '18446744073709551616'))))$$,
  'P0001', 'ROW_INVALID', '8. committed_kg 2^64 is ROW_INVALID');
select throws_ok(
  $$select public.indexer_apply(pg_temp.one(1000, 1100, 12, null,
    jsonb_build_array(pg_temp.shipment(1, '1', 2, 1100, 12, '5000000', '18446744073709551616'))))$$,
  'P0001', 'ROW_INVALID', '8. an i64 prepared_at of 2^64 is ROW_INVALID');
select throws_ok(
  $$select public.indexer_apply(pg_temp.one(1000, 1100, 12,
    pg_temp.ev(12, 0, 1100, 'CancelShipment', 'ShipmentCancelled', 'lot', jsonb_build_object(
      'lot', pg_temp.a('lot'), 'lot_revision', '2', 'shipment', pg_temp.a('s1'),
      'shipment_revision', '01')), '[]'::jsonb))$$,
  'P0001', 'ROW_INVALID', '8. a shipment_revision ''01'' is ROW_INVALID');
reset role;

-- 2. The widened CHECKs: exactly the IDL's variants (Prepared and Departure applied above).
set local role service_role;
select lives_ok(
  $$select public.indexer_apply(pg_temp.one(1000, 1100, 13, null,
    jsonb_build_array(pg_temp.lot('1', 'InTransit', 'ReviewRequired', 1100, 13))))$$,
  '2. indexer_apply accepts lot state InTransit and restriction ReviewRequired');
select lives_ok(
  $$select public.indexer_apply(pg_temp.one(1100, 1200, 14, null,
    jsonb_build_array(pg_temp.lot('1', 'Loaded', 'Disputed', 1200, 14))))$$,
  '2. indexer_apply accepts lot state Loaded and restriction Disputed');
select lives_ok(
  $$select public.indexer_apply(pg_temp.one(1200, 1300, 15, null,
    jsonb_build_array(pg_temp.lot('1', 'Stored', 'Frozen', 1300, 15))))$$,
  '2. indexer_apply accepts restriction Frozen');
select throws_ok(
  $$select public.indexer_apply(pg_temp.one(1300, 1400, 16, null,
    jsonb_build_array(pg_temp.lot('1', 'Shipped', 'Normal', 1400, 16))))$$,
  'P0001', 'ROW_INVALID', '2. lot state ''Shipped'' is ROW_INVALID');
select throws_ok(
  $$select public.indexer_apply(pg_temp.one(1300, 1400, 16, null,
    jsonb_build_array(pg_temp.lot('1', 'Stored', 'Hold', 1400, 16))))$$,
  'P0001', 'ROW_INVALID', '2. restriction ''Hold'' is ROW_INVALID');
select throws_ok(
  $$select public.indexer_apply(pg_temp.one(1300, 1400, 16, null,
    jsonb_build_array(pg_temp.document('Transport', null, 1400, 16))))$$,
  'P0001', 'ROW_INVALID', '2. document kind ''Transport'' is ROW_INVALID');
reset role;

-- 7. indexer_reset leaves no row in the two tables.
set local role service_role;
select lives_ok($$select public.indexer_halt(pg_temp.stream(), 1300, 'EVENT_GAP', 'sequence: synthetic', null)$$,
  '7. the stream halts');
select lives_ok($$select public.indexer_reset(pg_temp.stream())$$, '7. indexer_reset clears the stream');
reset role;
select is((select count(*)::int from public.chain_shipments) + (select count(*)::int from public.chain_batches),
  0, '7. no row is left in chain_shipments or chain_batches');

select * from finish();
rollback;
