import { type MobileWallet, transact } from "@solana-mobile/mobile-wallet-adapter-protocol";
import { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "../App";
import { encodeBase58, encodeBase64 } from "../src/lib/encoding";

vi.mock("@solana-mobile/mobile-wallet-adapter-protocol", () => ({ transact: vi.fn() }));
vi.mock("expo-status-bar", () => ({ StatusBar: "StatusBar" }));
vi.mock("react-native", () => ({
  Button: "Button",
  ScrollView: "ScrollView",
  StatusBar: {},
  StyleSheet: { create: (styles: unknown) => styles },
  Text: "Text",
  View: "View",
}));

// Run the screen with persistent state and explicitly control when its polling effect starts.
const screen = vi.hoisted(() => ({ state: [] as unknown[], cursor: 0, effect: () => {} }));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState(initial: unknown) {
    const index = screen.cursor++;
    if (index >= screen.state.length) screen.state[index] = initial;
    return [
      screen.state[index],
      (next: unknown) => {
        screen.state[index] = next;
      },
    ];
  },
  useRef(initial: unknown) {
    const index = screen.cursor++;
    if (index >= screen.state.length) screen.state[index] = { current: initial };
    return screen.state[index];
  },
  useEffect(effect: () => void) {
    screen.effect = effect;
  },
}));

const key = new Uint8Array(32).fill(7);
const otherKey = new Uint8Array(32).fill(8);
const expectedAddress = encodeBase58(key);
const messageText = "Thetis authorisation v1\nTest network only. Synthetic data.";
const messageBase64 = Buffer.from(messageText).toString("base64");
const intent = {
  role: "sender",
  expectedAddress,
  messageBase64,
  messageText,
  messageSha256: "a".repeat(64),
  validUntil: "1795098725",
  validUntilText: "2026-11-19 16:32:05 SAST",
  expectedSequence: "0",
  network: "devnet",
};
const authorization = {
  accounts: [{ address: encodeBase64(key) }],
  auth_token: "token",
  wallet_uri_base: "",
};
const authorize = vi.fn();
const signMessages = vi.fn();
const fetchRelay = vi.fn();

type Props = {
  children?: ReactNode;
  title?: string;
  onPress?: () => void;
  disabled?: boolean;
};

function inspectScreen() {
  screen.cursor = 0;
  const buttons = new Map<string, Props>();
  const text: string[] = [];
  function visit(node: ReactNode) {
    if (Array.isArray(node)) {
      node.forEach(visit);
    } else if (isValidElement<Props>(node)) {
      if (node.type === "Button" && node.props.title) {
        buttons.set(node.props.title, node.props);
      } else if (typeof node.type === "function") {
        visit((node.type as (props: Props) => ReactNode)(node.props));
      } else {
        visit(node.props.children);
      }
    } else if (typeof node === "string") {
      text.push(node);
    }
  }
  visit(App());
  return { buttons, text: text.join(" ") };
}

async function press(title: string) {
  const button = inspectScreen().buttons.get(title);
  expect(button?.disabled).toBe(false);
  button?.onPress?.();
  await vi.waitFor(() => expect(inspectScreen().buttons.get("Load intent")?.disabled).toBe(false));
}

beforeEach(() => {
  screen.state = [];
  vi.clearAllMocks();
  authorize.mockResolvedValue(authorization);
  const wallet: Partial<MobileWallet> = { authorize, signMessages };
  vi.mocked(transact).mockImplementation(async (callback) => callback(wallet as MobileWallet));
  signMessages.mockResolvedValue({ signed_payloads: [encodeBase64(new Uint8Array(64))] });
  fetchRelay.mockImplementation(async () => Response.json(intent));
  vi.stubGlobal("fetch", fetchRelay);
});

afterEach(() => vi.unstubAllGlobals());

it("clears the loaded intent and asks for a reload when the relay refuses STALE_INTENT", async () => {
  fetchRelay.mockImplementation(async (url: string) =>
    Response.json(
      url.endsWith("/signature") ? { verified: false, reason: "STALE_INTENT" } : intent,
    ),
  );
  await press("Connect wallet");
  await press("Load intent");
  await press("Sign");

  const { buttons, text } = inspectScreen();
  expect(text).toContain("Intent changed. Reload it.");
  expect(text).not.toContain(intent.messageText);
  expect(buttons.get("Sign")?.disabled).toBe(true);
  expect(fetchRelay.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
    "/intent",
    "/intent",
    "/intent",
    "/intent",
    "/signature",
  ]);
  expect(JSON.parse(fetchRelay.mock.lastCall?.[1].body)).toMatchObject({
    messageSha256: intent.messageSha256,
  });
});

it.each(["refreshed", "completed"])(
  "does not prompt or submit when /intent reports %s bytes after wallet authorization",
  async (change) => {
    const latest =
      change === "refreshed"
        ? { ...intent, messageSha256: "b".repeat(64) }
        : { verified: false, reason: "BATCH_COMPLETE" };
    fetchRelay
      .mockResolvedValueOnce(Response.json(intent))
      .mockResolvedValueOnce(Response.json(intent))
      .mockResolvedValueOnce(Response.json(latest, { status: change === "refreshed" ? 200 : 409 }));
    await press("Connect wallet");
    await press("Load intent");
    await press("Sign");

    expect(authorize).toHaveBeenCalledTimes(2);
    expect(signMessages).not.toHaveBeenCalled();
    expect(fetchRelay).toHaveBeenCalledTimes(3);
    expect(inspectScreen().text).not.toContain(intent.messageText);
  },
);

it("rechecks freshness after signing and discards a signature for superseded bytes", async () => {
  fetchRelay
    .mockResolvedValueOnce(Response.json(intent))
    .mockResolvedValueOnce(Response.json(intent))
    .mockResolvedValueOnce(Response.json(intent))
    .mockResolvedValueOnce(Response.json({ ...intent, messageSha256: "b".repeat(64) }));
  await press("Connect wallet");
  await press("Load intent");
  await press("Sign");

  expect(signMessages).toHaveBeenCalledOnce();
  expect(fetchRelay.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
    "/intent",
    "/intent",
    "/intent",
    "/intent",
  ]);
  expect(inspectScreen().text).toContain("Intent changed. Reload it.");
});

it("reports a relay failure during wallet authorization separately from wallet cancellation", async () => {
  await press("Connect wallet");
  await press("Load intent");
  fetchRelay
    .mockResolvedValueOnce(Response.json(intent))
    .mockRejectedValueOnce(new Error("Offline"));
  await press("Sign");
  expect(inspectScreen().text).toContain("Run adb reverse");
  expect(inspectScreen().text).not.toContain("Wallet refused");
  expect(signMessages).not.toHaveBeenCalled();

  signMessages.mockRejectedValueOnce(new Error("User cancelled signing"));
  await press("Sign");
  expect(inspectScreen().text).toContain("Wallet refused User cancelled signing");
});

it("shows a payload mismatch alongside the relay's verification of the parsed signature", async () => {
  signMessages.mockResolvedValue({ signed_payloads: [encodeBase64(new Uint8Array(65))] });
  fetchRelay.mockImplementation(async (url: string) =>
    Response.json(url.endsWith("/signature") ? { verified: true } : intent),
  );
  await press("Connect wallet");
  await press("Load intent");
  await press("Sign");

  const { text } = inspectScreen();
  expect(text).toContain("Payload mismatch");
  expect(text).toContain("Received 65 bytes");
  expect(text).toContain("Verified over exact text: yes");
  expect(text).not.toContain("Wallet refused");
  expect(JSON.parse(fetchRelay.mock.lastCall?.[1].body)).toMatchObject({
    signatureBase58: "1".repeat(64),
  });
});

it.each(["bbbbbbbb", "aaaaaaaa"])(
  "shows the outcome fingerprint %s and hides results for a different full digest",
  async (fingerprint) => {
    await press("Load intent");
    // A matching eight-character fingerprint still requires comparing the full digest.
    const otherOutcome = {
      state: "confirmed",
      activeMessageSha256: intent.messageSha256,
      submittedMessageSha256: `${fingerprint}${"b".repeat(56)}`,
      signature: "otherDevnetSignature",
      checks: { sender: { verified: true } },
    };
    fetchRelay.mockImplementation(async () => Response.json(otherOutcome));
    const startPolling = screen.effect as () => () => void;
    const stopPolling = startPolling();
    try {
      await vi.waitFor(() =>
        expect(inspectScreen().text).toContain(`Outcome Message SHA-256 ${fingerprint}`),
      );
      const { text } = inspectScreen();
      expect(text).toContain("This outcome is for different bytes than the intent on this screen");
      expect(text).not.toContain("confirmed");
      expect(text).not.toContain("otherDevnetSignature");
      expect(text).not.toContain("Verified over exact text: yes");
    } finally {
      stopPolling();
    }
  },
);

it.each([
  { binding: "matching", digest: intent.messageSha256, expected: "confirmed" },
  {
    binding: "missing",
    digest: undefined,
    expected: "Waiting for an outcome for the loaded intent",
  },
])(
  "shows '$expected' for a relay confirmation with a $binding digest",
  async ({ digest, expected }) => {
    await press("Load intent");
    fetchRelay.mockImplementation(async () =>
      Response.json({
        state: "confirmed",
        activeMessageSha256: intent.messageSha256,
        submittedMessageSha256: digest,
        checks: { sender: { verified: true } },
      }),
    );
    const startPolling = screen.effect as () => () => void;
    const stopPolling = startPolling();
    try {
      await vi.waitFor(() => expect(inspectScreen().text).toContain(expected));
      const { text } = inspectScreen();
      expect(text).toContain("Verified over exact text: yes");
      expect(text.includes("confirmed")).toBe(digest !== undefined);
    } finally {
      stopPolling();
    }
  },
);

it("shows the full text and fingerprint with one signing action", async () => {
  await press("Connect wallet");
  await press("Load intent");
  const { buttons, text } = inspectScreen();
  expect(text).toContain(messageText);
  expect(text).toContain("Message SHA-256 aaaaaaaa");
  expect([...buttons.keys()].filter((label) => label.startsWith("Sign"))).toEqual(["Sign"]);
});

it.each([
  { binding: "different", digest: "b".repeat(64) },
  { binding: "missing", digest: undefined },
])(
  "clears a completed intent with a $binding submitted digest before signing",
  async ({ digest }) => {
    await press("Connect wallet");
    await press("Load intent");
    fetchRelay.mockImplementation(async (url: string) =>
      Response.json(
        url.endsWith("/outcome")
          ? {
              state: "confirmed",
              activeMessageSha256: intent.messageSha256,
              submittedMessageSha256: digest,
              checks: {},
            }
          : { verified: false, reason: "BATCH_COMPLETE" },
        { status: url.endsWith("/outcome") ? 200 : 409 },
      ),
    );
    await press("Sign");

    expect(fetchRelay.mock.lastCall?.[0]).toContain("/intent");
    expect(authorize).toHaveBeenCalledOnce();
    expect(signMessages).not.toHaveBeenCalled();
    const { text } = inspectScreen();
    expect(text).toContain("This batch is complete. Ask the operator for a fresh batch.");
    expect(text).not.toContain(intent.messageText);
  },
);

it.each([
  { binding: "matching", digest: intent.messageSha256, visible: true },
  { binding: "different", digest: "b".repeat(64), visible: false },
])(
  "shows both phones' waiting checks only for a matching active digest ($binding)",
  async ({ digest, visible }) => {
    await press("Load intent");
    fetchRelay.mockImplementation(async () =>
      Response.json({
        state: "waiting",
        activeMessageSha256: digest,
        checks: {
          sender: { verified: true },
          receiver: { verified: false, reason: "BAD_SIGNATURE" },
        },
      }),
    );
    const startPolling = screen.effect as () => () => void;
    const stopPolling = startPolling();
    try {
      await vi.waitFor(() => {
        const { text } = inspectScreen();
        expect(text).toContain(
          visible ? "waiting" : "Waiting for an outcome for the loaded intent",
        );
        expect(text.includes("Verified over exact text: yes")).toBe(visible);
        expect(text.includes("Verified over exact text: no")).toBe(visible);
      });
    } finally {
      stopPolling();
    }
  },
);

it("selects a matching secondary authorized account when the intent loads without reconnecting", async () => {
  const otherAddress = encodeBase58(otherKey);
  authorize.mockResolvedValue({
    ...authorization,
    accounts: [{ address: encodeBase64(otherKey) }, ...authorization.accounts],
  });
  await press("Connect wallet");
  expect(inspectScreen().text).toContain(otherAddress);
  await press("Load intent");

  const { text } = inspectScreen();
  expect(text).toContain(`Authorized address ${expectedAddress}`);
  expect(text).not.toContain(otherAddress);
  expect(text).not.toContain("The authorized address does not match this role.");
  expect(authorize).toHaveBeenCalledOnce();

  fetchRelay.mockImplementation(async (url: string) =>
    Response.json(url.endsWith("/signature") ? { verified: true } : intent),
  );
  await press("Sign");
  expect(signMessages).toHaveBeenCalledWith({
    addresses: [encodeBase64(key)],
    payloads: [messageBase64],
  });
});

it("warns and disables signing when none of the authorized accounts match the loaded intent", async () => {
  authorize.mockResolvedValue({
    ...authorization,
    accounts: [
      { address: encodeBase64(otherKey) },
      { address: encodeBase64(new Uint8Array(32).fill(9)) },
    ],
  });
  await press("Connect wallet");
  await press("Load intent");
  const { buttons, text } = inspectScreen();
  expect(text).toContain("The authorized address does not match this role.");
  expect(buttons.get("Sign")?.disabled).toBe(true);
  expect(buttons.has("Sign as transaction")).toBe(false);
});

it("polls every three seconds and shows an unknown outcome with both checks and transaction details", async () => {
  fetchRelay.mockImplementation(async () =>
    Response.json({
      state: "unknown",
      activeMessageSha256: intent.messageSha256,
      submittedMessageSha256: intent.messageSha256,
      signature: "pendingSignature",
      sizeBytes: 900,
      checks: {
        sender: { verified: true },
        receiver: { verified: true },
      },
    }),
  );
  inspectScreen();
  vi.useFakeTimers();
  const startPolling = screen.effect as () => () => void;
  const stopPolling = startPolling();
  try {
    await vi.advanceTimersByTimeAsync(2_999);
    expect(fetchRelay).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchRelay).toHaveBeenCalledTimes(2);
    const { text } = inspectScreen();
    expect(text).toContain("Outcome unknown: check the explorer");
    expect(text).toContain("pendingSignature");
    expect(text).toContain("Size: 900 bytes");
    expect(text.match(/Verified over exact text: yes/g)).toHaveLength(2);
  } finally {
    stopPolling();
    vi.useRealTimers();
  }
});
