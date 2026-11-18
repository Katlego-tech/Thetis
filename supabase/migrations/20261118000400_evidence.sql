create type public.subject_kind as enum ('lot', 'batch', 'organisation');
create type public.purpose as enum ('weighbridge', 'assay', 'origin', 'transport', 'loading', 'bank', 'other');

create table public.evidence_objects (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  owner_organisation_id uuid not null references public.organisations (id),
  subject_kind public.subject_kind not null,
  subject_ref text not null,
  purpose public.purpose not null,
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default pg_catalog.now()
);

create table public.evidence_versions (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  object_id uuid not null references public.evidence_objects (id),
  version integer not null check (version > 0),
  storage_path text not null unique,
  mime text not null check (mime in ('application/pdf', 'image/jpeg', 'image/png')),
  size_bytes bigint check (size_bytes between 0 and 20971520),
  sha256 text check (sha256 ~ '^[0-9a-f]{64}$'),
  uploaded_by uuid not null references auth.users (id),
  finalized_at timestamptz,
  supersedes_id uuid references public.evidence_versions (id),
  created_at timestamptz not null default pg_catalog.now(),
  unique (object_id, version),
  check (
    (finalized_at is null and size_bytes is null and sha256 is null)
    or (finalized_at is not null and size_bytes is not null and sha256 is not null)
  )
);

create table public.evidence_access (
  object_id uuid not null references public.evidence_objects (id),
  organisation_id uuid not null references public.organisations (id),
  granted_by uuid not null references auth.users (id),
  granted_at timestamptz not null default pg_catalog.now(),
  revoked_at timestamptz,
  created_at timestamptz not null default pg_catalog.now(),
  primary key (object_id, organisation_id, granted_at)
);

create unique index evidence_access_active_object_org
  on public.evidence_access (object_id, organisation_id) where revoked_at is null;

create function private.can_read_evidence(object uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.evidence_objects o
    where o.id = object and private.is_member(o.owner_organisation_id)
  ) or exists (
    select 1 from public.evidence_access a
    where a.object_id = object and a.revoked_at is null and private.is_member(a.organisation_id)
  );
$$;

create function private.check_evidence_storage_path()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  expected_path text;
begin
  select o.owner_organisation_id || '/' || o.id || '/' || new.version into expected_path
  from public.evidence_objects o where o.id = new.object_id;
  if new.storage_path is distinct from expected_path then
    raise exception using errcode = 'P0001', message = 'EVIDENCE_PATH_INVALID';
  end if;
  if new.supersedes_id is not null and not exists (
    select 1 from public.evidence_versions previous
    where previous.id = new.supersedes_id and previous.object_id = new.object_id
      and previous.version < new.version
  ) then
    raise exception using errcode = 'P0001', message = 'EVIDENCE_VERSION_INVALID';
  end if;
  return new;
end;
$$;

create function private.enforce_evidence_finalization()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if old.finalized_at is not null or new.finalized_at is null
    or (pg_catalog.to_jsonb(new) - array['sha256', 'size_bytes', 'finalized_at'])
       is distinct from (pg_catalog.to_jsonb(old) - array['sha256', 'size_bytes', 'finalized_at'])
  then
    raise exception using errcode = 'P0001', message = 'IMMUTABLE_ROW';
  end if;
  return new;
end;
$$;

create function public.finalize_evidence_version(version_id uuid, sha256 text, size_bytes bigint)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  version_row public.evidence_versions%rowtype;
  owner_org uuid;
begin
  if sha256 is null or sha256 !~ '^[0-9a-f]{64}$'
    or size_bytes is null or size_bytes not between 0 and 20971520
  then
    raise exception using errcode = 'P0001', message = 'EVIDENCE_VERSION_INVALID';
  end if;

  update public.evidence_versions v
  set sha256 = $2, size_bytes = $3, finalized_at = pg_catalog.now()
  where v.id = version_id and v.finalized_at is null
    and exists (
      select 1 from storage.objects o
      where o.bucket_id = 'originals' and o.name = v.storage_path
        and o.metadata->>'mimetype' = v.mime
        and o.metadata->>'size' = $3::text
    )
  returning v.* into version_row;

  if not found then
    raise exception using errcode = 'P0001', message = 'EVIDENCE_VERSION_INVALID';
  end if;

  select o.owner_organisation_id into strict owner_org
  from public.evidence_objects o where o.id = version_row.object_id;

  insert into public.audit_events (actor_user_id, organisation_id, action, subject)
  values (null, owner_org, 'evidence.finalized', version_id::text);
end;
$$;

revoke all on function private.can_read_evidence(uuid), private.check_evidence_storage_path(),
  private.enforce_evidence_finalization(), public.finalize_evidence_version(uuid, text, bigint)
  from public, anon, authenticated, service_role;
grant execute on function private.can_read_evidence(uuid) to authenticated;
grant execute on function public.finalize_evidence_version(uuid, text, bigint) to service_role;

alter table public.evidence_objects enable row level security;
alter table public.evidence_versions enable row level security;
alter table public.evidence_access enable row level security;

revoke all on table public.evidence_objects, public.evidence_versions, public.evidence_access
  from public, anon, authenticated, service_role;
grant select on table public.evidence_objects, public.evidence_versions, public.evidence_access
  to authenticated, service_role;
grant insert on table public.evidence_objects, public.evidence_versions, public.evidence_access to authenticated;
grant update on table public.evidence_access to authenticated;
grant update, delete on table public.evidence_objects, public.evidence_versions to service_role;

create policy evidence_objects_read on public.evidence_objects
  for select to authenticated
  using (private.is_member(owner_organisation_id) or private.can_read_evidence(id));

create policy evidence_objects_owner_insert on public.evidence_objects
  for insert to authenticated
  with check (private.is_member(owner_organisation_id) and created_by = (select auth.uid()));

create policy evidence_versions_read on public.evidence_versions
  for select to authenticated using (private.can_read_evidence(object_id));

create policy evidence_versions_owner_insert on public.evidence_versions
  for insert to authenticated with check (
    uploaded_by = (select auth.uid()) and sha256 is null and finalized_at is null and exists (
      select 1 from public.evidence_objects o
      where o.id = evidence_versions.object_id and private.is_member(o.owner_organisation_id)
    )
  );

create policy evidence_access_read on public.evidence_access
  for select to authenticated using (
    private.is_member(organisation_id) or exists (
      select 1 from public.evidence_objects o
      where o.id = evidence_access.object_id and private.is_member(o.owner_organisation_id)
    )
  );

create policy evidence_access_owner_admin_insert on public.evidence_access
  for insert to authenticated with check (
    granted_by = (select auth.uid()) and exists (
      select 1 from public.evidence_objects o
      where o.id = evidence_access.object_id and private.is_admin(o.owner_organisation_id)
    )
  );

create policy evidence_access_owner_admin_revoke on public.evidence_access
  for update to authenticated using (
    exists (
      select 1 from public.evidence_objects o
      where o.id = evidence_access.object_id and private.is_admin(o.owner_organisation_id)
    )
  );

create trigger evidence_objects_immutable before update or delete on public.evidence_objects
  for each row execute function private.reject_mutation();

-- Run before the foreign key trigger so a missing predecessor gets the same error.
create trigger "00_evidence_versions_check_path" after insert on public.evidence_versions
  for each row execute function private.check_evidence_storage_path();

-- Direct service-role edits are refused. The RPC runs with its owner's privileges.
create trigger evidence_versions_reject_service_edit before update on public.evidence_versions
  for each row when (current_user = 'service_role') execute function private.reject_mutation();

create trigger evidence_versions_finalize_once before update on public.evidence_versions
  for each row execute function private.enforce_evidence_finalization();

create trigger evidence_versions_no_delete before delete on public.evidence_versions
  for each row execute function private.reject_mutation();

create trigger evidence_access_enforce_revocation before update on public.evidence_access
  for each row execute function private.enforce_revocation();
