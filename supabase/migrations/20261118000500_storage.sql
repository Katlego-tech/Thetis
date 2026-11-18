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

create policy originals_granted_select on storage.objects
  for select to authenticated using (
    bucket_id = 'originals' and exists (
      select 1 from public.evidence_versions v
      where v.storage_path = objects.name and private.can_read_evidence(v.object_id)
    )
  );
