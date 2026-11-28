import { describe, expect, it, vi } from "vitest";
import type { CommandStatus, CommandView } from "../src/api/commands";
import { Outcome } from "../src/components/Outcome";
import {
  type CustodyOutcomeContext,
  custodyOutcomeView,
  type HandoverOutcomeContext,
  type LoadingOutcomeContext,
  type ObservationOutcomeContext,
} from "../src/outcome";
import {
  handoverText,
  handoverView,
  loadingView,
  MOSELA_ORG,
  observationView,
  PORT_ORG,
  SIGN_BEFORE,
} from "./custody-fixtures";
import { TX_SIGNATURE } from "./fixtures";
import { textOf } from "./render";

vi.mock("react-native", () => ({
  Linking: { openURL: vi.fn() },
  Pressable: "Pressable",
  StyleSheet: { create: (s: unknown) => s },
  Text: "Text",
  View: "View",
  useColorScheme: () => "light",
}));

const STATUSES: CommandStatus[] = [
  "awaiting_signatures",
  "submitted",
  "confirmed",
  "failed",
  "outcome_unknown",
  "expired",
];

const handoverCtx: HandoverOutcomeContext = {
  kind: "handover",
  org: "Kopano Stockyard Custody",
  lotId: "CR-0001",
  batchLine: "batch 1 of 1",
  quantity: "5,000.000 t",
  from: "Kopano Stockyard Custody",
  to: "Mosela Haulage",
  stage: "Departure",
  signBefore: SIGN_BEFORE,
  initiator: true,
};
const observationCtx: ObservationOutcomeContext = {
  kind: "record_observation",
  org: "Mosela Haulage",
  holder: "Mosela Haulage",
  batchLine: "batch 1 of 1",
  signBefore: SIGN_BEFORE,
};
const loadingCtx: LoadingOutcomeContext = {
  kind: "record_loading",
  org: "Port Terminal T1",
  owner: "Khunou Ore Exports",
  signBefore: SIGN_BEFORE,
  initiator: true,
};

type Build = (status: CommandStatus, overrides?: Partial<CommandView>) => CommandView;
const KINDS: [string, Build, CustodyOutcomeContext][] = [
  ["handover", (status, overrides) => handoverView(status, {}, overrides), handoverCtx],
  [
    "record_observation",
    (status, overrides) => observationView(status, {}, overrides),
    observationCtx,
  ],
  ["record_loading", (status, overrides) => loadingView(status, {}, overrides), loadingCtx],
];

const failed = (code: string, detail: string | null = null) => ({
  error: { code, detail },
});

const TOO_LARGE =
  "This text is too long for one devnet transaction (1251 bytes; devnet takes 1,232). Nothing was sent. Shorter organisation names or a shorter lot ID make it smaller.";

describe("custody outcome fixtures", () => {
  it("the sign-before time is the text's validity less 30 seconds", () => {
    expect(SIGN_BEFORE).toBe("12:09:00 SAST");
  });
});

describe("custodyOutcomeView: the mark and what 'done' means", () => {
  it.each(
    KINDS.flatMap(([kind, build, ctx]) =>
      (
        [
          ["awaiting_signatures", "Awaiting signatures"],
          ["submitted", "Submitted, unconfirmed"],
          ["confirmed", "Confirmed"],
          ["failed", "Failed"],
          ["outcome_unknown", "Outcome unknown"],
          ["expired", "Not on chain"],
        ] as [CommandStatus, string][]
      ).map(([status, mark]) => [kind, status, mark, build, ctx] as const),
    ),
  )("%s %s shows the mark %s", (_kind, status, mark, build, ctx) => {
    expect(custodyOutcomeView(build(status), ctx).mark).toBe(mark);
  });

  it.each(KINDS)("%s: a finalized confirmation shows the mark Finalized", (_kind, build, ctx) => {
    const view = custodyOutcomeView(build("confirmed", { confirmedCommitment: "finalized" }), ctx);
    expect(view.mark).toBe("Finalized");
  });

  it.each(KINDS)("%s: only confirmed is done on chain", (_kind, build, ctx) => {
    for (const status of STATUSES) {
      for (const commitment of ["confirmed", "finalized"] as const) {
        const view = custodyOutcomeView(
          build(status, status === "confirmed" ? { confirmedCommitment: commitment } : {}),
          ctx,
        );
        expect(view.issued, `${status} ${commitment}`).toBe(status === "confirmed");
        if (status !== "confirmed") {
          const all = [view.mark, view.title ?? "", ...view.lines].join(" ");
          expect(all).not.toMatch(/Confirmed|Finalized/);
          expect(view.title).toBeNull();
        }
      }
    }
  });

  it.each(KINDS)("%s: only awaiting, submitted and unknown keep polling", (_kind, build, ctx) => {
    for (const status of STATUSES) {
      expect(custodyOutcomeView(build(status), ctx).polling, status).toBe(
        status === "awaiting_signatures" || status === "submitted" || status === "outcome_unknown",
      );
    }
  });

  it.each(KINDS)(
    "%s: the transaction is the relay's, once something was sent",
    (_kind, build, ctx) => {
      expect(custodyOutcomeView(build("awaiting_signatures"), ctx).transaction).toBeNull();
      expect(custodyOutcomeView(build("expired"), ctx).transaction).toBeNull();
      for (const status of ["submitted", "confirmed", "failed", "outcome_unknown"] as const) {
        expect(custodyOutcomeView(build(status), ctx).transaction).toStrictEqual({
          signature: TX_SIGNATURE,
          explorerUrl: `https://explorer.solana.com/tx/${TX_SIGNATURE}?cluster=devnet`,
        });
      }
    },
  );
});

describe("custodyOutcomeView: waiting, sent and unknown", () => {
  it.each(KINDS)("%s: awaiting signatures has no lines and keeps polling", (_kind, build, ctx) => {
    const view = custodyOutcomeView(build("awaiting_signatures"), ctx);
    expect(view.lines).toStrictEqual([]);
    expect(view.polling).toBe(true);
    expect(view.refusal).toBeNull();
  });

  it("submitted names the thing that was sent", () => {
    expect(custodyOutcomeView(handoverView("submitted"), handoverCtx).lines).toStrictEqual([
      "Thetis sent the handover to devnet. Waiting for confirmation.",
    ]);
    expect(custodyOutcomeView(observationView("submitted"), observationCtx).lines).toStrictEqual([
      "Thetis sent the observation to devnet. Waiting for confirmation.",
    ]);
    expect(custodyOutcomeView(loadingView("submitted"), loadingCtx).lines).toStrictEqual([
      "Thetis sent the loading to devnet. Waiting for confirmation.",
    ]);
  });

  it("outcome unknown warns against acting as if it landed, and against doing it again", () => {
    expect(custodyOutcomeView(handoverView("outcome_unknown"), handoverCtx).lines).toStrictEqual([
      "Thetis sent this handover but has no answer from devnet yet. Do not treat the load as handed over. Thetis keeps checking.",
    ]);
    expect(
      custodyOutcomeView(observationView("outcome_unknown"), observationCtx).lines,
    ).toStrictEqual([
      "Thetis sent this observation but has no answer from devnet yet. Don't record it again; Thetis keeps checking.",
    ]);
    expect(custodyOutcomeView(loadingView("outcome_unknown"), loadingCtx).lines).toStrictEqual([
      "Thetis sent this loading but has no answer from devnet yet. Do not load against it as recorded. Thetis keeps checking.",
    ]);
  });
});

describe("custodyOutcomeView: expired before both signed", () => {
  it("handover, the initiator: one line and Prepare a new text", () => {
    const view = custodyOutcomeView(handoverView("expired"), handoverCtx);
    expect(view.lines).toStrictEqual([
      "This text expired at 12:09:00 SAST before both of you signed. Nothing was sent.",
    ]);
    expect(view.primary).toBe("renew");
  });

  it("handover, not the initiator: asks the holder, and offers no renew", () => {
    const view = custodyOutcomeView(handoverView("expired"), { ...handoverCtx, initiator: false });
    expect(view.lines).toStrictEqual([
      "This text expired at 12:09:00 SAST before both of you signed. Nothing was sent.",
      "Ask Kopano Stockyard Custody to prepare a new text.",
    ]);
    expect(view.primary).toBe("back_home");
  });

  it("observation: one line and renew; there is no one else to ask", () => {
    const view = custodyOutcomeView(observationView("expired"), observationCtx);
    expect(view.lines).toStrictEqual(["This text expired at 12:09:00 SAST. Nothing was sent."]);
    expect(view.primary).toBe("renew");
  });

  it("loading, the initiator: one line and renew", () => {
    const view = custodyOutcomeView(loadingView("expired"), loadingCtx);
    expect(view.lines).toStrictEqual([
      "This text expired at 12:09:00 SAST before both of you signed. Nothing was sent.",
    ]);
    expect(view.primary).toBe("renew");
  });

  it("loading, not the initiator: asks the owner, and offers no renew", () => {
    const view = custodyOutcomeView(loadingView("expired"), { ...loadingCtx, initiator: false });
    expect(view.lines).toStrictEqual([
      "This text expired at 12:09:00 SAST before both of you signed. Nothing was sent.",
      "Ask Khunou Ore Exports to prepare a new text.",
    ]);
    expect(view.primary).toBe("back_home");
  });

  it.each(KINDS)("%s: a text too long for one transaction is not renewed", (_kind, build, ctx) => {
    const view = custodyOutcomeView(
      build("expired", failed("TRANSACTION_TOO_LARGE", "1251 bytes")),
      ctx,
    );
    expect(view.lines).toStrictEqual([TOO_LARGE]);
    expect(view.primary).toBe("back_home");
    expect(view.issued).toBe(false);
  });
});

describe("custodyOutcomeView: a failed handover", () => {
  it("wrong driver refused: the Anchor3012 line, who still holds the batch, and the transaction", () => {
    const view = custodyOutcomeView(
      handoverView("failed", { error: { code: "Anchor3012", detail: null } }),
      handoverCtx,
    );
    expect(view.lines).toStrictEqual([
      "An authority or record this action needs does not exist on this Thetis instance. Kopano Stockyard Custody still holds the batch.",
    ]);
    expect(view.refusal).toBe("Refused by the Thetis program: Anchor3012");
    expect(view.after).toBe("Nothing was recorded. The refusal is on devnet:");
    expect(view.transaction?.signature).toBe(TX_SIGNATURE);
    expect(view.primary).toBe("back_home");
    expect(view.issued).toBe(false);
  });

  it("the holder named is the text's From, whoever's phone this is", () => {
    const view = custodyOutcomeView(
      handoverView("failed", { error: { code: "Anchor3012", detail: null } }),
      {
        ...handoverCtx,
        org: "Mosela Haulage",
        from: "Mosela Haulage",
        to: "Port Terminal T1",
      },
    );
    expect(view.lines[0]).toMatch(/Mosela Haulage still holds the batch\.$/);
  });

  it.each(["StaleRevision", "Anchor0"])("another handover landed first: %s", (code) => {
    const view = custodyOutcomeView(handoverView("failed", failed(code)), handoverCtx);
    expect(view.lines).toStrictEqual([
      "Another handover of this batch was recorded first. Nothing was recorded for this one. Open the batch again to see who holds it.",
    ]);
    expect(view.refusal).toBe(`Refused by the Thetis program: ${code}`);
    expect(view.primary).toBe("back_home");
  });

  it("a recipient the batch does not allow names the recipient", () => {
    const view = custodyOutcomeView(
      handoverView("failed", failed("RecipientNotApproved")),
      handoverCtx,
    );
    expect(view.lines).toStrictEqual(["Mosela Haulage is not the next holder this batch allows."]);
  });

  it.each([
    "ManifestMismatch",
    "StageOutOfOrder",
    "ShipmentNotOpen",
    "ShipmentIncomplete",
    "DepartureDocumentInvalid",
    "Restricted",
  ])("batch can't move now: %s", (code) => {
    const view = custodyOutcomeView(handoverView("failed", failed(code)), handoverCtx);
    expect(view.lines).toStrictEqual([`This batch can't be handed over now (${code}).`]);
  });

  it("other program errors keep their shared copy", () => {
    expect(
      custodyOutcomeView(handoverView("failed", failed("WrongSigner")), handoverCtx).lines,
    ).toStrictEqual(["A signer's authority does not allow this action."]);
    expect(
      custodyOutcomeView(handoverView("failed", failed("TransactionError")), handoverCtx).lines,
    ).toStrictEqual(["See the transaction on the explorer for the program's message."]);
  });

  it("without a transaction there is nothing on devnet to link", () => {
    const view = custodyOutcomeView(
      handoverView("failed", failed("StaleRevision"), { transaction: null }),
      handoverCtx,
    );
    expect(view.after).toBe("Nothing was recorded.");
    expect(view.transaction).toBeNull();
  });
});

describe("custodyOutcomeView: a failed observation", () => {
  it.each([
    [
      "StaleRevision",
      "Another observation of this batch was recorded first. Prepare the text again.",
    ],
    [
      "ShipmentNotOpen",
      "This batch's shipment was cancelled, so no observation can be recorded for it.",
    ],
    [
      "WrongRole",
      "Mosela Haulage can't record this kind of observation. A border crossing is recorded only by a transporter or a terminal.",
    ],
    [
      "Anchor3012",
      "An authority or record this action needs does not exist on this Thetis instance.",
    ],
    ["InvalidField", "Thetis refused one of the values in this text."],
  ])("%s", (code, line) => {
    const view = custodyOutcomeView(
      observationView("failed", { error: { code, detail: null } }),
      observationCtx,
    );
    expect(view.lines).toStrictEqual([line]);
    expect(view.refusal).toBe(`Refused by the Thetis program: ${code}`);
    expect(view.after).toBe("Nothing was recorded. The refusal is on devnet:");
    expect(view.primary).toBe("edit");
  });

  it("without a transaction there is nothing on devnet to link", () => {
    const view = custodyOutcomeView(
      observationView(
        "failed",
        { error: { code: "StaleRevision", detail: null } },
        { transaction: null },
      ),
      observationCtx,
    );
    expect(view.after).toBe("Nothing was recorded.");
  });
});

describe("custodyOutcomeView: a failed loading", () => {
  it.each([
    [
      "AcceptanceMissing",
      "Not every lender with a lock on this lot has accepted this loading. Ask each lender with a lock on this lot to accept the loading in Thetis. If a loan on this lot is in recovery, the lot can't be loaded until the lender's recovery clears its lock.",
    ],
    [
      "LoanNotActive",
      "A loan on this lot is in recovery; the lot cannot be loaded until it is settled.",
    ],
    ["AcceptanceStale", "This loading can't be recorded now (AcceptanceStale)."],
    ["LoadingExpired", "This loading can't be recorded now (LoadingExpired)."],
    ["LoadingNotOpen", "This loading can't be recorded now (LoadingNotOpen)."],
    ["LotNotStored", "This loading can't be recorded now (LotNotStored)."],
    [
      "StaleRevision",
      "Another change reached this record first. Start again from the current state.",
    ],
  ])("%s", (code, line) => {
    const view = custodyOutcomeView(
      loadingView("failed", { error: { code, detail: null } }),
      loadingCtx,
    );
    expect(view.lines).toStrictEqual([line]);
    expect(view.refusal).toBe(`Refused by the Thetis program: ${code}`);
    expect(view.after).toBe("Nothing was recorded. The refusal is on devnet:");
    expect(view.primary).toBe("back_home");
  });
});

describe("custodyOutcomeView: a confirmed handover", () => {
  it("Departure confirmed: the receiving party holds the batch, and custody passed", () => {
    const view = custodyOutcomeView(handoverView("confirmed"), handoverCtx);
    expect(view.title).toBe("Mosela Haulage holds batch 1 of 1");
    expect(view.lines).toStrictEqual([
      "Custody of CR-0001, 5,000.000 t, passed from Kopano Stockyard Custody to Mosela Haulage. Confirmed on devnet in slot 526,890,114.",
    ]);
    expect(view.issued).toBe(true);
    expect(view.primary).toBe("back_home");
    expect(view.transaction?.signature).toBe(TX_SIGNATURE);
  });

  it("a transfer reads like a departure", () => {
    const view = custodyOutcomeView(handoverView("confirmed"), {
      ...handoverCtx,
      stage: "Transfer",
      from: "Mosela Haulage",
      to: "Second Carrier",
    });
    expect(view.title).toBe("Second Carrier holds batch 1 of 1");
    expect(view.lines).toStrictEqual([
      "Custody of CR-0001, 5,000.000 t, passed from Mosela Haulage to Second Carrier. Confirmed on devnet in slot 526,890,114.",
    ]);
  });

  it("a finalized confirmation says Finalized", () => {
    const view = custodyOutcomeView(
      handoverView("confirmed", { commitment: "finalized" }),
      handoverCtx,
    );
    expect(view.mark).toBe("Finalized");
    expect(view.lines).toStrictEqual([
      "Custody of CR-0001, 5,000.000 t, passed from Kopano Stockyard Custody to Mosela Haulage. Finalized on devnet in slot 526,890,114.",
    ]);
  });

  it("no slot on the view: Confirmed on devnet, with no slot", () => {
    const view = custodyOutcomeView(
      handoverView("confirmed", {}, { confirmedSlot: null, outcome: null }),
      handoverCtx,
    );
    expect(view.lines).toStrictEqual([
      "Custody of CR-0001, 5,000.000 t, passed from Kopano Stockyard Custody to Mosela Haulage. Confirmed on devnet.",
    ]);
  });

  it("Arrival confirmed: the terminal holds the batch, and nothing is said about the lot", () => {
    const ctx: HandoverOutcomeContext = {
      ...handoverCtx,
      org: "Port Terminal T1",
      from: "Mosela Haulage",
      to: "Port Terminal T1",
      stage: "Arrival",
      initiator: false,
    };
    const view = custodyOutcomeView(
      handoverView("confirmed", {
        text: handoverText({ From: "Mosela Haulage", To: "Port Terminal T1", Stage: "Arrival" }),
        holderOrg: MOSELA_ORG,
        nextOrg: PORT_ORG,
      }),
      ctx,
    );
    expect(view.title).toBe("Port Terminal T1 holds batch 1 of 1");
    expect(view.lines).toStrictEqual(["Arrival confirmed on devnet in slot 526,890,114."]);
    expect(view.primary).toBe("back_home");
    expect(view.issued).toBe(true);
  });
});

describe("custodyOutcomeView: a confirmed observation", () => {
  it("Recorded: the border crossing, and who still holds the batch", () => {
    const view = custodyOutcomeView(observationView("confirmed"), observationCtx);
    expect(view.title).toBe("Border crossing recorded");
    expect(view.lines).toStrictEqual([
      "Border crossing recorded for batch 1 of 1. Mosela Haulage still holds it. Confirmed on devnet in slot 526,890,114.",
    ]);
    expect(view.primary).toBe("back_home");
    expect(view.issued).toBe(true);
  });

  it("a finalized confirmation says Finalized", () => {
    const view = custodyOutcomeView(
      observationView("confirmed", {}, { confirmedCommitment: "finalized" }),
      observationCtx,
    );
    expect(view.mark).toBe("Finalized");
    expect(view.lines[0]).toMatch(/Finalized on devnet in slot 526,890,114\.$/);
  });

  it("no slot on the view: Confirmed on devnet, with no slot", () => {
    const view = custodyOutcomeView(
      observationView("confirmed", {}, { confirmedSlot: null, outcome: null }),
      observationCtx,
    );
    expect(view.lines).toStrictEqual([
      "Border crossing recorded for batch 1 of 1. Mosela Haulage still holds it. Confirmed on devnet.",
    ]);
  });
});

describe("custodyOutcomeView: a confirmed loading", () => {
  const confirmed = (data?: Record<string, unknown>) =>
    custodyOutcomeView(loadingView("confirmed", data ? { data } : {}), loadingCtx);

  it("Loaded, debt remains (lot retired): the registry is retired and the lender took the debt", () => {
    const view = confirmed({ lotLoaded: true, loanHandOffs: [{ externalHandoff: true }] });
    expect(view.title).toBe("Registry retired");
    expect(view.lines).toStrictEqual([
      "Registry retired; debt remains recorded; external hand-off accepted by lender. Confirmed on devnet in slot 526,890,114.",
    ]);
    expect(view.primary).toBe("back_home");
    expect(view.issued).toBe(true);
  });

  it("loaded, debt remains, the lot not retired: the position is loaded", () => {
    const view = confirmed({ lotLoaded: false, loanHandOffs: [{ externalHandoff: true }] });
    expect(view.title).toBe("Position loaded");
    expect(view.lines).toStrictEqual([
      "Position loaded; debt remains recorded; external hand-off accepted by lender. Confirmed on devnet in slot 526,890,114.",
    ]);
  });

  it("one hand-off among several that is external is enough for debt", () => {
    const view = confirmed({
      lotLoaded: true,
      loanHandOffs: [{ externalHandoff: false }, { externalHandoff: true }],
    });
    expect(view.title).toBe("Registry retired");
    expect(view.lines[0]).toMatch(/^Registry retired; debt remains recorded;/);
  });

  it.each([
    [[], "no hand-offs"],
    [[{ externalHandoff: false }], "an internal hand-off"],
  ])("loaded, no debt, the lot retired (%j: %s)", (loanHandOffs) => {
    const view = confirmed({ lotLoaded: true, loanHandOffs });
    expect(view.title).toBe("Registry retired");
    expect(view.lines).toStrictEqual([
      "Registry retired. No debt is handed off. Confirmed on devnet in slot 526,890,114.",
    ]);
  });

  it("loaded, no debt, the lot not retired: the position is loaded", () => {
    const view = confirmed({ lotLoaded: false, loanHandOffs: [] });
    expect(view.title).toBe("Position loaded");
    expect(view.lines).toStrictEqual([
      "Position loaded. No debt is handed off. Confirmed on devnet in slot 526,890,114.",
    ]);
  });

  it("a finalized confirmation says Finalized", () => {
    const view = custodyOutcomeView(
      loadingView("confirmed", {
        commitment: "finalized",
        data: { lotLoaded: true, loanHandOffs: [] },
      }),
      loadingCtx,
    );
    expect(view.mark).toBe("Finalized");
    expect(view.lines).toStrictEqual([
      "Registry retired. No debt is handed off. Finalized on devnet in slot 526,890,114.",
    ]);
  });

  it("an outcome the relay could not read is not guessed at", () => {
    const view = custodyOutcomeView(loadingView("confirmed", {}, { outcome: null }), loadingCtx);
    expect(view.title).toBe("Loading recorded");
    expect(view.lines).toStrictEqual([
      "Confirmed on devnet in slot 526,890,114. See the transaction for what was handed off.",
    ]);
    expect(view.issued).toBe(true);
  });

  it.each([
    ["no lotLoaded", { loanHandOffs: [] }],
    ["a lotLoaded that is not a boolean", { lotLoaded: "true", loanHandOffs: [] }],
    ["no loanHandOffs", { lotLoaded: true }],
    ["loanHandOffs that is not a list", { lotLoaded: true, loanHandOffs: "none" }],
    ["an empty outcome", {}],
  ])("%s is read as an unreadable outcome", (_name, data) => {
    const view = confirmed(data);
    expect(view.title).toBe("Loading recorded");
    expect(view.lines).toStrictEqual([
      "Confirmed on devnet in slot 526,890,114. See the transaction for what was handed off.",
    ]);
  });

  it("never says the position is secured by the bill of lading", () => {
    const outcomes: Record<string, unknown>[] = [
      { lotLoaded: true, loanHandOffs: [{ externalHandoff: true }] },
      { lotLoaded: false, loanHandOffs: [{ externalHandoff: true }] },
      { lotLoaded: true, loanHandOffs: [] },
      { lotLoaded: false, loanHandOffs: [] },
      {},
    ];
    for (const data of outcomes) {
      for (const commitment of ["confirmed", "finalized"] as const) {
        const view = custodyOutcomeView(loadingView("confirmed", { data, commitment }), loadingCtx);
        const all = [view.mark, view.title ?? "", ...view.lines, view.after ?? ""].join(" ");
        expect(all).not.toMatch(/secured by the bill of lading/i);
        expect(all).not.toMatch(/bill of lading/i);
      }
    }
  });
});

describe("copy rules in the custody outcome", () => {
  it("no en or em dash in any line, title or refusal, and at most one middle dot", () => {
    for (const [, build, ctx] of KINDS) {
      for (const status of STATUSES) {
        for (const initiator of [true, false]) {
          const view = custodyOutcomeView(build(status), {
            ...ctx,
            initiator,
          } as CustodyOutcomeContext);
          const all = [view.title ?? "", ...view.lines, view.refusal ?? "", view.after ?? ""];
          for (const line of all) {
            expect(line.includes("\u2013"), line).toBe(false);
            expect(line.includes("\u2014"), line).toBe(false);
            expect(line.split("\u00b7").length - 1, line).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });
});

describe("<Outcome> with a custody context", () => {
  const render = (
    command: CommandView,
    context: CustodyOutcomeContext,
    labels?: Partial<Record<"back_home" | "edit" | "renew", string>>,
  ) =>
    textOf(
      <Outcome command={command} context={context} onPrimary={() => {}} labels={labels} />,
    ).join(" ");

  it.each(
    KINDS.flatMap(([kind, build, ctx]) =>
      STATUSES.map((status) => [kind, status, build, ctx] as const),
    ),
  )("%s %s renders the mark and the lines of custodyOutcomeView", (_kind, status, build, ctx) => {
    const view = build(status);
    const text = render(view, ctx);
    const expected = custodyOutcomeView(view, ctx);
    expect(text).toContain(expected.mark);
    for (const line of expected.lines) expect(text).toContain(line);
    if (expected.title) expect(text).toContain(expected.title);
    if (status !== "confirmed") expect(text).not.toMatch(/Confirmed|Finalized/);
  });

  it("links the transaction on the explorer", () => {
    const text = render(handoverView("submitted"), handoverCtx);
    expect(text).toContain(TX_SIGNATURE);
    expect(text).toContain("View on Solana Explorer (devnet)");
  });

  it("the primary action is labelled as the issue screen's, unless the screen names it", () => {
    expect(render(handoverView("expired"), handoverCtx)).toContain("Prepare a new text");
    expect(render(handoverView("confirmed"), handoverCtx)).toContain("Back to home");
    expect(render(handoverView("expired"), handoverCtx, { renew: "Prepare again" })).toContain(
      "Prepare again",
    );
    expect(render(handoverView("expired"), handoverCtx, { renew: "Prepare again" })).not.toContain(
      "Prepare a new text",
    );
    expect(render(handoverView("confirmed"), handoverCtx, { back_home: "Done" })).toContain("Done");
  });

  it("a next holder who may not renew sees no Prepare a new text", () => {
    const text = render(handoverView("expired"), { ...handoverCtx, initiator: false });
    expect(text).not.toContain("Prepare a new text");
    expect(text).toContain("Ask Kopano Stockyard Custody to prepare a new text.");
    expect(text).toContain("Back to home");
  });
});
