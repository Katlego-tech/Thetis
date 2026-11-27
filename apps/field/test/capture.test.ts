import { describe, expect, it, vi } from "vitest";
import { captureEvidence } from "../src/evidence/capture";
import { checkLocalFile, MAX_BYTES } from "../src/evidence/upload";

const input = {
  draftId: "d-1",
  purpose: "weighbridge" as const,
  sourceUri: "file:///cache/ticket.pdf",
  mime: "application/pdf",
  localId: "l-1",
  capturedAt: "2026-11-27T08:03:00.000Z",
};

function files(size: number | null) {
  return {
    keepLocalCopy: vi.fn(() => "file:///data/drafts/d-1/l-1.pdf"),
    sizeOf: vi.fn(() => size),
    removeLocalCopy: vi.fn(),
  };
}

describe("the size checked is the local copy's (F9)", () => {
  it("takes the copied file's real size, not the picker's", () => {
    const deps = files(MAX_BYTES + 1);
    const result = captureEvidence(input, deps);
    if (result.kind !== "kept") throw new Error("expected the file kept");
    expect(deps.sizeOf).toHaveBeenCalledWith("file:///data/drafts/d-1/l-1.pdf");
    expect(result.item.sizeBytes).toBe(MAX_BYTES + 1);
    expect(checkLocalFile(result.item.mime, result.item.sizeBytes)).toStrictEqual({
      kind: "too_large",
      sizeBytes: MAX_BYTES + 1,
    });
  });

  it("does not keep a copy whose size can't be read", () => {
    const deps = files(null);
    expect(captureEvidence(input, deps)).toStrictEqual({ kind: "unreadable" });
    expect(deps.removeLocalCopy).toHaveBeenCalledWith("file:///data/drafts/d-1/l-1.pdf");
  });

  it("keeps a file within the limit as local", () => {
    const result = captureEvidence(input, files(1_234));
    expect(result).toMatchObject({
      kind: "kept",
      item: { localId: "l-1", sizeBytes: 1_234, upload: "local", objectId: null },
    });
  });
});
