-- Relay bookkeeping (live-lending.md §6.3, §9.2): access rules and the row checks of
-- public.commands and public.relay_lookup_tables.
-- SYNTHETIC: addresses and signatures are made up; only the program id is the devnet program.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(18);

insert into auth.users (id, email, email_confirmed_at, aud, role) values
  ('13000000-0000-4000-8000-000000000001', 'lender-one-member@example.test', now(), 'authenticated', 'authenticated'),
  ('13000000-0000-4000-8000-000000000002', 'khunou-member@example.test', now(), 'authenticated', 'authenticated'),
  ('13000000-0000-4000-8000-000000000003', 'kopano-member@example.test', now(), 'authenticated', 'authenticated');

insert into public.memberships (organisation_id, user_id, member_role) values
  ('11000000-0000-4000-8000-000000000005', '13000000-0000-4000-8000-000000000001', 'member'),
  ('11000000-0000-4000-8000-000000000001', '13000000-0000-4000-8000-000000000002', 'member'),
  ('11000000-0000-4000-8000-000000000002', '13000000-0000-4000-8000-000000000003', 'member');

-- A pledge command between Khunou (borrower) and Lender One (initiator).
create function pg_temp.command(
  id uuid, status public.command_status, sends integer, parties uuid[],
  signature text, commitment text
) returns void language sql as $$
  insert into public.commands (
    id, network, program_id, protocol, kind, status, created_by, initiator_org, parties,
    lot, facility, args, plan, fields, text_version, message_base64, message_sha256, valid_until,
    signers, transaction_base64, transaction_signature, last_valid_block_height, sends,
    confirmed_commitment, confirmed_slot
  ) values (
    id, 'devnet', 'jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3',
    '7porTR32j7zt69GG4AwoPQx3f3FL2RLpSDKGtPXWTeaQ', 'pledge', status,
    '13000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000005', parties,
    '7tj9biW3KRJ7EEWmVUGigHiouCTXhV2dzcyvwma7Cyu7', '7xeSk1y3uibLNKmGvmbdyAVa9MfjNYiTZ2eb19chxKDp',
    '{"quantityKg": "5000000"}', '{}', '[]', 1, 'VGhldGlz', repeat('a', 64), '1795098725',
    '[]', case when signature is null then null else 'AQID' end, signature,
    case when signature is null then null else '1000' end, sends,
    commitment, case when commitment is null then null else 5 end
  );
$$;

select pg_temp.command(
  '14000000-0000-4000-8000-000000000001', 'awaiting_signatures', 0,
  array['11000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000005']::uuid[],
  null, null
);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.commands'::regclass),
  '1. RLS is enabled on public.commands'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.relay_lookup_tables'::regclass),
  '1. RLS is enabled on public.relay_lookup_tables'
);

-- Row checks, as the service role writes them.
select throws_ok(
  $$select pg_temp.command('14000000-0000-4000-8000-000000000002', 'submitted', 4,
    array['11000000-0000-4000-8000-000000000005']::uuid[],
    '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW', null)$$,
  '23514', null, '2. sends = 4 is refused'
);
select throws_ok(
  $$select pg_temp.command('14000000-0000-4000-8000-000000000003', 'awaiting_signatures', 0,
    array['11000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000002',
          '11000000-0000-4000-8000-000000000005', '11000000-0000-4000-8000-000000000007']::uuid[],
    null, null)$$,
  '23514', null, '2. four parties are refused'
);
select throws_ok(
  $$select pg_temp.command('14000000-0000-4000-8000-000000000004', 'confirmed', 1,
    array['11000000-0000-4000-8000-000000000005']::uuid[],
    '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW', null)$$,
  '23514', null, '2. confirmed without confirmed_commitment is refused'
);
select throws_ok(
  $$select pg_temp.command('14000000-0000-4000-8000-000000000005', 'submitted', 1,
    array['11000000-0000-4000-8000-000000000005']::uuid[], null, null)$$,
  '23514', null, '2. submitted without a transaction signature is refused'
);
select lives_ok(
  $$select pg_temp.command('14000000-0000-4000-8000-000000000006', 'confirmed', 1,
    array['11000000-0000-4000-8000-000000000005']::uuid[],
    '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW', 'confirmed')$$,
  '2. a confirmed command with its signature and commitment is stored'
);

-- At most 5 open commands per user (fold 10): 1 above, 4 more, then a sixth is refused.
select lives_ok(
  $$select pg_temp.command(('14000000-0000-4000-8000-00000000001' || n)::uuid, 'awaiting_signatures', 0,
      array['11000000-0000-4000-8000-000000000005']::uuid[], null, null)
    from pg_catalog.generate_series(0, 3) as n$$,
  '6. a user stores five open commands'
);
select throws_ok(
  $$select pg_temp.command('14000000-0000-4000-8000-000000000020', 'awaiting_signatures', 0,
    array['11000000-0000-4000-8000-000000000005']::uuid[], null, null)$$,
  'P0001', 'TOO_MANY_OPEN_COMMANDS', '6. a sixth open command is refused'
);
update public.commands set status = 'expired' where id = '14000000-0000-4000-8000-000000000010';
select pg_temp.command('14000000-0000-4000-8000-000000000021', 'awaiting_signatures', 0,
  array['11000000-0000-4000-8000-000000000005']::uuid[], null, null);
select throws_ok(
  $$update public.commands set status = 'awaiting_signatures'
    where id = '14000000-0000-4000-8000-000000000010'$$,
  'P0001', 'TOO_MANY_OPEN_COMMANDS', '6. a renew past the cap is refused'
);

insert into public.relay_lookup_tables (network, program_id, protocol, address, authority) values
  ('devnet', 'jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3', '7porTR32j7zt69GG4AwoPQx3f3FL2RLpSDKGtPXWTeaQ',
   '82ZjtKS4W1tZWR1nN4vZG3GLPWsw3cQH7SKF4XfJheYX', '7xeSk1y3uibLNKmGvmbdyAVa9MfjNYiTZ2eb19chxKDp');

set local role authenticated;
set local "request.jwt.claims" = '{"sub":"13000000-0000-4000-8000-000000000002","role":"authenticated"}';
select results_eq(
  $$select id from public.commands where id = '14000000-0000-4000-8000-000000000001'$$,
  $$values ('14000000-0000-4000-8000-000000000001'::uuid)$$,
  '3. a member of a party reads the command'
);

set local "request.jwt.claims" = '{"sub":"13000000-0000-4000-8000-000000000003","role":"authenticated"}';
select is_empty(
  $$select id from public.commands$$,
  '3. a member of another organisation reads no command'
);

set local "request.jwt.claims" = '{"sub":"13000000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_ok(
  $$insert into public.commands (network, program_id, protocol, kind, status, created_by,
      initiator_org, parties, args, plan, fields, signers)
    values ('devnet', 'jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3',
      '7porTR32j7zt69GG4AwoPQx3f3FL2RLpSDKGtPXWTeaQ', 'repay', 'awaiting_signatures',
      '13000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000005',
      array['11000000-0000-4000-8000-000000000005']::uuid[], '{}', '{}', '[]', '[]')$$,
  '42501', null, '4. authenticated cannot insert a command'
);
select throws_ok(
  $$update public.commands set status = 'confirmed' where id = '14000000-0000-4000-8000-000000000001'$$,
  '42501', null, '4. authenticated cannot update a command'
);
select throws_ok(
  $$delete from public.commands where id = '14000000-0000-4000-8000-000000000001'$$,
  '42501', null, '4. authenticated cannot delete a command'
);
select throws_ok(
  $$select address from public.relay_lookup_tables$$,
  '42501', null, '4. authenticated cannot read relay_lookup_tables'
);
select throws_ok(
  $$insert into public.relay_lookup_tables (network, program_id, protocol, address, authority)
    values ('devnet', 'jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3',
      '82ZjtKS4W1tZWR1nN4vZG3GLPWsw3cQH7SKF4XfJheYX', '7tj9biW3KRJ7EEWmVUGigHiouCTXhV2dzcyvwma7Cyu7',
      '7xeSk1y3uibLNKmGvmbdyAVa9MfjNYiTZ2eb19chxKDp')$$,
  '42501', null, '4. authenticated cannot insert a lookup table'
);

reset role;
set local role service_role;
select throws_ok(
  $$delete from public.commands where id = '14000000-0000-4000-8000-000000000001'$$,
  '42501', null, '5. not even the service role deletes a command'
);

select * from finish();
rollback;
