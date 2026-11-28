// @vitest-environment jsdom
import { transact } from "@solana-mobile/mobile-wallet-adapter-protocol";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, ApiTimeout } from "../../src/api/client";
import type { CommandView } from "../../src/api/commands";
import { readOpenLoadingCommand } from "../../src/data/reads";
import { formatSast } from "../../src/format";
import { Loading } from "../../src/screens/Loading";
import { Loadings } from "../../src/screens/Loadings";
import {
  addr,
  handoverView,
  INTENT_ADDRESS,
  KHUNOU_ORG,
  LOADING_ID,
  LOAN_ONE,
  LOAN_TWO,
  lenderOneAccepted,
  lenderTwoMissing,
  lenderTwoStale,
  loadingIntent,
  loadingText,
  loadingView,
  NOW_UNIX,
  PORT_ORG,
  SIGN_BEFORE,
} from "../custody-fixtures";
import { PROTOCOL } from "../fixtures";
import { expectBusyBack, renderScreen, WALLET } from "./app";
import {
  button,
  cannotPress,
  enabled,
  installWallet,
  phone,
  rowText,
  SIGNATURE,
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
  // Only the clock is faked: an intent's expiry is read against it, and nothing else waits on it.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Number(NOW_UNIX) * 1_000);
  signMessages = installWallet();
  vi.mocked(readOpenLoadingCommand).mockReset();
  vi.mocked(readOpenLoadingCommand).mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** "2026-11-28 17:00 SAST": the minute an intent expires, as the screen prints it. */
const minute = (unix: bigint) => formatSast(unix).replace(/:\d\d SAST$/, " SAST");
const EXPIRES = NOW_UNIX + 18_000n;

const WAITING_FOR_OWNER = `Waiting for 1 of 2 signatures. You signed; Khunou Ore Exports signs on the web before ${SIGN_BEFORE}.`;

async function openLoading(
  intents = [loadingIntent()],
  overrides: Parameters<typeof phone>[1] = {},
) {
  const app = phone("port", overrides);
  vi.mocked(app.field.loadingIntents).mockResolvedValue(intents);
  const harness = await renderScreen(<Loading intent={INTENT_ADDRESS} />, app);
  return { app, harness };
}

/** The intent's page, once its rows are on screen. */
async function openDetail(
  intents = [loadingIntent()],
  overrides: Parameters<typeof phone>[1] = {},
) {
  const opened = await openLoading(intents, overrides);
  await screen.findByText("Loading document");
  return opened;
}

const press = async (name: string) => act(async () => fireEvent.click(await enabled(name)));

describe("Loadings at your terminal", () => {
  it("lists an open intent: the lot, the quantity for the owner, and how many lenders accepted", async () => {
    const app = phone("port");
    vi.mocked(app.field.loadingIntents).mockResolvedValue([
      loadingIntent({ acceptances: [lenderOneAccepted, lenderTwoMissing] }),
    ]);
    await renderScreen(<Loadings />, app);
    await screen.findByText("CR-0001");
    expect(screen.getByText("Loadings at your terminal")).toBeTruthy();
    expect(screen.getByText("3,000.000 t for Khunou Ore Exports")).toBeTruthy();
    expect(screen.getByText("Intent 1, 1 of 2 lenders accepted")).toBeTruthy();
    expect(screen.getByText("Open")).toBeTruthy();
    expect(app.field.loadingIntents).toHaveBeenCalledWith(PORT_ORG);
  });

  it("is the Loadings tab root: the tab bar, and no Back", async () => {
    const app = phone("port");
    await renderScreen(<Loadings />, app);
    await screen.findByText(/^No open loading intents at/);
    expect(screen.getByRole("tablist")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });

  it("an intent with no lenders reads 0 of 0 lenders accepted", async () => {
    const app = phone("port");
    vi.mocked(app.field.loadingIntents).mockResolvedValue([loadingIntent({ acceptances: [] })]);
    await renderScreen(<Loadings />, app);
    await screen.findByText("Intent 1, 0 of 0 lenders accepted");
  });

  it("tapping an intent opens it", async () => {
    const app = phone("port");
    vi.mocked(app.field.loadingIntents).mockResolvedValue([loadingIntent()]);
    await renderScreen(<Loadings />, app);
    await act(async () => fireEvent.click(await screen.findByText("CR-0001")));
    expect(app.navigate).toHaveBeenCalledWith({ name: "loading", intent: INTENT_ADDRESS });
  });

  it("no open loadings: says the owner prepares one on the web with the bill of lading", async () => {
    const app = phone("port");
    await renderScreen(<Loadings />, app);
    await screen.findByText(
      "No open loading intents at Port Terminal T1. The owner prepares one on the web with the bill of lading.",
    );
  });

  it("loadings failed to load: says nothing changed, and Retry reads again", async () => {
    const app = phone("port");
    vi.mocked(app.field.loadingIntents).mockRejectedValueOnce(new ApiTimeout());
    vi.mocked(app.field.loadingIntents).mockResolvedValue([loadingIntent()]);
    await renderScreen(<Loadings />, app);
    await screen.findByText(
      "Thetis could not load the loadings at your terminal. Nothing changed.",
    );
    await act(async () => fireEvent.click(await enabled("Retry")));
    await screen.findByText("CR-0001");
    expect(app.field.loadingIntents).toHaveBeenCalledTimes(2);
  });

  it("offline: says recording a loading needs a connection", async () => {
    const app = phone("port", { online: false });
    await renderScreen(<Loadings />, app);
    await screen.findByText(
      "Offline. Recording a loading needs a connection. Nothing was recorded.",
    );
  });
});

describe("Record loading: the intent", () => {
  it("shows the lot, the quantity, the loading document, the expiry and the locked quantity", async () => {
    const other = loadingIntent({ intent: addr(60), lotId: "CR-0002", nonce: "9" });
    await openDetail([other, loadingIntent()]);
    expect(screen.getByText("Record loading")).toBeTruthy();
    const lot = rowText("Lot");
    expect(lot).toContain("CR-0001");
    expect(lot).toContain("Khunou Ore Exports' position");
    expect(rowText("Quantity")).toContain("3,000.000 t");
    const document = rowText("Loading document");
    expect(document).toContain("aaaaaaaa");
    expect(document).toContain(`Intent 1, expires ${minute(EXPIRES)}`);
    expect(rowText("Locked")).toContain("3,000.000 t");
    expect(screen.queryByText("CR-0002")).toBeNull();
  });

  it("an accepted lender: its lock and Accepted", async () => {
    await openDetail();
    expect(screen.getByText("Lender One Bank")).toBeTruthy();
    expect(screen.getByText("Lock 3,000.000 t")).toBeTruthy();
    expect(screen.getByText("Accepted")).toBeTruthy();
    expect(screen.queryByText(/has not accepted/)).toBeNull();
  });

  it("a lender has not accepted: a warning, and Prepare loading text stays enabled", async () => {
    await openDetail([loadingIntent({ acceptances: [lenderOneAccepted, lenderTwoMissing] })]);
    await screen.findByText(
      "Lender Two Bank has not accepted this hand-off. Thetis will refuse the loading until every lender with a lock accepts.",
    );
    expect(screen.getByText("Not accepted")).toBeTruthy();
    expect(screen.getByText("Lock 1,000.000 t")).toBeTruthy();
    expect((await enabled("Prepare loading text")).disabled).toBe(false);
  });

  it("an acceptance is stale: the lender accepted before the loan changed", async () => {
    await openDetail([loadingIntent({ acceptances: [lenderOneAccepted, lenderTwoStale] })]);
    await screen.findByText(
      "Lender Two Bank accepted before the loan changed, so Thetis will refuse the loading until it accepts again.",
    );
    expect(screen.getByText("Accepted before a change")).toBeTruthy();
    expect((await enabled("Prepare loading text")).disabled).toBe(false);
  });

  it("no lenders: says no acceptance is needed", async () => {
    await openDetail([loadingIntent({ acceptances: [] })]);
    await screen.findByText("No lender holds a lock on this position, so no acceptance is needed.");
    expect(screen.queryByText(/has not accepted/)).toBeNull();
    await enabled("Prepare loading text");
  });

  it("intent expired: says when, that the owner prepares a new one, and offers no Prepare", async () => {
    const expiresAt = NOW_UNIX - 60n;
    await openDetail([loadingIntent({ expiresAt: String(expiresAt) })]);
    await screen.findByText(
      `This loading intent expired at ${minute(expiresAt)}. The owner prepares a new one on the web.`,
    );
    expect(button("Prepare loading text")).toBeNull();
  });

  it("an intent that expires this second is expired", async () => {
    await openDetail([loadingIntent({ expiresAt: String(NOW_UNIX) })]);
    await screen.findByText(/^This loading intent expired at /);
    expect(button("Prepare loading text")).toBeNull();
  });

  it("an intent that is not on the list is no longer open", async () => {
    const app = phone("port");
    vi.mocked(app.field.loadingIntents).mockResolvedValue([
      loadingIntent({ intent: addr(60), lotId: "CR-0002" }),
    ]);
    await renderScreen(<Loading intent={INTENT_ADDRESS} />, app);
    await screen.findByText("This loading intent is no longer open.");
    expect(button("Prepare loading text")).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Back" })));
    expect(app.back).toHaveBeenCalledOnce();
  });
});

describe("Prepare loading text: one text per intent (owner decision)", () => {
  it("opens the loading text that is already prepared, and never prepares a second", async () => {
    vi.mocked(readOpenLoadingCommand).mockResolvedValue(LOADING_ID);
    const { app } = await openLoading();
    vi.mocked(app.commands.get).mockResolvedValue(
      loadingView("awaiting_signatures", { ownerSigned: true }),
    );
    await press("Prepare loading text");
    await waitFor(() => expect(app.commands.get).toHaveBeenCalledWith(LOADING_ID));
    expect(readOpenLoadingCommand).toHaveBeenCalledWith(app.db, PROTOCOL, INTENT_ADDRESS);
    expect(app.commands.create).not.toHaveBeenCalled();
    await enabled("Sign in your wallet");
  });

  it("with none prepared, prepares the intent's text for this organisation", async () => {
    const { app } = await openLoading();
    vi.mocked(app.commands.create).mockResolvedValue(loadingView("awaiting_signatures"));
    await press("Prepare loading text");
    await waitFor(() => expect(app.commands.create).toHaveBeenCalledOnce());
    expect(app.commands.create).toHaveBeenCalledWith({
      kind: "record_loading",
      organisationId: PORT_ORG,
      args: { intent: INTENT_ADDRESS },
    });
    expect(readOpenLoadingCommand).toHaveBeenCalledWith(app.db, PROTOCOL, INTENT_ADDRESS);
    expect(app.commands.get).not.toHaveBeenCalled();
    await enabled("Sign in your wallet");
  });

  it("marks the app busy while the signature is sending, and Back does nothing", async () => {
    const { app } = await openLoading();
    vi.mocked(app.commands.create).mockResolvedValue(loadingView("awaiting_signatures"));
    vi.mocked(app.commands.get).mockResolvedValue(loadingView("awaiting_signatures"));
    vi.mocked(app.commands.sign).mockReturnValue(new Promise(() => {}));
    await press("Prepare loading text");
    await press("Sign in your wallet");
    await expectBusyBack(app);
  });

  it("when the check for a prepared text fails, nothing is prepared", async () => {
    vi.mocked(readOpenLoadingCommand).mockRejectedValue(new Error("did not answer"));
    const { app } = await openLoading();
    await press("Prepare loading text");
    await screen.findByText(
      "Thetis could not check for a loading text already prepared. Nothing was sent. Try again.",
    );
    expect(app.commands.create).not.toHaveBeenCalled();
    expect(app.commands.get).not.toHaveBeenCalled();
    expect((await enabled("Prepare loading text")).disabled).toBe(false);
  });

  it("after a failed check, trying again prepares once the check answers", async () => {
    vi.mocked(readOpenLoadingCommand).mockRejectedValueOnce(new Error("did not answer"));
    const { app } = await openLoading();
    vi.mocked(app.commands.create).mockResolvedValue(loadingView("awaiting_signatures"));
    await press("Prepare loading text");
    await screen.findByText(/Thetis could not check for a loading text already prepared/);
    await press("Prepare loading text");
    await waitFor(() => expect(app.commands.create).toHaveBeenCalledOnce());
  });

  it("a relay refusal of a missing acceptance names the lender whose loan it was", async () => {
    const { app } = await openLoading([
      loadingIntent({ acceptances: [lenderOneAccepted, lenderTwoMissing] }),
    ]);
    vi.mocked(app.commands.create).mockRejectedValue(
      new ApiError(409, "ACCEPTANCE_MISSING", "", `loan: ${LOAN_TWO}`),
    );
    await press("Prepare loading text");
    await screen.findByText(
      "Not every lender with a lock on this lot has accepted this loading. Ask Lender Two Bank to accept the loading in Thetis. Nothing was sent.",
    );
  });

  it("a missing acceptance whose loan is not on the list asks each lender with a lock", async () => {
    const { app } = await openLoading();
    vi.mocked(app.commands.create).mockRejectedValue(
      new ApiError(409, "ACCEPTANCE_MISSING", "", `loan: ${addr(77)}`),
    );
    await press("Prepare loading text");
    await screen.findByText(
      "Not every lender with a lock on this lot has accepted this loading. Ask each lender with a lock on this lot to accept the loading in Thetis. Nothing was sent.",
    );
  });

  it("a loan in recovery names its lender", async () => {
    const { app } = await openLoading();
    vi.mocked(app.commands.create).mockRejectedValue(
      new ApiError(409, "LOAN_NOT_ACTIVE", "", `loan: ${LOAN_ONE}`),
    );
    await press("Prepare loading text");
    await screen.findByText(
      "Lender One Bank's loan is in recovery; the lot cannot be loaded until it is settled. Nothing was sent.",
    );
  });

  it("a caller that is neither the owner nor the terminal is told so", async () => {
    const { app } = await openLoading();
    vi.mocked(app.commands.create).mockRejectedValue(new ApiError(403, "NOT_AUTHORISED", "", null));
    await press("Prepare loading text");
    await screen.findByText(
      "Port Terminal T1 is neither the owner nor the terminal of this loading. Nothing was sent.",
    );
  });

  it("a relay that does not answer in time says nothing changed", async () => {
    const { app } = await openLoading();
    vi.mocked(app.commands.create).mockRejectedValue(new ApiTimeout());
    await press("Prepare loading text");
    await screen.findByText(
      "Thetis did not answer in time. Nothing changed on this phone. Try again.",
    );
  });
});

describe("Record loading: review and sign", () => {
  /** Prepares `view` as the intent's text and waits until the screen has taken it. */
  async function prepare(view: CommandView, intents = [loadingIntent()]) {
    const opened = await openDetail(intents);
    vi.mocked(opened.app.commands.create).mockResolvedValue(view);
    vi.mocked(opened.app.commands.get).mockResolvedValue(view);
    await press("Prepare loading text");
    await waitFor(() => expect(button("Prepare loading text")).toBeNull());
    return opened;
  }

  async function prepared(view: CommandView = loadingView("awaiting_signatures")) {
    const opened = await prepare(view);
    await enabled("Sign in your wallet");
    return opened;
  }

  it("shows the text, that the owner signs the same text on the web, and that it matches", async () => {
    const view = loadingView("awaiting_signatures");
    await prepared(view);
    expect(screen.getByText("Khunou Ore Exports signs the same text on the web.")).toBeTruthy();
    expect(document.body.textContent).toContain("Action: Record loading");
    expect(screen.getByText("Matches what you entered: yes")).toBeTruthy();
    const bytes = Buffer.from(view.text?.messageBase64 ?? "", "base64").length;
    const sha = view.text?.messageSha256.slice(0, 8);
    expect(
      screen.getByText(`${bytes} bytes, UTF-8. SHA-256 ${sha}. Sign before ${SIGN_BEFORE}.`),
    ).toBeTruthy();
  });

  it("signs as terminal with the exact SHA-256, then waits for the owner", async () => {
    const view = loadingView("awaiting_signatures");
    const { app } = await prepared(view);
    vi.mocked(app.commands.sign).mockResolvedValue(
      loadingView("awaiting_signatures", { terminalSigned: true }),
    );
    await press("Sign in your wallet");
    await waitFor(() => expect(app.commands.sign).toHaveBeenCalledOnce());
    expect(app.commands.sign).toHaveBeenCalledWith(LOADING_ID, {
      role: "terminal",
      wallet: WALLET,
      messageSha256: view.text?.messageSha256,
      signature: SIGNATURE,
    });
    expect(signMessages).toHaveBeenCalledOnce();
    await screen.findByText(WAITING_FOR_OWNER);
    expect(button("Sign in your wallet")).toBeNull();
    expect(screen.getAllByText("Awaiting signatures").length).toBeGreaterThan(0);
  });

  it("waiting for the owner: a text this phone already signed is not signed again", async () => {
    vi.mocked(readOpenLoadingCommand).mockResolvedValue(LOADING_ID);
    const { app } = await openDetail();
    vi.mocked(app.commands.get).mockResolvedValue(
      loadingView("awaiting_signatures", { terminalSigned: true }),
    );
    await press("Prepare loading text");
    await screen.findByText(WAITING_FOR_OWNER);
    expect(button("Sign in your wallet")).toBeNull();
    expect(transact).not.toHaveBeenCalled();
  });

  it("a text whose Loan acceptances count is not the accepted lenders' never opens the wallet", async () => {
    const { app } = await prepare(
      loadingView("awaiting_signatures", { text: loadingText({ "Loan acceptances": "2" }) }),
    );
    await screen.findByText("Line 13, Loan acceptances");
    expect(screen.getByText("Expected 1")).toBeTruthy();
    expect(screen.getByText("Received 2")).toBeTruthy();
    expect(screen.getByText("Matches what you entered: no")).toBeTruthy();
    expect(cannotPress("Sign in your wallet")).toBe(true);
    expect(transact).not.toHaveBeenCalled();
    expect(app.commands.sign).not.toHaveBeenCalled();
  });

  it("a lender accepts after the first read: the intent is read again for the text, and it matches", async () => {
    const lenderTwoAccepted = { ...lenderTwoMissing, state: "accepted" as const };
    const app = phone("port");
    vi.mocked(app.field.loadingIntents)
      .mockResolvedValueOnce([
        loadingIntent({ acceptances: [lenderOneAccepted, lenderTwoMissing] }),
      ])
      .mockResolvedValue([loadingIntent({ acceptances: [lenderOneAccepted, lenderTwoAccepted] })]);
    await renderScreen(<Loading intent={INTENT_ADDRESS} />, app);
    await screen.findByText("Loading document");
    const view = loadingView("awaiting_signatures", {
      text: loadingText({ "Loan acceptances": "2" }),
    });
    vi.mocked(app.commands.create).mockResolvedValue(view);
    vi.mocked(app.commands.get).mockResolvedValue(view);
    await press("Prepare loading text");
    await enabled("Sign in your wallet");
    expect(screen.getByText("Matches what you entered: yes")).toBeTruthy();
    expect(app.field.loadingIntents).toHaveBeenCalledTimes(2);
  });

  it("a failing check offers Check again, which reads the intent again and passes once it agrees", async () => {
    const lenderTwoAccepted = { ...lenderTwoMissing, state: "accepted" as const };
    const app = phone("port");
    const oneOfTwo = [loadingIntent({ acceptances: [lenderOneAccepted, lenderTwoMissing] })];
    vi.mocked(app.field.loadingIntents)
      .mockResolvedValueOnce(oneOfTwo)
      .mockResolvedValueOnce(oneOfTwo)
      .mockResolvedValue([loadingIntent({ acceptances: [lenderOneAccepted, lenderTwoAccepted] })]);
    await renderScreen(<Loading intent={INTENT_ADDRESS} />, app);
    await screen.findByText("Loading document");
    const view = loadingView("awaiting_signatures", {
      text: loadingText({ "Loan acceptances": "2" }),
    });
    vi.mocked(app.commands.create).mockResolvedValue(view);
    vi.mocked(app.commands.get).mockResolvedValue(view);
    await press("Prepare loading text");
    await screen.findByText("Matches what you entered: no");
    expect(button("Back to home")).not.toBeNull();
    await press("Check again");
    await enabled("Sign in your wallet");
    expect(screen.getByText("Matches what you entered: yes")).toBeTruthy();
    expect(app.field.loadingIntents).toHaveBeenCalledTimes(3);
  });

  it("a text for another terminal never opens the wallet", async () => {
    await prepare(
      loadingView("awaiting_signatures", { text: loadingText({ Terminal: "Port Terminal T2" }) }),
    );
    await screen.findByText("Line 9, Terminal");
    expect(screen.getByText("Expected Port Terminal T1")).toBeTruthy();
    expect(screen.getByText("Received Port Terminal T2")).toBeTruthy();
    expect(
      screen.getByText(
        "Report this. Do not sign a text that does not match what is in front of you.",
      ),
    ).toBeTruthy();
    expect(transact).not.toHaveBeenCalled();
  });

  it("a text for another loading document or owner never opens the wallet", async () => {
    await prepare(
      loadingView("awaiting_signatures", {
        text: loadingText({ "Loading document": "bb".repeat(32), Owner: "Someone Else" }),
      }),
    );
    await screen.findByText("Line 10, Loading document");
    expect(screen.getByText("Line 8, Owner")).toBeTruthy();
    expect(transact).not.toHaveBeenCalled();
  });

  it("a text of another intent is an unexpected answer, and never signed", async () => {
    await prepare(loadingView("awaiting_signatures", {}, { intent: addr(99) }));
    await screen.findByText(/\(UNEXPECTED_ANSWER\)/);
    expect(cannotPress("Sign in your wallet")).toBe(true);
    expect(transact).not.toHaveBeenCalled();
  });

  it("a command that is not a loading is an unexpected answer, and never signed", async () => {
    await prepare(handoverView("awaiting_signatures"));
    await screen.findByText(/\(UNEXPECTED_ANSWER\)/);
    expect(cannotPress("Sign in your wallet")).toBe(true);
    expect(transact).not.toHaveBeenCalled();
  });

  it("Loaded, debt remains (lot retired): the outcome after the terminal signs last", async () => {
    const { app } = await prepared(loadingView("awaiting_signatures", { ownerSigned: true }));
    vi.mocked(app.commands.sign).mockResolvedValue(
      loadingView("confirmed", {
        data: { lotLoaded: true, loanHandOffs: [{ externalHandoff: true }] },
      }),
    );
    await press("Sign in your wallet");
    await screen.findByText("Registry retired");
    expect(
      screen.getByText(
        "Registry retired; debt remains recorded; external hand-off accepted by lender. Confirmed on devnet in slot 526,890,114.",
      ),
    ).toBeTruthy();
    expect(screen.getAllByText("Confirmed").length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/bill of lading/i);
    await act(async () => fireEvent.click(await enabled("Back to home")));
    expect(app.navigate).toHaveBeenCalledWith({ name: "home" });
  });

  it("loaded with no debt: the position is loaded and no debt is handed off", async () => {
    const { app } = await prepared(loadingView("awaiting_signatures", { ownerSigned: true }));
    vi.mocked(app.commands.sign).mockResolvedValue(
      loadingView("confirmed", { data: { lotLoaded: false, loanHandOffs: [] } }),
    );
    await press("Sign in your wallet");
    await screen.findByText("Position loaded");
    expect(
      screen.getByText(
        "Position loaded. No debt is handed off. Confirmed on devnet in slot 526,890,114.",
      ),
    ).toBeTruthy();
  });

  it("a refused loading shows the program's refusal and the transaction", async () => {
    vi.mocked(readOpenLoadingCommand).mockResolvedValue(LOADING_ID);
    const { app } = await openDetail();
    vi.mocked(app.commands.get).mockResolvedValue(
      loadingView("failed", { error: { code: "AcceptanceStale", detail: null } }),
    );
    await press("Prepare loading text");
    await screen.findByText("This loading can't be recorded now (AcceptanceStale).");
    expect(screen.getByText("Refused by the Thetis program: AcceptanceStale")).toBeTruthy();
    expect(screen.getByText("View on Solana Explorer (devnet)")).toBeTruthy();
  });

  it("expired before both signed: the terminal that prepared it may prepare a new text", async () => {
    vi.mocked(readOpenLoadingCommand).mockResolvedValue(LOADING_ID);
    const { app } = await openDetail();
    vi.mocked(app.commands.get).mockResolvedValue(loadingView("expired"));
    await press("Prepare loading text");
    await screen.findByText(
      `This text expired at ${SIGN_BEFORE} before both of you signed. Nothing was sent.`,
    );
    expect(screen.queryByText(/^Ask /)).toBeNull();
    vi.mocked(app.commands.renew).mockResolvedValue(loadingView("awaiting_signatures"));
    await press("Prepare a new text");
    await waitFor(() => expect(app.commands.renew).toHaveBeenCalledWith(LOADING_ID));
    await enabled("Sign in your wallet");
  });

  it("expired before both signed: when the owner prepared it, the terminal asks the owner", async () => {
    vi.mocked(readOpenLoadingCommand).mockResolvedValue(LOADING_ID);
    const { app } = await openDetail();
    vi.mocked(app.commands.get).mockResolvedValue(
      loadingView("expired", {}, { initiatorOrganisationId: KHUNOU_ORG }),
    );
    await press("Prepare loading text");
    await screen.findByText("Ask Khunou Ore Exports to prepare a new text.");
    expect(button("Prepare a new text")).toBeNull();
    expect(app.commands.renew).not.toHaveBeenCalled();
  });
});

describe("Offline", () => {
  it("says recording a loading needs a connection, disables Prepare and keeps the intent", async () => {
    const { app, harness } = await openDetail();
    harness.setOnline(false);
    await screen.findByText(
      "Offline. Recording a loading needs a connection. Nothing was recorded.",
    );
    expect(cannotPress("Prepare loading text")).toBe(true);
    expect(screen.getByText("Needs a connection.")).toBeTruthy();
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Prepare loading text" })),
    );
    expect(app.commands.create).not.toHaveBeenCalled();
    expect(readOpenLoadingCommand).not.toHaveBeenCalled();
    expect(rowText("Lot")).toContain("CR-0001");

    harness.setOnline(true);
    expect((await enabled("Prepare loading text")).disabled).toBe(false);
    expect(rowText("Lot")).toContain("CR-0001");
  });
});
