// @vitest-environment jsdom
// navigation.md §8.2 (13 to 20): the tab bar, the per-tab stacks, Account and Android Back, on the
// whole signed-in app with the reads and the wallet as stand-ins.
import type { Session } from "@supabase/supabase-js";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NAV_COPY } from "../../src/copy";
import { createDraftStore } from "../../src/drafts/store";
import { SignedIn } from "../../src/SignedIn";
import { IssueReview } from "../../src/screens/IssueReview";
import { KOPANO_ORG } from "../fixtures";
import { completeDraft, fakeApp, membership, renderScreen, USER, WALLET } from "./app";
import { pressBack } from "./native";

const stores = vi.hoisted(() => {
  const make = () => {
    const values = new Map<string, string>();
    return {
      values,
      getItem: async (key: string) => values.get(key) ?? null,
      setItem: async (key: string, value: string) => void values.set(key, value),
      removeItem: async (key: string) => void values.delete(key),
    };
  };
  return { drafts: make(), secure: make() };
});

const terminal = {
  organisationId: "2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60",
  memberRole: "member",
  name: "Port Terminal T1",
  slug: "port-terminal-t1",
  kind: "terminal",
  synthetic: true,
};
const cast = vi.hoisted(() => ({ memberships: [] as unknown[] }));

vi.mock("react-native", async () => (await import("./native")).reactNative);
vi.mock("react-native-safe-area-context", async () => (await import("./native")).safeArea);
vi.mock("@solana-mobile/mobile-wallet-adapter-protocol", () => ({ transact: vi.fn() }));
vi.mock("expo-crypto", async () => ({ randomUUID: (await import("node:crypto")).randomUUID }));
vi.mock("expo-image-picker", () => ({}));
vi.mock("expo-document-picker", () => ({}));
vi.mock("expo-file-system", () => {
  class File {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = parts.map((p) => (typeof p === "string" ? p : p.uri)).join("/");
    }
    get exists() {
      return true;
    }
    get size() {
      return 1_234;
    }
    copy() {}
    delete() {}
  }
  class Directory extends File {
    create() {}
  }
  return { File, Directory, Paths: { document: "file:///data" } };
});
vi.mock("@react-native-async-storage/async-storage", () => ({ default: stores.drafts }));
vi.mock("../../src/supabase", () => ({
  sessionStorage: stores.secure,
  SupabaseTimeout: class extends Error {},
}));
vi.mock("../../src/data/reads", async (importOriginal) => {
  const { chainOrganisation, owner, protocolContext, site } = await import("./app");
  return {
    ...(await importOriginal<typeof import("../../src/data/reads")>()),
    readMemberships: vi.fn(async () => cast.memberships),
    readProtocol: vi.fn(async () => ({ kind: "ready", context: protocolContext })),
    readChainOrganisation: vi.fn(async () => chainOrganisation),
    readSignerLinks: vi.fn(async () => []),
    readAuthority: vi.fn(async () => null),
    readSites: vi.fn(async () => [site]),
    readOwners: vi.fn(async () => [owner]),
    readLotsAtSites: vi.fn(async () => []),
    readWaiting: vi.fn(async () => []),
    readIssuedIntake: vi.fn(async () => null),
    readLotIdUsed: vi.fn(async () => false),
  };
});
vi.mock("../../src/api/walletLinks", () => ({
  walletLinksApi: () => ({
    challenge: vi.fn(async () => ({
      challengeId: "7c1e2d3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f",
      message: "Thetis wants you to link a Solana wallet.",
      expiresAt: "2099-01-01T00:00:00.000Z",
    })),
    complete: vi.fn(),
  }),
}));
vi.mock("../../src/link-challenge", () => ({ checkLinkChallenge: () => true }));
vi.mock("../../src/wallet", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/wallet")>()),
  sessionConnection: () => ({}),
  // The wallet never returns, so the screen stays in its signing step.
  signText: vi.fn(() => new Promise(() => {})),
}));

const session = { user: { id: USER, email: "custodian@example.test" } } as unknown as Session;
const config = fakeApp().config;
const signOut = vi.fn();
const draftStore = () => createDraftStore(stores.drafts);

async function start(options: { two?: boolean; wallet?: boolean } = {}) {
  cast.memberships = options.two ? [membership, terminal] : [membership];
  if (options.two) await draftStore().setOrganisation(USER, KOPANO_ORG);
  if (options.wallet)
    await draftStore().setWallet(USER, KOPANO_ORG, {
      address: WALLET,
      walletUriBase: "https://wallet.example",
    });
  render(
    <SignedIn
      config={config}
      db={{ auth: { getSession: async () => ({ data: { session } }) } } as never}
      session={session}
      online
      sessionExpired={() => {}}
      signOut={signOut}
    />,
  );
  await screen.findByText("Drafts on this phone");
}

const tab = (name: string) => screen.getByRole("tab", { name }) as HTMLButtonElement;
const selected = () =>
  screen
    .getAllByRole("tab")
    .filter((t) => t.getAttribute("aria-selected") === "true")
    .map((t) => t.textContent);
const press = async (element: HTMLElement) => act(async () => fireEvent.click(element));
const back = async () => {
  let handled = false;
  await act(async () => {
    handled = pressBack();
  });
  return handled;
};
const switcher = (org: string) =>
  screen.queryByRole("button", { name: `Switch organisation, now ${org}` });

beforeEach(() => {
  stores.drafts.values.clear();
  stores.secure.values.clear();
  signOut.mockReset();
});
afterEach(cleanup);

describe("tab bar and per-tab stacks (navigation.md §4)", () => {
  it("shows the tab bar on Home and Account with the current tab selected", async () => {
    await start();
    expect(screen.getAllByRole("tablist")).toHaveLength(1);
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Home", "Account"]);
    expect(selected()).toEqual(["Home"]);
    await press(tab("Account"));
    await screen.findByText(NAV_COPY.signedInTitle);
    expect(selected()).toEqual(["Account"]);
  });

  it("hides the tab bar on intake and issue review, which show Back", async () => {
    await draftStore().save(completeDraft());
    await start();
    expect(screen.getAllByRole("tablist")).toHaveLength(1);
    await press(await screen.findByRole("button", { name: "CR-0001" }));
    await screen.findByText("New intake");
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
    cleanup();
    const app = fakeApp();
    await app.store.save(completeDraft());
    await renderScreen(<IssueReview draftId="d-1" />, app);
    await waitFor(() => expect(screen.getByRole("button", { name: "Back" })).toBeTruthy());
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("disables the tabs and the organisation switch while the wallet is signing", async () => {
    await start({ two: true, wallet: true });
    await press(tab("Account"));
    await press(await screen.findByRole("button", { name: "Link this wallet" }));
    await press(await screen.findByRole("button", { name: "Sign in your wallet" }));
    await screen.findByRole("button", { name: "Waiting for your wallet" });
    expect(tab("Home").disabled).toBe(true);
    expect(tab("Account").disabled).toBe(true);
    expect(tab("Home").getAttribute("aria-description")).toBe(NAV_COPY.busyHint);
    expect((switcher("Kopano Stockyard Custody") as HTMLButtonElement).disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: NAV_COPY.switchOrganisation }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(await back()).toBe(true);
    expect(selected()).toEqual(["Account"]);
  });

  it("offers organisation switching in the top bar only with more than one membership", async () => {
    await start();
    expect(switcher("Kopano Stockyard Custody")).toBeNull();
    cleanup();
    stores.drafts.values.clear();
    await start({ two: true });
    await press(switcher("Kopano Stockyard Custody") as HTMLElement);
    await screen.findByText("Which organisation are you working for?");
    expect(screen.getByText(NAV_COPY.pickerFootnote)).toBeTruthy();
    await press(screen.getByRole("button", { name: "Port Terminal T1" }));
    await waitFor(() => expect(switcher("Port Terminal T1")).not.toBeNull());
    expect(selected()).toEqual(["Home"]);
    await press(screen.getByRole("button", { name: "New intake" }));
    await screen.findByRole("button", { name: "Back" });
    expect(switcher("Port Terminal T1")).toBeNull();
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("shows the wallet, the organisation and Sign out on Account", async () => {
    await start({ two: true });
    await press(tab("Account"));
    await screen.findByText(NAV_COPY.accountTitle, { selector: "span" });
    expect(screen.getAllByText("Wallet").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Connect wallet" })).toBeTruthy();
    expect(screen.getByText(NAV_COPY.organisationTitle)).toBeTruthy();
    expect(screen.getAllByText("Kopano Stockyard Custody").length).toBeGreaterThan(0);
    expect(await screen.findByText("Custodian")).toBeTruthy();
    expect(screen.getByRole("button", { name: NAV_COPY.switchOrganisation })).toBeTruthy();
    expect(screen.getByText(NAV_COPY.signedInTitle)).toBeTruthy();
    expect(screen.getByText("custodian@example.test")).toBeTruthy();
    expect(screen.getByRole("button", { name: NAV_COPY.signOut })).toBeTruthy();
    expect(screen.getByText(NAV_COPY.signOutHelp)).toBeTruthy();
  });

  it("signs out from Account and keeps the drafts on this phone", async () => {
    await draftStore().save(completeDraft());
    await start();
    await press(tab("Account"));
    await press(await screen.findByRole("button", { name: NAV_COPY.signOut }));
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(await draftStore().list(USER, KOPANO_ORG)).toHaveLength(1);
  });

  it("opens Account from Link this wallet on Home, and Back returns to Home", async () => {
    await start({ wallet: true });
    await press(await screen.findByRole("button", { name: "Link this wallet" }));
    await screen.findByText(NAV_COPY.signedInTitle);
    expect(selected()).toEqual(["Account"]);
    expect(await back()).toBe(true);
    await screen.findByText("Drafts on this phone");
    expect(selected()).toEqual(["Home"]);
    expect(await back()).toBe(false);
  });

  it("returns to the same draft after leaving intake for Account", async () => {
    await draftStore().save(completeDraft());
    await start();
    await press(await screen.findByRole("button", { name: "CR-0001" }));
    await screen.findByText("New intake");
    await press(await screen.findByRole("button", { name: "Wallet" }));
    await screen.findByText(NAV_COPY.signedInTitle);
    expect(selected()).toEqual(["Account"]);
    await press(tab("Home"));
    await screen.findByText("New intake");
    await waitFor(() =>
      expect((screen.getByRole("textbox", { name: "Lot ID" }) as HTMLInputElement).value).toBe(
        "CR-0001",
      ),
    );
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(await back()).toBe(true);
    await screen.findByText("Drafts on this phone");
  });
});
