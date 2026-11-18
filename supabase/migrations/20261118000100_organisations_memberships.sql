create schema private;
revoke all on schema private from public, anon, authenticated;

create type public.org_kind as enum (
  'exporter', 'custodian', 'transporter', 'terminal', 'lender', 'buyer', 'accreditor'
);
create type public.member_role as enum ('admin', 'member');

create table public.organisations (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  slug text not null unique,
  name text not null,
  kind public.org_kind not null,
  synthetic boolean not null default false,
  created_at timestamptz not null default pg_catalog.now()
);

create table public.memberships (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  user_id uuid not null references auth.users (id),
  member_role public.member_role not null,
  revoked_at timestamptz,
  created_at timestamptz not null default pg_catalog.now()
);

create unique index memberships_active_org_user
  on public.memberships (organisation_id, user_id) where revoked_at is null;

create function private.is_member(org uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m
    where m.organisation_id = org and m.user_id = (select auth.uid()) and m.revoked_at is null
  );
$$;

create function private.is_admin(org uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m
    where m.organisation_id = org and m.user_id = (select auth.uid())
      and m.revoked_at is null and m.member_role = 'admin'
  );
$$;

create function private.enforce_revocation()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if old.revoked_at is not null or new.revoked_at is null
    or (pg_catalog.to_jsonb(new) - 'revoked_at') is distinct from (pg_catalog.to_jsonb(old) - 'revoked_at')
  then
    raise exception using errcode = 'P0001', message = 'IMMUTABLE_ROW';
  end if;
  return new;
end;
$$;

revoke all on function private.is_member(uuid), private.is_admin(uuid), private.enforce_revocation()
  from public, anon, authenticated, service_role;
grant execute on function private.is_member(uuid), private.is_admin(uuid) to authenticated;

alter table public.organisations enable row level security;
alter table public.memberships enable row level security;

revoke all on table public.organisations, public.memberships from public, anon, authenticated, service_role;
grant select on table public.organisations, public.memberships to authenticated, service_role;
grant insert, update, delete on table public.organisations to service_role;
grant update on table public.memberships to authenticated;

create policy organisations_member_select on public.organisations
  for select to authenticated using (private.is_member(id));

create policy memberships_member_select on public.memberships
  for select to authenticated using (private.is_member(organisation_id));

create policy memberships_admin_revoke on public.memberships
  for update to authenticated
  using (private.is_admin(organisation_id) and user_id <> (select auth.uid()))
  with check (private.is_admin(organisation_id) and user_id <> (select auth.uid()));

create trigger memberships_enforce_revocation before update on public.memberships
  for each row execute function private.enforce_revocation();
