create table public.audit_events (
  id bigint generated always as identity primary key,
  at timestamptz not null default pg_catalog.now(),
  actor_user_id uuid references auth.users (id),
  organisation_id uuid not null references public.organisations (id),
  action text not null,
  subject text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default pg_catalog.now()
);

create index audit_events_organisation_id on public.audit_events (organisation_id);

create function private.reject_mutation()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  raise exception using errcode = 'P0001', message = 'IMMUTABLE_ROW';
end;
$$;

revoke all on function private.reject_mutation() from public, anon, authenticated, service_role;

alter table public.audit_events enable row level security;
revoke all on table public.audit_events from public, anon, authenticated, service_role;
grant select on table public.audit_events to authenticated, service_role;

create policy audit_events_admin_select on public.audit_events
  for select to authenticated using (private.is_admin(organisation_id));

create trigger audit_events_immutable before update or delete on public.audit_events
  for each row execute function private.reject_mutation();

create function public.revoke_membership(membership_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  target_org uuid;
  target_user uuid;
begin
  -- Serialize revocations in the organisation before checking the caller's membership.
  select o.id, m.user_id into target_org, target_user
  from public.organisations o
  join public.memberships m on m.organisation_id = o.id
  where m.id = membership_id
  for update of o;

  if not found or not private.is_admin(target_org) or target_user = caller_id then
    raise exception using errcode = 'P0001', message = 'NOT_AUTHORISED';
  end if;

  update public.memberships m
  set revoked_at = pg_catalog.now()
  where m.id = membership_id and m.revoked_at is null;

  if not found then
    raise exception using errcode = 'P0001', message = 'MEMBERSHIP_INVALID';
  end if;

  insert into public.audit_events (actor_user_id, organisation_id, action, subject)
  values (caller_id, target_org, 'membership.revoked', membership_id::text);
end;
$$;

revoke all on function public.revoke_membership(uuid) from public, anon, authenticated, service_role;
grant execute on function public.revoke_membership(uuid) to authenticated;
