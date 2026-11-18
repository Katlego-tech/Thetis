insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('originals', 'originals', false, 20971520, array['application/pdf', 'image/jpeg', 'image/png']);

-- Supabase Storage enables RLS on its objects table.
revoke all on table storage.objects, storage.buckets from anon;

create policy originals_uploader_insert on storage.objects
  for insert to authenticated with check (
    bucket_id = 'originals' and exists (
      select 1
      from public.evidence_versions v
      join public.evidence_objects o on o.id = v.object_id
      where v.storage_path = objects.name and v.finalized_at is null
        and v.uploaded_by = (select auth.uid())
        and private.is_member(o.owner_organisation_id)
    )
  );

-- Signed uploads run with elevated privileges. Check the path regardless of RLS.
create function private.check_original_insert()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  -- Keep this insert and evidence finalization ordered on the evidence version.
  perform 1 from public.evidence_versions v
  where v.storage_path = new.name and v.finalized_at is null
  for share;

  if not found then
    raise exception using errcode = 'P0001', message = 'ORIGINAL_IMMUTABLE';
  end if;
  return new;
end;
$$;

create function private.reject_original_mutation()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  raise exception using errcode = 'P0001', message = 'ORIGINAL_IMMUTABLE';
end;
$$;

revoke all on function private.check_original_insert(), private.reject_original_mutation()
  from public, anon, authenticated, service_role;

create trigger originals_check_insert before insert on storage.objects
  for each row when (new.bucket_id = 'originals')
  execute function private.check_original_insert();

create trigger originals_no_update before update on storage.objects
  for each row when (old.bucket_id = 'originals' or new.bucket_id = 'originals')
  execute function private.reject_original_mutation();

create trigger originals_no_delete before delete on storage.objects
  for each row when (old.bucket_id = 'originals')
  execute function private.reject_original_mutation();
