// The upload machine's steps over Supabase (rows, Storage) and the API's finalize route.
import type { SupabaseClient } from "@supabase/supabase-js";
import * as Crypto from "expo-crypto";
import { File } from "expo-file-system";
import { ApiError, ApiTimeout, ApiUnreachable } from "../api/client";
import type { evidenceApi } from "../api/evidence";
import { SupabaseTimeout } from "../supabase";
import { type UploadDeps, UploadStepError } from "./upload";

function insertError(error: { code?: string; message: string }): UploadStepError {
  if (error.code === "23505") return new UploadStepError("duplicate", error.message);
  if (/SupabaseTimeout|did not answer|Network request failed|fetch/i.test(error.message)) {
    return new UploadStepError("network", error.message);
  }
  return new UploadStepError("other", error.message);
}

function thrown(error: unknown): UploadStepError {
  if (error instanceof UploadStepError) return error;
  if (
    error instanceof SupabaseTimeout ||
    error instanceof ApiTimeout ||
    error instanceof ApiUnreachable
  ) {
    return new UploadStepError("network", error.message);
  }
  if (error instanceof TypeError) return new UploadStepError("network", error.message);
  return new UploadStepError("other", error instanceof Error ? error.message : String(error));
}

export function uploadDeps(
  db: SupabaseClient,
  evidence: ReturnType<typeof evidenceApi>,
): UploadDeps {
  return {
    newId: () => Crypto.randomUUID(),
    async insertObject(row) {
      try {
        const { error } = await db.from("evidence_objects").insert(row);
        if (error) throw insertError(error);
      } catch (error) {
        throw thrown(error);
      }
    },
    async insertVersion(row) {
      try {
        const { error } = await db.from("evidence_versions").insert(row);
        if (error) throw insertError(error);
      } catch (error) {
        throw thrown(error);
      }
    },
    async selectVersion(id) {
      try {
        const { data, error } = await db
          .from("evidence_versions")
          .select("sha256, finalized_at")
          .eq("id", id)
          .maybeSingle();
        if (error) throw insertError(error);
        return data;
      } catch (error) {
        throw thrown(error);
      }
    },
    async upload(path, localUri, mime) {
      try {
        const bytes = await new File(localUri).arrayBuffer();
        const { error } = await db.storage
          .from("originals")
          .upload(path, bytes, { contentType: mime, upsert: false });
        if (error) {
          const status = "statusCode" in error ? String(error.statusCode) : "";
          if (status === "409" || /already exists|Duplicate/i.test(error.message)) {
            throw new UploadStepError("exists", error.message);
          }
          throw new UploadStepError(
            /fetch|network|did not answer/i.test(error.message) ? "network" : "other",
            error.message,
          );
        }
      } catch (error) {
        throw thrown(error);
      }
    },
    async finalize(versionId) {
      try {
        return await evidence.finalize(versionId);
      } catch (error) {
        if (error instanceof ApiError) {
          if (error.status === 404) throw new UploadStepError("not_found", error.code);
          if (error.code === "EVIDENCE_VERSION_INVALID")
            throw new UploadStepError("invalid_version", error.code);
          if (error.status === 500) throw new UploadStepError("unreadable", error.code);
          throw new UploadStepError("other", error.code);
        }
        throw thrown(error);
      }
    },
  };
}
