// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { type MobileWallet, transact } from "@solana-mobile/mobile-wallet-adapter-protocol";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, ApiShapeError, ApiTimeout, ApiUnreachable } from "../../src/api/client";
import type { IntakeDraft } from "../../src/drafts/store";
import { decodeBase58, encodeBase64 } from "../../src/lib/encoding";
import { IssueReview } from "../../src/screens/IssueReview";
import { commandView, DEMO_TEXT } from "../fixtures";
import { completeDraft, fakeApp, membership, renderScreen, USER, WALLET } from "./app";
import { emitAppState } from "./native";

vi.mock("react-native", async () => (await import("./native")).reactNative);
vi.mock("react-native-safe-area-context", async () => (await import("./native")).safeArea);
vi.mock("@solana-mobile/mobile-wallet-adapter-protocol", () => ({ transact: vi.fn() }));
vi.mock("../../src/supabase", () => ({ SupabaseTimeout: class extends Error {} }));
vi.mock("expo-crypto", async () => ({ randomUUID: (await import("node:crypto")).randomUUID }));
vi.mock("expo-image-picker", () => ({}));
vi.mock("expo-document-picker", () => ({}));
vi.mock("expo-file-system", () => ({ File: class {}, Directory: class {}, Paths: {} }));
vi.mock("../../src/data/reads", async (importOriginal) => {
  const { chainOrganisation, owner, site, USER, WALLET, membership } = await import("./app");
  return {
    ...(await importOriginal<typeof import("../../src/data/reads")>()),
    readSites: vi.fn(async () => [site]),
    readOwners: vi.fn(async () => [owner]),
    readChainOrganisation: vi.fn(async () => chainOrganisation),
    readSignerLinks: vi.fn(async () => [
      { userId: USER, organisationId: membership.organisationId, wallet: WALLET },
    ]),
    readAuthority: vi.fn(async () => ({
      address: "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T",
      organisation: chainOrganisation.address,
      orgId: membership.organisationId,
      scopes: 1,
      expiresAt: "1798272000",
      revokedAt: null,
    })),
    readIssuedIntake: vi.fn(async () => null),
    readLotIdUsed: vi.fn(async () => false),
  };
});

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const b64 = (text: string) => Buffer.from(text).toString("base64");
const OTHER_TEXT = DEMO_TEXT.replace("Owner: Khunou Ore Exports", "Owner: Someone Else");
const COMMAND_ID = commandView("awaiting_signatures").id;

// The wallet's key is never used: the wallet stand-in returns the text with 64 bytes appended.
const walletKey = decodeBase58(WALLET);
const signMessages = vi.fn(async ({ payloads }: { payloads: string[] }) => ({
  signed_payloads: payloads.map((p) =>
    encodeBase64(new Uint8Array([...Buffer.from(p, "base64"), ...new Uint8Array(64).fill(9)])),
  ),
}));

beforeEach(() => {
  signMessages.mockClear();
  vi.mocked(transact).mockReset();
  vi.mocked(transact).mockImplementation(async (callback) =>
    callback({
      authorize: async () => ({
        accounts: [{ address: encodeBase64(walletKey) }],
        auth_token: "token",
        wallet_uri_base: "https://wallet.example",
      }),
      signMessages,
    } as unknown as MobileWallet),
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function withStored(draft: IntakeDraft, overrides: Parameters<typeof fakeApp>[0] = {}) {
  const app = fakeApp(overrides);
  await app.store.save(draft);
  return app;
}

function signedDraft(): IntakeDraft {
  return {
    ...completeDraft(),
    status: "awaiting_signature",
    command: {
      commandId: COMMAND_ID,
      lastStatus: "awaiting_signatures",
      textVersion: 1,
      transactionSignature: null,
      lot: null,
      explorerUrl: null,
      commitment: null,
    },
  };
}

const button = (name: string) => screen.queryByRole("button", { name });

/** Waits until the named button is on screen and can be pressed. */
async function enabled(name: string): Promise<HTMLButtonElement> {
  return waitFor(() => {
    const found = screen.getByRole("button", { name }) as HTMLButtonElement;
    expect(found.disabled).toBe(false);
    return found;
  });
}

describe("resume after the app was killed (F1)", () => {
  it("never offers Prepare while offline, and only reads the same command when back online", async () => {
    const app = await withStored(signedDraft(), { online: false });
    vi.mocked(app.commands.get).mockRejectedValue(new ApiUnreachable());
    const harness = await renderScreen(<IssueReview draftId="d-1" />, app);

    await screen.findByText(/Thetis already prepared a text for this draft/);
    expect(button("Prepare text")).toBeNull();
    expect(button("Try again")).toBeNull();
    expect(button("Check again")).not.toBeNull();

    vi.mocked(app.commands.get).mockResolvedValue(commandView("awaiting_signatures"));
    harness.setOnline(true);
    await screen.findByRole("button", { name: "Sign in your wallet" });
    expect(app.commands.create).not.toHaveBeenCalled();
    expect((await app.store.get(USER, membership.organisationId, "d-1"))?.command?.commandId).toBe(
      COMMAND_ID,
    );
  });

  it("checks again on return to the foreground", async () => {
    const app = await withStored(signedDraft());
    vi.mocked(app.commands.get).mockRejectedValueOnce(new ApiTimeout());
    await renderScreen(<IssueReview draftId="d-1" />, app);
    await screen.findByRole("button", { name: "Check again" });
    expect(button("Prepare text")).toBeNull();

    vi.mocked(app.commands.get).mockResolvedValue(commandView("awaiting_signatures"));
    await act(async () => emitAppState("active"));
    await screen.findByRole("button", { name: "Sign in your wallet" });
    expect(app.commands.create).not.toHaveBeenCalled();
  });

  it("shows an unreadable answer as that, not as offline, and still offers no Prepare", async () => {
    const app = await withStored(signedDraft());
    vi.mocked(app.commands.get).mockRejectedValue(new ApiShapeError("status: not one of"));
    await renderScreen(<IssueReview draftId="d-1" />, app);
    await screen.findByText(/Thetis could not read this command's status \(UNEXPECTED_ANSWER\)/);
    expect(screen.queryByText(/Offline/)).toBeNull();
    expect(button("Prepare text")).toBeNull();
    fireEvent.click(button("Check again") as HTMLElement);
    await waitFor(() => expect(app.commands.get).toHaveBeenCalledTimes(2));
    expect(app.commands.create).not.toHaveBeenCalled();
  });

  it("goes back to editing only on a 404", async () => {
    const app = await withStored(signedDraft());
    vi.mocked(app.commands.get).mockRejectedValue(new ApiError(404, "NOT_FOUND", "", null));
    await renderScreen(<IssueReview draftId="d-1" />, app);
    await waitFor(() =>
      expect(app.navigate).toHaveBeenCalledWith({ name: "intake", draftId: "d-1" }),
    );
    expect(app.commands.create).not.toHaveBeenCalled();
  });
});

describe("the text is checked again at the tap (F2)", () => {
  it("never signs a view swapped in after render, before the tap", async () => {
    const app = await withStored(completeDraft());
    const created = commandView("awaiting_signatures");
    vi.mocked(app.commands.create).mockResolvedValue(created);
    vi.mocked(app.commands.get).mockResolvedValue(commandView("awaiting_signatures"));
    await renderScreen(<IssueReview draftId="d-1" />, app);
    const sign = await enabled("Sign in your wallet");

    // The object the screen holds changes under it, with no render in between.
    if (!created.text) throw new Error("fixture has a text");
    created.text.messageBase64 = b64(OTHER_TEXT);
    created.text.messageSha256 = sha(OTHER_TEXT);
    await act(async () => fireEvent.click(sign));

    expect(transact).not.toHaveBeenCalled();
    expect(signMessages).not.toHaveBeenCalled();
    await screen.findByText(/does not match what you entered/);
  });

  it("asks nothing when the fresh view in beforeSigning does not match the draft", async () => {
    const app = await withStored(completeDraft());
    vi.mocked(app.commands.create).mockResolvedValue(commandView("awaiting_signatures"));
    const fresh = commandView("awaiting_signatures");
    // Same SHA-256 claimed, other bytes: the claimed digest no longer matches the text.
    if (!fresh.text) throw new Error("fixture has a text");
    fresh.text.messageBase64 = b64(OTHER_TEXT);
    vi.mocked(app.commands.get).mockResolvedValue(fresh);
    await renderScreen(<IssueReview draftId="d-1" />, app);
    const sign = await enabled("Sign in your wallet");
    await act(async () => fireEvent.click(sign));

    expect(signMessages).not.toHaveBeenCalled();
    expect(app.commands.sign).not.toHaveBeenCalled();
  });
});

describe("a held signature keeps its SHA-256 (F8)", () => {
  it("is not sent once the text has changed", async () => {
    const app = await withStored(completeDraft());
    vi.mocked(app.commands.create).mockResolvedValue(commandView("awaiting_signatures"));
    vi.mocked(app.commands.get).mockResolvedValueOnce(commandView("awaiting_signatures"));
    vi.mocked(app.commands.sign).mockRejectedValue(new ApiTimeout());
    // After the lost reply the relay shows a renewed text, still unsigned.
    const renewed = commandView("awaiting_signatures", {
      text: {
        version: 2,
        messageBase64: b64(OTHER_TEXT),
        messageSha256: sha(OTHER_TEXT),
        validUntil: "1795767275",
        validUntilText: "2026-11-27 10:14:35 SAST",
      },
    });
    vi.mocked(app.commands.get).mockResolvedValue(renewed);
    await renderScreen(<IssueReview draftId="d-1" />, app);
    const sign = await enabled("Sign in your wallet");
    await act(async () => fireEvent.click(sign));
    const again = await enabled("Send signature");
    await act(async () => fireEvent.click(again));

    expect(app.commands.sign).toHaveBeenCalledTimes(1);
    await screen.findByText(/The text changed after you signed it/);
  });
});

describe("another Thetis instance (F12)", () => {
  it("never opens the wallet for a command of another instance", async () => {
    const app = await withStored(completeDraft());
    vi.mocked(app.commands.create).mockResolvedValue(
      commandView("awaiting_signatures", {
        protocol: "11111111111111111111111111111111",
      }),
    );
    await renderScreen(<IssueReview draftId="d-1" />, app);
    await screen.findByText(/another Thetis instance than the one this phone is reading/);
    expect(button("Sign in your wallet")).toBeNull();
    expect(transact).not.toHaveBeenCalled();
  });

  it("checks the instance again at the tap", async () => {
    const app = await withStored(completeDraft());
    const created = commandView("awaiting_signatures");
    vi.mocked(app.commands.create).mockResolvedValue(created);
    await renderScreen(<IssueReview draftId="d-1" />, app);
    const sign = await enabled("Sign in your wallet");
    (created as { protocol: string }).protocol = "11111111111111111111111111111111";
    await act(async () => fireEvent.click(sign));
    expect(transact).not.toHaveBeenCalled();
  });
});

describe("unexpected errors while signing (F13)", () => {
  it("shows the INTERNAL copy and leaves no unhandled rejection", async () => {
    const app = await withStored(completeDraft(), {
      setConnection: () => {
        throw new Error("boom");
      },
    });
    vi.mocked(app.commands.create).mockResolvedValue(commandView("awaiting_signatures"));
    await renderScreen(<IssueReview draftId="d-1" />, app);
    const sign = await enabled("Sign in your wallet");
    await act(async () => fireEvent.click(sign));
    await screen.findByText(/\(INTERNAL\)/);
    expect(app.commands.sign).not.toHaveBeenCalled();
  });
});
