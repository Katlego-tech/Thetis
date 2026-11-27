-- Phase 2 of the chain read model: the eight lending tables, their access rules, the new event
-- keys and the write functions that carry them (live-lending.md §6.1, §6.2, §9.2).
-- SYNTHETIC: every address, signature and slot below is made up (base58 of repeated bytes);
-- only the program id is the real devnet program. The amounts are demo.md §2's.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(73);

-- A clean slate inside this transaction (rolled back at the end).
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
    when 'posB' then '79cu2QNvp92chEmBhBgcUfERDT9KHnUcr8eiJb5WzKKt'
    when 'mint' then '7DYCAhqwQSKqqL1h8V1XmY1BTcMWxrASQYKNMy87jeea'
    when 'fac1' then '7HTVK1Jwzjd4yRGCZnLT4QmwhmZidurFxwz2RMAiUyyG'
    when 'fac2' then '7MNnTJmxb2vJ7WWi15fNMHYhwvmvJyY5XMegUjDKEKHx'
    when 'val1' then '7RJ5bcEyBLDXFbmDSNzHeAKUC5z7z3Du5mKLY7Fuyece'
    when 'loan1' then '7VDNjuhymdWkPh1isgKCw36ESFCKf6uieAyzbVJWiywL'
    when 'lock1' then '7Z8ftDAzMvoyXnGEJye8DurzgQQXLAbYCaeeesM7UKG2'
    when 'pay1' then '7d3y2WdzxE7CfsWjkGy3WndkvZcj1EHMkzKJiFPiDeai'
    when 'pay2' then '7gyGAp71YXQRoxmFBaHxofQXAipvgHyBKPyxmdSJxyuQ'
    when 'intent1' then '7ktZK7a28phex41kcsct6YBHQt38MMezsoecq1UuiKE6'
    when 'pool' then '7porTR32j7zt69GG4AwoPQx3f3FL2RLpSDKGtPXWTeYn'
    when 'share1' then '7tj9biW3KRJ7EEWmVUGigHiouCTXhV2dzcyvwma7CysU'
    when 'poolMint' then '7xeSk1y3uibLNKmGvmbdyAVa9MfjNYiTZ2eb19chxKCA'
    when 'poolVault' then '82ZjtKS4W1tZWR1nN4vZG3GLPWsw3cQH7SKF4XfJheWr'
    when 'walletK' then '86V32cu56KBneWGHoNFUYv36dg68ig66fqyu7uhuSyqY'
  end
$$;

create function pg_temp.sig(n int) returns text language sql immutable as $$
  select case n
    when 1 then '2wvXWzaBr7c9GXXqE47x9JSGasSjCW2khNCkpnMu96ZopRU8hVSJ9pjzCc46wy3FGiKmsxth2gbHmcz8sHj9depg'
    when 2 then '2y63jG7d5BGB9Wej9QUx7bMkFVF2yTwPcztwSZ5NatfXZN8gU9zr29AwoQTTLf5fLToUQPPKv87YHygncrnaEiCh'
    when 3 then '2zFZwXf4JEvD2Vmd4kqx5tHDv73LkRr2Ydb84Knr2gmFJJoEEpZPtTbuQCrojM85QDHAvosxoZdnpLPSNRqzqmai'
    when 4 then '31R69oCVXJaEuUtWz7Cx4BChaiqeXPkfUGHJg6WKUUry3FTn1V7wkn2s11GA83AVTxksTENbh1A3Lh667zuRSpxj'
    when 5 then '32acN4jvkNEGnU1QuTZx2U8BFLdxJMfJPtyVHsDnvGxgnC8Kn9gVd6TpbofWWjCuXiEZyesEaSgHs3njsZxr3tLk'
    when 6 then '33k8aLHMyRtJfT8Jpovwzm3euxSG5KZwKXffudwGN54QX8nsYpF3VQtnCc4ruRFKbTiGW5MsTtCYPQVPd92Gewim'
    when 7 then '34uenbpoCVYLYSFCkAHwy3y8aaEZrHUaFAMrXQejosA8G5TRKUobMjKjoQUDJ7HjfDBy2VrWMKinumC3Ni5hG16n'
    when 8 then '365AzsNERZCNRRN6fWewwLtcFC2sdFPDAo439BNDFfFr127y69N9E3khQCsZgoL9ixffYvM9EmF3S7th8H97s4Uo'
    when 9 then '37EhD8ufecrQJQUzas1wudp5uoqBQDHr6RkDkx5ghTMZjxnWrovh6NBf11Gv5VNZni9N5Lqn8CmHxUbLsrCYU7rp'
    when 10 then '38QDRQT6sgWSBPbtWDNwsvjZaRdVBBCV24SQNioA9FTHUuT4dUVExgccbogGUBQyrTd4bmLR1eHYUqHzdRFy5BEq'
    when 11 then '39ZjdfzY6kAU4NinRZjwrDf3F3Rnx977wh8azVWdb3Z1Dr7cQ93nq13aCc5crsTPvD6m8Bq3u5oo1BzeNzKPgEcr'
    when 12 then '3AjFqwXyKopVwMqgLv6wpWaWufE6j71ksKpmcGE72qeixnnAAocLhKUXoQUyFZVoyxaTecKgnXL3XYhJ8ZNpHHzs'
    when 13 then '3Btn4D5QYsUXpLxaGGTwnoVzaH2QW4vPnxWxE2waUdkShjShwUAtZduVQCtKeFYE3i4AB2pKfxrJ3uPwt8SEtMNt'
    when 14 then '3D4JGUcqmw8ZhL5UBcpwm6RUEtpiH2q2ibD8qof3vRrASg7Fi8jSRxLT11Hg2wae7TXrhTJxZQNYaG6bdhVfVQku'
    when 15 then '3EDpUkAGzznbaKCN6yBwjPLwuWd23zjfeDuKTaNXNDwtBcmoUoHzJGmQboh2Rdd4BD1ZDsobSqto6coFPGZ66U8v'
  end
$$;

create function pg_temp.org(slug text) returns text language sql stable as $$
  select id::text from public.organisations where organisations.slug = org.slug
$$;

create function pg_temp.slug(name text) returns text language sql immutable as $$
  select case name when 'buyer' then 'buyer-smelter' when 'lender1' then 'lender-one'
    when 'lender2' then 'lender-two' else name end
$$;

create function pg_temp.stream() returns jsonb language sql immutable as $$
  select jsonb_build_object('network', 'devnet', 'programId', pg_temp.a('program'),
    'protocol', pg_temp.a('protocol'))
$$;

create function pg_temp.at(slot bigint) returns text language sql immutable as $$
  select to_char(timestamptz '2026-11-27 00:00:00+00' + make_interval(secs => slot), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
$$;

create function pg_temp.tx(n int, slot bigint, events int) returns jsonb language sql immutable as $$
  select jsonb_build_object('network', 'devnet', 'program_id', pg_temp.a('program'),
    'signature', pg_temp.sig(n), 'slot', slot, 'block_time', pg_temp.at(slot), 'succeeded', true,
    'protocol', pg_temp.a('protocol'), 'event_count', events, 'other_instance', false)
$$;

-- An event row: the Phase 1 keys, the eight Phase 2 keys as null, then `keys` over them.
create function pg_temp.ev(n int, idx int, slot bigint, instruction text, event text, scope text,
  keys jsonb) returns jsonb language sql immutable as $$
  select jsonb_build_object('network', 'devnet', 'program_id', pg_temp.a('program'),
    'signature', pg_temp.sig(n), 'event_index', idx, 'slot', slot, 'block_time', pg_temp.at(slot),
    'protocol', pg_temp.a('protocol'), 'instruction', instruction, 'event', event, 'scope', scope,
    'lot', null, 'lot_revision', null, 'org_id', null, 'data', jsonb_build_object('synthetic', true),
    'facility', null, 'loan', null, 'loan_revision', null, 'pool', null, 'pool_revision', null,
    'valuation', null, 'valuation_version', null, 'created', null) || keys
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

create function pg_temp.pos(address text, owner text, quantity text, locked text, revision text,
  slot bigint, n int) returns jsonb language sql stable as $$
  select pg_temp.up('chain_positions', pg_temp.a(address), slot, n, jsonb_build_object(
    'lot', pg_temp.a('lot'), 'owner', pg_temp.a(owner), 'owner_org_id', pg_temp.org(pg_temp.slug(owner)),
    'quantity_kg', quantity, 'locked_kg', locked, 'reserved_kg', '0', 'revision', revision))
$$;

create function pg_temp.lot(revision text, slot bigint, n int) returns jsonb language sql stable as $$
  select pg_temp.up('chain_lots', pg_temp.a('lot'), slot, n, jsonb_build_object(
    'lot_id', 'CR-0001', 'class_policy', pg_temp.a('class'), 'class_version', 1, 'grade', 'G1',
    'custodian_class', pg_temp.a('site'), 'custodian', pg_temp.a('kopano'),
    'custodian_org_id', pg_temp.org('kopano'), 'intake', pg_temp.a('intake'), 'parent', null,
    'root', pg_temp.a('lot'), 'mint', pg_temp.a('mint'), 'supply_kg', '5000000', 'state', 'Stored',
    'restriction', 'Normal', 'expires_at', '1800000000', 'revision', revision, 'live_children', 0,
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

create function pg_temp.valuation(version int, event_version int, slot bigint, n int, valid_until text default '1800000000')
returns jsonb language sql stable as $$
  select pg_temp.up('chain_valuations', pg_temp.a('val1'), slot, n, jsonb_build_object(
    'facility', pg_temp.a('fac1'), 'class_policy', pg_temp.a('class'), 'grade', 'G1',
    'custodian_class', pg_temp.a('site'), 'value_per_kg', '20', 'haircut_bps', 0,
    'valid_until', valid_until, 'source_digest_hex', repeat('22', 32), 'version', version,
    'set_at', '1795000000', 'event_version', event_version))
$$;

create function pg_temp.loan(principal text, revision text, event_revision text, slot bigint, n int)
returns jsonb language sql stable as $$
  select pg_temp.up('chain_loans', pg_temp.a('loan1'), slot, n, jsonb_build_object(
    'facility', pg_temp.a('fac1'), 'lender_org_id', pg_temp.org('lender-one'),
    'borrower', pg_temp.a('khunou'), 'borrower_org_id', pg_temp.org('khunou'),
    'lot', pg_temp.a('lot'), 'position', pg_temp.a('posK'), 'loan_index', 0, 'status', 'Active',
    'rate_bps', 1200, 'terms_version', 1, 'principal', principal, 'booked_interest', '0',
    'accrual_remainder', '0', 'accrued_at', '1795000000', 'open_exceptions', 0,
    'revision', revision, 'event_revision', event_revision))
$$;

create function pg_temp.lock(quantity text, slot bigint, n int) returns jsonb language sql stable as $$
  select pg_temp.up('chain_locks', pg_temp.a('lock1'), slot, n, jsonb_build_object(
    'loan', pg_temp.a('loan1'), 'position', pg_temp.a('posK'), 'quantity_kg', quantity,
    'control', 'Pledged'))
$$;

create function pg_temp.payment(address text, purpose text, subject text, amount text, status text,
  slot bigint, n int) returns jsonb language sql stable as $$
  select pg_temp.up('chain_payments', pg_temp.a(address), slot, n, jsonb_build_object(
    'lender', pg_temp.a('lender1'), 'lender_org_id', pg_temp.org('lender-one'),
    'loan', pg_temp.a('loan1'), 'payment_id_hex', repeat(case address when 'pay1' then '32' else '31' end, 32),
    'purpose', purpose, 'subject', pg_temp.a(subject), 'amount', amount, 'currency', 'USD',
    'evidence_digest_hex', repeat('41', 32), 'observed_at', '1795000000', 'status', status,
    'applied', '0', 'surplus', '0'))
$$;

create function pg_temp.intent(status text, slot bigint, n int) returns jsonb language sql stable as $$
  select pg_temp.up('chain_release_intents', pg_temp.a('intent1'), slot, n, jsonb_build_object(
    'loan', pg_temp.a('loan1'), 'lot', pg_temp.a('lot'), 'position', pg_temp.a('posK'),
    'seller', pg_temp.a('khunou'), 'seller_org_id', pg_temp.org('khunou'),
    'buyer', pg_temp.a('buyer'), 'buyer_org_id', pg_temp.org('buyer-smelter'),
    'lender', pg_temp.a('lender1'), 'lender_org_id', pg_temp.org('lender-one'),
    'currency_decimals', 2, 'nonce', '1', 'quantity_kg', '2000000', 'price', '40000000',
    'top_up', '0', 'currency', 'USD', 'expires_at', '1795086400', 'position_revision', '1',
    'status', status))
$$;

create function pg_temp.batch(expected bigint, through bigint, txs jsonb, evs jsonb, ups jsonb)
returns jsonb language sql immutable as $$
  select jsonb_build_object('stream', pg_temp.stream(), 'expectedThroughSlot', expected,
    'throughSlot', through, 'transactions', txs, 'events', evs, 'upserts', ups)
$$;

create function pg_temp.cursor() returns bigint language sql stable as $$
  select indexed_through_slot from public.indexer_checkpoints
$$;

create function pg_temp.lending_rows() returns bigint language sql stable as $$
  select (select count(*) from public.chain_facilities) + (select count(*) from public.chain_valuations)
    + (select count(*) from public.chain_loans) + (select count(*) from public.chain_locks)
    + (select count(*) from public.chain_payments) + (select count(*) from public.chain_release_intents)
    + (select count(*) from public.chain_pools) + (select count(*) from public.chain_pool_shares)
$$;

-- The batches, built as postgres and kept as settings.
-- 100: the registry (protocol, class, five organisations, the custodian class).
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
    pg_temp.up('chain_custodian_classes', pg_temp.a('site'), 100, 1, jsonb_build_object(
      'custodian', pg_temp.a('kopano'), 'custodian_org_id', pg_temp.org('kopano'),
      'class_policy', pg_temp.a('class'), 'site_code', 'PORT-STOCKYARD',
      'approved_capacity_kg', '10000000', 'occupied_kg', '5000000', 'reserved_inbound_kg', '0'))))::text, true);
-- 200: CR-0001 issued to Khunou at Kopano.
select set_config('t.b2', pg_temp.batch(100, 200,
  jsonb_build_array(pg_temp.tx(2, 200, 1)),
  jsonb_build_array(pg_temp.ev(2, 0, 200, 'IssueLot', 'LotIssued', 'lot',
    jsonb_build_object('lot', pg_temp.a('lot'), 'lot_revision', '0'))),
  jsonb_build_array(
    pg_temp.lot('0', 200, 2),
    pg_temp.up('chain_intakes', pg_temp.a('intake'), 200, 2, jsonb_build_object(
      'custodian', pg_temp.a('kopano'), 'custodian_org_id', pg_temp.org('kopano'),
      'intake_digest_hex', repeat('01', 32), 'lot', pg_temp.a('lot'), 'retired', false)),
    pg_temp.pos('posK', 'khunou', '5000000', '0', '0', 200, 2)))::text, true);
-- 300: Lender One's and Lender Two's facilities to Khunou.
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
-- 400: Lender One's valuation, version 1.
select set_config('t.b4', pg_temp.batch(300, 400,
  jsonb_build_array(pg_temp.tx(4, 400, 1)),
  jsonb_build_array(pg_temp.ev(4, 0, 400, 'SetValuation', 'ValuationSet', 'facility',
    jsonb_build_object('facility', pg_temp.a('fac1'), 'valuation', pg_temp.a('val1'), 'valuation_version', 1))),
  jsonb_build_array(pg_temp.valuation(1, 1, 400, 4)))::text, true);
-- 500: loan 0 pledged with its lock.
select set_config('t.b5', pg_temp.batch(400, 500,
  jsonb_build_array(pg_temp.tx(5, 500, 1)),
  jsonb_build_array(pg_temp.ev(5, 0, 500, 'Pledge', 'Pledged', 'facility',
    jsonb_build_object('facility', pg_temp.a('fac1'), 'loan', pg_temp.a('loan1'), 'loan_revision', '0'))),
  jsonb_build_array(
    pg_temp.loan('0', '0', '0', 500, 5),
    pg_temp.lock('5000000', 500, 5),
    pg_temp.pos('posK', 'khunou', '5000000', '5000000', '1', 500, 5),
    pg_temp.facility('fac1', 'lender1', 1, 500, 5)))::text, true);
-- 600: a Repayment payment, an intent to Buyer Smelter and its Release payment.
select set_config('t.b6', pg_temp.batch(500, 600,
  jsonb_build_array(pg_temp.tx(6, 600, 3)),
  jsonb_build_array(
    pg_temp.ev(6, 0, 600, 'ConfirmPayment', 'PaymentConfirmed', 'facility', jsonb_build_object(
      'facility', pg_temp.a('fac1'), 'loan', pg_temp.a('loan1'), 'created', pg_temp.a('pay1'))),
    pg_temp.ev(6, 1, 600, 'CreateReleaseIntent', 'ReleaseIntentCreated', 'facility', jsonb_build_object(
      'facility', pg_temp.a('fac1'), 'loan', pg_temp.a('loan1'), 'created', pg_temp.a('intent1'))),
    pg_temp.ev(6, 2, 600, 'ConfirmPayment', 'PaymentConfirmed', 'facility', jsonb_build_object(
      'facility', pg_temp.a('fac1'), 'loan', pg_temp.a('loan1'), 'created', pg_temp.a('pay2')))),
  jsonb_build_array(
    pg_temp.payment('pay1', 'Repayment', 'loan1', '21000000', 'Unconsumed', 600, 6),
    pg_temp.intent('Open', 600, 6),
    pg_temp.payment('pay2', 'Release', 'intent1', '40000000', 'Unconsumed', 600, 6)))::text, true);
-- 700: the sale, lot-scoped (lot revision 1, loan revision 1).
select set_config('t.b7', pg_temp.batch(600, 700,
  jsonb_build_array(pg_temp.tx(7, 700, 1)),
  jsonb_build_array(pg_temp.ev(7, 0, 700, 'SellPledged', 'PledgedSold', 'lot', jsonb_build_object(
    'lot', pg_temp.a('lot'), 'lot_revision', '1', 'loan', pg_temp.a('loan1'), 'loan_revision', '1'))),
  jsonb_build_array(
    pg_temp.loan('20000000', '1', '1', 700, 7),
    pg_temp.lock('3000000', 700, 7),
    pg_temp.lot('1', 700, 7),
    pg_temp.pos('posK', 'khunou', '3000000', '3000000', '2', 700, 7),
    pg_temp.pos('posB', 'buyer', '2000000', '0', '0', 700, 7),
    pg_temp.intent('Executed', 700, 7),
    pg_temp.payment('pay2', 'Release', 'intent1', '40000000', 'Consumed', 700, 7)))::text, true);
-- 800: a pool opened and Lender One's deposit.
select set_config('t.b8', pg_temp.batch(700, 800,
  jsonb_build_array(pg_temp.tx(8, 800, 2)),
  jsonb_build_array(
    pg_temp.ev(8, 0, 800, 'OpenPool', 'PoolOpened', 'pool',
      jsonb_build_object('pool', pg_temp.a('pool'), 'created', pg_temp.a('pool'))),
    pg_temp.ev(8, 1, 800, 'Deposit', 'Deposited', 'pool',
      jsonb_build_object('pool', pg_temp.a('pool'), 'pool_revision', '1'))),
  jsonb_build_array(
    pg_temp.up('chain_pools', pg_temp.a('pool'), 800, 8, jsonb_build_object(
      'mint', pg_temp.a('poolMint'), 'vault', pg_temp.a('poolVault'), 'currency', 'USD',
      'currency_decimals', 2, 'cash_minor', '60000000', 'total_shares', '60000000',
      'lent_minor', '0', 'income_minor', '0', 'revision', '1', 'event_revision', '1')),
    pg_temp.up('chain_pool_shares', pg_temp.a('share1'), 800, 8, jsonb_build_object(
      'pool', pg_temp.a('pool'), 'organisation', pg_temp.a('lender1'),
      'org_id', pg_temp.org('lender-one'), 'shares', '60000000', 'lent_minor', '0'))))::text, true);

insert into auth.users (id, email, email_confirmed_at, aud, role) values
  ('41000000-0000-4000-8000-000000000001', 'lend-lender-one@example.test', now(), 'authenticated', 'authenticated'),
  ('41000000-0000-4000-8000-000000000002', 'lend-lender-two@example.test', now(), 'authenticated', 'authenticated'),
  ('41000000-0000-4000-8000-000000000003', 'lend-khunou@example.test', now(), 'authenticated', 'authenticated'),
  ('41000000-0000-4000-8000-000000000004', 'lend-buyer@example.test', now(), 'authenticated', 'authenticated'),
  ('41000000-0000-4000-8000-000000000005', 'lend-kopano@example.test', now(), 'authenticated', 'authenticated');
insert into public.memberships (organisation_id, user_id, member_role)
select organisations.id, fixture.user_id::uuid, 'member'
from (values
  ('lender-one', '41000000-0000-4000-8000-000000000001'),
  ('lender-two', '41000000-0000-4000-8000-000000000002'),
  ('khunou', '41000000-0000-4000-8000-000000000003'),
  ('buyer-smelter', '41000000-0000-4000-8000-000000000004'),
  ('kopano', '41000000-0000-4000-8000-000000000005')
) as fixture(slug, user_id)
join public.organisations on organisations.slug = fixture.slug;

create function pg_temp.as_user(n int) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', '41000000-0000-4000-8000-00000000000' || n,
    'role', 'authenticated')::text, true)
$$;

-- ---------------------------------------------------------------------------------------------
-- 1. RLS on the eight tables; anon selects nothing; no role writes them directly.
select is(
  (select count(*)::int from pg_catalog.pg_class
    where relnamespace = 'public'::regnamespace and relrowsecurity
      and relname in ('chain_facilities', 'chain_valuations', 'chain_loans', 'chain_locks',
        'chain_payments', 'chain_release_intents', 'chain_pools', 'chain_pool_shares')),
  8, '1. RLS is enabled on the eight lending tables');
select is_empty(
  $$select relname from pg_catalog.pg_class
    where relnamespace = 'public'::regnamespace and relkind = 'r'
      and relname in ('chain_facilities', 'chain_valuations', 'chain_loans', 'chain_locks',
        'chain_payments', 'chain_release_intents', 'chain_pools', 'chain_pool_shares')
      and (has_table_privilege('anon', oid, 'SELECT') or has_any_column_privilege('anon', oid, 'SELECT'))$$,
  '1. anon has no SELECT on a lending table');
select is_empty(
  $$select relname || ' ' || role || ' ' || privilege from pg_catalog.pg_class,
      unnest(array['anon', 'authenticated', 'service_role']) as role,
      unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) as privilege
    where relnamespace = 'public'::regnamespace and relkind = 'r'
      and relname in ('chain_facilities', 'chain_valuations', 'chain_loans', 'chain_locks',
        'chain_payments', 'chain_release_intents', 'chain_pools', 'chain_pool_shares')
      and has_table_privilege(role, oid, privilege)$$,
  '1. no API role may insert, update, delete or truncate a lending table');
select is(
  (select count(*)::int from pg_catalog.pg_class
    where relnamespace = 'public'::regnamespace and relkind = 'r'
      and relname in ('chain_facilities', 'chain_valuations', 'chain_loans', 'chain_locks',
        'chain_payments', 'chain_release_intents', 'chain_pools', 'chain_pool_shares')
      and has_table_privilege('authenticated', oid, 'SELECT')
      and has_table_privilege('service_role', oid, 'SELECT')),
  8, '1. authenticated and service_role may select the eight tables');
select is_empty(
  $$select p.proname || ' ' || role from pg_catalog.pg_proc p,
      unnest(array['anon', 'service_role']) as role
    where p.pronamespace = 'private'::regnamespace
      and p.proname in ('can_read_facility', 'can_read_loan', 'can_read_lot')
      and has_function_privilege(role, p.oid, 'EXECUTE')$$,
  '1. the read helpers are not executable by anon or service_role');
select ok((select bool_and(has_function_privilege('authenticated', p.oid, 'EXECUTE'))
    from pg_catalog.pg_proc p where p.pronamespace = 'private'::regnamespace
      and p.proname in ('can_read_facility', 'can_read_loan', 'can_read_lot')),
  '1. authenticated executes the read helpers');

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
select lives_ok($$select public.indexer_apply(current_setting('t.b7')::jsonb)$$, 'batch 7 applies');
select lives_ok($$select public.indexer_apply(current_setting('t.b8')::jsonb)$$, 'batch 8 applies');
reset role;
select is(pg_temp.cursor(), 800::bigint, 'the cursor is at the last batch');
select is(pg_temp.lending_rows(), 10::bigint, 'ten lending rows stored');
select is((select count(*)::int from public.chain_events), 12, 'twelve events stored');

-- 2. Who reads what.
set local role authenticated;
select pg_temp.as_user(1); -- lender-one
select set_eq($$select address from public.chain_facilities$$, array[pg_temp.a('fac1')],
  '2. lender-one reads its own facility only');
select set_eq($$select address from public.chain_valuations$$, array[pg_temp.a('val1')],
  '2. lender-one reads its valuation');
select set_eq($$select address from public.chain_loans$$, array[pg_temp.a('loan1')], '2. lender-one reads its loan');
select set_eq($$select address from public.chain_locks$$, array[pg_temp.a('lock1')], '2. lender-one reads the lock');
select set_eq($$select address from public.chain_payments$$, array[pg_temp.a('pay1'), pg_temp.a('pay2')],
  '2. lender-one reads both payments');
select set_eq($$select address from public.chain_release_intents$$, array[pg_temp.a('intent1')],
  '2. lender-one reads the intent');
select set_eq($$select address from public.chain_lots$$, array[pg_temp.a('lot')], '2. lender-one reads the lot');
select set_eq($$select address from public.chain_positions$$, array[pg_temp.a('posK'), pg_temp.a('posB')],
  '2. lender-one reads the lot''s positions');
select set_eq($$select created from public.chain_events where scope = 'facility' and created is not null$$,
  array[pg_temp.a('fac1'), pg_temp.a('pay1'), pg_temp.a('intent1'), pg_temp.a('pay2')],
  '2. lender-one reads its facility''s events and not Lender Two''s');
select set_eq($$select address from public.chain_pool_shares$$, array[pg_temp.a('share1')],
  '2. lender-one reads its own pool share');

select pg_temp.as_user(2); -- lender-two
select set_eq($$select address from public.chain_facilities$$, array[pg_temp.a('fac2')],
  '2. lender-two reads its own facility');
select set_eq($$select address from public.chain_lots$$, array[pg_temp.a('lot')],
  '2. lender-two reads the lot its borrower holds');
select set_eq($$select address from public.chain_positions$$, array[pg_temp.a('posK'), pg_temp.a('posB')],
  '2. lender-two reads the lot''s positions');
select is_empty($$select 1 from public.chain_valuations union all select 1 from public.chain_loans
  union all select 1 from public.chain_locks union all select 1 from public.chain_payments
  union all select 1 from public.chain_release_intents union all select 1 from public.chain_pool_shares$$,
  '2. lender-two reads none of Lender One''s lending rows');
select set_eq($$select created from public.chain_events where scope = 'facility'$$, array[pg_temp.a('fac2')],
  '2. lender-two reads only its own facility event');
select is((select count(*)::int from public.chain_pools), 1, '2. members read the pool');

select pg_temp.as_user(3); -- khunou, the borrower
select set_eq($$select address from public.chain_facilities$$, array[pg_temp.a('fac1'), pg_temp.a('fac2')],
  '2. khunou reads both facilities');
select is((select count(*)::int from public.chain_valuations), 1, '2. khunou reads the valuation');
select is((select count(*)::int from public.chain_loans), 1, '2. khunou reads the loan');
select is((select count(*)::int from public.chain_locks), 1, '2. khunou reads the lock');
select is((select count(*)::int from public.chain_payments), 2, '2. khunou reads both payments');
select is((select count(*)::int from public.chain_release_intents), 1, '2. khunou reads the intent');
select is((select count(*)::int from public.chain_events where scope = 'facility'), 7,
  '2. khunou reads every facility event of both facilities');
select is_empty($$select 1 from public.chain_pool_shares$$, '2. khunou reads no pool share');

select pg_temp.as_user(4); -- buyer-smelter
select set_eq($$select address from public.chain_release_intents$$, array[pg_temp.a('intent1')],
  '2. buyer-smelter reads the intent to it');
select set_eq($$select address from public.chain_payments$$, array[pg_temp.a('pay2')],
  '2. buyer-smelter reads the intent''s Release payment and not the Repayment');
select set_eq($$select address from public.chain_lots$$, array[pg_temp.a('lot')], '2. buyer-smelter reads the lot');
select is_empty($$select 1 from public.chain_facilities union all select 1 from public.chain_valuations
  union all select 1 from public.chain_loans union all select 1 from public.chain_locks$$,
  '2. buyer-smelter reads no facility, valuation, loan or lock');

select pg_temp.as_user(5); -- kopano, the custodian
select set_eq($$select address from public.chain_lots$$, array[pg_temp.a('lot')], '2. kopano reads the lot');
select is(
  (select count(*)::int from public.chain_facilities) + (select count(*)::int from public.chain_valuations)
    + (select count(*)::int from public.chain_loans) + (select count(*)::int from public.chain_locks)
    + (select count(*)::int from public.chain_payments) + (select count(*)::int from public.chain_release_intents)
    + (select count(*)::int from public.chain_pool_shares),
  0, '2. kopano reads no row of the facility-scoped lending tables');
select is_empty($$select 1 from public.chain_events where scope = 'facility'$$,
  '2. kopano reads no facility-scoped event');
select set_eq($$select event from public.chain_events where scope = 'lot'$$,
  array['LotIssued', 'PledgedSold'], '2. kopano reads the lot-scoped PledgedSold');
reset role;

-- 3. A stored program key repeated under another signature is REVISION_SEQUENCE, writing nothing.
set local role service_role;
select throws_ok(
  $$select public.indexer_apply(pg_temp.batch(800, 900, jsonb_build_array(pg_temp.tx(9, 900, 1)),
    jsonb_build_array(pg_temp.ev(9, 0, 900, 'RecordAdvance', 'AdvanceRecorded', 'facility', jsonb_build_object(
      'facility', pg_temp.a('fac1'), 'loan', pg_temp.a('loan1'), 'loan_revision', '1'))), '[]'::jsonb))$$,
  'P0001', 'REVISION_SEQUENCE', '3. a repeated (loan, loan_revision) is REVISION_SEQUENCE');
select throws_ok(
  $$select public.indexer_apply(pg_temp.batch(800, 900, jsonb_build_array(pg_temp.tx(9, 900, 1)),
    jsonb_build_array(pg_temp.ev(9, 0, 900, 'Withdraw', 'Withdrawn', 'pool', jsonb_build_object(
      'pool', pg_temp.a('pool'), 'pool_revision', '1'))), '[]'::jsonb))$$,
  'P0001', 'REVISION_SEQUENCE', '3. a repeated (pool, pool_revision) is REVISION_SEQUENCE');
select throws_ok(
  $$select public.indexer_apply(pg_temp.batch(800, 900, jsonb_build_array(pg_temp.tx(9, 900, 1)),
    jsonb_build_array(pg_temp.ev(9, 0, 900, 'SetValuation', 'ValuationSet', 'facility', jsonb_build_object(
      'facility', pg_temp.a('fac1'), 'valuation', pg_temp.a('val1'), 'valuation_version', 1))), '[]'::jsonb))$$,
  'P0001', 'REVISION_SEQUENCE', '3. a repeated (valuation, valuation_version) is REVISION_SEQUENCE');
select throws_ok(
  $$select public.indexer_apply(pg_temp.batch(800, 900, jsonb_build_array(pg_temp.tx(9, 900, 1)),
    jsonb_build_array(pg_temp.ev(9, 0, 900, 'OpenFacility', 'FacilityOpened', 'facility', jsonb_build_object(
      'facility', pg_temp.a('fac1'), 'created', pg_temp.a('fac1')))), '[]'::jsonb))$$,
  'P0001', 'REVISION_SEQUENCE', '3. a repeated created account is REVISION_SEQUENCE');
reset role;
select is(pg_temp.cursor(), 800::bigint, '3. the cursor did not move');
select is((select count(*)::int from public.chain_events), 12, '3. no event was written');

-- 4. Row shape: the scope pairs and the eight keys.
set local role service_role;
select throws_ok(
  $$select public.indexer_apply(pg_temp.batch(800, 900, jsonb_build_array(pg_temp.tx(9, 900, 1)),
    jsonb_build_array(pg_temp.ev(9, 0, 900, 'RecordAdvance', 'AdvanceRecorded', 'facility', jsonb_build_object(
      'loan', pg_temp.a('loan1'), 'loan_revision', '2'))), '[]'::jsonb))$$,
  'P0001', 'ROW_INVALID', '4. a facility-scoped event without facility is ROW_INVALID');
select throws_ok(
  $$select public.indexer_apply(pg_temp.batch(800, 900, jsonb_build_array(pg_temp.tx(9, 900, 1)),
    jsonb_build_array(pg_temp.ev(9, 0, 900, 'RecordAdvance', 'AdvanceRecorded', 'facility', jsonb_build_object(
      'facility', pg_temp.a('fac1'), 'loan_revision', '2'))), '[]'::jsonb))$$,
  'P0001', 'ROW_INVALID', '4. a loan_revision without loan is ROW_INVALID');
select throws_ok(
  $$select public.indexer_apply(pg_temp.batch(800, 900, jsonb_build_array(pg_temp.tx(9, 900, 1)),
    jsonb_build_array(pg_temp.ev(9, 0, 900, 'Pause', 'PauseChanged', 'registry', '{}')
      - array['facility', 'loan', 'loan_revision', 'pool', 'pool_revision', 'valuation',
        'valuation_version', 'created']), '[]'::jsonb))$$,
  'P0001', 'ROW_INVALID', '4. an event row without the eight new keys is ROW_INVALID');
reset role;

-- 5. event_revision and event_version come from indexer_apply even at a lower slot, and
-- indexer_reconcile never changes them.
set local role service_role;
select lives_ok(
  $$select public.indexer_apply(pg_temp.batch(800, 900, jsonb_build_array(pg_temp.tx(10, 900, 2)),
    jsonb_build_array(
      pg_temp.ev(10, 0, 900, 'RecordAdvance', 'AdvanceRecorded', 'facility', jsonb_build_object(
        'facility', pg_temp.a('fac1'), 'loan', pg_temp.a('loan1'), 'loan_revision', '2')),
      pg_temp.ev(10, 1, 900, 'SetValuation', 'ValuationSet', 'facility', jsonb_build_object(
        'facility', pg_temp.a('fac1'), 'valuation', pg_temp.a('val1'), 'valuation_version', 2))),
    jsonb_build_array(pg_temp.loan('999', '1', '2', 650, 10), pg_temp.valuation(1, 2, 350, 10))))$$,
  '5. a batch with older account reads applies');
reset role;
select is((select row(principal, revision, event_revision, slot) from public.chain_loans),
  row('20000000'::text, '1'::text, '2'::text, 700::bigint), '5. the loan keeps its newer account columns and takes event_revision 2');
select is((select row(version, event_version, slot) from public.chain_valuations),
  row(1::bigint, 2::bigint, 400::bigint), '5. the valuation keeps its account columns and takes event_version 2');
set local role service_role;
select lives_ok(
  $$select public.indexer_reconcile(pg_temp.stream(), 900, jsonb_build_array(
    jsonb_set(pg_temp.loan('20000000', '1', '7', 900, 10), '{row,commitment}', '"finalized"'),
    jsonb_set(pg_temp.valuation(1, 7, 900, 10), '{row,commitment}', '"finalized"')), '[]'::jsonb)$$,
  '5. indexer_reconcile promotes the loan and the valuation');
reset role;
select is((select row(event_revision, commitment::text) from public.chain_loans),
  row('2'::text, 'finalized'::text), '5. reconcile does not change event_revision');
select is((select row(event_version, commitment::text) from public.chain_valuations),
  row(2::bigint, 'finalized'::text), '5. reconcile does not change event_version');

-- 7. The new u64 and i64 columns refuse non-canonical and out-of-range text as ROW_INVALID.
set local role service_role;
select throws_ok(
  $$select public.indexer_apply(pg_temp.batch(900, 1000, jsonb_build_array(pg_temp.tx(11, 1000, 0)),
    '[]'::jsonb, jsonb_build_array(pg_temp.loan('01', '1', '2', 1000, 11))))$$,
  'P0001', 'ROW_INVALID', '7. principal ''01'' is ROW_INVALID');
select throws_ok(
  $$select public.indexer_apply(pg_temp.batch(900, 1000, jsonb_build_array(pg_temp.tx(11, 1000, 0)),
    '[]'::jsonb, jsonb_build_array(pg_temp.loan('18446744073709551616', '1', '2', 1000, 11))))$$,
  'P0001', 'ROW_INVALID', '7. principal 2^64 is ROW_INVALID');
select throws_ok(
  $$select public.indexer_apply(pg_temp.batch(900, 1000, jsonb_build_array(pg_temp.tx(11, 1000, 0)),
    '[]'::jsonb, jsonb_build_array(pg_temp.valuation(1, 2, 1000, 11, '18446744073709551616'))))$$,
  'P0001', 'ROW_INVALID', '7. an i64 valid_until of 2^64 is ROW_INVALID');
select throws_ok(
  $$select public.indexer_apply(pg_temp.batch(900, 1000, jsonb_build_array(pg_temp.tx(11, 1000, 1)),
    jsonb_build_array(pg_temp.ev(11, 0, 1000, 'Deposit', 'Deposited', 'pool', jsonb_build_object(
      'pool', pg_temp.a('pool'), 'pool_revision', '02'))), '[]'::jsonb))$$,
  'P0001', 'ROW_INVALID', '7. a pool_revision ''02'' is ROW_INVALID');
reset role;
select ok(not private.is_u64('01') and not private.is_u64('18446744073709551616')
  and not private.is_i64('01') and not private.is_i64('18446744073709551616'),
  '7. the value checks are false, not a cast error');

-- 6. indexer_reset leaves no row in the eight tables.
set local role service_role;
select lives_ok($$select public.indexer_halt(pg_temp.stream(), 900, 'EVENT_GAP', 'sequence: synthetic', null)$$,
  '6. the stream halts');
select lives_ok($$select public.indexer_reset(pg_temp.stream())$$, '6. indexer_reset clears the stream');
reset role;
select is(pg_temp.lending_rows(), 0::bigint, '6. no row is left in the eight lending tables');

select * from finish();
rollback;
