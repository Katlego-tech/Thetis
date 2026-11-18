create table private.settings (
  key text primary key,
  value text not null,
  created_at timestamptz not null default pg_catalog.now()
);

create table public.wallet_link_challenges (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  user_id uuid not null references auth.users (id),
  organisation_id uuid not null references public.organisations (id),
  wallet text not null check (wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  nonce text not null check (nonce ~ '^[0-9a-f]{32}$'),
  message text not null,
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default pg_catalog.now()
);

create table public.signer_links (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  user_id uuid not null references auth.users (id),
  organisation_id uuid not null references public.organisations (id),
  wallet text not null check (wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  challenge_id uuid not null unique references public.wallet_link_challenges (id),
  linked_at timestamptz not null default pg_catalog.now(),
  revoked_at timestamptz,
  created_at timestamptz not null default pg_catalog.now()
);

create unique index signer_links_active_wallet on public.signer_links (wallet) where revoked_at is null;
create index signer_links_organisation_id on public.signer_links (organisation_id);
create index wallet_link_challenges_user_id on public.wallet_link_challenges (user_id);

create function private.enforce_challenge_consumption()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if old.consumed_at is not null or new.consumed_at is null
    or (pg_catalog.to_jsonb(new) - 'consumed_at') is distinct from (pg_catalog.to_jsonb(old) - 'consumed_at')
  then
    raise exception using errcode = 'P0001', message = 'IMMUTABLE_ROW';
  end if;
  return new;
end;
$$;

create function public.issue_wallet_link_challenge(org uuid, wallet text)
returns table (challenge_id uuid, message text, expires_at timestamptz)
language plpgsql security definer set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  link_domain text;
  org_slug text;
  nonce_hex text;
  signing_message text;
  issued_at timestamptz := pg_catalog.now();
  expiry timestamptz := issued_at + interval '5 minutes';
begin
  if not private.is_member(org) then
    raise exception using errcode = 'P0001', message = 'NOT_AUTHORISED';
  end if;
  if wallet is null or wallet !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' then
    raise exception using errcode = 'P0001', message = 'WALLET_INVALID';
  end if;

  select s.value into strict link_domain from private.settings s where s.key = 'link_domain';
  select o.slug into strict org_slug from public.organisations o where o.id = org;
  nonce_hex := pg_catalog.encode(extensions.gen_random_bytes(16), 'hex');

  signing_message := pg_catalog.format(
    E'%s wants you to link a Solana wallet to Thetis.\n\nWallet: %s\nOrganisation: %s\nUser: %s\n' ||
    E'Action: link_wallet\nNonce: %s\nIssued At: %s\nExpiration Time: %s',
    link_domain, wallet, org_slug, actor_id, nonce_hex,
    pg_catalog.to_char(issued_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    pg_catalog.to_char(expiry at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );

  insert into public.wallet_link_challenges (user_id, organisation_id, wallet, nonce, message, issued_at, expires_at)
  values (actor_id, org, wallet, nonce_hex, signing_message, issued_at, expiry)
  returning id into challenge_id;

  insert into public.audit_events (actor_user_id, organisation_id, action, subject)
  values (actor_id, org, 'wallet.challenge_issued', challenge_id::text);

  message := signing_message;
  expires_at := expiry;
  return next;
end;
$$;

create function public.complete_wallet_link(challenge_id uuid)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  challenge public.wallet_link_challenges%rowtype;
  link_id uuid;
begin
  update public.wallet_link_challenges c
  set consumed_at = pg_catalog.now()
  where c.id = $1 and c.consumed_at is null and c.expires_at > pg_catalog.now()
  returning c.* into challenge;

  if not found then
    raise exception using errcode = 'P0001', message = 'CHALLENGE_INVALID';
  end if;

  -- Keep revocation and link completion ordered on the active membership row.
  perform 1 from public.memberships m
  where m.user_id = challenge.user_id and m.organisation_id = challenge.organisation_id
    and m.revoked_at is null
  for share;

  if not found then
    raise exception using errcode = 'P0001', message = 'CHALLENGE_INVALID';
  end if;

  insert into public.signer_links (user_id, organisation_id, wallet, challenge_id)
  values (challenge.user_id, challenge.organisation_id, challenge.wallet, challenge.id)
  on conflict (wallet) where revoked_at is null do nothing
  returning id into link_id;

  if not found then
    raise exception using errcode = 'P0001', message = 'WALLET_ALREADY_LINKED';
  end if;

  insert into public.audit_events (actor_user_id, organisation_id, action, subject)
  values (challenge.user_id, challenge.organisation_id, 'wallet.linked', link_id::text);
  return link_id;
end;
$$;

create function public.revoke_wallet_link(link_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  link public.signer_links%rowtype;
begin
  select s.* into link
  from public.signer_links s
  where s.id = link_id and (s.user_id = actor_id or private.is_admin(s.organisation_id))
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'NOT_AUTHORISED';
  end if;
  if link.revoked_at is not null then
    raise exception using errcode = 'P0001', message = 'LINK_INVALID';
  end if;

  update public.signer_links set revoked_at = pg_catalog.now() where id = link.id;

  insert into public.audit_events (actor_user_id, organisation_id, action, subject)
  values (actor_id, link.organisation_id, 'wallet.revoked', link.id::text);
end;
$$;

revoke all on function private.enforce_challenge_consumption(), public.issue_wallet_link_challenge(uuid, text),
  public.complete_wallet_link(uuid), public.revoke_wallet_link(uuid) from public, anon, authenticated, service_role;
grant execute on function public.issue_wallet_link_challenge(uuid, text), public.revoke_wallet_link(uuid)
  to authenticated;
grant execute on function public.complete_wallet_link(uuid) to service_role;

alter table private.settings enable row level security;
alter table public.wallet_link_challenges enable row level security;
alter table public.signer_links enable row level security;

revoke all on table private.settings, public.wallet_link_challenges, public.signer_links
  from public, anon, authenticated, service_role;
grant select on table public.wallet_link_challenges, public.signer_links to authenticated, service_role;

create policy wallet_link_challenges_owner_select on public.wallet_link_challenges
  for select to authenticated using (user_id = (select auth.uid()));

create policy signer_links_member_or_owner_select on public.signer_links
  for select to authenticated using (private.is_member(organisation_id) or user_id = (select auth.uid()));

create trigger wallet_link_challenges_consume_once before update on public.wallet_link_challenges
  for each row execute function private.enforce_challenge_consumption();

create trigger wallet_link_challenges_no_delete before delete on public.wallet_link_challenges
  for each row execute function private.reject_mutation();

create trigger signer_links_enforce_revocation before update on public.signer_links
  for each row execute function private.enforce_revocation();

create trigger signer_links_no_delete before delete on public.signer_links
  for each row execute function private.reject_mutation();
