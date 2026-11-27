import { describe, expect, it, vi } from "vitest";
import { ApiError, ApiUnreachable } from "../src/api/client";
import type { CommandStatus } from "../src/api/commands";
import {
  applyCommand,
  createDraftStore,
  type DraftStatus,
  draftStatusFor,
  editDraft,
  type IntakeDraft,
  isEarlierRun,
  newDraft,
  resumeDraft,
} from "../src/drafts/store";
import { commandView, PROGRAM, PROTOCOL } from "./fixtures";

function memory() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => void values.set(key, value),
    removeItem: async (key: string) => void values.delete(key),
  };
}

const USER = "fa57ea5f-9cf6-43fc-82b1-592d505bc3d7";
const ORG = "0b9f4d2e-3c1a-4f6e-9d8b-7a6c5e4d3b2a";
const NOW = "2026-11-27T08:05:00.000Z";

function draft(): IntakeDraft {
  return newDraft({ id: "d-1", userId: USER, organisationId: ORG, protocol: PROTOCOL, now: NOW });
}

describe("save and restore", () => {
  it("restores what was saved, keyed by user and organisation", async () => {
    const storage = memory();
    const store = createDraftStore(storage);
    const saved = editDraft(draft(), { lotId: "CR-0001", quantityText: "5000" }, NOW);
    await store.save(saved);
    expect(await store.list(USER, ORG)).toStrictEqual([saved]);
    expect(await store.list(USER, "other-org")).toStrictEqual([]);
    expect(await store.list("other-user", ORG)).toStrictEqual([]);
    expect([...storage.values.keys()]).toStrictEqual([`thetis.field.drafts.${USER}.${ORG}`]);
  });

  it("removes a discarded draft", async () => {
    const store = createDraftStore(memory());
    const saved = draft();
    await store.save(saved);
    await store.remove(saved);
    expect(await store.list(USER, ORG)).toStrictEqual([]);
  });

  it("never stores a signature, the text or an auth token", async () => {
    const storage = memory();
    const store = createDraftStore(storage);
    const view = commandView("awaiting_signatures");
    const withCommand = applyCommand({ ...draft(), status: "preparing" }, view);
    await store.save(withCommand);
    const json = [...storage.values.values()].join("");
    expect(json).toContain(view.id);
    expect(json).not.toContain(view.text?.messageBase64 ?? "missing");
    expect(json).not.toContain("Thetis authorisation");
    expect(json).not.toMatch(/signatureBase58|authToken|messageBase64|auth_token/);
  });
});

describe("revision", () => {
  it("starts at 0 and goes up by 1 on each tracked change", () => {
    const start = draft();
    expect(start.revision).toBe(0);
    expect(start.status).toBe("editing");
    const one = editDraft(start, { grade: "G1" }, NOW);
    expect(one.revision).toBe(1);
    expect(editDraft(one, { quantityText: "5000", weighbridgeTicket: "wb 2611-0042" }, NOW).revision).toBe(2);
  });

  it("an edit clears the command", () => {
    const failed = applyCommand({ ...draft(), status: "preparing" }, commandView("failed"));
    expect(failed.status).toBe("failed");
    const edited = editDraft(failed, { quantityText: "4999" }, NOW);
    expect(edited.command).toBeNull();
    expect(edited.status).toBe("editing");
  });

  it("refuses edits while submitted or unknown", () => {
    for (const status of ["submitted", "unknown", "awaiting_signature", "issued", "preparing"] as DraftStatus[]) {
      expect(() => editDraft({ ...draft(), status }, { grade: "G1" }, NOW)).toThrow();
    }
  });
});

describe("lotIdLocked", () => {
  it("locks the lot id once a file is registered, and refuses a change after that", () => {
    const locked = { ...editDraft(draft(), { lotId: "CR-0001" }, NOW), lotIdLocked: true };
    expect(() => editDraft(locked, { lotId: "CR-0002" }, NOW)).toThrow();
    expect(editDraft(locked, { grade: "G1" }, NOW).lotId).toBe("CR-0001");
  });
});

describe("mapping a command status", () => {
  it.each([
    ["awaiting_signatures", "awaiting_signature"],
    ["expired", "awaiting_signature"],
    ["submitted", "submitted"],
    ["outcome_unknown", "unknown"],
    ["confirmed", "issued"],
    ["failed", "failed"],
  ] as [CommandStatus, DraftStatus][])("%s is %s", (status, expected) => {
    expect(draftStatusFor(status)).toBe(expected);
    const applied = applyCommand({ ...draft(), status: "preparing" }, commandView(status));
    expect(applied.status).toBe(expected);
    expect(applied.command?.lastStatus).toBe(status);
  });

  it("keeps the transaction signature and lot only once the relay reports them", () => {
    const waiting = applyCommand({ ...draft(), status: "preparing" }, commandView("awaiting_signatures"));
    expect(waiting.command?.transactionSignature).toBeNull();
    const done = applyCommand(waiting, commandView("confirmed"));
    expect(done.command?.transactionSignature).toBe(commandView("confirmed").transaction?.signature);
    expect(done.command?.lot).toBe(commandView("confirmed").lot);
  });
});

describe("resume (field-app.md §5.1)", () => {
  const withCommand = applyCommand({ ...draft(), status: "preparing" }, commandView("awaiting_signatures"));

  it.each([
    ["awaiting_signatures", "awaiting_signature"],
    ["expired", "awaiting_signature"],
    ["submitted", "submitted"],
    ["confirmed", "issued"],
    ["outcome_unknown", "unknown"],
    ["failed", "failed"],
  ] as [CommandStatus, DraftStatus][])("finds %s and shows %s", async (status, expected) => {
    const get = vi.fn(async () => commandView(status));
    const { draft: resumed } = await resumeDraft(withCommand, get);
    expect(get).toHaveBeenCalledWith(withCommand.command?.commandId);
    expect(resumed.status).toBe(expected);
  });

  it("404 returns the draft to editing at revision + 1", async () => {
    const get = vi.fn(async () => {
      throw new ApiError(404, "NOT_FOUND", "m", null);
    });
    const { draft: resumed } = await resumeDraft(withCommand, get);
    expect(resumed.status).toBe("editing");
    expect(resumed.command).toBeNull();
    expect(resumed.revision).toBe(withCommand.revision + 1);
  });

  it("preparing with no commandId returns to editing at the same revision", async () => {
    const get = vi.fn();
    const killed = { ...draft(), status: "preparing" as const, revision: 4 };
    const { draft: resumed } = await resumeDraft(killed, get);
    expect(get).not.toHaveBeenCalled();
    expect(resumed.status).toBe("editing");
    expect(resumed.revision).toBe(4);
  });

  it("a network failure leaves the stored state, never issued", async () => {
    const submitted = applyCommand(withCommand, commandView("submitted"));
    const get = vi.fn(async () => {
      throw new ApiUnreachable();
    });
    const result = await resumeDraft(submitted, get);
    expect(result.draft).toStrictEqual(submitted);
    expect(result.offline).toBe(true);
  });

  it("a draft with no command is left as it is", async () => {
    const get = vi.fn();
    const { draft: resumed } = await resumeDraft(draft(), get);
    expect(resumed).toStrictEqual(draft());
    expect(get).not.toHaveBeenCalled();
  });
});

describe("drafts of an earlier run", () => {
  it("are read-only when their protocol is not the indexed one", () => {
    expect(isEarlierRun(draft(), PROTOCOL)).toBe(false);
    expect(isEarlierRun(draft(), PROGRAM)).toBe(true);
  });
});
