// @vitest-environment jsdom
import { transact } from "@solana-mobile/mobile-wallet-adapter-protocol";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, ApiTimeout } from "../../src/api/client";
import type { CommandView } from "../../src/api/commands";
import { Handover } from "../../src/screens/Handover";
import {
  fieldBatch,
  HANDOVER_CODE,
  HANDOVER_ID,
  handoverText,
  handoverView,
  MOSELA_ORG,
  PORT_ORG,
  SIGN_BEFORE,
} from "../custody-fixtures";
import { commandView, TX_SIGNATURE } from "../fixtures";
import { expectBusyBack, renderScreen, WALLET } from "./app";
import {
  button,
  cannotPress,
  enabled,
  installWallet,
  phone,
  rowText,
  SIGNATURE,
  type Who,
} from "./custody-app";

vi.mock("react-native", async () => (await import("./native")).reactNative);
vi.mock("react-native-safe-area-context", async () => (await import("./native")).safeArea);
vi.mock("@solana-mobile/mobile-wallet-adapter-protocol", () => ({ transact: vi.fn() }));
vi.mock("../../src/supabase", () => ({ SupabaseTimeout: class extends Error {} }));
vi.mock("expo-crypto", async () => ({ randomUUID: (await import("node:crypto")).randomUUID }));
vi.mock("expo-image-picker", () => ({}));
vi.mock("expo-document-picker", () => ({}));
vi.mock("expo-file-system", () => ({ File: class {}, Directory: class {}, Paths: {} }));
vi.mock("../../src/data/reads", async (importOriginal) =>
  (await import("../custody-fixtures")).custodyReads(
    await importOriginal<typeof import("../../src/data/reads")>(),
  ),
);

let signMessages: ReturnType<typeof installWallet>;

beforeEach(() => {
  signMessages = installWallet();
});

afterEach(cleanup);

const CLOSING = "Report this. Do not sign a text that does not match what is in front of you.";
const WAITING_FOR_MOSELA = `Waiting for 1 of 2 signatures. You signed; Mosela Haulage has not. Sign before ${SIGN_BEFORE}.`;
const WAITING_FOR_KOPANO = `Waiting for 1 of 2 signatures. You signed; Kopano Stockyard Custody has not. Sign before ${SIGN_BEFORE}.`;
const CONFIRMS =
  "Mosela Haulage takes custody of batch 1 of 1 of CR-0001, 5,000.000 t, from Kopano Stockyard Custody. It does not record the load's condition.";

/** A phone of `who` that reads `view` as the command, with the batch list `batches`. */
async function open(who: Who, view: CommandView, batches = [fieldBatch()]) {
  const app = phone(who);
  vi.mocked(app.commands.get).mockResolvedValue(view);
  vi.mocked(app.field.batches).mockResolvedValue(batches);
  const harness = await renderScreen(<Handover commandId={HANDOVER_ID} />, app);
  return { app, harness };
}

const press = async (name: string) => act(async () => fireEvent.click(await enabled(name)));

describe("busy while signing (navigation.md §4.4)", () => {
  it("marks the app busy while the signature is sending, and Back does nothing", async () => {
    const { app } = await open("mosela", handoverView("awaiting_signatures"), []);
    vi.mocked(app.commands.sign).mockReturnValue(new Promise(() => {}));
    await press("Sign in your wallet");
    await expectBusyBack(app);
  });
});

describe("the next holder's phone: Take custody", () => {
  it("shows who hands over to whom, the load, the stage and what the signature confirms", async () => {
    const view = handoverView("awaiting_signatures");
    await open("mosela", view, []);
    await screen.findByText("Take custody");
    expect(rowText("From")).toContain("Kopano Stockyard Custody");
    expect(rowText("To")).toContain("Mosela Haulage");
    const load = rowText("Load");
    expect(load).toContain("CR-0001, batch 1 of 1");
    expect(load).toContain("5,000.000 t");
    const stage = rowText("Stage");
    expect(stage).toContain("Departure");
    expect(stage).toContain("Manifest 44444444");
    expect(screen.getByText("What this signature confirms")).toBeTruthy();
    expect(screen.getByText(CONFIRMS)).toBeTruthy();
    expect(screen.getByText("Kopano Stockyard Custody has not signed yet.")).toBeTruthy();
  });

  it("shows the exact text, its byte line, and that it matches", async () => {
    const view = handoverView("awaiting_signatures");
    await open("mosela", view, []);
    await screen.findByText("Take custody");
    const bytes = Buffer.from(view.text?.messageBase64 ?? "", "base64").length;
    const sha = view.text?.messageSha256.slice(0, 8);
    expect(document.body.textContent).toContain("Action: Hand over custody");
    expect(document.body.textContent).toContain("Stage: Departure");
    expect(
      screen.getByText(`${bytes} bytes, UTF-8. SHA-256 ${sha}. Sign before ${SIGN_BEFORE}.`),
    ).toBeTruthy();
    expect(screen.getByText("Matches what you entered: yes")).toBeTruthy();
  });

  it("has no code to show: the next holder opens the command from Waiting for you", async () => {
    await open("mosela", handoverView("awaiting_signatures"), []);
    await screen.findByText("Take custody");
    expect(screen.queryByText(/^Code /)).toBeNull();
    expect(screen.queryByText(/^Show this to/)).toBeNull();
  });

  it("a stage of Arrival is Arrival at the terminal", async () => {
    const view = handoverView("awaiting_signatures", {
      text: handoverText({ From: "Mosela Haulage", To: "Port Terminal T1", Stage: "Arrival" }),
      holderOrg: MOSELA_ORG,
      nextOrg: PORT_ORG,
    });
    await open("port", view, []);
    await screen.findByText("Arrival at Port Terminal T1");
    expect(rowText("Stage")).toContain("Arrival");
    await enabled("Sign in your wallet");
  });

  it("signs as next_holder with the exact SHA-256, then waits for the holder", async () => {
    const view = handoverView("awaiting_signatures");
    const { app } = await open("mosela", view, []);
    vi.mocked(app.commands.sign).mockResolvedValue(
      handoverView("awaiting_signatures", { nextSigned: true }),
    );
    await press("Sign in your wallet");
    await waitFor(() => expect(app.commands.sign).toHaveBeenCalledOnce());
    expect(app.commands.sign).toHaveBeenCalledWith(HANDOVER_ID, {
      role: "next_holder",
      wallet: WALLET,
      messageSha256: view.text?.messageSha256,
      signature: SIGNATURE,
    });
    expect(signMessages).toHaveBeenCalledOnce();
    expect(signMessages.mock.calls[0]?.[0].payloads).toStrictEqual([view.text?.messageBase64]);
    await screen.findByText(WAITING_FOR_KOPANO);
    expect(button("Sign in your wallet")).toBeNull();
    expect(screen.getAllByText("Awaiting signatures").length).toBeGreaterThan(0);
  });
});

describe("the holder's phone: Hand over to", () => {
  it("shows the code to read aloud, who it is for, and what the signature confirms", async () => {
    await open("kopano", handoverView("awaiting_signatures"));
    await screen.findByText("Hand over to Mosela Haulage");
    expect(screen.getByText("Show this to Mosela Haulage")).toBeTruthy();
    expect(screen.getByText(`Code ${HANDOVER_CODE}`)).toBeTruthy();
    expect(
      screen.getByText("Mosela Haulage opens it from Waiting for you. Nothing is signed yet."),
    ).toBeTruthy();
    expect(
      screen.getByText("Check the name matches the driver and company in front of you."),
    ).toBeTruthy();
    expect(screen.getByText("What this signature confirms")).toBeTruthy();
    expect(screen.getByText(CONFIRMS)).toBeTruthy();
    expect(rowText("From")).toContain("Kopano Stockyard Custody");
    expect(rowText("To")).toContain("Mosela Haulage");
    expect(rowText("Load")).toContain("CR-0001, batch 1 of 1");
    expect(rowText("Stage")).toContain("Manifest 44444444");
    expect(screen.getByText("Mosela Haulage has not signed yet.")).toBeTruthy();
    expect(screen.getByText("Matches what you entered: yes")).toBeTruthy();
  });

  it("signs as holder, then waits for the other signature", async () => {
    const view = handoverView("awaiting_signatures");
    const { app } = await open("kopano", view);
    vi.mocked(app.commands.sign).mockResolvedValue(
      handoverView("awaiting_signatures", { holderSigned: true }),
    );
    await press("Sign in your wallet");
    await waitFor(() => expect(app.commands.sign).toHaveBeenCalledOnce());
    expect(app.commands.sign).toHaveBeenCalledWith(HANDOVER_ID, {
      role: "holder",
      wallet: WALLET,
      messageSha256: view.text?.messageSha256,
      signature: SIGNATURE,
    });
    await screen.findByText(WAITING_FOR_MOSELA);
    expect(button("Sign in your wallet")).toBeNull();
  });

  it("waiting for the other signature: a command this phone already signed is not signed again", async () => {
    await open("kopano", handoverView("awaiting_signatures", { holderSigned: true }));
    await screen.findByText(WAITING_FOR_MOSELA);
    expect(button("Sign in your wallet")).toBeNull();
    expect(screen.getAllByText("Awaiting signatures").length).toBeGreaterThan(0);
    expect(transact).not.toHaveBeenCalled();
  });

  it("reads the batch once for the names and quantity it checks the text against", async () => {
    const { app } = await open("kopano", handoverView("awaiting_signatures"));
    await enabled("Sign in your wallet");
    expect(app.field.batches).toHaveBeenCalledTimes(1);
    expect(app.commands.get).toHaveBeenCalledWith(HANDOVER_ID);
  });

  it("the batch is not on the list: the holder's check is unreadable, never the command's own fields", async () => {
    await open("kopano", handoverView("awaiting_signatures"), []);
    await screen.findByText("Line 0, Text");
    expect(screen.getByText("Expected a handover text for this batch")).toBeTruthy();
    expect(screen.getByText("Matches what you entered: no")).toBeTruthy();
    expect(screen.queryByText("Matches what you entered: yes")).toBeNull();
    expect(cannotPress("Sign in your wallet")).toBe(true);
    expect(transact).not.toHaveBeenCalled();
  });

  it("the batch list fails to read: a self-consistent text to a wrong recipient is unreadable, never a match", async () => {
    const app = phone("kopano");
    vi.mocked(app.commands.get).mockResolvedValue(
      handoverView("awaiting_signatures", { text: handoverText({ To: "Someone Else" }) }),
    );
    vi.mocked(app.field.batches).mockRejectedValue(new Error("batches unavailable"));
    await renderScreen(<Handover commandId={HANDOVER_ID} />, app);
    await screen.findByText("Line 0, Text");
    expect(screen.getByText("Matches what you entered: no")).toBeTruthy();
    expect(screen.queryByText("Matches what you entered: yes")).toBeNull();
    expect(cannotPress("Sign in your wallet")).toBe(true);
    expect(transact).not.toHaveBeenCalled();
    expect(signMessages).not.toHaveBeenCalled();
  });

  it("a text whose To is not the batch's next holder never opens the wallet", async () => {
    const view = handoverView("awaiting_signatures", {
      text: handoverText({ To: "Someone Else" }),
    });
    await open("kopano", view);
    await screen.findByText("Line 11, To");
    expect(screen.getByText("Expected Mosela Haulage")).toBeTruthy();
    expect(screen.getByText("Received Someone Else")).toBeTruthy();
    expect(screen.getByText(CLOSING)).toBeTruthy();
    expect(screen.getByText("Matches what you entered: no")).toBeTruthy();
    expect(cannotPress("Sign in your wallet")).toBe(true);
    expect(transact).not.toHaveBeenCalled();
  });

  it("a text whose From is not the batch's holder never opens the wallet", async () => {
    const view = handoverView("awaiting_signatures", {
      text: handoverText({ From: "Someone Else" }),
    });
    await open("kopano", view);
    await screen.findByText("Line 10, From");
    expect(screen.getByText("Expected Kopano Stockyard Custody")).toBeTruthy();
    expect(transact).not.toHaveBeenCalled();
  });

  it("a text whose Quantity is not the batch's never opens the wallet", async () => {
    const view = handoverView("awaiting_signatures", {
      text: handoverText({ Quantity: "4,000.000 t" }),
    });
    await open("kopano", view);
    await screen.findByText("Line 9, Quantity");
    expect(screen.getByText("Expected 5,000.000 t")).toBeTruthy();
    expect(screen.getByText("Received 4,000.000 t")).toBeTruthy();
    expect(transact).not.toHaveBeenCalled();
  });

  it("a text whose Stage is not one of the three words never opens the wallet", async () => {
    const view = handoverView("awaiting_signatures", {
      text: handoverText({ Stage: "Loading" }),
    });
    await open("kopano", view);
    await screen.findByText("Line 12, Stage");
    expect(screen.getByText("Expected Departure, Arrival or Transfer")).toBeTruthy();
    expect(screen.getByText("Received Loading")).toBeTruthy();
    expect(transact).not.toHaveBeenCalled();
  });
});

describe("the next holder's phone: a text for someone else", () => {
  it("a text whose To differs never opens the wallet", async () => {
    const view = handoverView("awaiting_signatures", {
      text: handoverText({ To: "Port Terminal T1" }),
    });
    await open("mosela", view, []);
    await screen.findByText("Line 11, To");
    expect(screen.getByText("Expected Mosela Haulage")).toBeTruthy();
    expect(screen.getByText("Received Port Terminal T1")).toBeTruthy();
    expect(screen.getByText(CLOSING)).toBeTruthy();
    expect(cannotPress("Sign in your wallet")).toBe(true);
    expect(transact).not.toHaveBeenCalled();
    expect(signMessages).not.toHaveBeenCalled();
  });
});

describe("not a signer here, and not visible", () => {
  it("not a signer here: this phone's organisation is not named, so the wallet never opens", async () => {
    const { app } = await open("port", handoverView("awaiting_signatures"), []);
    await screen.findByText("This phone's organisation is not a signer of this command.");
    expect(cannotPress("Sign in your wallet")).toBe(true);
    expect(transact).not.toHaveBeenCalled();
    expect(app.commands.sign).not.toHaveBeenCalled();
  });

  it("command not visible: a 404 says Thetis can't find it or it is not one of yours", async () => {
    const app = phone("mosela");
    vi.mocked(app.commands.get).mockRejectedValue(new ApiError(404, "NOT_FOUND", "", null));
    await renderScreen(<Handover commandId={HANDOVER_ID} />, app);
    await screen.findByText("Thetis can't find this command, or it is not one of yours.");
    expect(cannotPress("Sign in your wallet")).toBe(true);
    expect(transact).not.toHaveBeenCalled();
  });

  it("a command that is not a handover is an unexpected answer, and never signed", async () => {
    await open("kopano", commandView("awaiting_signatures"), []);
    await screen.findByText(/\(UNEXPECTED_ANSWER\)/);
    expect(cannotPress("Sign in your wallet")).toBe(true);
    expect(transact).not.toHaveBeenCalled();
  });

  it("another Thetis instance: the wallet is never opened", async () => {
    await open(
      "kopano",
      handoverView("awaiting_signatures", {}, { protocol: "11111111111111111111111111111111" }),
    );
    await screen.findByText(/another Thetis instance than the one this phone is reading/);
    expect(screen.getByText(/Your wallet was not opened\./)).toBeTruthy();
    expect(cannotPress("Sign in your wallet")).toBe(true);
    expect(transact).not.toHaveBeenCalled();
  });
});

describe("how it ends", () => {
  it("wrong driver refused: the Anchor3012 line, who still holds the batch, and the failed transaction", async () => {
    await open(
      "mosela",
      handoverView("failed", { error: { code: "Anchor3012", detail: null } }),
      [],
    );
    await screen.findByText(
      "An authority or record this action needs does not exist on this Thetis instance. Kopano Stockyard Custody still holds the batch.",
    );
    expect(screen.getByText("Refused by the Thetis program: Anchor3012")).toBeTruthy();
    expect(screen.getByText("Nothing was recorded. The refusal is on devnet:")).toBeTruthy();
    expect(screen.getByText(TX_SIGNATURE)).toBeTruthy();
    expect(screen.getByText("View on Solana Explorer (devnet)")).toBeTruthy();
    expect(screen.getAllByText("Failed").length).toBeGreaterThan(0);
    expect(button("Sign in your wallet")).toBeNull();
  });

  it("another handover landed first: StaleRevision says nothing was recorded for this one", async () => {
    await open(
      "kopano",
      handoverView("failed", { error: { code: "StaleRevision", detail: null } }),
    );
    await screen.findByText(
      "Another handover of this batch was recorded first. Nothing was recorded for this one. Open the batch again to see who holds it.",
    );
    expect(screen.getByText("Refused by the Thetis program: StaleRevision")).toBeTruthy();
  });

  it("another handover landed first: Anchor0 reads the same", async () => {
    await open("kopano", handoverView("failed", { error: { code: "Anchor0", detail: null } }));
    await screen.findByText(
      "Another handover of this batch was recorded first. Nothing was recorded for this one. Open the batch again to see who holds it.",
    );
  });

  it("batch can't move now: the program's refusal names its code", async () => {
    await open(
      "kopano",
      handoverView("failed", { error: { code: "ManifestMismatch", detail: null } }),
    );
    await screen.findByText("This batch can't be handed over now (ManifestMismatch).");
  });

  it("expired before both signed: the next holder is told to ask the holder, with no way to renew", async () => {
    const { app } = await open("mosela", handoverView("expired"), []);
    await screen.findByText(
      `This text expired at ${SIGN_BEFORE} before both of you signed. Nothing was sent.`,
    );
    expect(screen.getByText("Ask Kopano Stockyard Custody to prepare a new text.")).toBeTruthy();
    expect(button("Prepare a new text")).toBeNull();
    expect(button("Back to home")).not.toBeNull();
    expect(app.commands.renew).not.toHaveBeenCalled();
  });

  it("expired before both signed: the holder may prepare a new text, and signs it", async () => {
    const { app } = await open("kopano", handoverView("expired"));
    await screen.findByText(
      `This text expired at ${SIGN_BEFORE} before both of you signed. Nothing was sent.`,
    );
    expect(screen.queryByText(/^Ask /)).toBeNull();
    vi.mocked(app.commands.renew).mockResolvedValue(handoverView("awaiting_signatures"));
    await press("Prepare a new text");
    await waitFor(() => expect(app.commands.renew).toHaveBeenCalledWith(HANDOVER_ID));
    await enabled("Sign in your wallet");
    expect(app.commands.create).not.toHaveBeenCalled();
  });

  it("Departure confirmed: the next holder holds the batch", async () => {
    const { app } = await open("mosela", handoverView("confirmed"), []);
    await screen.findByText("Mosela Haulage holds batch 1 of 1");
    expect(
      screen.getByText(
        "Custody of CR-0001, 5,000.000 t, passed from Kopano Stockyard Custody to Mosela Haulage. Confirmed on devnet in slot 526,890,114.",
      ),
    ).toBeTruthy();
    expect(screen.getAllByText("Confirmed").length).toBeGreaterThan(0);
    expect(screen.getByText(TX_SIGNATURE)).toBeTruthy();
    await act(async () => fireEvent.click(await enabled("Back to home")));
    expect(app.navigate).toHaveBeenCalledWith({ name: "home" });
  });

  it("Departure confirmed: the holder's phone says the same", async () => {
    await open("kopano", handoverView("confirmed"));
    await screen.findByText("Mosela Haulage holds batch 1 of 1");
  });

  it("Arrival confirmed: the terminal holds the batch, and nothing is said about the lot", async () => {
    await open(
      "port",
      handoverView("confirmed", {
        text: handoverText({ From: "Mosela Haulage", To: "Port Terminal T1", Stage: "Arrival" }),
        holderOrg: MOSELA_ORG,
        nextOrg: PORT_ORG,
      }),
      [],
    );
    await screen.findByText("Port Terminal T1 holds batch 1 of 1");
    expect(screen.getByText("Arrival confirmed on devnet in slot 526,890,114.")).toBeTruthy();
  });

  it("submitted: waiting for confirmation, and nothing signable", async () => {
    await open("kopano", handoverView("submitted"));
    await screen.findByText("Thetis sent the handover to devnet. Waiting for confirmation.");
    expect(button("Sign in your wallet")).toBeNull();
    expect(screen.getAllByText("Submitted, unconfirmed").length).toBeGreaterThan(0);
  });

  it("outcome unknown: says not to treat the load as handed over", async () => {
    await open("mosela", handoverView("outcome_unknown"), []);
    await screen.findByText(
      "Thetis sent this handover but has no answer from devnet yet. Do not treat the load as handed over. Thetis keeps checking.",
    );
  });
});

describe("signing, as the other screens sign", () => {
  it("a wallet that closes without signing: nothing was signed or sent, and it can be tried again", async () => {
    const { app } = await open("mosela", handoverView("awaiting_signatures"), []);
    signMessages.mockRejectedValueOnce(new Error("closed"));
    await press("Sign in your wallet");
    await screen.findByText(
      `Your wallet closed without signing. Nothing was signed or sent. You can sign this text until ${SIGN_BEFORE}.`,
    );
    expect(app.commands.sign).not.toHaveBeenCalled();
    await enabled("Sign in your wallet");
  });

  it("a wallet account that is not the linked one: says which to choose", async () => {
    const { app } = await open("mosela", handoverView("awaiting_signatures"), []);
    vi.mocked(transact).mockImplementation(async (callback) =>
      callback({
        authorize: async () => ({
          accounts: [{ address: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }],
          auth_token: "token",
          wallet_uri_base: "https://wallet.example",
        }),
        signMessages,
      } as never),
    );
    await press("Sign in your wallet");
    await screen.findByText(
      /Your wallet did not offer G7sT.+, the wallet linked for Mosela Haulage\./,
    );
    expect(signMessages).not.toHaveBeenCalled();
    expect(app.commands.sign).not.toHaveBeenCalled();
  });

  it("a relay refusal of the signature shows its copy and keeps the sign button", async () => {
    const { app } = await open("kopano", handoverView("awaiting_signatures"));
    vi.mocked(app.commands.sign).mockRejectedValue(
      new ApiError(403, "AUTHORITY_INVALID", "", "SHIP"),
    );
    await press("Sign in your wallet");
    await screen.findByText(
      "Thetis did not send this: this wallet has no current authority for Kopano Stockyard Custody that allows this action (SHIP).",
    );
    await enabled("Sign in your wallet");
  });

  it("an expired session opens sign in again", async () => {
    const { app } = await open("kopano", handoverView("awaiting_signatures"));
    vi.mocked(app.commands.sign).mockRejectedValue(
      new ApiError(401, "NOT_AUTHENTICATED", "", null),
    );
    await press("Sign in your wallet");
    await waitFor(() => expect(app.sessionExpired).toHaveBeenCalled());
  });

  it("a signature that may not have landed is read before it is offered again", async () => {
    const view = handoverView("awaiting_signatures");
    const { app } = await open("mosela", view, []);
    vi.mocked(app.commands.sign).mockRejectedValueOnce(new ApiTimeout());
    vi.mocked(app.commands.sign).mockResolvedValue(
      handoverView("awaiting_signatures", { nextSigned: true }),
    );
    await press("Sign in your wallet");
    await screen.findByText(
      `Your signature was not sent. Send it again before ${SIGN_BEFORE}. If you leave this screen, you will need to sign again.`,
    );
    await press("Send signature");
    await screen.findByText(WAITING_FOR_KOPANO);
    expect(app.commands.sign).toHaveBeenCalledTimes(2);
    expect(signMessages).toHaveBeenCalledOnce();
  });

  it("a held signature is not sent once the text has changed", async () => {
    const view = handoverView("awaiting_signatures");
    // After the lost reply the relay shows a renewed text, still unsigned.
    const renewed = handoverView("awaiting_signatures", { text: handoverText({ Sequence: "1" }) });
    const { app } = await open("mosela", view, []);
    vi.mocked(app.commands.sign).mockRejectedValue(new ApiTimeout());
    vi.mocked(app.commands.get).mockImplementation(async () =>
      vi.mocked(app.commands.sign).mock.calls.length > 0 ? renewed : view,
    );
    await press("Sign in your wallet");
    await press("Send signature");
    await screen.findByText(
      "The text changed after you signed it. Your signature was not sent. Sign the new text.",
    );
    expect(app.commands.sign).toHaveBeenCalledTimes(1);
  });

  it("never signs a view swapped in after render, before the tap", async () => {
    const view = handoverView("awaiting_signatures");
    const { app } = await open("mosela", view, []);
    const sign = await enabled("Sign in your wallet");
    // The object the screen holds changes under it, with no render in between.
    const other = handoverText({ To: "Someone Else" });
    if (!view.text) throw new Error("fixture has a text");
    view.text.messageBase64 = Buffer.from(other).toString("base64");
    await act(async () => fireEvent.click(sign));
    expect(transact).not.toHaveBeenCalled();
    expect(signMessages).not.toHaveBeenCalled();
    expect(app.commands.sign).not.toHaveBeenCalled();
  });

  it("asks nothing when the fresh view read just before signing does not match", async () => {
    const view = handoverView("awaiting_signatures");
    const { app } = await open("mosela", view, []);
    const sign = await enabled("Sign in your wallet");
    const fresh = handoverView("awaiting_signatures");
    // The same SHA-256 claimed, other bytes: the claimed digest no longer matches the text.
    if (!fresh.text) throw new Error("fixture has a text");
    fresh.text.messageBase64 = Buffer.from(handoverText({ To: "Someone Else" })).toString("base64");
    vi.mocked(app.commands.get).mockResolvedValue(fresh);
    await act(async () => fireEvent.click(sign));
    await screen.findByText(/The text changed before your wallet opened/);
    expect(signMessages).not.toHaveBeenCalled();
    expect(app.commands.sign).not.toHaveBeenCalled();
  });
});

describe("Offline", () => {
  it("says a handover needs both phones online, and does not sign", async () => {
    const view = handoverView("awaiting_signatures");
    const app = phone("mosela", { online: false });
    vi.mocked(app.commands.get).mockResolvedValue(view);
    await renderScreen(<Handover commandId={HANDOVER_ID} />, app);
    await screen.findByText(
      "Offline. A handover needs both phones online at the moment you sign. Nothing was recorded.",
    );
    expect(cannotPress("Sign in your wallet")).toBe(true);
    expect(transact).not.toHaveBeenCalled();
    expect(app.commands.sign).not.toHaveBeenCalled();
  });

  it("going offline disables Sign in your wallet, and coming back enables it", async () => {
    const { harness } = await open("mosela", handoverView("awaiting_signatures"), []);
    await enabled("Sign in your wallet");
    harness.setOnline(false);
    await screen.findByText(
      "Offline. A handover needs both phones online at the moment you sign. Nothing was recorded.",
    );
    expect(cannotPress("Sign in your wallet")).toBe(true);
    harness.setOnline(true);
    await enabled("Sign in your wallet");
  });
});
