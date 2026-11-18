begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(65);

-- 1. Every application table has RLS enabled and no anonymous read privilege.
select is_empty(
  $$select relname from pg_catalog.pg_class
    where relnamespace = 'public'::regnamespace and relkind in ('r', 'p')
      and not relrowsecurity$$,
  '1. RLS is enabled on every public table'
);
select is_empty(
  $$select relname from pg_catalog.pg_class
    where relnamespace = 'public'::regnamespace and relkind in ('r', 'p')
      and (has_table_privilege('anon', oid, 'SELECT')
        or has_any_column_privilege('anon', oid, 'SELECT'))$$,
  '1. Anon has no table or column SELECT privilege on any public table'
);

insert into auth.users (id, email, email_confirmed_at, aud, role) values
  ('10000000-0000-4000-8000-000000000001', 'admin@example.test', now(), 'authenticated', 'authenticated'),
  ('10000000-0000-4000-8000-000000000002', 'member@example.test', now(), 'authenticated', 'authenticated'),
  ('10000000-0000-4000-8000-000000000003', 'lender@example.test', now(), 'authenticated', 'authenticated'),
  ('10000000-0000-4000-8000-000000000004', 'kopano@example.test', now(), 'authenticated', 'authenticated'),
  ('10000000-0000-4000-8000-000000000005', 'outsider@example.test', now(), 'authenticated', 'authenticated'),
  ('10000000-0000-4000-8000-000000000006', 'second-admin@example.test', now(), 'authenticated', 'authenticated');

insert into public.memberships (organisation_id, user_id, member_role)
select organisations.id, fixture.user_id::uuid, fixture.member_role::public.member_role
from (values
  ('khunou', '10000000-0000-4000-8000-000000000001', 'admin'),
  ('khunou', '10000000-0000-4000-8000-000000000002', 'member'),
  ('khunou', '10000000-0000-4000-8000-000000000006', 'admin'),
  ('lender-one', '10000000-0000-4000-8000-000000000003', 'member'),
  ('kopano', '10000000-0000-4000-8000-000000000004', 'member')
) as fixture(slug, user_id, member_role)
join public.organisations on organisations.slug = fixture.slug;

insert into public.evidence_objects (id, owner_organisation_id, subject_kind, subject_ref, purpose, created_by)
select fixture.id::uuid, organisations.id, 'lot', 'CR-0001', 'assay', fixture.user_id::uuid
from (values
  ('khunou', '20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002'),
  ('kopano', '20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000004')
) as fixture(slug, id, user_id)
join public.organisations on organisations.slug = fixture.slug;

insert into public.evidence_versions (id, object_id, version, storage_path, mime, uploaded_by)
select fixture.id::uuid, o.id, fixture.version,
  o.owner_organisation_id || '/' || o.id || '/' || fixture.version,
  'application/pdf', fixture.uploader::uuid
from (values
  ('30000000-0000-4000-8000-000000000001', 1, '10000000-0000-4000-8000-000000000002'),
  ('30000000-0000-4000-8000-000000000002', 2, '10000000-0000-4000-8000-000000000001'),
  ('30000000-0000-4000-8000-000000000003', 3, '10000000-0000-4000-8000-000000000002'),
  ('30000000-0000-4000-8000-000000000004', 4, '10000000-0000-4000-8000-000000000003'),
  ('30000000-0000-4000-8000-000000000006', 6, '10000000-0000-4000-8000-000000000002')
) as fixture(id, version, uploader)
cross join public.evidence_objects o
where o.id = '20000000-0000-4000-8000-000000000001';

do $$
begin
  perform set_config('test.path', (select storage_path from public.evidence_versions where version = 1), true);
  perform set_config('test.other_upload', (select storage_path from public.evidence_versions where version = 2), true);
  perform set_config('test.finalized_path', (select storage_path from public.evidence_versions where version = 3), true);
  perform set_config('test.lender_upload', (select storage_path from public.evidence_versions where version = 4), true);
  perform set_config('test.revoked_upload', (select storage_path from public.evidence_versions where version = 6), true);
  perform set_config('test.admin_membership',
    (select id::text from public.memberships where user_id = '10000000-0000-4000-8000-000000000001'), true);
  perform set_config('test.member_membership',
    (select id::text from public.memberships where user_id = '10000000-0000-4000-8000-000000000002'), true);
  perform set_config('test.second_admin_membership',
    (select id::text from public.memberships where user_id = '10000000-0000-4000-8000-000000000006'), true);
  perform set_config('test.lender', (select id::text from public.organisations where slug = 'lender-one'), true);
end;
$$;

select is(
  (select relrowsecurity from pg_catalog.pg_class where oid = 'storage.objects'::regclass),
  true, '8. Storage objects are subject to row-level security'
);
select results_eq(
  $$select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'originals'$$,
  $$values (false, 20971520::bigint, array['application/pdf', 'image/jpeg', 'image/png']::text[])$$,
  '8. Originals bucket is private with the exact size and MIME limits'
);

set local role authenticated;
set local "request.jwt.claims" = '{"sub":"10000000-0000-4000-8000-000000000005","role":"authenticated","email":"outsider@example.test"}';
select is_empty($$select id from public.organisations$$, '2. A non-member sees no organisations');
select is_empty($$select id from public.memberships$$, '2. A non-member sees no memberships');
select is_empty($$select id from public.evidence_objects$$, '2. A non-member sees no evidence objects');
select is_empty($$select id from public.evidence_versions$$, '2. A non-member sees no evidence versions');

set local "request.jwt.claims" = '{"sub":"10000000-0000-4000-8000-000000000002","role":"authenticated","email":"member@example.test"}';
select results_eq($$select slug from public.organisations$$, $$values ('khunou'::text)$$,
  '2. A Khunou member sees only Khunou');
select throws_ok(
  $$insert into public.evidence_versions (object_id, version, storage_path, mime, uploaded_by)
    select id, 7, owner_organisation_id || '/' || id || '/7', 'application/pdf',
      '10000000-0000-4000-8000-000000000001'
    from public.evidence_objects where id = '20000000-0000-4000-8000-000000000001'$$,
  '42501', 'new row violates row-level security policy for table "evidence_versions"',
  '5. An owner member cannot name another member as the version uploader'
);
select throws_ok(
  $$insert into public.evidence_versions (object_id, version, storage_path, mime, uploaded_by, supersedes_id)
    select id, 5, owner_organisation_id || '/' || id || '/5', 'application/pdf', auth.uid(),
      '30000000-0000-4000-8000-000000000006'
    from public.evidence_objects where id = '20000000-0000-4000-8000-000000000001'$$,
  'P0001', 'EVIDENCE_VERSION_INVALID',
  '6. An evidence version cannot supersede a later version of the same object'
);
select throws_ok(
  $$insert into public.evidence_versions (id, object_id, version, storage_path, mime, uploaded_by, supersedes_id)
    select '30000000-0000-4000-8000-000000000008', id, 8,
      owner_organisation_id || '/' || id || '/8', 'application/pdf', auth.uid(),
      '30000000-0000-4000-8000-000000000008'
    from public.evidence_objects where id = '20000000-0000-4000-8000-000000000001'$$,
  'P0001', 'EVIDENCE_VERSION_INVALID',
  '6. An evidence version cannot supersede itself at the same version number'
);
select throws_ok(
  $$insert into public.evidence_versions (object_id, version, storage_path, mime, uploaded_by, supersedes_id)
    select id, 10, owner_organisation_id || '/' || id || '/10', 'application/pdf', auth.uid(),
      '30000000-0000-4000-8000-000000000099'
    from public.evidence_objects where id = '20000000-0000-4000-8000-000000000001'$$,
  'P0001', 'EVIDENCE_VERSION_INVALID',
  '6. An evidence version cannot supersede a missing version'
);
select lives_ok(
  $$insert into public.evidence_versions (object_id, version, storage_path, mime, uploaded_by, supersedes_id)
    select id, 9, owner_organisation_id || '/' || id || '/9', 'application/pdf', auth.uid(),
      '30000000-0000-4000-8000-000000000006'
    from public.evidence_objects where id = '20000000-0000-4000-8000-000000000001'$$,
  '6. An uploader can supersede an earlier version of the same object'
);
select throws_ok(
  $$insert into public.memberships (organisation_id, user_id, member_role)
    values ((select id from public.organisations where slug = 'khunou'),
      '10000000-0000-4000-8000-000000000005', 'member')$$,
  '42501', 'permission denied for table memberships',
  '4. A member cannot insert a membership directly'
);
select throws_ok(
  $$update public.memberships set member_role = 'admin' where user_id = auth.uid()$$,
  '42501', 'permission denied for table memberships', '4. A member cannot update their own role'
);
select throws_ok(
  $$select public.revoke_membership(current_setting('test.admin_membership')::uuid)$$,
  'P0001', 'NOT_AUTHORISED', '8. An ordinary member cannot revoke a membership'
);
select throws_ok(
  $$select public.finalize_evidence_version('30000000-0000-4000-8000-000000000001', repeat('a', 64), 10)$$,
  '42501', 'permission denied for function finalize_evidence_version',
  '6. Authenticated cannot execute evidence finalization'
);
select throws_ok(
  $$select public.complete_wallet_link('30000000-0000-4000-8000-000000000001')$$,
  '42501', 'permission denied for function complete_wallet_link',
  '6. Authenticated cannot complete a wallet link'
);
select lives_ok(
  $$insert into storage.objects (bucket_id, name, owner_id)
    values ('originals', current_setting('test.path'), auth.uid()::text)$$,
  '8. The uploader can insert at their own unfinalized evidence path'
);
select throws_ok(
  $$insert into storage.objects (bucket_id, name, owner_id)
    values ('originals', current_setting('test.other_upload'), '10000000-0000-4000-8000-000000000001')$$,
  '42501', 'new row violates row-level security policy for table "objects"',
  '8. A member cannot upload at another member’s path'
);
select throws_ok(
  $$insert into storage.objects (bucket_id, name, owner_id)
    values ('originals', 'unregistered-original', '10000000-0000-4000-8000-000000000002')$$,
  'P0001', 'ORIGINAL_IMMUTABLE',
  '8. An unregistered storage path is refused'
);
select is_empty(
  $$select name from storage.objects where bucket_id = 'originals'$$,
  '8. An authenticated owner member cannot read originals'
);
select lives_ok($$
  do $modify$
  begin
    update storage.objects set metadata = '{"changed":true}' where bucket_id = 'originals';
    assert not found, 'Original was updated';
  end;
  $modify$
$$, '8. An owner member cannot update an original');
-- The Storage API sets this flag to pass its separate statement-level deletion guard.
set local storage.allow_delete_query = 'true';
select lives_ok($$
  do $modify$
  begin
    delete from storage.objects where bucket_id = 'originals';
    assert not found, 'Original was deleted';
  end;
  $modify$
$$, '8. An owner member cannot delete an original');

select throws_ok(
  $$insert into public.evidence_access (object_id, organisation_id, granted_by)
    values ('20000000-0000-4000-8000-000000000001', current_setting('test.lender')::uuid, auth.uid())$$,
  '42501', 'new row violates row-level security policy for table "evidence_access"',
  '5. An ordinary owner member cannot grant evidence access'
);

set local "request.jwt.claims" = '{"sub":"10000000-0000-4000-8000-000000000003","role":"authenticated","email":"lender@example.test"}';
select is_empty($$select id from public.evidence_objects$$, '5. Lender One sees no Khunou object before a grant');
select is_empty($$select name from storage.objects where bucket_id = 'originals'$$,
  '8. Lender One cannot read originals before a grant');


set local "request.jwt.claims" = '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","email":"admin@example.test"}';
insert into public.evidence_access (object_id, organisation_id, granted_by)
values ('20000000-0000-4000-8000-000000000001', current_setting('test.lender')::uuid, auth.uid());

set local "request.jwt.claims" = '{"sub":"10000000-0000-4000-8000-000000000003","role":"authenticated","email":"lender@example.test"}';
select results_eq(
  $$select id from public.evidence_objects$$,
  $$values ('20000000-0000-4000-8000-000000000001'::uuid)$$,
  '5. Lender One can read exactly the object a Khunou admin granted'
);
select is_empty(
  $$select name from storage.objects where bucket_id = 'originals'$$,
  '8. An authenticated grantee cannot read originals even with an active object grant'
);
select throws_ok(
  $$insert into storage.objects (bucket_id, name, owner_id)
    values ('originals', current_setting('test.lender_upload'), auth.uid()::text)$$,
  'P0001', 'NOT_AUTHORISED',
  '8. A grantee cannot upload to a Khunou path even when designated as uploader'
);

set local "request.jwt.claims" = '{"sub":"10000000-0000-4000-8000-000000000004","role":"authenticated","email":"kopano@example.test"}';
select results_eq(
  $$select id from public.evidence_objects where subject_ref = 'CR-0001'$$,
  $$values ('20000000-0000-4000-8000-000000000002'::uuid)$$,
  '5. Kopano sees only its own evidence even with the same subject reference'
);
select throws_ok(
  $$insert into public.evidence_versions (object_id, version, storage_path, mime, uploaded_by, supersedes_id)
    select id, 2, owner_organisation_id || '/' || id || '/2', 'application/pdf', auth.uid(),
      '30000000-0000-4000-8000-000000000001'
    from public.evidence_objects where id = '20000000-0000-4000-8000-000000000002'$$,
  'P0001', 'EVIDENCE_VERSION_INVALID',
  '6. An evidence version cannot supersede an earlier version of a different object'
);

set local "request.jwt.claims" = '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","email":"admin@example.test"}';
update public.evidence_access set revoked_at = now() where organisation_id = current_setting('test.lender')::uuid;
set local "request.jwt.claims" = '{"sub":"10000000-0000-4000-8000-000000000003","role":"authenticated","email":"lender@example.test"}';
select is_empty($$select id from public.evidence_objects$$, '5. Lender One loses access after the grant is revoked');
select is_empty($$select name from storage.objects where bucket_id = 'originals'$$,
  '8. An authenticated grantee cannot read originals after grant revocation');

reset role;
set local role service_role;
set local "request.jwt.claims" = '{}';
select throws_ok(
  $$update public.evidence_versions set sha256 = repeat('c', 64), size_bytes = 10, finalized_at = now()
    where version = 1$$,
  'P0001', 'IMMUTABLE_ROW', '6. Service role must use the finalization RPC to set the digest'
);
select public.finalize_evidence_version('30000000-0000-4000-8000-000000000001', repeat('a', 64), 10);
select throws_ok(
  $$select public.finalize_evidence_version('30000000-0000-4000-8000-000000000003', repeat('b', 64), 12)$$,
  'P0001', 'EVIDENCE_VERSION_INVALID', '8. Finalization requires a stored original'
);
select results_eq(
  $$select sha256, size_bytes, finalized_at from public.evidence_versions
    where id = '30000000-0000-4000-8000-000000000003'$$,
  $$values (null::text, null::bigint, null::timestamptz)$$,
  '8. Finalization without an original leaves the version pending'
);
insert into storage.objects (bucket_id, name, owner_id)
values ('originals', current_setting('test.finalized_path'), '10000000-0000-4000-8000-000000000002');
select public.finalize_evidence_version('30000000-0000-4000-8000-000000000003', repeat('b', 64), 12);
select throws_ok(
  $$update public.evidence_versions set sha256 = repeat('c', 64) where version = 1$$,
  'P0001', 'IMMUTABLE_ROW', '6. Even service role cannot change SHA-256 after finalization'
);
select throws_ok(
  $$delete from public.evidence_versions where version = 1$$,
  'P0001', 'IMMUTABLE_ROW', '6. Even service role cannot delete a finalized version'
);
reset role;

set local role authenticated;
set local "request.jwt.claims" = '{"sub":"10000000-0000-4000-8000-000000000002","role":"authenticated","email":"member@example.test"}';
select throws_ok(
  $$insert into storage.objects (bucket_id, name, owner_id)
    values ('originals', current_setting('test.finalized_path'), '10000000-0000-4000-8000-000000000002')$$,
  'P0001', 'ORIGINAL_IMMUTABLE',
  '8. The uploader cannot insert at an already finalized path'
);
select is_empty($$select id from public.audit_events$$, '9. A member who is not an admin sees no audit rows');

set local "request.jwt.claims" = '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","email":"admin@example.test"}';
select is(
  (select count(*) from public.audit_events where action = 'evidence.finalized'),
  2::bigint, '9. Finalizing evidence writes an audit row for the owner organisation'
);
select throws_ok(
  $$update public.memberships set member_role = 'admin', revoked_at = now()
    where id = current_setting('test.member_membership')::uuid$$,
  '42501', 'permission denied for table memberships',
  '4. An admin cannot change another member’s role during revocation'
);
select throws_ok(
  $$update public.memberships set revoked_at = now()
    where id = current_setting('test.member_membership')::uuid$$,
  '42501', 'permission denied for table memberships',
  '8. An authenticated admin cannot revoke a membership by direct update'
);
select throws_ok(
  $$select public.revoke_membership(current_setting('test.admin_membership')::uuid)$$,
  'P0001', 'NOT_AUTHORISED', '4. An admin cannot revoke their own membership'
);
select public.revoke_membership(current_setting('test.member_membership')::uuid);
select results_eq(
  $$select revoked_at from public.memberships where id = current_setting('test.member_membership')::uuid$$,
  $$select now()$$,
  '4. An admin can revoke another member'
);
select throws_ok(
  $$select public.revoke_membership(current_setting('test.member_membership')::uuid)$$,
  'P0001', 'MEMBERSHIP_INVALID', '8. An admin cannot revoke a membership twice'
);
select results_eq(
  $$select actor_user_id, organisation_id, subject from public.audit_events where action = 'membership.revoked'$$,
  $$select auth.uid(), (select id from public.organisations where slug = 'khunou'),
    current_setting('test.member_membership')$$,
  '9. Membership revocation records one audit event with the admin, organisation and membership'
);
select ok(
  pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.revoke_membership(uuid)'))
    ~* 'from[[:space:]]+public[.]organisations.*for[[:space:]]+update of o.*private[.]is_admin',
  '8. Membership revocation locks the organisation before checking admin status'
);
select public.revoke_membership(current_setting('test.second_admin_membership')::uuid);
set local "request.jwt.claims" = '{"sub":"10000000-0000-4000-8000-000000000006","role":"authenticated","email":"second-admin@example.test"}';
select throws_ok(
  $$select public.revoke_membership(current_setting('test.admin_membership')::uuid)$$,
  'P0001', 'NOT_AUTHORISED', '8. A revoked admin cannot revoke the remaining admin'
);
set local "request.jwt.claims" = '{"sub":"10000000-0000-4000-8000-000000000002","role":"authenticated","email":"member@example.test"}';
select is_empty($$select id from public.organisations$$, '4. A revoked member immediately loses organisation reads');
select is_empty($$select id from public.memberships$$, '4. A revoked member immediately loses membership reads');
select is_empty($$select id from public.evidence_objects$$, '4. A revoked member immediately loses evidence reads');
select is_empty($$select name from storage.objects where bucket_id = 'originals'$$,
  '8. An authenticated former member cannot read originals');

reset role;

-- The Storage service role bypasses RLS as the table owner.
select ok(
  (select relowner = 'supabase_storage_admin'::regrole and not relforcerowsecurity
    from pg_catalog.pg_class where oid = 'storage.objects'::regclass),
  '8. The Storage service role owns storage.objects and bypasses its RLS'
);

-- Supabase CLI's postgres login cannot assume the reserved Storage role. In
-- that runner use service_role to exercise the same triggers with RLS bypassed.
select pg_has_role(session_user, 'supabase_storage_admin', 'SET') as can_set_storage_role
\gset
\if :can_set_storage_role
  grant usage on schema extensions to supabase_storage_admin;
  set local role supabase_storage_admin;
\else
  set local role service_role;
\endif
set local "request.jwt.claims" = '{}';
select is(row_security_active('storage.objects'), false,
  '8. The current role reaches the Storage triggers without RLS');
select throws_ok(
  $$insert into storage.objects (bucket_id, name, owner_id)
    values ('originals', current_setting('test.other_upload'), '10000000-0000-4000-8000-000000000002')$$,
  'P0001', 'NOT_AUTHORISED', '8. Privileged original insertion rejects an owner ID different from the uploader'
);
select throws_ok(
  $$insert into storage.objects (bucket_id, name, owner_id)
    values ('originals', current_setting('test.revoked_upload'), '10000000-0000-4000-8000-000000000002')$$,
  'P0001', 'NOT_AUTHORISED', '8. Privileged original insertion rejects an uploader whose membership was revoked'
);
select throws_ok(
  $$insert into storage.objects (bucket_id, name, owner_id)
    values ('originals', current_setting('test.other_upload'), null)$$,
  'P0001', 'NOT_AUTHORISED', '8. Privileged original insertion rejects a missing owner ID'
);
select lives_ok(
  $$insert into storage.objects (bucket_id, name, owner_id)
    values ('originals', current_setting('test.other_upload'), '10000000-0000-4000-8000-000000000001')$$,
  '8. With RLS bypassed, a registered unfinalized path accepts an original'
);
select throws_ok(
  $$insert into storage.objects (bucket_id, name, owner_id)
    values ('originals', 'unregistered-original', '10000000-0000-4000-8000-000000000002')$$,
  'P0001', 'ORIGINAL_IMMUTABLE',
  '8. With RLS bypassed, an unregistered path refuses an original'
);
select throws_ok(
  $$insert into storage.objects (bucket_id, name, owner_id)
    values ('originals', current_setting('test.finalized_path'), '10000000-0000-4000-8000-000000000002')$$,
  'P0001', 'ORIGINAL_IMMUTABLE',
  '8. With RLS bypassed, a finalized path refuses an original'
);
select throws_ok(
  $$update storage.objects set metadata = '{"changed":true}'
    where bucket_id = 'originals' and name = current_setting('test.path')$$,
  'P0001', 'ORIGINAL_IMMUTABLE',
  '8. With RLS bypassed, the trigger refuses to update an original'
);
select throws_ok(
  $$delete from storage.objects where bucket_id = 'originals' and name = current_setting('test.path')$$,
  'P0001', 'ORIGINAL_IMMUTABLE',
  '8. With RLS bypassed, the trigger refuses to delete an original'
);
reset role;

select * from finish();
rollback;
