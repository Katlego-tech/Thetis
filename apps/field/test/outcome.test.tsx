import { describe, expect, it, vi } from "vitest";
import type { CommandStatus } from "../src/api/commands";
import { Outcome } from "../src/components/Outcome";
import { type OutcomeContext, outcomeView } from "../src/outcome";
import { commandView, OWNER_ORG_ADDRESS, TX_SIGNATURE } from "./fixtures";
import { textOf } from "./render";

vi.mock("react-native", () => ({
  Linking: { openURL: vi.fn() },
  Pressable: "Pressable",
  StyleSheet: { create: (s: unknown) => s },
  Text: "Text",
  View: "View",
  useColorScheme: () => "light",
}));

const ctx: OutcomeContext = {
  lotId: "CR-0001",
  ownerName: "Khunou Ore Exports",
  ownerOrgAddress: OWNER_ORG_ADDRESS,
  org: "Kopano Stockyard Custody",
  signed: { quantity: "5,000.000 t", owner: "Khunou Ore Exports", site: "KOPANO-YARD-1" },
  signBefore: "10:14:05 SAST",
};

const STATUSES: CommandStatus[] = [
  "awaiting_signatures",
  "submitted",
  "confirmed",
  "failed",
  "outcome_unknown",
  "expired",
];

describe("outcomeView", () => {
  it.each([
    ["awaiting_signatures", "Awaiting signatures"],
    ["submitted", "Submitted, unconfirmed"],
    ["confirmed", "Confirmed"],
    ["failed", "Failed"],
    ["outcome_unknown", "Outcome unknown"],
    ["expired", "Not on chain"],
  ] as [CommandStatus, string][])("%s shows the mark %s", (status, mark) => {
    expect(outcomeView(commandView(status), ctx).mark).toBe(mark);
  });

  it("finalized commitment shows Finalized", () => {
    const view = outcomeView(commandView("confirmed", { confirmedCommitment: "finalized" }), ctx);
    expect(view.mark).toBe("Finalized");
    expect(view.lines[0]).toBe(
      "Finalized on devnet in slot 526,890,114. Khunou Ore Exports holds 5,000.000 t of receipts at KOPANO-YARD-1.",
    );
  });

  it("confirmed names the lot, slot, owner, quantity and site", () => {
    const view = outcomeView(commandView("confirmed"), ctx);
    expect(view.title).toBe("Lot CR-0001 issued");
    expect(view.lines).toStrictEqual([
      "Confirmed on devnet in slot 526,890,114. Khunou Ore Exports holds 5,000.000 t of receipts at KOPANO-YARD-1.",
    ]);
    expect(view.transaction?.signature).toBe(TX_SIGNATURE);
    expect(view.primary).toBe("back_home");
  });

  it("confirmed takes the quantity from the event, and the signed owner when the event's owner differs", () => {
    const base = commandView("confirmed");
    const view = outcomeView(
      {
        ...base,
        outcome: base.outcome && {
          ...base.outcome,
          data: { owner: "11111111111111111111111111111111", quantityKg: "4999875" },
        },
      },
      { ...ctx, signed: { ...ctx.signed, owner: "Signed Owner Name" } },
    );
    expect(view.lines[0]).toBe(
      "Confirmed on devnet in slot 526,890,114. Signed Owner Name holds 4,999.875 t of receipts at KOPANO-YARD-1.",
    );
  });

  it("failed shows the program message, the code and the explorer", () => {
    const view = outcomeView(
      commandView("failed", { error: { code: "OverCapacity", detail: null } }),
      ctx,
    );
    expect(view.lines).toStrictEqual(["5,000.000 t is more than KOPANO-YARD-1 has room for."]);
    expect(view.refusal).toBe("Refused by the Thetis program: OverCapacity");
    expect(view.after).toBe("Nothing was recorded. The refusal is on devnet:");
    expect(view.primary).toBe("edit");
  });

  it.each([
    [
      "Anchor0",
      "Thetis already has this intake or this lot ID. A second lot for the same intake is refused.",
    ],
    [
      "RelatedCustodian",
      "Kopano Stockyard Custody is declared related to Khunou Ore Exports, so it can't hold this lot as an independent custodian.",
    ],
    [
      "WrongRole",
      "Khunou Ore Exports is not accredited as an exporter, so it can't own a new lot.",
    ],
    ["AuthorityRevoked", "A signer's authority does not allow this action."],
    ["WrongSigner", "A signer's authority does not allow this action."],
    ["WrongSignatureCount", "The signature did not match what Thetis expected."],
    ["CrossInstructionReference", "The signature did not match what Thetis expected."],
    ["WindowTooLong", "The signed text was no longer valid when it reached devnet."],
    ["Paused", "This action is paused on this Thetis instance."],
    ["TransactionError", "See the transaction on the explorer for the program's message."],
  ])("failed %s", (code, message) => {
    expect(
      outcomeView(commandView("failed", { error: { code, detail: null } }), ctx).lines,
    ).toStrictEqual([message]);
  });

  it("outcome unknown keeps polling and warns against a second issue", () => {
    const view = outcomeView(commandView("outcome_unknown"), ctx);
    expect(view.lines).toStrictEqual([
      "Thetis sent this issue but has no answer from devnet yet. Do not issue this intake again. Thetis keeps checking.",
    ]);
    expect(view.polling).toBe(true);
  });

  it("expired offers a new text", () => {
    const view = outcomeView(commandView("expired"), ctx);
    expect(view.lines).toStrictEqual(["This text expired at 10:14:05 SAST. Nothing was sent."]);
    expect(view.primary).toBe("renew");
  });

  it.each(STATUSES)("only confirmed says issued (%s)", (status) => {
    for (const commitment of ["confirmed", "finalized", null] as const) {
      const view = outcomeView(
        commandView(status, {
          confirmedCommitment: status === "confirmed" ? (commitment ?? "confirmed") : null,
        }),
        ctx,
      );
      const all = [view.mark, view.title ?? "", ...view.lines].join(" ");
      expect(view.issued).toBe(status === "confirmed");
      if (status !== "confirmed") {
        expect(all).not.toMatch(/issued/i);
        expect(all).not.toMatch(/Confirmed|Finalized/);
      }
    }
  });
});

describe("<Outcome>", () => {
  it.each(STATUSES)("renders the mark and copy for %s", (status) => {
    const view = commandView(status);
    const text = textOf(<Outcome command={view} context={ctx} onPrimary={() => {}} />).join(" ");
    const expected = outcomeView(view, ctx);
    expect(text).toContain(expected.mark);
    for (const line of expected.lines) expect(text).toContain(line);
    if (status === "confirmed") expect(text).toContain("Lot CR-0001 issued");
    else expect(text).not.toMatch(/issued|Confirmed/);
  });

  it("links the transaction on the explorer", () => {
    const text = textOf(
      <Outcome command={commandView("submitted")} context={ctx} onPrimary={() => {}} />,
    ).join(" ");
    expect(text).toContain(TX_SIGNATURE);
    expect(text).toContain("View on Solana Explorer (devnet)");
  });
});
