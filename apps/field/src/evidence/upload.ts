// One evidence file's way from the phone to the originals bucket: register the rows with ids made
// on the phone, upload the bytes, finalize. Each step can fail and be retried from where it stopped.

export type Purpose = "weighbridge" | "assay" | "origin" | "transport";
export type UploadState =
  | "local"
  | "registering"
  | "uploading"
  | "finalizing"
  | "finalized"
  | "failed"
  | "rejected";

export interface EvidenceItem {
  localId: string;
  purpose: Purpose;
  localUri: string;
  mime: string;
  sizeBytes: number;
  capturedAt: string;
  objectId: string | null;
  versionId: string | null;
  version: number | null;
  supersedesId: string | null;
  storagePath: string | null;
  upload: UploadState;
  sha256: string | null;
  error: string | null;
}

export const MAX_BYTES = 20_971_520;
export const STORABLE_MIME = ["application/pdf", "image/jpeg", "image/png"] as const;

export type LocalProblem = { kind: "too_large"; sizeBytes: number } | { kind: "type" };

export function checkLocalFile(mime: string, sizeBytes: number): LocalProblem | null {
  if (!(STORABLE_MIME as readonly string[]).includes(mime)) return { kind: "type" };
  if (sizeBytes > MAX_BYTES) return { kind: "too_large", sizeBytes };
  return null;
}

export type UploadErrorKind =
  | "duplicate" // the row already exists (23505): it landed
  | "exists" // the object already exists at the path: the upload landed
  | "not_found" // finalize 404: the version is already finalized, or not ours
  | "invalid_version" // finalize 409 EVIDENCE_VERSION_INVALID
  | "unreadable" // finalize 500: the stored original could not be read
  | "network"
  | "other";

export class UploadStepError extends Error {
  constructor(
    readonly kind: UploadErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "UploadStepError";
  }
}

export interface UploadSubject {
  organisationId: string;
  userId: string;
  subjectKind: "lot" | "batch";
  subjectRef: string;
}

export interface UploadDeps {
  newId(): string;
  insertObject(row: {
    id: string;
    owner_organisation_id: string;
    subject_kind: "lot" | "batch";
    subject_ref: string;
    purpose: Purpose;
    created_by: string;
  }): Promise<void>;
  insertVersion(row: {
    id: string;
    object_id: string;
    version: number;
    storage_path: string;
    mime: string;
    uploaded_by: string;
    supersedes_id: string | null;
  }): Promise<void>;
  selectVersion(id: string): Promise<{ sha256: string | null; finalized_at: string | null } | null>;
  upload(path: string, localUri: string, mime: string): Promise<void>;
  finalize(versionId: string): Promise<{ versionId: string; sha256: string; sizeBytes: number }>;
}

function asStepError(error: unknown): UploadStepError {
  return error instanceof UploadStepError
    ? error
    : new UploadStepError("other", error instanceof Error ? error.message : String(error));
}

/** Runs the item forward until it is finalized, failed or rejected; calls onChange at each state. */
export async function advanceUpload(
  start: EvidenceItem,
  subject: UploadSubject,
  deps: UploadDeps,
  onChange: (item: EvidenceItem) => void = () => {},
): Promise<EvidenceItem> {
  if (start.upload === "finalized") return start;
  if (start.upload === "local" && checkLocalFile(start.mime, start.sizeBytes)) return start;

  let item: EvidenceItem = { ...start, error: null };
  const move = (patch: Partial<EvidenceItem>) => {
    item = { ...item, ...patch };
    onChange(item);
  };
  const fail = (error: UploadStepError) => {
    move({
      upload: error.kind === "invalid_version" ? "rejected" : "failed",
      error: error.message,
    });
    return item;
  };

  // A rejected version is replaced by the next version of the same object.
  if (item.upload === "rejected") {
    item = {
      ...item,
      supersedesId: item.versionId,
      versionId: deps.newId(),
      version: (item.version ?? 0) + 1,
      storagePath: null,
    };
  }

  if (item.storagePath === null) {
    const objectId = item.objectId ?? deps.newId();
    const versionId = item.versionId ?? deps.newId();
    const version = item.version ?? 1;
    move({ upload: "registering", objectId, versionId, version });
    const storagePath = `${subject.organisationId}/${objectId}/${version}`;
    try {
      if (version === 1) {
        await deps
          .insertObject({
            id: objectId,
            owner_organisation_id: subject.organisationId,
            subject_kind: subject.subjectKind,
            subject_ref: subject.subjectRef,
            purpose: item.purpose,
            created_by: subject.userId,
          })
          .catch((error: unknown) => {
            if (asStepError(error).kind !== "duplicate") throw error;
          });
      }
      await deps
        .insertVersion({
          id: versionId,
          object_id: objectId,
          version,
          storage_path: storagePath,
          mime: item.mime,
          uploaded_by: subject.userId,
          supersedes_id: item.supersedesId,
        })
        .catch((error: unknown) => {
          if (asStepError(error).kind !== "duplicate") throw error;
        });
    } catch (error) {
      return fail(asStepError(error));
    }
    item = { ...item, storagePath };
  }

  const storagePath = item.storagePath as string;
  const versionId = item.versionId as string;
  move({ upload: "uploading" });
  try {
    await deps.upload(storagePath, item.localUri, item.mime).catch((error: unknown) => {
      if (asStepError(error).kind !== "exists") throw error;
    });
  } catch (error) {
    return fail(asStepError(error));
  }

  move({ upload: "finalizing" });
  try {
    const finalized = await deps.finalize(versionId);
    move({ upload: "finalized", sha256: finalized.sha256, error: null });
    return item;
  } catch (error) {
    const stepError = asStepError(error);
    if (stepError.kind !== "not_found") return fail(stepError);
    try {
      const row = await deps.selectVersion(versionId);
      if (row?.sha256 && row.finalized_at) {
        move({ upload: "finalized", sha256: row.sha256, error: null });
        return item;
      }
    } catch (readError) {
      return fail(asStepError(readError));
    }
    return fail(stepError);
  }
}
