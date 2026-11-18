import { address, blockhash, getCompiledTransactionMessageEncoder } from "@solana/kit";
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
const expectedAddress = address(encodeBase58(key));
const authorizationBase64 = encodeBase64(
  getCompiledTransactionMessageEncoder().encode({
    version: "legacy",
    header: {
      numSignerAccounts: 1,
      numReadonlySignerAccounts: 0,
      numReadonlyNonSignerAccounts: 0,
    },
    staticAccounts: [expectedAddress],
    lifetimeToken: blockhash("11111111111111111111111111111111"),
    instructions: [],
  }),
);
const intent = {
  role: "sender",
  expectedAddress,
  authorizationBase64,
  authorizationSha256: "a".repeat(64),
  network: "devnet",
  intent: {
    text: "Synthetic test data.",
    batchId: "0123456789abcdef0123456789abcdef",
    quantityKg: "2000000",
    from: "Kopano Stockyard Custody",
    to: "Mosela Haulage",
    expirySlot: 9001,
    expectedSequence: 0,
  },
};
const authorize = vi.fn().mockResolvedValue({
  accounts: [{ address: encodeBase64(key) }],
  auth_token: "token",
  wallet_uri_base: "",
});
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
  await press("Sign as message");

  const { buttons, text } = inspectScreen();
  expect(text).toContain("Intent changed. Reload it.");
  expect(text).not.toContain(intent.intent.text);
  expect(buttons.get("Sign as message")?.disabled).toBe(true);
  expect(fetchRelay.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
    "/intent",
    "/intent",
    "/intent",
    "/intent",
    "/signature",
  ]);
  expect(JSON.parse(fetchRelay.mock.lastCall?.[1].body)).toMatchObject({
    authorizationSha256: intent.authorizationSha256,
  });
});

it.each(["refreshed", "expired"])(
  "does not prompt or submit when /intent reports %s bytes after wallet authorization",
  async (change) => {
    const latest =
      change === "refreshed"
        ? { ...intent, authorizationSha256: "b".repeat(64) }
        : { verified: false, reason: "INTENT_EXPIRED" };
    fetchRelay
      .mockResolvedValueOnce(Response.json(intent))
      .mockResolvedValueOnce(Response.json(intent))
      .mockResolvedValueOnce(Response.json(latest));
    await press("Connect wallet");
    await press("Load intent");
    await press("Sign as message");

    expect(authorize).toHaveBeenCalledTimes(2);
    expect(signMessages).not.toHaveBeenCalled();
    expect(fetchRelay).toHaveBeenCalledTimes(3);
    expect(inspectScreen().text).not.toContain(intent.intent.text);
  },
);

it("rechecks freshness after signing and discards a signature for superseded bytes", async () => {
  fetchRelay
    .mockResolvedValueOnce(Response.json(intent))
    .mockResolvedValueOnce(Response.json(intent))
    .mockResolvedValueOnce(Response.json(intent))
    .mockResolvedValueOnce(Response.json({ ...intent, authorizationSha256: "b".repeat(64) }));
  await press("Connect wallet");
  await press("Load intent");
  await press("Sign as message");

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
  await press("Sign as message");
  expect(inspectScreen().text).toContain("Run adb reverse");
  expect(inspectScreen().text).not.toContain("Wallet refused");
  expect(signMessages).not.toHaveBeenCalled();

  signMessages.mockRejectedValueOnce(new Error("User cancelled signing"));
  await press("Sign as message");
  expect(inspectScreen().text).toContain("Wallet refused User cancelled signing");
});

it("shows a payload mismatch alongside the relay's verification of the parsed signature", async () => {
  signMessages.mockResolvedValue({ signed_payloads: [encodeBase64(new Uint8Array(65))] });
  fetchRelay.mockImplementation(async (url: string) =>
    Response.json(url.endsWith("/signature") ? { verified: true } : intent),
  );
  await press("Connect wallet");
  await press("Load intent");
  await press("Sign as message");

  const { text } = inspectScreen();
  expect(text).toContain("Payload mismatch");
  expect(text).toContain("Received 65 bytes");
  expect(text).toContain("Verified over exact bytes: yes");
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
      authorizationSha256: `${fingerprint}${"b".repeat(56)}`,
      signature: "otherDevnetSignature",
      checks: { sender: { message: { verified: true } }, receiver: {} },
    };
    fetchRelay.mockImplementation(async () => Response.json(otherOutcome));
    const startPolling = screen.effect as () => () => void;
    const stopPolling = startPolling();
    try {
      await vi.waitFor(() =>
        expect(inspectScreen().text).toContain(`Outcome Authorization SHA-256 ${fingerprint}`),
      );
      const { text } = inspectScreen();
      expect(text).toContain("This outcome is for different bytes than the intent on this screen");
      expect(text).not.toContain("confirmed");
      expect(text).not.toContain("otherDevnetSignature");
      expect(text).not.toContain("Verified over exact bytes: yes");
    } finally {
      stopPolling();
    }
  },
);

it.each([
  { binding: "matching", digest: intent.authorizationSha256, expected: "confirmed" },
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
        authorizationSha256: digest,
        checks: { sender: { message: { verified: true } }, receiver: {} },
      }),
    );
    const startPolling = screen.effect as () => () => void;
    const stopPolling = startPolling();
    try {
      await vi.waitFor(() => expect(inspectScreen().text).toContain(expected));
      expect(inspectScreen().text.includes("Verified over exact bytes: yes")).toBe(
        digest !== undefined,
      );
    } finally {
      stopPolling();
    }
  },
);
