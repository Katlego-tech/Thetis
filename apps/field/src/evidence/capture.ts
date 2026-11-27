// A picked or captured file becomes a local evidence item: copied into the draft's directory, and
// sized from that copy, because the picker's size can be missing or wrong.
import type { EvidenceItem, Purpose } from "./upload";

const EXTENSIONS: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
};

export interface CaptureFiles {
  keepLocalCopy(draftId: string, sourceUri: string, localId: string, extension: string): string;
  /** The copy's size in bytes, or null when the phone can't read it. */
  sizeOf(uri: string): number | null;
  removeLocalCopy(uri: string): void;
}

export type Captured = { kind: "kept"; item: EvidenceItem } | { kind: "unreadable" };

export function captureEvidence(
  input: {
    draftId: string;
    purpose: Purpose;
    sourceUri: string;
    mime: string;
    localId: string;
    capturedAt: string;
  },
  files: CaptureFiles,
): Captured {
  const localUri = files.keepLocalCopy(
    input.draftId,
    input.sourceUri,
    input.localId,
    EXTENSIONS[input.mime] ?? "bin",
  );
  const size = files.sizeOf(localUri);
  if (size === null || !Number.isSafeInteger(size) || size < 0) {
    files.removeLocalCopy(localUri);
    return { kind: "unreadable" };
  }
  return {
    kind: "kept",
    item: {
      localId: input.localId,
      purpose: input.purpose,
      localUri,
      mime: input.mime,
      sizeBytes: size,
      capturedAt: input.capturedAt,
      objectId: null,
      versionId: null,
      version: null,
      supersedesId: null,
      storagePath: null,
      upload: "local",
      sha256: null,
      error: null,
    },
  };
}
