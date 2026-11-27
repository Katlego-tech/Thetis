// Intake drafts on the phone, keyed by (user, organisation). Drafts hold the relay's command id
// and status, never a signature, a signed text or a wallet token.
import { ApiError } from "../api/client";
import type { CommandStatus, CommandView } from "../api/commands";
import type { EvidenceItem } from "../evidence/upload";
import { LOT_ID } from "../intake";
import type { KeyValueStorage } from "../secure-session";

export type DraftStatus =
  | "editing"
  | "preparing"
  | "awaiting_signature"
  | "submitted"
  | "unknown"
  | "issued"
  | "failed";

export interface DraftCommand {
  commandId: string;
  lastStatus: CommandStatus;
  textVersion: number;
  transactionSignature: string | null;
  lot: string | null;
  /** The relay's explorer link for the transaction; the phone never builds one. */
  explorerUrl: string | null;
  commitment: "confirmed" | "finalized" | null;
}

export interface IntakeDraft {
  id: string;
  userId: string;
  organisationId: string;
  protocol: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  custodianClass: string | null;
  siteCode: string | null;
  classLabel: string | null;
  ownerOrgId: string | null;
  ownerName: string | null;
  lotId: string;
  lotIdLocked: boolean;
  /** The person finished typing the lot id (blur or Done): only then do uploads start. */
  lotIdCommitted: boolean;
  grade: string | null;
  quantityText: string;
  weighbridgeTicket: string;
  evidence: EvidenceItem[];
  command: DraftCommand | null;
  status: DraftStatus;
}

export type DraftEdit = Partial<
  Pick<
    IntakeDraft,
    | "custodianClass"
    | "siteCode"
    | "classLabel"
    | "ownerOrgId"
    | "ownerName"
    | "lotId"
    | "grade"
    | "quantityText"
    | "weighbridgeTicket"
    | "evidence"
  >
>;

export function newDraft(init: {
  id: string;
  userId: string;
  organisationId: string;
  protocol: string;
  now: string;
}): IntakeDraft {
  return {
    ...init,
    revision: 0,
    createdAt: init.now,
    updatedAt: init.now,
    custodianClass: null,
    siteCode: null,
    classLabel: null,
    ownerOrgId: null,
    ownerName: null,
    lotId: "",
    lotIdLocked: false,
    lotIdCommitted: false,
    grade: null,
    quantityText: "",
    weighbridgeTicket: "",
    evidence: [],
    command: null,
    status: "editing",
  };
}

export class DraftLocked extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "DraftLocked";
  }
}

/** A change a person makes: revision + 1, and any abandoned command forgotten. */
export function editDraft(draft: IntakeDraft, edit: DraftEdit, now: string): IntakeDraft {
  if (draft.status !== "editing" && draft.status !== "failed") {
    throw new DraftLocked(`a draft in ${draft.status} can't be edited`);
  }
  if (edit.lotId !== undefined && edit.lotId !== draft.lotId && draft.lotIdLocked) {
    throw new DraftLocked("the lot id is fixed once a file is registered");
  }
  const lotIdChanged = edit.lotId !== undefined && edit.lotId !== draft.lotId;
  return {
    ...draft,
    ...edit,
    lotIdCommitted: lotIdChanged ? false : draft.lotIdCommitted,
    revision: draft.revision + 1,
    updatedAt: now,
    command: null,
    status: "editing",
  };
}

/** The lot id field lost focus or Done was pressed: a valid lot id is now final for uploads. */
export function commitLotId(draft: IntakeDraft): IntakeDraft {
  if (draft.lotIdCommitted || !LOT_ID.test(draft.lotId)) return draft;
  return { ...draft, lotIdCommitted: true };
}

/** Upload progress: not a person's edit, so the revision stays; locks the lot id once registered. */
export function withEvidence(
  draft: IntakeDraft,
  evidence: EvidenceItem[],
  now: string,
): IntakeDraft {
  const registered = evidence.some((item) => item.objectId !== null && item.upload !== "local");
  return { ...draft, evidence, updatedAt: now, lotIdLocked: draft.lotIdLocked || registered };
}

export function draftStatusFor(status: CommandStatus): DraftStatus {
  switch (status) {
    case "awaiting_signatures":
    case "expired":
      return "awaiting_signature";
    case "submitted":
      return "submitted";
    case "outcome_unknown":
      return "unknown";
    case "confirmed":
      return "issued";
    case "failed":
      return "failed";
  }
}

/** A relay answer that is not this draft's issue: never mapped onto it. */
export class CommandMismatch extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "CommandMismatch";
  }
}

/** Whether a view is this draft's issue: the kind, the lot id, and the command it already holds. */
export function checkBelongs(draft: IntakeDraft, view: CommandView): void {
  if (view.kind !== "issue_lot") throw new CommandMismatch(`kind ${view.kind}`);
  if (view.args.lotId !== draft.lotId) throw new CommandMismatch("another lot id");
  if (draft.command && draft.command.commandId !== view.id) {
    throw new CommandMismatch("another command");
  }
}

/** Applies a relay answer. `issued` is reached only here, from a relay `confirmed`. */
export function applyCommand(draft: IntakeDraft, view: CommandView): IntakeDraft {
  checkBelongs(draft, view);
  return {
    ...draft,
    status: draftStatusFor(view.status),
    command: {
      commandId: view.id,
      lastStatus: view.status,
      textVersion: view.text?.version ?? 0,
      transactionSignature: view.transaction?.signature ?? null,
      lot: view.lot,
      explorerUrl: view.transaction?.explorerUrl ?? null,
      commitment: view.confirmedCommitment,
    },
  };
}

/** Back to editing after the person chose Edit details (or the relay lost the command). */
export function backToEditing(draft: IntakeDraft, now: string): IntakeDraft {
  return {
    ...draft,
    status: "editing",
    command: null,
    revision: draft.revision + 1,
    updatedAt: now,
  };
}

/**
 * Reconciles a stored draft with the relay. `error` is set when no view could be applied (offline,
 * timeout, an unreadable answer, a view of another draft): the draft keeps its stored state and
 * its command, and the caller keeps checking. Only a 404 forgets the command.
 */
export async function resumeDraft(
  draft: IntakeDraft,
  get: (commandId: string) => Promise<CommandView>,
): Promise<{ draft: IntakeDraft; view: CommandView | null; error: unknown }> {
  if (!draft.command) {
    if (draft.status === "preparing")
      return { draft: { ...draft, status: "editing" }, view: null, error: null };
    return { draft, view: null, error: null };
  }
  try {
    const view = await get(draft.command.commandId);
    return { draft: applyCommand(draft, view), view, error: null };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return { draft: backToEditing(draft, draft.updatedAt), view: null, error: null };
    }
    return { draft, view: null, error };
  }
}

export function isEarlierRun(draft: IntakeDraft, protocol: string): boolean {
  return draft.protocol !== protocol;
}

export const draftsKey = (userId: string, organisationId: string) =>
  `thetis.field.drafts.${userId}.${organisationId}`;
export const organisationKey = (userId: string) => `thetis.field.org.${userId}`;
export const walletKey = (userId: string, organisationId: string) =>
  `thetis.field.wallet.${userId}.${organisationId}`;

export interface StoredWallet {
  address: string;
  walletUriBase: string;
}

/** A draft stored before a field existed reads that field's default. */
function restore(stored: IntakeDraft): IntakeDraft {
  const command = stored.command
    ? {
        ...stored.command,
        explorerUrl: stored.command.explorerUrl ?? null,
        commitment: stored.command.commitment ?? null,
      }
    : null;
  return { ...stored, lotIdCommitted: stored.lotIdCommitted ?? stored.lotIdLocked, command };
}

export function createDraftStore(storage: KeyValueStorage) {
  // Every read-modify-write runs after the one before it, so two saves can't land out of order.
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  }
  async function read(userId: string, organisationId: string): Promise<IntakeDraft[]> {
    const raw = await storage.getItem(draftsKey(userId, organisationId));
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as IntakeDraft[]).map(restore) : [];
    } catch {
      return [];
    }
  }
  async function write(userId: string, organisationId: string, drafts: IntakeDraft[]) {
    await storage.setItem(draftsKey(userId, organisationId), JSON.stringify(drafts));
  }
  const list = (userId: string, organisationId: string) =>
    serial(() => read(userId, organisationId));
  return {
    list,
    async get(userId: string, organisationId: string, id: string) {
      return (await list(userId, organisationId)).find((draft) => draft.id === id) ?? null;
    },
    save(draft: IntakeDraft): Promise<void> {
      return serial(async () => {
        const drafts = await read(draft.userId, draft.organisationId);
        const others = drafts.filter((d) => d.id !== draft.id);
        await write(draft.userId, draft.organisationId, [...others, draft]);
      });
    },
    remove(draft: IntakeDraft): Promise<void> {
      return serial(async () => {
        const drafts = await read(draft.userId, draft.organisationId);
        await write(
          draft.userId,
          draft.organisationId,
          drafts.filter((d) => d.id !== draft.id),
        );
      });
    },
    async wallet(userId: string, organisationId: string): Promise<StoredWallet | null> {
      const raw = await storage.getItem(walletKey(userId, organisationId));
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw) as StoredWallet;
        return typeof parsed.address === "string" ? parsed : null;
      } catch {
        return null;
      }
    },
    async setWallet(userId: string, organisationId: string, wallet: StoredWallet | null) {
      if (wallet) await storage.setItem(walletKey(userId, organisationId), JSON.stringify(wallet));
      else await storage.removeItem(walletKey(userId, organisationId));
    },
    async organisation(userId: string) {
      return storage.getItem(organisationKey(userId));
    },
    async setOrganisation(userId: string, organisationId: string) {
      await storage.setItem(organisationKey(userId), organisationId);
    },
  };
}

export type DraftStore = ReturnType<typeof createDraftStore>;
