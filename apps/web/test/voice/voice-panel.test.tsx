// voice.md §5.1: the web voice panel's states, copy and typed fallback. The
// ElevenLabs SDK is stubbed at `@elevenlabs/react`: nothing connects, speaks or costs credits.
// Organisations and lot ids are the synthetic demo cast's.

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { RailItem, RailSection } from "@/components/shell/rail-nav";

type StartOptions = {
  conversationToken?: string;
  clientTools?: Record<string, (parameters: Record<string, unknown>) => unknown>;
  onConnect?: (props: { conversationId: string }) => void;
  onDisconnect?: (details: { reason: string; message?: string }) => void;
  onError?: (message: string, context?: unknown) => void;
  onModeChange?: (props: { mode: "speaking" | "listening" }) => void;
};

const sdk = vi.hoisted(() => ({
  starts: [] as StartOptions[],
  ends: 0,
}));

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  session: { access_token: "synthetic-token" } as { access_token: string } | null,
}));

vi.mock("@elevenlabs/react", () => ({
  ConversationProvider: ({ children }: { children: ReactNode }) => children,
  useConversation: () => ({
    startSession: (options: StartOptions) => {
      sdk.starts.push(options);
    },
    endSession: () => {
      sdk.ends += 1;
    },
  }),
}));

vi.mock("next/navigation", async (original) => ({
  ...(await original<typeof import("next/navigation")>()),
  useRouter: () => ({ push: mocks.push, replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}));

vi.mock("@/components/access/use-access-session", () => ({
  useAccessSession: () => mocks.session,
}));

const { VoiceProvider } = await import("@/components/voice/voice-provider");
const { VoicePanel } = await import("@/components/voice/voice-panel");

const API = "http://api.test";
const RELEASE_ONE = "7VDNjuhymdWkPh1isgKCw36ESFCKf6uieAyzbVJWiyxs";
const UNAVAILABLE = "Voice is unavailable. Use the controls below.";

const lot = (id: string): RailItem => ({
  key: id,
  label: id,
  detail: null,
  href: `/lender-one/lots/${encodeURIComponent(id)}`,
});
const release = (lotId: string, address: string): RailItem => ({
  key: address,
  label: lotId,
  detail: "2,000.000 t",
  href: `/lender-one/releases/${address}`,
});
const SECTIONS: RailSection[] = [
  {
    segment: "queue",
    label: "Work queue",
    count: 3,
    href: "/lender-one/queue",
    items: [],
    empty: null,
  },
  {
    segment: "lots",
    label: "Lots",
    count: 2,
    href: null,
    items: [lot("CR-0001"), lot("CR-0002")],
    empty: "No lots yet",
  },
  {
    segment: "releases",
    label: "Releases",
    count: 3,
    href: null,
    items: [
      release("CR-0001", RELEASE_ONE),
      release("CR-0002", "6QWeT6FpJrm8AF1btu6pTTmbDRDW8WHrpXUbFg59iCes"),
      release("CR-0002", "5".repeat(44)),
    ],
    empty: "No releases yet",
  },
  {
    segment: "exceptions",
    label: "Exceptions",
    count: 0,
    href: "/lender-one/exceptions",
    items: [],
    empty: null,
  },
];

type Call = { url: string; method: string; body: unknown; auth: string | null };
const calls: Call[] = [];
let replies: ((call: Call) => Response | Promise<Response> | undefined)[] = [];
let tokens = 0;
const stop = vi.fn();
let microphone: () => Promise<unknown> = async () => ({ getTracks: () => [{ stop }] });

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_API_URL", API);
  calls.length = 0;
  replies = [];
  tokens = 0;
  sdk.starts.length = 0;
  sdk.ends = 0;
  mocks.push.mockReset();
  mocks.session = { access_token: "synthetic-token" };
  stop.mockReset();
  microphone = async () => ({ getTracks: () => [{ stop }] });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: vi.fn((_constraints: unknown) => microphone()),
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      const call = {
        url: url.replace(API, ""),
        method: init.method ?? "GET",
        body: init.body ?? null,
        auth: headers.Authorization ?? null,
      };
      calls.push(call);
      for (const reply of replies) {
        const response = reply(call);
        if (response) return response;
      }
      if (call.url === "/v1/conversations/session") {
        tokens += 1;
        return json(200, {
          data: {
            conversationToken: `synthetic-conversation-token-${tokens}`,
            conversationId: `conv_${tokens}`,
            agentId: "agent_synthetic",
          },
        });
      }
      return json(404, { error: { code: "NOT_FOUND", message: "Not found." } });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function renderPanel() {
  return render(
    <VoiceProvider organisationId="lender-one">
      <VoicePanel organisationId="lender-one" sections={SECTIONS} />
    </VoiceProvider>,
  );
}

const talkButton = () =>
  screen.getByRole("button", {
    name: /^(Talk to the Thetis navigator|Connecting to voice|End voice session|Try voice again)$/,
  });
const status = () => screen.getByRole("status");
const sessionCalls = () => calls.filter(({ url }) => url === "/v1/conversations/session");

function expectFallbackEnabled() {
  const screenPicker = screen.getByRole("combobox", { name: "Open a screen" });
  expect(screenPicker).toBeVisible();
  expect(screenPicker).toBeEnabled();
  expect(screenPicker).toHaveValue("lot");
  const id = screen.getByRole("textbox", { name: "Lot id" });
  expect(id).toBeEnabled();
  expect(id).toHaveAttribute("placeholder", "CR-0001");
  expect(screen.getByRole("button", { name: "Open" })).toBeEnabled();
}

/** Talk, granted microphone, a token, and the SDK's onConnect: the session is live. */
async function goLive() {
  fireEvent.click(talkButton());
  await waitFor(() => expect(sdk.starts).toHaveLength(1));
  act(() => sdk.starts[0]?.onConnect?.({ conversationId: "conv_1" }));
  expect(status()).toHaveTextContent("Listening.");
  return sdk.starts[0] as StartOptions;
}

describe("voice panel", () => {
  test("keeps the typed fallback visible and enabled in every voice state", async () => {
    // Outside a provider: unavailable/service, and the fallback still works.
    render(<VoicePanel organisationId="lender-one" sections={SECTIONS} />);
    expect(status()).toHaveTextContent(UNAVAILABLE);
    expectFallbackEnabled();
    cleanup();

    let answer: (response: Response) => void = () => {};
    replies.push((call) =>
      call.url === "/v1/conversations/session" && sessionCalls().length === 1
        ? new Promise<Response>((resolve) => {
            answer = resolve;
          })
        : undefined,
    );
    renderPanel();
    expect(screen.getByRole("heading", { name: "Voice" })).toBeInTheDocument();
    expect(talkButton()).toHaveAccessibleName("Talk to the Thetis navigator");
    expect(talkButton()).toHaveTextContent("Talk");
    expect(status()).toHaveTextContent("Ask to open a screen, or what evidence a lot has.");
    expectFallbackEnabled();

    fireEvent.click(talkButton());
    await waitFor(() => expect(status()).toHaveTextContent("Starting voice."));
    expect(talkButton()).toHaveAccessibleName("Connecting to voice");
    expect(talkButton()).toHaveTextContent("Connecting");
    expect(talkButton()).toHaveAttribute("aria-disabled", "true");
    expectFallbackEnabled();
    // Talk while connecting is ignored: no second token is asked for.
    fireEvent.click(talkButton());
    await waitFor(() => expect(sessionCalls()).toHaveLength(1));

    answer(
      json(200, {
        data: {
          conversationToken: "synthetic-conversation-token-1",
          conversationId: "c",
          agentId: "a",
        },
      }),
    );
    await waitFor(() => expect(sdk.starts).toHaveLength(1));
    expect(sdk.starts[0]?.conversationToken).toBe("synthetic-conversation-token-1");
    act(() => sdk.starts[0]?.onConnect?.({ conversationId: "c" }));
    expect(talkButton()).toHaveAccessibleName("End voice session");
    expect(talkButton()).toHaveTextContent("End");
    expect(status()).toHaveTextContent("Listening.");
    expectFallbackEnabled();
    act(() => sdk.starts[0]?.onModeChange?.({ mode: "speaking" }));
    expect(status()).toHaveTextContent("Speaking.");
    expectFallbackEnabled();

    // A drop with an error: unavailable, and Talk tries again.
    act(() => sdk.starts[0]?.onDisconnect?.({ reason: "error", message: "lost" }));
    expect(status()).toHaveTextContent(UNAVAILABLE);
    expect(talkButton()).toHaveAccessibleName("Try voice again");
    expect(talkButton()).toHaveTextContent("Talk");
    expectFallbackEnabled();
  });

  test("shows Voice is unavailable. Use the controls below. when the session route fails", async () => {
    for (const reply of [
      () => json(503, { error: { code: "VOICE_UNAVAILABLE", message: "Voice is unavailable." } }),
      () => json(401, { error: { code: "NOT_AUTHENTICATED", message: "Sign in." } }),
      () => Promise.reject(new TypeError("Failed to fetch")),
    ]) {
      replies = [(call) => (call.url === "/v1/conversations/session" ? reply() : undefined)];
      renderPanel();
      fireEvent.click(talkButton());
      await waitFor(() => expect(status()).toHaveTextContent(UNAVAILABLE));
      expect(status().textContent).toBe(UNAVAILABLE);
      expect(sdk.starts).toHaveLength(0);
      expectFallbackEnabled();
      cleanup();
    }
    // Signed out: no session to ask with, so nothing is sent and voice is unavailable.
    replies = [];
    calls.length = 0;
    mocks.session = null;
    renderPanel();
    fireEvent.click(talkButton());
    await waitFor(() => expect(status()).toHaveTextContent(UNAVAILABLE));
    expect(sessionCalls()).toHaveLength(0);
    expect(sdk.starts).toHaveLength(0);
  });

  test("fetches one new token when the first is refused, and never a third", async () => {
    renderPanel();
    fireEvent.click(talkButton());
    await waitFor(() => expect(sdk.starts).toHaveLength(1));
    expect(sessionCalls()[0]).toMatchObject({
      method: "POST",
      auth: "Bearer synthetic-token",
      body: null,
    });
    expect(sdk.starts[0]?.conversationToken).toBe("synthetic-conversation-token-1");
    // startSession rejects the first token: one re-fetch.
    act(() => sdk.starts[0]?.onError?.("token expired"));
    await waitFor(() => expect(sdk.starts).toHaveLength(2));
    expect(status()).toHaveTextContent("Getting a new voice session.");
    expect(talkButton()).toHaveAccessibleName("Connecting to voice");
    expect(sdk.starts[1]?.conversationToken).toBe("synthetic-conversation-token-2");
    // A second rejection: unavailable, and no third token.
    act(() => sdk.starts[1]?.onError?.("token expired"));
    await waitFor(() => expect(status()).toHaveTextContent(UNAVAILABLE));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sessionCalls()).toHaveLength(2);
    expect(sdk.starts).toHaveLength(2);
    // A late error from the first attempt changes nothing.
    act(() => sdk.starts[0]?.onError?.("late"));
    expect(sessionCalls()).toHaveLength(2);

    // Talk again asks for a fresh token; neither earlier one is reused.
    fireEvent.click(talkButton());
    await waitFor(() => expect(sdk.starts).toHaveLength(3));
    expect(sdk.starts[2]?.conversationToken).toBe("synthetic-conversation-token-3");
    act(() => sdk.starts[2]?.onConnect?.({ conversationId: "conv_3" }));
    expect(status()).toHaveTextContent("Listening.");
    // End, then Talk: another fresh token.
    fireEvent.click(talkButton());
    expect(sdk.ends).toBeGreaterThanOrEqual(1);
    expect(status()).toHaveTextContent("Ask to open a screen, or what evidence a lot has.");
    fireEvent.click(talkButton());
    await waitFor(() => expect(sdk.starts).toHaveLength(4));
    expect(new Set(sdk.starts.map(({ conversationToken }) => conversationToken)).size).toBe(4);
  });

  test("shows the microphone line when the browser refuses the microphone", async () => {
    microphone = () => Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
    renderPanel();
    fireEvent.click(talkButton());
    await waitFor(() => expect(status()).toHaveTextContent(UNAVAILABLE));
    expect(status()).toHaveTextContent(
      "Microphone access is off for this site. Allow it in the browser, then press Talk.",
    );
    expect(talkButton()).toHaveAccessibleName("Try voice again");
    expect(sessionCalls()).toHaveLength(0);
    expect(sdk.starts).toHaveLength(0);
    expectFallbackEnabled();

    // Granted on the next Talk: the tracks are stopped at once, then the token is asked for.
    microphone = async () => ({ getTracks: () => [{ stop }] });
    fireEvent.click(talkButton());
    await waitFor(() => expect(sdk.starts).toHaveLength(1));
    expect(stop).toHaveBeenCalled();
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenLastCalledWith({ audio: true });
  });

  test("opens a screen from the typed fallback and shows the refusal message under Open", async () => {
    renderPanel();
    const picker = screen.getByRole("combobox", { name: "Open a screen" });
    const id = screen.getByRole("textbox", { name: "Lot id" });
    const open = screen.getByRole("button", { name: "Open" });
    expect(
      within(picker)
        .getAllByRole("option")
        .map((option) => [option.getAttribute("value"), option.textContent]),
    ).toEqual([
      ["queue", "Work queue"],
      ["exceptions", "Exceptions"],
      ["lot", "Lot"],
      ["release", "Release"],
      ["account", "Your account"],
    ]);

    fireEvent.change(picker, { target: { value: "exceptions" } });
    expect(id).toBeDisabled();
    fireEvent.click(open);
    expect(mocks.push).toHaveBeenLastCalledWith("/lender-one/exceptions");

    fireEvent.change(picker, { target: { value: "release" } });
    expect(id).toBeEnabled();
    fireEvent.change(id, { target: { value: "CR-0002" } });
    fireEvent.click(open);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Lot CR-0002 has more than one release. Choose one under Releases.",
    );
    expect(mocks.push).toHaveBeenCalledTimes(1);
    // The next change clears it.
    fireEvent.change(id, { target: { value: "CR-0001" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(open);
    expect(mocks.push).toHaveBeenLastCalledWith(`/lender-one/releases/${RELEASE_ONE}`);

    fireEvent.change(picker, { target: { value: "lot" } });
    fireEvent.change(id, { target: { value: "CR-0009" } });
    fireEvent.click(open);
    expect(screen.getByRole("alert")).toHaveTextContent("Lot CR-0009 is not in this workspace.");
    fireEvent.change(id, { target: { value: "not a lot" } });
    fireEvent.click(open);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "That is not a lot id. Lot ids look like CR-0001.",
    );
    // Enter in the id field is Open.
    fireEvent.change(id, { target: { value: "cr-0002" } });
    fireEvent.submit(id.closest("form") as HTMLFormElement);
    expect(mocks.push).toHaveBeenLastCalledWith("/lender-one/lots/CR-0002");

    fireEvent.change(picker, { target: { value: "account" } });
    fireEvent.click(open);
    expect(mocks.push).toHaveBeenLastCalledWith("/account");
    expect(mocks.push).toHaveBeenCalledTimes(4);
  });

  test("navigate_to pushes only a resolved route and speaks a refusal's message", async () => {
    renderPanel();
    const options = await goLive();
    const tools = options.clientTools ?? {};
    expect(Object.keys(tools).sort()).toEqual(["get_lot_evidence", "navigate_to"]);

    const ok = await act(async () => tools.navigate_to?.({ screen: "lot", id: "CR-0001" }));
    expect(JSON.parse(String(ok))).toEqual({ ok: true, screen: "lot" });
    expect(mocks.push).toHaveBeenLastCalledWith("/lender-one/lots/CR-0001");

    const refused = await act(async () =>
      tools.navigate_to?.({ screen: "release", id: "CR-0003" }),
    );
    expect(JSON.parse(String(refused))).toEqual({
      ok: false,
      reason: "NOT_FOUND",
      message: "There is no release for lot CR-0003 in this workspace.",
    });
    expect(status()).toHaveTextContent("There is no release for lot CR-0003 in this workspace.");
    const many = await act(async () => tools.navigate_to?.({ screen: "release", id: "CR-0002" }));
    expect(JSON.parse(String(many))).toMatchObject({ reason: "MANY_RELEASES" });
    const bad = await act(async () => tools.navigate_to?.({ screen: "lot", id: "bad id" }));
    expect(JSON.parse(String(bad))).toMatchObject({ reason: "BAD_ID" });
    const unknown = await act(async () => tools.navigate_to?.({ screen: "settings" }));
    expect(JSON.parse(String(unknown))).toMatchObject({ reason: "UNKNOWN_SCREEN" });
    expect(mocks.push).toHaveBeenCalledTimes(1);

    // get_lot_evidence: a bad id never reaches the API; a good one returns the API's data.
    const badLookup = await act(async () => tools.get_lot_evidence?.({ lot_id: "no good" }));
    expect(JSON.parse(String(badLookup))).toEqual({
      ok: false,
      reason: "BAD_ID",
      message: "That is not a lot id. Lot ids look like CR-0001.",
    });
    expect(calls.some(({ url }) => url.startsWith("/v1/voice/"))).toBe(false);
    replies.push((call) =>
      call.url === "/v1/voice/lots/CR-0001/evidence"
        ? json(200, {
            data: {
              lotId: "CR-0001",
              items: [
                {
                  purpose: "bank",
                  version: 1,
                  finalizedAt: "2026-11-26T00:00:00.000Z",
                  sha256Prefix: "5a5a5a5a5a5a",
                },
              ],
              observedAt: "2026-11-28T10:00:00.000Z",
            },
          })
        : undefined,
    );
    const found = await act(async () => tools.get_lot_evidence?.({ lot_id: "cr-0001" }));
    expect(JSON.parse(String(found))).toMatchObject({
      lotId: "CR-0001",
      items: [{ purpose: "bank" }],
    });
    expect(calls.find(({ url }) => url === "/v1/voice/lots/CR-0001/evidence")?.auth).toBe(
      "Bearer synthetic-token",
    );
    const missing = await act(async () => tools.get_lot_evidence?.({ lot_id: "CR-0002" }));
    expect(JSON.parse(String(missing))).toEqual({ ok: false, reason: "NOT_FOUND" });
    expect(mocks.push).toHaveBeenCalledTimes(1);
  });

  test("drops a tool result that arrives after the session ended", async () => {
    renderPanel();
    const options = await goLive();
    const tools = options.clientTools ?? {};
    let answer: (response: Response) => void = () => {};
    replies.push((call) =>
      call.url === "/v1/voice/lots/CR-0001/evidence"
        ? new Promise<Response>((resolve) => {
            answer = resolve;
          })
        : undefined,
    );
    const pending = tools.get_lot_evidence?.({ lot_id: "CR-0001" }) as Promise<unknown>;
    await waitFor(() =>
      expect(calls.some(({ url }) => url === "/v1/voice/lots/CR-0001/evidence")).toBe(true),
    );
    // End while the lookup is out.
    fireEvent.click(talkButton());
    expect(sdk.ends).toBe(1);
    expect(status()).toHaveTextContent("Ask to open a screen, or what evidence a lot has.");
    answer(json(404, { error: { code: "NOT_FOUND", message: "Not found." } }));
    await act(async () => {
      expect(await pending).toBeUndefined();
    });
    expect(status()).toHaveTextContent("Ask to open a screen, or what evidence a lot has.");
    // A navigate_to from the ended session moves nothing and returns nothing.
    const late = await act(async () => tools.navigate_to?.({ screen: "queue" }));
    expect(late).toBeUndefined();
    expect(mocks.push).not.toHaveBeenCalled();

    // The agent's end_call (a clean disconnect) returns to idle, and its tools are dropped too.
    cleanup();
    sdk.starts.length = 0;
    renderPanel();
    const second = await goLive();
    act(() => second.onDisconnect?.({ reason: "agent" }));
    expect(status()).toHaveTextContent("Ask to open a screen, or what evidence a lot has.");
    expect(
      await act(async () => second.clientTools?.navigate_to?.({ screen: "queue" })),
    ).toBeUndefined();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  test("ends the session when the provider unmounts", async () => {
    const view = renderPanel();
    const options = await goLive();
    view.unmount();
    expect(sdk.ends).toBe(1);
    expect(await options.clientTools?.navigate_to?.({ screen: "queue" })).toBeUndefined();
    expect(mocks.push).not.toHaveBeenCalled();
  });
});
