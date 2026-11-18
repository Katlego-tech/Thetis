create extension if not exists pgcrypto with schema extensions;

create table public.invitations (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id),
  email text not null,
  member_role public.member_role not null,
  token_sha256 bytea not null unique check (pg_catalog.octet_length(token_sha256) = 32),
  invited_by uuid not null references auth.users (id),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default pg_catalog.now()
);

create index invitations_open_org_email
  on public.invitations (organisation_id, pg_catalog.lower(email), expires_at)
  where accepted_at is null and revoked_at is null;

alter table public.invitations enable row level security;
revoke all on table public.invitations from public, anon, authenticated, service_role;
grant select on table public.invitations to authenticated, service_role;
grant update on table public.invitations to authenticated;

create policy invitations_admin_select on public.invitations
  for select to authenticated using (private.is_admin(organisation_id));

create policy invitations_admin_revoke on public.invitations
  for update to authenticated using (private.is_admin(organisation_id))
  with check (private.is_admin(organisation_id));

-- Only API updates are revocations. The acceptance RPC updates as the table owner.
create trigger invitations_enforce_revocation before update on public.invitations
  for each row when (current_user = 'authenticated')
  execute function private.enforce_revocation();

create function public.create_invitation(org uuid, email text, role public.member_role)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  invitation_id uuid;
  token text;
begin
  -- Lock the organisation first (the same lock revoke_membership takes), then check admin
  -- status: a revocation that commits while this waits is seen by the check below. The lock also
  -- serialises duplicate checks without preventing an expired invitation from being reissued.
  perform 1 from public.organisations o where o.id = org for no key update;
  if not private.is_admin(org) then
    raise exception using errcode = 'P0001', message = 'NOT_AUTHORISED';
  end if;
  if exists (
    select 1 from public.invitations i
    where i.organisation_id = org and pg_catalog.lower(i.email) = pg_catalog.lower($2)
      and i.accepted_at is null and i.revoked_at is null and i.expires_at > pg_catalog.now()
  ) then
    raise exception using errcode = 'P0001', message = 'INVITATION_EXISTS';
  end if;

  token := pg_catalog.encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.invitations (organisation_id, email, member_role, token_sha256, invited_by, expires_at)
  values (org, $2, $3, extensions.digest(token, 'sha256'), actor_id, pg_catalog.now() + interval '7 days')
  returning id into invitation_id;

  insert into public.audit_events (actor_user_id, organisation_id, action, subject)
  values (actor_id, org, 'invitation.created', invitation_id::text);
  return token;
end;
$$;

create function public.accept_invitation(token text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  invitation public.invitations%rowtype;
  membership_id uuid;
begin
  select i.* into invitation
  from public.invitations i
  join auth.users u on u.id = actor_id
    and pg_catalog.lower(u.email) = pg_catalog.lower(i.email)
    and u.email_confirmed_at is not null
  where i.token_sha256 = extensions.digest(token, 'sha256')
    and i.accepted_at is null and i.revoked_at is null and i.expires_at > pg_catalog.now()
  for update of i;

  if not found then
    raise exception using errcode = 'P0001', message = 'INVITATION_INVALID';
  end if;

  insert into public.memberships (organisation_id, user_id, member_role)
  values (invitation.organisation_id, actor_id, invitation.member_role)
  on conflict (organisation_id, user_id) where revoked_at is null do nothing
  returning id into membership_id;

  if not found then
    raise exception using errcode = 'P0001', message = 'INVITATION_INVALID';
  end if;

  update public.invitations set accepted_at = pg_catalog.now() where id = invitation.id;
  insert into public.audit_events (actor_user_id, organisation_id, action, subject)
  values (actor_id, invitation.organisation_id, 'invitation.accepted', invitation.id::text);
  return membership_id;
end;
$$;

revoke all on function public.create_invitation(uuid, text, public.member_role), public.accept_invitation(text)
  from public, anon, authenticated, service_role;
grant execute on function public.create_invitation(uuid, text, public.member_role), public.accept_invitation(text)
  to authenticated;
