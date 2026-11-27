// What a command's status means on screen. The only route to "issued" is a relay `confirmed`.
import type { CommandView } from "./api/commands";
import { failedCommandCopy, transactionTooLargeCopy } from "./copy";
import { formatSlot, formatTonnes } from "./format";
import { markFor, type RegistryMark } from "./marks";

export interface OutcomeContext {
  lotId: string;
  ownerName: string;
  ownerOrgAddress: string | null;
  org: string;
  /** Values from the signed text's lines. */
  signed: { quantity: string; owner: string; site: string };
  signBefore: string;
}

export interface OutcomeView {
  mark: RegistryMark;
  title: string | null;
  lines: string[];
  refusal: string | null;
  after: string | null;
  transaction: { signature: string; explorerUrl: string } | null;
  issued: boolean;
  polling: boolean;
  primary: "back_home" | "edit" | "renew" | null;
}

function eventQuantity(data: Record<string, unknown> | undefined): string | null {
  const value = data?.quantityKg;
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)
    ? formatTonnes(BigInt(value))
    : null;
}

export function outcomeView(command: CommandView, ctx: OutcomeContext): OutcomeView {
  const mark = markFor(command.status, command.confirmedCommitment);
  const transaction = command.transaction && {
    signature: command.transaction.signature,
    explorerUrl: command.transaction.explorerUrl,
  };
  const base: OutcomeView = {
    mark,
    title: null,
    lines: [],
    refusal: null,
    after: null,
    transaction,
    issued: false,
    polling: false,
    primary: null,
  };
  switch (command.status) {
    case "awaiting_signatures":
      return { ...base, polling: true };
    case "expired":
      // Renewing the same draft would build the same size, so the way on is Edit.
      if (command.error?.code === "TRANSACTION_TOO_LARGE") {
        return {
          ...base,
          lines: [transactionTooLargeCopy(command.error.detail)],
          primary: "edit",
        };
      }
      return {
        ...base,
        lines: [`This text expired at ${ctx.signBefore}. Nothing was sent.`],
        primary: "renew",
      };
    case "submitted":
      return {
        ...base,
        lines: ["Thetis sent the issue to devnet. Waiting for confirmation."],
        polling: true,
      };
    case "outcome_unknown":
      return {
        ...base,
        lines: [
          "Thetis sent this issue but has no answer from devnet yet. Do not issue this intake again. Thetis keeps checking.",
        ],
        polling: true,
      };
    case "failed": {
      // The parser refuses a failed view without an error, so the code is the program's own.
      const code = command.error?.code ?? null;
      return {
        ...base,
        lines: [
          failedCommandCopy(
            code ?? "",
            {
              org: ctx.org,
              owner: ctx.ownerName,
              site: ctx.signed.site,
              quantity: ctx.signed.quantity,
            },
            command.kind,
          ),
        ],
        refusal: code === null ? null : `Refused by the Thetis program: ${code}`,
        after: transaction
          ? "Nothing was recorded. The refusal is on devnet:"
          : "Nothing was recorded.",
        primary: "edit",
      };
    }
    case "confirmed": {
      const quantity = eventQuantity(command.outcome?.data) ?? ctx.signed.quantity;
      const owner =
        ctx.ownerOrgAddress !== null && command.outcome?.data.owner === ctx.ownerOrgAddress
          ? ctx.ownerName
          : ctx.signed.owner;
      const slot = command.confirmedSlot ?? command.outcome?.slot ?? null;
      const verb = mark === "Finalized" ? "Finalized" : "Confirmed";
      const where = slot
        ? `${verb} on devnet in slot ${formatSlot(BigInt(slot))}.`
        : `${verb} on devnet.`;
      return {
        ...base,
        title: `Lot ${ctx.lotId} issued`,
        lines: [`${where} ${owner} holds ${quantity} of receipts at ${ctx.signed.site}.`],
        issued: true,
        primary: "back_home",
      };
    }
  }
}

export interface HandoverOutcomeContext {
  kind: "handover";
  org: string;
  lotId: string;
  batchLine: string;
  /** "5,000.000 t" */
  quantity: string;
  from: string;
  to: string;
  /** From the signed text: "Departure", "Arrival" or "Transfer". */
  stage: string;
  signBefore: string;
  /** This phone's organisation started the command, so it may renew it. */
  initiator: boolean;
}

export interface ObservationOutcomeContext {
  kind: "record_observation";
  org: string;
  holder: string;
  batchLine: string;
  signBefore: string;
}

export interface LoadingOutcomeContext {
  kind: "record_loading";
  org: string;
  owner: string;
  signBefore: string;
  initiator: boolean;
}

export type CustodyOutcomeContext =
  | HandoverOutcomeContext
  | ObservationOutcomeContext
  | LoadingOutcomeContext;

/** What a loading's confirmed event says was handed off, or null when the relay could not read it. */
function loadingResult(
  data: Record<string, unknown> | undefined,
): { debt: boolean; retired: boolean } | null {
  const lotLoaded = data?.lotLoaded;
  const handOffs = data?.loanHandOffs;
  if (typeof lotLoaded !== "boolean" || !Array.isArray(handOffs)) return null;
  const debt = handOffs.some(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      (item as { externalHandoff?: unknown }).externalHandoff === true,
  );
  return { debt, retired: lotLoaded };
}

function confirmedLoading(
  command: CommandView,
  where: string,
): Pick<OutcomeView, "title" | "lines"> {
  const result = loadingResult(command.outcome?.data);
  if (result === null) {
    return {
      title: "Loading recorded",
      lines: [`${where} See the transaction for what was handed off.`],
    };
  }
  const head = result.retired ? "Registry retired" : "Position loaded";
  const debt = result.debt
    ? "; debt remains recorded; external hand-off accepted by lender."
    : ". No debt is handed off.";
  return { title: head, lines: [`${head}${debt} ${where}`] };
}

/** The outcome of a handover, a border observation or a loading; the same rules as `outcomeView`. */
export function custodyOutcomeView(command: CommandView, ctx: CustodyOutcomeContext): OutcomeView {
  const mark = markFor(command.status, command.confirmedCommitment);
  const transaction = command.transaction && {
    signature: command.transaction.signature,
    explorerUrl: command.transaction.explorerUrl,
  };
  const base: OutcomeView = {
    mark,
    title: null,
    lines: [],
    refusal: null,
    after: null,
    transaction,
    issued: false,
    polling: false,
    primary: null,
  };
  const noun =
    ctx.kind === "handover"
      ? "handover"
      : ctx.kind === "record_observation"
        ? "observation"
        : "loading";
  switch (command.status) {
    case "awaiting_signatures":
      return { ...base, polling: true };
    case "expired": {
      if (command.error?.code === "TRANSACTION_TOO_LARGE") {
        return {
          ...base,
          lines: [transactionTooLargeCopy(command.error.detail)],
          primary: "back_home",
        };
      }
      if (ctx.kind === "record_observation") {
        return {
          ...base,
          lines: [`This text expired at ${ctx.signBefore}. Nothing was sent.`],
          primary: "renew",
        };
      }
      const lines = [
        `This text expired at ${ctx.signBefore} before both of you signed. Nothing was sent.`,
      ];
      if (!ctx.initiator) {
        lines.push(`Ask ${ctx.kind === "handover" ? ctx.from : ctx.owner} to prepare a new text.`);
      }
      return { ...base, lines, primary: ctx.initiator ? "renew" : "back_home" };
    }
    case "submitted":
      return {
        ...base,
        lines: [`Thetis sent the ${noun} to devnet. Waiting for confirmation.`],
        polling: true,
      };
    case "outcome_unknown": {
      const advice =
        ctx.kind === "handover"
          ? "Do not treat the load as handed over. Thetis keeps checking."
          : ctx.kind === "record_observation"
            ? "Don't record it again; Thetis keeps checking."
            : "Do not load against it as recorded. Thetis keeps checking.";
      return {
        ...base,
        lines: [`Thetis sent this ${noun} but has no answer from devnet yet. ${advice}`],
        polling: true,
      };
    }
    case "failed": {
      const code = command.error?.code ?? "";
      const line =
        ctx.kind === "handover"
          ? failedCommandCopy(code, { org: ctx.org, to: ctx.to, holder: ctx.from }, "handover")
          : failedCommandCopy(code, { org: ctx.org }, ctx.kind);
      return {
        ...base,
        lines: [line],
        refusal: command.error === null ? null : `Refused by the Thetis program: ${code}`,
        after: transaction
          ? "Nothing was recorded. The refusal is on devnet:"
          : "Nothing was recorded.",
        primary: ctx.kind === "record_observation" ? "edit" : "back_home",
      };
    }
    case "confirmed": {
      const slot = command.confirmedSlot ?? command.outcome?.slot ?? null;
      const finalized = mark === "Finalized";
      const verb = finalized ? "Finalized" : "Confirmed";
      const where = slot
        ? `${verb} on devnet in slot ${formatSlot(BigInt(slot))}.`
        : `${verb} on devnet.`;
      const done = { ...base, issued: true, primary: "back_home" } as const;
      if (ctx.kind === "handover") {
        const title = `${ctx.to} holds ${ctx.batchLine}`;
        if (ctx.stage === "Arrival") {
          const arrival = slot
            ? `Arrival ${verb.toLowerCase()} on devnet in slot ${formatSlot(BigInt(slot))}.`
            : `Arrival ${verb.toLowerCase()} on devnet.`;
          return {
            ...done,
            title,
            lines: [`${arrival} The lot is Stored at the terminal once every batch has arrived.`],
          };
        }
        return {
          ...done,
          title,
          lines: [
            `Custody of ${ctx.lotId}, ${ctx.quantity}, passed from ${ctx.from} to ${ctx.to}. ${where}`,
          ],
        };
      }
      if (ctx.kind === "record_observation") {
        return {
          ...done,
          title: "Border crossing recorded",
          lines: [
            `Border crossing recorded for ${ctx.batchLine}. ${ctx.holder} still holds it. ${where}`,
          ],
        };
      }
      return { ...done, ...confirmedLoading(command, where) };
    }
  }
}
