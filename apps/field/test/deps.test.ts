import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/client";
import { uploadDeps } from "../src/evidence/deps";
import { advanceUpload, type EvidenceItem, UploadStepError } from "../src/evidence/upload";

vi.mock("expo-crypto", () => ({ randomUUID: () => "0c0c0c0c-0000-4000-8000-000000000001" }));
vi.mock("expo-file-system", () => ({
  File: class {
    async arrayBuffer() {
      return new ArrayBuffer(4);
    }
  },
}));
vi.mock("../src/supabase", () => ({ SupabaseTimeout: class extends Error {} }));

const item: EvidenceItem = {
  localId: "l-1",
  purpose: "assay",
  localUri: "file:///data/drafts/d-1/l-1.pdf",
  mime: "application/pdf",
  sizeBytes: 1_234,
  capturedAt: "2026-11-27T08:03:00.000Z",
  objectId: "0a0a0a0a-0000-4000-8000-000000000001",
  versionId: "0b0b0b0b-0000-4000-8000-000000000001",
  version: 1,
  supersedesId: null,
  storagePath: "0b9f4d2e-3c1a-4f6e-9d8b-7a6c5e4d3b2a/0a0a0a0a-0000-4000-8000-000000000001/1",
  upload: "finalizing",
  sha256: null,
  error: null,
};

function depsWith(finalize: () => Promise<never>) {
  const db = {
    storage: { from: () => ({ upload: async () => ({ error: null }) }) },
  } as unknown as Parameters<typeof uploadDeps>[0];
  return uploadDeps(db, { finalize } as unknown as Parameters<typeof uploadDeps>[1]);
}

describe("finalize 403 NOT_AUTHORISED (pre-check fold 5)", () => {
  it("is a step error of kind other", async () => {
    const deps = depsWith(async () => {
      throw new ApiError(403, "NOT_AUTHORISED", "", null);
    });
    const error = await deps.finalize("v").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UploadStepError);
    expect(error).toMatchObject({ kind: "other", message: "NOT_AUTHORISED" });
  });

  it("marks the item failed with the error", async () => {
    const deps = depsWith(async () => {
      throw new ApiError(403, "NOT_AUTHORISED", "", null);
    });
    const done = await advanceUpload(
      item,
      {
        organisationId: "0b9f4d2e-3c1a-4f6e-9d8b-7a6c5e4d3b2a",
        userId: "fa57ea5f-9cf6-43fc-82b1-592d505bc3d7",
        subjectKind: "lot",
        subjectRef: "CR-0001",
      },
      deps,
    );
    expect(done.upload).toBe("failed");
    expect(done.error).toBe("NOT_AUTHORISED");
  });
});
