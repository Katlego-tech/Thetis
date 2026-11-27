import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  advanceUpload,
  checkLocalFile,
  type EvidenceItem,
  type UploadDeps,
  UploadStepError,
} from "../src/evidence/upload";

const ORG = "0b9f4d2e-3c1a-4f6e-9d8b-7a6c5e4d3b2a";
const USER = "fa57ea5f-9cf6-43fc-82b1-592d505bc3d7";
const subject = {
  organisationId: ORG,
  userId: USER,
  subjectKind: "lot" as const,
  subjectRef: "CR-0001",
};
const SHA = "7e8533c2".padEnd(64, "0");

function local(): EvidenceItem {
  return {
    localId: "l-1",
    purpose: "weighbridge",
    localUri: "file:///data/drafts/d-1/l-1.jpg",
    mime: "image/jpeg",
    sizeBytes: 1_234,
    capturedAt: "2026-11-27T08:04:00.000Z",
    objectId: null,
    versionId: null,
    version: null,
    supersedesId: null,
    storagePath: null,
    upload: "local",
    sha256: null,
    error: null,
  };
}

let ids: string[];
let deps: { [K in keyof UploadDeps]: ReturnType<typeof vi.fn> } & UploadDeps;
beforeEach(() => {
  ids = ["obj-1", "ver-1", "ver-2"];
  deps = {
    newId: vi.fn(() => ids.shift() ?? "id-x"),
    insertObject: vi.fn(async () => {}),
    insertVersion: vi.fn(async () => {}),
    selectVersion: vi.fn(async () => null),
    upload: vi.fn(async () => {}),
    finalize: vi.fn(async (versionId: string) => ({ versionId, sha256: SHA, sizeBytes: 1_234 })),
  } as never;
});

describe("the happy path", () => {
  it("registers with phone-made ids, uploads, finalizes", async () => {
    const seen: string[] = [];
    const done = await advanceUpload(local(), subject, deps, (item) => seen.push(item.upload));
    expect(seen).toStrictEqual(["registering", "uploading", "finalizing", "finalized"]);
    expect(deps.insertObject).toHaveBeenCalledWith({
      id: "obj-1",
      owner_organisation_id: ORG,
      subject_kind: "lot",
      subject_ref: "CR-0001",
      purpose: "weighbridge",
      created_by: USER,
    });
    expect(deps.insertVersion).toHaveBeenCalledWith({
      id: "ver-1",
      object_id: "obj-1",
      version: 1,
      storage_path: `${ORG}/obj-1/1`,
      mime: "image/jpeg",
      uploaded_by: USER,
      supersedes_id: null,
    });
    expect(deps.upload).toHaveBeenCalledWith(`${ORG}/obj-1/1`, local().localUri, "image/jpeg");
    expect(done).toMatchObject({
      upload: "finalized",
      sha256: SHA,
      objectId: "obj-1",
      versionId: "ver-1",
      version: 1,
    });
  });

  it("a duplicate row means it landed: continue", async () => {
    deps.insertObject.mockRejectedValueOnce(new UploadStepError("duplicate", "23505"));
    deps.insertVersion.mockRejectedValueOnce(new UploadStepError("duplicate", "23505"));
    expect((await advanceUpload(local(), subject, deps)).upload).toBe("finalized");
  });

  it("an upload that already exists continues to finalizing", async () => {
    deps.upload.mockRejectedValueOnce(new UploadStepError("exists", "Duplicate"));
    expect((await advanceUpload(local(), subject, deps)).upload).toBe("finalized");
  });
});

describe("failures and retry from each step", () => {
  it("registering fails, retry registers with the same ids", async () => {
    deps.insertVersion.mockRejectedValueOnce(new UploadStepError("network", "offline"));
    const failed = await advanceUpload(local(), subject, deps);
    expect(failed).toMatchObject({
      upload: "failed",
      objectId: "obj-1",
      versionId: "ver-1",
      storagePath: null,
    });
    expect(failed.error).toBe("offline");
    deps.insertObject.mockRejectedValueOnce(new UploadStepError("duplicate", "23505"));
    const retried = await advanceUpload(failed, subject, deps);
    expect(retried.upload).toBe("finalized");
    expect(deps.insertVersion).toHaveBeenLastCalledWith(expect.objectContaining({ id: "ver-1" }));
  });

  it("uploading fails, retry starts at uploading", async () => {
    deps.upload.mockRejectedValueOnce(new UploadStepError("network", "timeout"));
    const failed = await advanceUpload(local(), subject, deps);
    expect(failed.upload).toBe("failed");
    expect(failed.storagePath).toBe(`${ORG}/obj-1/1`);
    deps.insertObject.mockClear();
    deps.insertVersion.mockClear();
    const retried = await advanceUpload(failed, subject, deps);
    expect(deps.insertObject).not.toHaveBeenCalled();
    expect(deps.insertVersion).not.toHaveBeenCalled();
    expect(retried.upload).toBe("finalized");
  });

  it("finalizing fails, retry re-uploads (exists) then finalizes", async () => {
    deps.finalize.mockRejectedValueOnce(new UploadStepError("network", "timeout"));
    const failed = await advanceUpload(local(), subject, deps);
    expect(failed.upload).toBe("failed");
    deps.upload.mockRejectedValueOnce(new UploadStepError("exists", "Duplicate"));
    expect((await advanceUpload(failed, subject, deps)).upload).toBe("finalized");
  });

  it("finalize 404 reads the version: finalized when it holds a digest", async () => {
    deps.finalize.mockRejectedValueOnce(new UploadStepError("not_found", "NOT_FOUND"));
    deps.selectVersion.mockResolvedValueOnce({ sha256: SHA, finalized_at: "2026-11-27T08:05:00Z" });
    expect(await advanceUpload(local(), subject, deps)).toMatchObject({
      upload: "finalized",
      sha256: SHA,
    });
  });

  it("finalize 404 with no digest on the version is failed", async () => {
    deps.finalize.mockRejectedValueOnce(new UploadStepError("not_found", "NOT_FOUND"));
    deps.selectVersion.mockResolvedValueOnce({ sha256: null, finalized_at: null });
    expect((await advanceUpload(local(), subject, deps)).upload).toBe("failed");
  });

  it("finalize 500 retries from uploading", async () => {
    deps.finalize.mockRejectedValueOnce(new UploadStepError("unreadable", "INTERNAL"));
    const failed = await advanceUpload(local(), subject, deps);
    expect(failed).toMatchObject({ upload: "failed", storagePath: `${ORG}/obj-1/1` });
    deps.upload.mockClear();
    await advanceUpload(failed, subject, deps);
    expect(deps.upload).toHaveBeenCalledOnce();
  });

  it("409 EVIDENCE_VERSION_INVALID is rejected; retry registers version + 1 superseding it", async () => {
    deps.finalize.mockRejectedValueOnce(
      new UploadStepError("invalid_version", "EVIDENCE_VERSION_INVALID"),
    );
    const rejected = await advanceUpload(local(), subject, deps);
    expect(rejected.upload).toBe("rejected");
    deps.insertObject.mockClear();
    const next = await advanceUpload(rejected, subject, deps);
    expect(deps.insertObject).not.toHaveBeenCalled();
    expect(deps.insertVersion).toHaveBeenLastCalledWith({
      id: "ver-2",
      object_id: "obj-1",
      version: 2,
      storage_path: `${ORG}/obj-1/2`,
      mime: "image/jpeg",
      uploaded_by: USER,
      supersedes_id: "ver-1",
    });
    expect(next).toMatchObject({
      upload: "finalized",
      version: 2,
      versionId: "ver-2",
      supersedesId: "ver-1",
    });
  });

  it("any other error marks the item failed with it", async () => {
    deps.insertObject.mockRejectedValueOnce(new UploadStepError("other", "NOT_AUTHORISED"));
    expect(await advanceUpload(local(), subject, deps)).toMatchObject({
      upload: "failed",
      error: "NOT_AUTHORISED",
    });
  });

  it("a finalized item is left alone", async () => {
    const done = await advanceUpload(local(), subject, deps);
    deps.finalize.mockClear();
    expect(await advanceUpload(done, subject, deps)).toStrictEqual(done);
    expect(deps.finalize).not.toHaveBeenCalled();
  });
});

describe("local checks", () => {
  it("refuses large or unstorable files", () => {
    expect(checkLocalFile("image/jpeg", 20_971_520)).toBeNull();
    expect(checkLocalFile("image/jpeg", 24_536_678)).toStrictEqual({
      kind: "too_large",
      sizeBytes: 24_536_678,
    });
    expect(checkLocalFile("image/heic", 10)).toStrictEqual({ kind: "type" });
    expect(checkLocalFile("application/pdf", 10)).toBeNull();
    expect(checkLocalFile("image/png", 10)).toBeNull();
  });

  it("an item that fails the local check never leaves local", async () => {
    const big = { ...local(), sizeBytes: 30_000_000 };
    expect(await advanceUpload(big, subject, deps)).toStrictEqual(big);
    expect(deps.insertObject).not.toHaveBeenCalled();
  });
});
