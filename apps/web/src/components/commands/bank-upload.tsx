"use client";

import { apiPost } from "@/lib/api";
import { supabaseBrowser } from "@/lib/supabase-browser";

// The bank confirmation upload (live-lending.md §6.9.5 "Bank file upload"): the evidence rows, the
// original in storage and the API's finalize, all before any command is created.

export const BANK_FILE_TYPES = ["application/pdf", "image/jpeg", "image/png"] as const;
export const BANK_FILE_MAX_BYTES = 20 * 1024 * 1024;
export const bankFileRefused = "Choose a PDF, JPEG or PNG file of at most 20 MiB.";
export const bankUploadFailed =
  "Thetis could not store the bank confirmation. Nothing was recorded.";

export function bankFileProblem(file: File | null): string | null {
  if (!file) return bankFileRefused;
  const typed = (BANK_FILE_TYPES as readonly string[]).includes(file.type);
  return typed && file.size <= BANK_FILE_MAX_BYTES ? null : bankFileRefused;
}

/** Stores and finalizes the file; returns the evidence version id, or null when any step failed. */
export async function uploadBankFile(input: {
  file: File;
  ownerOrganisationId: string;
  lotId: string;
  userId: string;
  token: string;
}): Promise<string | null> {
  const { file, ownerOrganisationId, lotId, userId, token } = input;
  try {
    const supabase = supabaseBrowser();
    const object = await supabase
      .from("evidence_objects")
      .insert({
        owner_organisation_id: ownerOrganisationId,
        subject_kind: "lot",
        subject_ref: lotId,
        purpose: "bank",
        created_by: userId,
      })
      .select("id")
      .single();
    if (object.error || !object.data) return null;
    const objectId = String(object.data.id);
    const storagePath = `${ownerOrganisationId}/${objectId}/1`;
    const version = await supabase
      .from("evidence_versions")
      .insert({
        object_id: objectId,
        version: 1,
        storage_path: storagePath,
        mime: file.type,
        uploaded_by: userId,
      })
      .select("id")
      .single();
    if (version.error || !version.data) return null;
    const versionId = String(version.data.id);
    const stored = await supabase.storage
      .from("originals")
      .upload(storagePath, file, { contentType: file.type, upsert: false });
    if (stored.error) return null;
    const finalized = await apiPost(
      `/v1/evidence/${encodeURIComponent(versionId)}/finalize`,
      {},
      token,
    );
    return finalized.ok ? versionId : null;
  } catch {
    return null;
  }
}
