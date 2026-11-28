// @vitest-environment jsdom
// voice.md §5.1 to §5.4, field: Talk on tab roots, the strip's states, the client tools and when a
// session ends, on the whole signed-in app. The ElevenLabs SDK is the stand-in of test/voice-sdk.ts:
// nothing connects, speaks or costs credits. The API client is a stand-in that records each call.
import type { Session } from "@supabase/supabase-js";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, ApiUnreachable } from "../../src/api/client";
import { NAV_COPY, VOICE_COPY } from "../../src/copy";
import { createDraftStore } from "../../src/drafts/store";
import { SignedIn } from "../../src/SignedIn";
import { WalletRefused } from "../../src/wallet";
import { KOPANO_ORG } from "../fixtures";
import { voiceSdk } from "../voice-sdk";
import { fakeApp, membership, USER, WALLET } from "./app";
import { emitAppState, microphone } from "./native";

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

type Request = { method: string; path: string; timeoutMs?: number };
const api = vi.hoisted(() => ({
  calls: [] as Request[],
  tokens: 0,
  session: null as null | (() => Promise<unknown>),
  evidence: null as null | ((path: string) => Promise<unknown>),
}));
const cast = vi.hoisted(() => ({ memberships: [] as unknown[] }));
const wallet = vi.hoisted(() => ({ refuse: null as null | ((error: unknown) => void) }));

const terminal = {
  organisationId: "2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60",
  memberRole: "member",
  name: "Port Terminal T1",
  slug: "port-terminal-t1",
  kind: "terminal",
  synthetic: true,
};

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
vi.mock("../../src/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/api/client")>()),
  createApiClient: () => ({
    request: async (
      method: string,
      path: string,
      options: { timeoutMs?: number; parse: (data: unknown) => unknown },
    ) => {
      api.calls.push({ method, path, timeoutMs: options.timeoutMs });
      if (path === "/v1/conversations/session") {
        if (api.session) return options.parse(await api.session());
        api.tokens += 1;
        return options.parse({
          conversationToken: `synthetic-token-${api.tokens}`,
          conversationId: `conv_${api.tokens}`,
          agentId: "agent_synthetic",
        });
      }
      if (path.startsWith("/v1/voice/lots/") && api.evidence)
        return options.parse(await api.evidence(path));
      throw new ApiUnreachable();
    },
  }),
}));
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
  // The wallet answers only when a test refuses it, so the screen stays signing until then.
  signText: vi.fn(
    () =>
      new Promise((_resolve, reject) => {
        wallet.refuse = reject;
      }),
  ),
}));

const session = { user: { id: USER, email: "custodian@example.test" } } as unknown as Session;
const config = fakeApp().config;
const draftStore = () => createDraftStore(stores.drafts);
const UNAVAILABLE = "Voice is unavailable. Use the controls below.";

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
      signOut={() => {}}
    />,
  );
  await screen.findByText("Drafts on this phone");
}

const button = (name: string) => screen.queryByRole("button", { name }) as HTMLButtonElement | null;
const press = async (element: HTMLElement) => act(async () => fireEvent.click(element));
const selected = () =>
  screen
    .getAllByRole("tab")
    .filter((t) => t.getAttribute("aria-selected") === "true")
    .map((t) => t.textContent);
const sessionCalls = () => api.calls.filter((c) => c.path === "/v1/conversations/session");

/** Talk, then the SDK connects: the session is live and listening. */
async function goLive() {
  const before = voiceSdk.starts.length;
  await press(await screen.findByRole("button", { name: "Talk to the Thetis navigator" }));
  await waitFor(() => expect(voiceSdk.starts.length).toBe(before + 1));
  await act(async () => voiceSdk.last().onConnect?.({ conversationId: "conv" }));
  await screen.findByText("Listening.");
}

/** Calls a client tool as the agent would, and returns what the provider answered. */
async function tool(name: string, parameters?: unknown): Promise<unknown> {
  const tools = voiceSdk.last().clientTools ?? {};
  const run = tools[name];
  if (!run) throw new Error(`no client tool ${name}`);
  let out: unknown;
  await act(async () => {
    out = await run(parameters);
  });
  return out;
}

const parsed = (value: unknown) => JSON.parse(value as string) as Record<string, unknown>;

beforeEach(() => {
  stores.drafts.values.clear();
  stores.secure.values.clear();
  voiceSdk.reset();
  api.calls = [];
  api.tokens = 0;
  api.session = null;
  api.evidence = null;
  wallet.refuse = null;
  microphone.answer = "granted";
  microphone.requested = [];
  microphone.duringRequest = null;
});
afterEach(cleanup);

describe("Talk on the phone (voice.md §5.1)", () => {
  it("shows Talk after the tabs on tab roots and nowhere on pushed screens", async () => {
    await start();
    const talk = button("Talk to the Thetis navigator") as HTMLButtonElement;
    expect(talk.textContent).toBe("Talk");
    const tablist = screen.getByRole("tablist");
    expect(tablist.compareDocumentPosition(talk) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tablist.contains(talk)).toBe(false);
    expect(screen.queryByText("Listening.")).toBeNull();
    await press(screen.getByRole("tab", { name: "Account" }));
    await screen.findByText(NAV_COPY.signedInTitle);
    expect(button("Talk to the Thetis navigator")).not.toBeNull();
    await press(screen.getByRole("tab", { name: "Home" }));
    await press(await screen.findByRole("button", { name: "New intake" }));
    await screen.findByRole("button", { name: "Back" });
    expect(button("Talk to the Thetis navigator")).toBeNull();
  });

  it("asks for a fresh token with the 8 s limit, starts over WebRTC, and shows each live state", async () => {
    await start();
    await press(button("Talk to the Thetis navigator") as HTMLElement);
    await waitFor(() => expect(voiceSdk.starts).toHaveLength(1));
    expect(sessionCalls()).toEqual([
      { method: "POST", path: "/v1/conversations/session", timeoutMs: 8_000 },
    ]);
    expect(voiceSdk.last()).toMatchObject({
      conversationToken: "synthetic-token-1",
      connectionType: "webrtc",
    });
    expect(screen.getByText("Starting voice.")).toBeTruthy();
    expect(button("Connecting to voice")?.disabled).toBe(true);
    await act(async () => voiceSdk.last().onConnect?.({ conversationId: "conv_1" }));
    await screen.findByText("Listening.");
    expect(button("End voice session")?.textContent).toBe("End");
    await act(async () => voiceSdk.last().onModeChange?.({ mode: "speaking" }));
    await screen.findByText("Speaking.");
    await press(button("End voice session") as HTMLElement);
    expect(voiceSdk.ends).toBe(1);
    expect(screen.queryByText("Speaking.")).toBeNull();
    expect(button("Talk to the Thetis navigator")).not.toBeNull();
    // A second Talk asks for a new token; one is never reused.
    await goLive();
    expect(voiceSdk.last().conversationToken).toBe("synthetic-token-2");
  });

  it("opens the Home tab for queue and the Account tab for account, and refuses the web-only screens", async () => {
    await start();
    await goLive();
    expect(parsed(await tool("navigate_to", { screen: "account" }))).toEqual({
      ok: true,
      screen: "account",
    });
    expect(selected()).toEqual(["Account"]);
    expect(parsed(await tool("navigate_to", { screen: "queue" }))).toEqual({
      ok: true,
      screen: "queue",
    });
    expect(selected()).toEqual(["Home"]);
    for (const [screenName, message] of Object.entries(VOICE_COPY.refusals.NOT_ON_PHONE)) {
      expect(parsed(await tool("navigate_to", { screen: screenName, id: "CR-0001" }))).toEqual({
        ok: false,
        reason: "NOT_ON_PHONE",
        message,
      });
      expect(screen.getByText(message)).toBeTruthy();
      expect(selected()).toEqual(["Home"]);
    }
    // The refusal shows until the next tool call.
    await tool("navigate_to", { screen: "queue" });
    expect(screen.getByText("Listening.")).toBeTruthy();
  });

  it("refuses navigation while the wallet is signing and queues nothing", async () => {
    await start({ wallet: true });
    await press(screen.getByRole("tab", { name: "Account" }));
    await goLive();
    await press(await screen.findByRole("button", { name: "Link this wallet" }));
    await press(await screen.findByRole("button", { name: "Sign in your wallet" }));
    await screen.findByRole("button", { name: "Waiting for your wallet" });
    const message = "Your wallet is signing. The screen stays as it is until it finishes.";
    expect(parsed(await tool("navigate_to", { screen: "queue" }))).toEqual({
      ok: false,
      reason: "BUSY",
      message,
    });
    expect(screen.getByText(message)).toBeTruthy();
    expect(selected()).toEqual(["Account"]);
    await act(async () => wallet.refuse?.(new WalletRefused("closed")));
    await screen.findByRole("button", { name: "Sign in your wallet" });
    expect(selected()).toEqual(["Account"]);
  });

  it("disables Talk while busy and keeps End enabled", async () => {
    await start({ wallet: true });
    await press(screen.getByRole("tab", { name: "Account" }));
    await goLive();
    await press(await screen.findByRole("button", { name: "Link this wallet" }));
    await press(await screen.findByRole("button", { name: "Sign in your wallet" }));
    await screen.findByRole("button", { name: "Waiting for your wallet" });
    const end = button("End voice session") as HTMLButtonElement;
    expect(end.disabled).toBe(false);
    await press(end);
    expect(voiceSdk.ends).toBe(1);
    const talk = button("Talk to the Thetis navigator") as HTMLButtonElement;
    expect(talk.disabled).toBe(true);
    expect(talk.getAttribute("aria-description")).toBe(NAV_COPY.busyHint);
    await press(talk);
    expect(voiceSdk.starts).toHaveLength(1);
  });

  it("looks up a lot's evidence with the person's session, refusing a bad id without a call", async () => {
    await start();
    await goLive();
    expect(parsed(await tool("get_lot_evidence", { lot_id: "not an id!" }))).toEqual({
      ok: false,
      reason: "BAD_ID",
      message: "That is not a lot id. Lot ids look like CR-0001.",
    });
    expect(api.calls.filter((c) => c.path.startsWith("/v1/voice/"))).toEqual([]);
    const data = {
      lotId: "CR-0001",
      items: [
        {
          purpose: "assay",
          version: 1,
          finalizedAt: "2026-11-27T08:04:00.000Z",
          sha256Prefix: "a1b2c3d40000",
        },
      ],
      observedAt: "2026-11-27T08:05:00.000Z",
    };
    api.evidence = async () => data;
    expect(parsed(await tool("get_lot_evidence", { lot_id: " cr-0001 " }))).toEqual(data);
    expect(api.calls.at(-1)).toMatchObject({
      method: "GET",
      path: "/v1/voice/lots/CR-0001/evidence",
    });
    api.evidence = async () => {
      throw new ApiError(404, "NOT_FOUND", "", null);
    };
    expect(parsed(await tool("get_lot_evidence", { lot_id: "CR-0002" }))).toEqual({
      ok: false,
      reason: "NOT_FOUND",
    });
    api.evidence = async () => {
      throw new ApiUnreachable();
    };
    expect(parsed(await tool("get_lot_evidence", { lot_id: "CR-0002" }))).toEqual({
      ok: false,
      reason: "NETWORK",
    });
    expect(selected()).toEqual(["Home"]);
  });

  it("answers a malformed tool call with its refusal and never throws", async () => {
    await start();
    await goLive();
    for (const parameters of [undefined, null, "queue", 7, []]) {
      expect(parsed(await tool("navigate_to", parameters))).toMatchObject({
        ok: false,
        reason: "UNKNOWN_SCREEN",
      });
      expect(parsed(await tool("get_lot_evidence", parameters))).toMatchObject({
        ok: false,
        reason: "BAD_ID",
      });
    }
    expect(screen.getByText("That is not a lot id. Lot ids look like CR-0001.")).toBeTruthy();
  });

  it("keeps a live session live on an error, and shows it dropped once the connection closes", async () => {
    await start();
    await goLive();
    await act(async () => voiceSdk.last().onError?.("a transient error"));
    expect(screen.getByText("Listening.")).toBeTruthy();
    expect(voiceSdk.ends).toBe(0);
    await act(async () => {
      voiceSdk.last().onStatusChange?.({ status: "disconnected" });
      voiceSdk.last().onError?.("connection closed");
    });
    await screen.findByText(UNAVAILABLE);
    expect(button("Try voice again")?.textContent).toBe("Talk");
  });

  it("returns to Talk when the agent ends the call", async () => {
    await start();
    await goLive();
    await act(async () => voiceSdk.last().onDisconnect?.({ reason: "agent" }));
    expect(screen.queryByText("Listening.")).toBeNull();
    expect(button("Talk to the Thetis navigator")).not.toBeNull();
  });

  it("fetches one new token when the first is refused, and never a third", async () => {
    await start();
    await press(button("Talk to the Thetis navigator") as HTMLElement);
    await waitFor(() => expect(voiceSdk.starts).toHaveLength(1));
    await act(async () => voiceSdk.last().onError?.("token refused"));
    await waitFor(() => expect(voiceSdk.starts).toHaveLength(2));
    expect(voiceSdk.last().conversationToken).toBe("synthetic-token-2");
    expect(screen.getByText("Getting a new voice session.")).toBeTruthy();
    await act(async () => voiceSdk.last().onError?.("token refused again"));
    await screen.findByText(UNAVAILABLE);
    expect(sessionCalls()).toHaveLength(2);
    expect(voiceSdk.starts).toHaveLength(2);
  });

  it("shows Voice is unavailable. Use the controls below. when the session route fails", async () => {
    api.session = async () => {
      throw new ApiError(503, "VOICE_UNAVAILABLE", "", null);
    };
    await start();
    await press(button("Talk to the Thetis navigator") as HTMLElement);
    await screen.findByText(UNAVAILABLE);
    expect(voiceSdk.starts).toEqual([]);
    expect(button("Try voice again")).not.toBeNull();
    expect(screen.getAllByRole("tab")).toHaveLength(2);
  });

  it("shows Voice is unavailable. Use the controls below. when the microphone is refused, with the settings line", async () => {
    microphone.answer = "denied";
    await start();
    await press(button("Talk to the Thetis navigator") as HTMLElement);
    await screen.findByText(UNAVAILABLE);
    expect(
      screen.getByText(
        "Microphone access is off for Thetis field. Allow it in Android settings, then press Talk.",
      ),
    ).toBeTruthy();
    expect(sessionCalls()).toEqual([]);
    expect(voiceSdk.starts).toEqual([]);
  });

  it("starts on the first Talk although the permission dialog pauses the app", async () => {
    microphone.duringRequest = () => {
      emitAppState("background");
      emitAppState("active");
    };
    await start();
    await press(button("Talk to the Thetis navigator") as HTMLElement);
    await waitFor(() => expect(voiceSdk.starts).toHaveLength(1));
    expect(microphone.requested).toEqual(["android.permission.RECORD_AUDIO"]);
    expect(sessionCalls()).toHaveLength(1);
  });

  it("ends a live session when a pushed screen opens or the app leaves the foreground", async () => {
    await start();
    await goLive();
    await press(screen.getByRole("button", { name: "New intake" }));
    await screen.findByRole("button", { name: "Back" });
    expect(voiceSdk.ends).toBe(1);
    await press(screen.getByRole("button", { name: "Back" }));
    await screen.findByText("Drafts on this phone");
    expect(screen.queryByText("Listening.")).toBeNull();
    expect(button("Talk to the Thetis navigator")).not.toBeNull();
    await goLive();
    await act(async () => emitAppState("background"));
    expect(voiceSdk.ends).toBe(2);
    expect(screen.queryByText("Listening.")).toBeNull();
    expect(button("Talk to the Thetis navigator")).not.toBeNull();
  });

  it("ends a live session when the organisation switches", async () => {
    await start({ two: true });
    await goLive();
    await press(
      screen.getByRole("button", { name: "Switch organisation, now Kopano Stockyard Custody" }),
    );
    await press(screen.getByRole("button", { name: "Port Terminal T1" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Switch organisation, now Port Terminal T1" }),
      ).toBeTruthy(),
    );
    expect(voiceSdk.ends).toBe(1);
    expect(screen.queryByText("Listening.")).toBeNull();
    expect(button("Talk to the Thetis navigator")).not.toBeNull();
  });

  it("drops a tool result that arrives after the session ended", async () => {
    await start();
    await goLive();
    let answer: (value: unknown) => void = () => {};
    api.evidence = () =>
      new Promise((resolve) => {
        answer = resolve;
      });
    const tools = voiceSdk.last().clientTools ?? {};
    let pending: Promise<unknown> = Promise.resolve();
    await act(async () => {
      pending = Promise.resolve(tools.get_lot_evidence?.({ lot_id: "CR-0001" }));
    });
    await press(button("End voice session") as HTMLElement);
    let out: unknown = "unset";
    await act(async () => {
      answer({ lotId: "CR-0001", items: [], observedAt: "2026-11-27T08:05:00.000Z" });
      out = await pending;
    });
    expect(out).toBeUndefined();
    // A call from the ended session moves nothing either.
    let moved: unknown = "unset";
    await act(async () => {
      moved = await tools.navigate_to?.({ screen: "account" });
    });
    expect(moved).toBeUndefined();
    expect(selected()).toEqual(["Home"]);
  });
});
