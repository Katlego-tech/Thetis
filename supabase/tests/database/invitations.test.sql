begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(13);

insert into auth.users (id, email, email_confirmed_at, aud, role) values
  ('11000000-0000-4000-8000-000000000001', 'admin@example.test', now(), 'authenticated', 'authenticated'),
  ('11000000-0000-4000-8000-000000000002', 'member@example.test', now(), 'authenticated', 'authenticated'),
  ('11000000-0000-4000-8000-000000000003', 'invitee@example.test', now(), 'authenticated', 'authenticated'),
  ('11000000-0000-4000-8000-000000000004', 'unconfirmed@example.test', null, 'authenticated', 'authenticated'),
  ('11000000-0000-4000-8000-000000000005', 'outsider@example.test', now(), 'authenticated', 'authenticated');

insert into public.memberships (organisation_id, user_id, member_role)
select id, '11000000-0000-4000-8000-000000000001'::uuid, 'admin'::public.member_role from public.organisations where slug = 'khunou'
union all
select id, '11000000-0000-4000-8000-000000000002', 'member' from public.organisations where slug = 'khunou';

do $$
begin
  perform set_config('test.org', (select id::text from public.organisations where slug = 'khunou'), true);
end;
$$;

set local role authenticated;
set local "request.jwt.claims" = '{"sub":"11000000-0000-4000-8000-000000000002","role":"authenticated","email":"member@example.test"}';
select throws_ok(
  $$select public.create_invitation(current_setting('test.org')::uuid, 'invitee@example.test', 'member')$$,
  'P0001', 'NOT_AUTHORISED', '3. An ordinary member cannot create an invitation'
);

set local "request.jwt.claims" = '{"sub":"11000000-0000-4000-8000-000000000001","role":"authenticated","email":"admin@example.test"}';
select lives_ok($$
  do $call$
  begin
    perform set_config('test.token', public.create_invitation(
      current_setting('test.org')::uuid, 'Invitee@Example.Test', 'member'
    ), true);
    perform set_config('test.unconfirmed', public.create_invitation(
      current_setting('test.org')::uuid, 'unconfirmed@example.test', 'member'
    ), true);
  end;
  $call$
$$, '3. An organisation admin can create invitations');
select results_eq(
  $$select token_sha256, expires_at, pg_catalog.strpos(to_jsonb(i)::text, current_setting('test.token'))
    from public.invitations i where lower(email) = 'invitee@example.test'$$,
  $$select extensions.digest(current_setting('test.token'), 'sha256'), now() + interval '7 days', 0$$,
  '3. The stored invitation contains only the token hash and expires in seven days'
);
select throws_ok(
  $$select public.create_invitation(current_setting('test.org')::uuid, 'invitee@example.test', 'member')$$,
  'P0001', 'INVITATION_EXISTS', '3. An open invitation blocks duplicate creation regardless of email case'
);

reset role;
insert into public.invitations (organisation_id, email, member_role, token_sha256, invited_by, expires_at, revoked_at)
values
  (current_setting('test.org')::uuid, 'invitee@example.test', 'member', extensions.digest('expired fixture', 'sha256'),
   '11000000-0000-4000-8000-000000000001', now() - interval '1 minute', null),
  (current_setting('test.org')::uuid, 'invitee@example.test', 'member', extensions.digest('revoked fixture', 'sha256'),
   '11000000-0000-4000-8000-000000000001', now() + interval '1 day', now());

set local role authenticated;
set local "request.jwt.claims" = '{"sub":"11000000-0000-4000-8000-000000000004","role":"authenticated","email":"unconfirmed@example.test"}';
select throws_ok(
  $$select public.accept_invitation(current_setting('test.unconfirmed'))$$,
  'P0001', 'INVITATION_INVALID', '3. A matching but unconfirmed email cannot accept'
);
set local "request.jwt.claims" = '{"sub":"11000000-0000-4000-8000-000000000005","role":"authenticated","email":"invitee@example.test"}';
select throws_ok(
  $$select public.accept_invitation(current_setting('test.token'))$$,
  'P0001', 'INVITATION_INVALID', '3. A wrong database email cannot accept even if the JWT email matches'
);

set local "request.jwt.claims" = '{"sub":"11000000-0000-4000-8000-000000000003","role":"authenticated","email":"invitee@example.test"}';
select throws_ok(
  $$select public.accept_invitation('expired fixture')$$,
  'P0001', 'INVITATION_INVALID', '3. A matching confirmed email cannot accept an expired invitation'
);
select throws_ok(
  $$select public.accept_invitation('revoked fixture')$$,
  'P0001', 'INVITATION_INVALID', '3. A matching confirmed email cannot accept a revoked invitation'
);
do $$
begin
  perform set_config('test.membership', public.accept_invitation(current_setting('test.token'))::text, true);
end;
$$;
select results_eq(
  $$select id, organisation_id, member_role::text from public.memberships where user_id = auth.uid()$$,
  $$select current_setting('test.membership')::uuid, current_setting('test.org')::uuid, 'member'::text$$,
  '3. A matching confirmed email accepts case-insensitively and receives the invited membership'
);
set local "request.jwt.claims" = '{"sub":"11000000-0000-4000-8000-000000000001","role":"authenticated","email":"admin@example.test"}';
select results_eq(
  $$select accepted_at from public.invitations where token_sha256 = extensions.digest(current_setting('test.token'), 'sha256')$$,
  $$select now()$$,
  '3. Acceptance records when the invitation was consumed'
);
select public.revoke_membership(current_setting('test.membership')::uuid);
set local "request.jwt.claims" = '{"sub":"11000000-0000-4000-8000-000000000003","role":"authenticated","email":"invitee@example.test"}';
select throws_ok(
  $$select public.accept_invitation(current_setting('test.token'))$$,
  'P0001', 'INVITATION_INVALID', '3. The accepted invitation cannot be used twice even after membership revocation'
);
set local "request.jwt.claims" = '{"sub":"11000000-0000-4000-8000-000000000001","role":"authenticated","email":"admin@example.test"}';
select is(
  (select count(*) from public.audit_events where action = 'invitation.created'),
  2::bigint, '9. Each successful invitation creation writes one audit row'
);
select is(
  (select count(*) from public.audit_events where action = 'invitation.accepted'),
  1::bigint, '9. Only successful invitation acceptance writes an audit row'
);

reset role;
select * from finish();
rollback;
