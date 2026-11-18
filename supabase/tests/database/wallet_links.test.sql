begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(14);

insert into auth.users (id, email, email_confirmed_at, aud, role) values
  ('12000000-0000-4000-8000-000000000001', 'first@example.test', now(), 'authenticated', 'authenticated'),
  ('12000000-0000-4000-8000-000000000002', 'second@example.test', now(), 'authenticated', 'authenticated');

insert into public.memberships (organisation_id, user_id, member_role)
select id, '12000000-0000-4000-8000-000000000001'::uuid, 'admin'::public.member_role from public.organisations where slug = 'khunou'
union all
select id, '12000000-0000-4000-8000-000000000002'::uuid, 'admin'::public.member_role from public.organisations where slug = 'kopano'
union all
select id, '12000000-0000-4000-8000-000000000002'::uuid, 'member'::public.member_role from public.organisations where slug = 'khunou';

do $$
begin
  perform set_config('test.khunou', (select id::text from public.organisations where slug = 'khunou'), true);
  perform set_config('test.kopano', (select id::text from public.organisations where slug = 'kopano'), true);
  perform set_config('test.wallet', '11111111111111111111111111111111', true);
end;
$$;

set local role authenticated;
set local "request.jwt.claims" = '{"sub":"12000000-0000-4000-8000-000000000001","role":"authenticated","email":"first@example.test"}';
select throws_ok(
  $$select public.issue_wallet_link_challenge(current_setting('test.khunou')::uuid, repeat('0', 32))$$,
  'P0001', 'WALLET_INVALID', '7. A malformed wallet address is refused'
);
select throws_ok(
  $$select public.issue_wallet_link_challenge(current_setting('test.kopano')::uuid, current_setting('test.wallet'))$$,
  'P0001', 'NOT_AUTHORISED', '7. Challenge issuance requires membership in the chosen organisation'
);
do $$
declare
  issued record;
begin
  select * into strict issued from public.issue_wallet_link_challenge(
    current_setting('test.khunou')::uuid, current_setting('test.wallet')
  );
  perform set_config('test.first', issued.challenge_id::text, true);
  perform set_config('test.message', issued.message, true);
  perform set_config('test.expires', issued.expires_at::text, true);
end;
$$;
select results_eq(
  $$select convert_to(message, 'UTF8'), convert_to(current_setting('test.message'), 'UTF8'),
      expires_at, current_setting('test.expires')::timestamptz, nonce ~ '^[0-9a-f]{32}$'
    from public.wallet_link_challenges where id = current_setting('test.first')::uuid$$,
  $$select convert_to(
      E'localhost:3000 wants you to link a Solana wallet to Thetis.\n\n' ||
      E'Wallet: 11111111111111111111111111111111\n' ||
      E'Organisation: khunou\n' ||
      E'User: 12000000-0000-4000-8000-000000000001\n' ||
      E'Action: link_wallet\nNonce: ' || nonce ||
      E'\nIssued At: ' || to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') ||
      E'\nExpiration Time: ' || to_char((now() + interval '5 minutes') at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'UTF8'
    ), convert_to(message, 'UTF8'), now() + interval '5 minutes', expires_at, true
    from public.wallet_link_challenges where id = current_setting('test.first')::uuid$$,
  '7. Stored and returned wallet challenge match the exact UTF-8 signing bytes and five-minute expiry'
);

set local "request.jwt.claims" = '{"sub":"12000000-0000-4000-8000-000000000002","role":"authenticated","email":"second@example.test"}';
do $$
begin
  perform set_config('test.second', (
    select challenge_id from public.issue_wallet_link_challenge(
      current_setting('test.kopano')::uuid, current_setting('test.wallet')
    )
  )::text, true);
end;
$$;

reset role;
insert into public.wallet_link_challenges (id, user_id, organisation_id, wallet, nonce, message, issued_at, expires_at)
values ('22000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001',
  current_setting('test.khunou')::uuid, current_setting('test.wallet'), repeat('0', 32),
  'Expired test challenge', now() - interval '6 minutes', now() - interval '1 minute');

set local role service_role;
do $$
begin
  perform set_config('test.first_link', public.complete_wallet_link(current_setting('test.first')::uuid)::text, true);
end;
$$;
select results_eq(
  $$select s.id, s.user_id, s.organisation_id, s.wallet, c.consumed_at
    from public.signer_links s join public.wallet_link_challenges c on c.id = s.challenge_id
    where c.id = current_setting('test.first')::uuid$$,
  $$select current_setting('test.first_link')::uuid, '12000000-0000-4000-8000-000000000001'::uuid,
    current_setting('test.khunou')::uuid, current_setting('test.wallet'), now()$$,
  '7. Service completion consumes the challenge and links the same wallet, user and organisation'
);
select throws_ok(
  $$select public.complete_wallet_link(current_setting('test.first')::uuid)$$,
  'P0001', 'CHALLENGE_INVALID', '7. A consumed wallet challenge cannot be used again'
);
select throws_ok(
  $$select public.complete_wallet_link('22000000-0000-4000-8000-000000000001')$$,
  'P0001', 'CHALLENGE_INVALID', '7. An expired wallet challenge cannot be completed'
);
select throws_ok(
  $$select public.complete_wallet_link(current_setting('test.second')::uuid)$$,
  'P0001', 'WALLET_ALREADY_LINKED', '7. An active wallet link blocks the same wallet across organisations'
);
reset role;

set local role authenticated;
set local "request.jwt.claims" = '{"sub":"12000000-0000-4000-8000-000000000001","role":"authenticated","email":"first@example.test"}';
update public.signer_links set revoked_at = now() where id = current_setting('test.first_link')::uuid;
select results_eq(
  $$select revoked_at from public.signer_links where id = current_setting('test.first_link')::uuid$$,
  $$select now()$$,
  '7. A wallet link owner can revoke their link'
);
select is(
  (select count(*) from public.audit_events where action = 'wallet.challenge_issued'),
  1::bigint, '9. Successful challenge issuance writes an audit row'
);
select is(
  (select count(*) from public.audit_events where action = 'wallet.linked'),
  1::bigint, '9. Successful wallet linking writes an audit row'
);
reset role;

set local role service_role;
select lives_ok(
  $$select public.complete_wallet_link(current_setting('test.second')::uuid)$$,
  '7. The failed duplicate attempt leaves the challenge usable after revocation'
);
select results_eq(
  $$select organisation_id from public.signer_links where wallet = current_setting('test.wallet') and revoked_at is null$$,
  $$select current_setting('test.kopano')::uuid$$,
  '7. The wallet has one active link in the new organisation after revocation'
);

reset role;
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"12000000-0000-4000-8000-000000000002","role":"authenticated","email":"second@example.test"}';
do $$
begin
  perform set_config('test.revoked_member_challenge', (
    select challenge_id from public.issue_wallet_link_challenge(
      current_setting('test.kopano')::uuid, repeat('2', 32)
    )
  )::text, true);
end;
$$;

reset role;
update public.memberships set revoked_at = now()
where user_id = '12000000-0000-4000-8000-000000000002'
  and organisation_id = current_setting('test.kopano')::uuid;

set local role service_role;
select throws_ok(
  $$select public.complete_wallet_link(current_setting('test.revoked_member_challenge')::uuid)$$,
  'P0001', 'CHALLENGE_INVALID',
  '7. Wallet completion refuses a revoked member even with active membership in another organisation'
);
select results_eq(
  $$select consumed_at from public.wallet_link_challenges
    where id = current_setting('test.revoked_member_challenge')::uuid$$,
  $$values (null::timestamptz)$$,
  '7. A membership refusal leaves the wallet challenge unconsumed'
);

reset role;
select * from finish();
rollback;
