// What a command's status means on screen. The only route to "issued" is a relay `confirmed`.
import type { CommandView } from "./api/commands";
import { failedCommandCopy } from "./copy";
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
      const code = command.error?.code ?? "TransactionError";
      return {
        ...base,
        lines: [
          failedCommandCopy(code, {
            org: ctx.org,
            owner: ctx.ownerName,
            site: ctx.signed.site,
            quantity: ctx.signed.quantity,
          }),
        ],
        refusal: `Refused by the Thetis program: ${code}`,
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
