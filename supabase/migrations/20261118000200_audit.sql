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
