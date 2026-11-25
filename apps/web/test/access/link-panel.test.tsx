import "@testing-library/jest-dom/vitest";
import { verify } from "node:crypto";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { getWallets } from "@wallet-standard/app";
import bs58 from "bs58";
import { afterEach, beforeEach, expect, type Mock, test, vi } from "vitest";
import { LinkPanel, type LinkPanelProps } from "@/components/access/link-panel";
import { accessMessages } from "@/lib/access-messages";
import type { ApiErrorCode, ApiResult } from "@/lib/api";
import { formatClockTime } from "@/lib/format";
import { type FakeWallet, fakeWallet } from "./fake-wallet";

const api = vi.hoisted(() => ({ apiPost: vi.fn() }));
vi.mock("@/lib/api", () => api);

const messages = accessMessages.link;
const ORG = { id: "o-1", name: "Lender One Bank" };
const ORG_TWO = { id: "o-2", name: "Terminal Two" };
const TOKEN = "access-token-1";
const EXPIRES_AT = "2099-11-23T12:46:07.218Z";
const TIME = formatClockTime(EXPIRES_AT);

function messageFor(address: string, extra = "") {
  return [
    "localhost:3100 wants you to link a Solana wallet to Thetis.",
    "",
    `Wallet: ${address}`,
    `Organisation: lender-one${extra}`,
    "Action: link_wallet",
    "Nonce: f75bb6106f1d054bbc3df08d6dde348b",
    "Issued At: 2026-11-23T12:41:07.218Z",
    `Expiration Time: ${EXPIRES_AT}`,
  ].join("\n");
}

const unregister: (() => void)[] = [];
let solflare: FakeWallet;

function install(fake: FakeWallet) {
  unregister.push(getWallets().register(fake.wallet));
}

function ok<T>(data: T): ApiResult<T> {
  return { ok: true, data };
}

function failure(code: ApiErrorCode | "NETWORK", status: number): ApiResult<never> {
  return { ok: false, code, status };
}

type Routes = {
  challenge?: () => Promise<ApiResult<unknown>> | ApiResult<unknown>;
  link?: () => Promise<ApiResult<unknown>> | ApiResult<unknown>;
};

function route(routes: Routes) {
  api.apiPost.mockImplementation(async (path: string) => {
    if (path === "/v1/wallet-links/challenges") return routes.challenge?.();
    if (path === "/v1/wallet-links") return routes.link?.();
    throw new Error(`unexpected path ${path}`);
  });
}

function issued(address = solflare.account.address) {
  return ok({ challengeId: "c-1", message: messageFor(address), expiresAt: EXPIRES_AT });
}

function linkedFor(organisationId = ORG.id) {
  return ok({ linkId: "link-1", wallet: solflare.account.address, organisationId });
}

function pending<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const getAccessToken = vi.fn(async (): Promise<string | null> => TOKEN);

type Spies = {
  reloadLinks: Mock;
  reloadMemberships: Mock;
  onSessionExpired: Mock;
};

function renderPanel(overrides: Partial<LinkPanelProps> = {}) {
  const spies: Spies = {
    reloadLinks: vi.fn(async () => []),
    reloadMemberships: vi.fn(),
    onSessionExpired: vi.fn(),
  };
  const view = render(
    <LinkPanel getAccessToken={getAccessToken} memberships={[ORG]} {...spies} {...overrides} />,
  );
  return { ...view, ...spies };
}

const connectButton = (name: string) => screen.findByRole("button", { name: `Connect ${name}` });

async function toReady() {
  fireEvent.click(await connectButton("Solflare"));
  await screen.findByRole("button", { name: "Sign with Solflare" });
}

// The change listener is attached in an effect, which can land just after the button appears.
async function toReadySubscribed() {
  await toReady();
  await waitFor(() => expect(solflare.listeners.size).toBe(1));
}

async function toLinkedAttempt() {
  await toReady();
  fireEvent.click(screen.getByRole("button", { name: "Sign with Solflare" }));
}

beforeEach(() => {
  api.apiPost.mockReset();
  getAccessToken.mockClear();
  solflare = fakeWallet("Solflare");
  route({ challenge: () => issued(), link: () => linkedFor() });
});

afterEach(() => {
  cleanup();
  for (const off of unregister.splice(0)) off();
  vi.useRealTimers();
});

test("link panel: no qualifying wallet shows the install link, and a later register moves to Choose", async () => {
  renderPanel();
  expect(await screen.findByText(messages.noWallet)).toBeVisible();
  expect(screen.getByRole("link", { name: "Get Solflare" })).toHaveAttribute(
    "href",
    "https://solflare.com/download",
  );
  expect(screen.queryByRole("button", { name: /^Connect/ })).not.toBeInTheDocument();

  act(() => install(solflare));
  expect(await connectButton("Solflare")).toBeVisible();
  expect(screen.queryByText(messages.noWallet)).not.toBeInTheDocument();

  act(() => {
    for (const off of unregister.splice(0)) off();
  });
  expect(await screen.findByText(messages.noWallet)).toBeVisible();
});

test("link panel: a wallet without signMessage does not count", async () => {
  install(fakeWallet("Plain", { without: ["solana:signMessage"] }));
  renderPanel();
  expect(await screen.findByText(messages.noWallet)).toBeVisible();
});

test("link panel: not a member disables the button and says why", async () => {
  install(solflare);
  renderPanel({ memberships: [] });
  const button = await screen.findByRole("button", { name: "Connect a wallet" });
  expect(button).toBeDisabled();
  expect(
    screen.getByText("Linking needs a membership: a wallet is always linked for one organisation."),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "Connect Solflare" })).not.toBeInTheDocument();
});

test("link panel: loading memberships shows a busy skeleton", async () => {
  install(solflare);
  const { container } = renderPanel({ memberships: null });
  expect(screen.getByRole("heading", { name: "Link a wallet" })).toBeVisible();
  expect(container.querySelector('section[aria-busy="true"]')).not.toBeNull();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});

test("link panel: Choose lists wallets with Solflare first, then by name", async () => {
  const phantom = fakeWallet("Phantom");
  const backpack = fakeWallet("Backpack");
  install(phantom);
  install(backpack);
  install(solflare);
  renderPanel();
  await connectButton("Solflare");
  const rows = within(screen.getByRole("list")).getAllByRole("listitem");
  expect(rows.map((row) => row.textContent)).toEqual([
    "SolflareInstalledConnect",
    "BackpackInstalledConnect",
    "PhantomInstalledConnect",
  ]);
  expect(within(rows[0] as HTMLElement).getByRole("button")).toHaveClass("access-primary");
  expect(within(rows[1] as HTMLElement).getByRole("button")).toHaveClass("access-outline");
  expect(screen.getByText("Lender One Bank")).toBeVisible();
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
});

test("link panel: waiting for connection", async () => {
  const gate = pending<{ accounts: never[] }>();
  solflare.connect.mockReturnValue(gate.promise);
  install(solflare);
  renderPanel();
  fireEvent.click(await connectButton("Solflare"));

  expect(await screen.findByText("Approve the connection in Solflare.")).toBeVisible();
  const button = screen.getByRole("button", { name: "Waiting for Solflare" });
  expect(button).toBeDisabled();
  expect(button).toHaveAttribute("aria-busy", "true");
  expect(screen.getByRole("status")).toHaveTextContent("Waiting for Solflare to connect");
  expect(api.apiPost).not.toHaveBeenCalled();
  await act(async () => gate.resolve({ accounts: [] }));
});

test("link panel: connection refused returns to Choose with the message", async () => {
  solflare.connect.mockRejectedValue(new Error("User rejected the request"));
  install(solflare);
  renderPanel();
  fireEvent.click(await connectButton("Solflare"));
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(messages.connectRefused({ wallet: "Solflare" }));
  expect(screen.getByRole("button", { name: "Connect Solflare" })).toBeEnabled();
  expect(api.apiPost).not.toHaveBeenCalled();
});

test("link panel: a wallet that returns no Solana account counts as refused", async () => {
  solflare.connect.mockResolvedValue({ accounts: [] });
  install(solflare);
  renderPanel();
  fireEvent.click(await connectButton("Solflare"));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    messages.connectRefused({ wallet: "Solflare" }),
  );
  expect(api.apiPost).not.toHaveBeenCalled();
});

test("link panel: preparing requests the challenge at once for the organisation and account", async () => {
  const gate = pending<ApiResult<unknown>>();
  route({ challenge: () => gate.promise });
  install(solflare);
  renderPanel();
  fireEvent.click(await connectButton("Solflare"));

  const button = await screen.findByRole("button", { name: "Preparing message" });
  expect(button).toBeDisabled();
  expect(button).toHaveAttribute("aria-busy", "true");
  expect(screen.getByText("You will sign exactly this text")).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent("Preparing the message");
  expect(api.apiPost).toHaveBeenCalledTimes(1);
  expect(api.apiPost).toHaveBeenCalledWith(
    "/v1/wallet-links/challenges",
    { organisationId: "o-1", wallet: solflare.account.address },
    TOKEN,
  );
  await act(async () => gate.resolve(issued()));
});

test("link panel: ready shows the message verbatim with its byte count", async () => {
  const message = messageFor(solflare.account.address, " (Müller & Söhne)");
  route({
    challenge: () => ok({ challengeId: "c-1", message, expiresAt: EXPIRES_AT }),
  });
  install(solflare);
  renderPanel();
  await toReady();

  const bytes = new TextEncoder().encode(message).length;
  expect(bytes).toBeGreaterThan(message.length);
  const block = screen.getByLabelText(`Link message, ${bytes} bytes`);
  expect(block.tagName).toBe("PRE");
  expect(block.textContent).toBe(message);
  expect(screen.getByText(`${bytes} bytes, UTF-8. Expires at ${TIME}.`)).toBeVisible();
  expect(
    screen.getByText(
      "Signing proves this wallet is yours. The text cannot move funds or approve a transaction, and Solflare should show it unchanged.",
    ),
  ).toBeVisible();
  expect(
    screen.getByText(
      `Connected: ${solflare.account.address.slice(0, 4)}…${solflare.account.address.slice(-4)}`,
    ),
  ).toBeVisible();
  expect(screen.getAllByRole("status")).toHaveLength(1);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("link panel: waiting for the signature, then Checking, then Linked after the exact bytes are signed", async () => {
  const signing = pending<{ signedMessage: Uint8Array; signature: Uint8Array }[]>();
  const checking = pending<ApiResult<unknown>>();
  route({ challenge: () => issued(), link: () => checking.promise });
  install(solflare);
  solflare.signMessage.mockImplementationOnce(() => signing.promise);
  const { reloadLinks } = renderPanel();
  await toReady();

  fireEvent.click(screen.getByRole("button", { name: "Sign with Solflare" }));
  expect(
    await screen.findByText(
      "Approve the signature in Solflare. Check that it shows the same text as this page.",
    ),
  ).toBeVisible();
  const waiting = screen.getByRole("button", { name: "Waiting for Solflare" });
  expect(waiting).toBeDisabled();
  expect(screen.getByRole("status")).toHaveTextContent("Waiting for Solflare to sign");

  const message = messageFor(solflare.account.address);
  const bytes = new TextEncoder().encode(message);
  const signature = solflare.key.sign(bytes);
  expect(solflare.signMessage.mock.calls[0]?.[0].message).toEqual(bytes);
  await act(async () => signing.resolve([{ signedMessage: bytes, signature }]));

  const button = await screen.findByRole("button", { name: "Checking signature" });
  expect(button).toBeDisabled();
  expect(button).toHaveAttribute("aria-busy", "true");
  expect(api.apiPost).toHaveBeenLastCalledWith(
    "/v1/wallet-links",
    { challengeId: "c-1", signatureBase58: bs58.encode(signature) },
    TOKEN,
  );
  expect(verify(null, bytes, solflare.key.publicKey, bs58.decode(bs58.encode(signature)))).toBe(
    true,
  );
  expect(reloadLinks).not.toHaveBeenCalled();

  await act(async () => checking.resolve(linkedFor()));
  expect(await screen.findByRole("heading", { name: "Wallet linked" })).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent("Wallet linked");
  expect(reloadLinks).toHaveBeenCalledTimes(1);
  expect(
    screen.getByText(
      (_c, el) =>
        el?.className === "access-note" &&
        el.textContent ===
          `Solflare wallet ${solflare.account.address} is linked to your account for Lender One Bank.`,
    ),
  ).toBeVisible();
  expect(
    screen.getByText(
      "It now appears under Linked wallets. Signing for Lender One Bank also needs an on-chain delegation, which an admin records.",
    ),
  ).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: "Link another wallet" }));
  expect(await connectButton("Solflare")).toBeVisible();
  expect(screen.queryByRole("heading", { name: "Wallet linked" })).not.toBeInTheDocument();
});

test("link panel: cancelling in the wallet keeps the message and says it stays valid", async () => {
  install(solflare);
  solflare.signMessage.mockRejectedValueOnce(new Error("User rejected the request"));
  renderPanel();
  await toLinkedAttempt();
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(messages.signCancelled({ wallet: "Solflare", time: TIME }));
  expect(screen.getByRole("button", { name: "Sign with Solflare" })).toBeEnabled();
  expect(screen.getByLabelText(/^Link message, \d+ bytes$/)).toBeVisible();
  expect(api.apiPost).toHaveBeenCalledTimes(1);
});

test("link panel: BAD_SIGNATURE names the wallet and offers another", async () => {
  route({ challenge: () => issued(), link: () => failure("BAD_SIGNATURE", 422) });
  install(solflare);
  install(fakeWallet("Phantom"));
  renderPanel();
  await toLinkedAttempt();
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(messages.badSignature({ wallet: "Solflare" }));
  expect(within(alert).getByText("Solflare").tagName).toBe("STRONG");
  expect(screen.getByText(messages.badSignatureHelp)).toBeVisible();
  expect(screen.getByLabelText(/^Link message, \d+ bytes$/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Choose another wallet" }));
  expect(await connectButton("Phantom")).toBeVisible();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("link panel: CHALLENGE_INVALID is Expired and a new message can be prepared", async () => {
  route({ challenge: () => issued(), link: () => failure("CHALLENGE_INVALID", 409) });
  install(solflare);
  renderPanel();
  await toLinkedAttempt();
  expect(await screen.findByRole("alert")).toHaveTextContent(messages.expired({ time: TIME }));

  route({ challenge: () => issued(), link: () => linkedFor() });
  fireEvent.click(screen.getByRole("button", { name: "Prepare a new message" }));
  expect(await screen.findByRole("button", { name: "Sign with Solflare" })).toBeVisible();
  expect(api.apiPost).toHaveBeenCalledTimes(3);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(solflare.connect).toHaveBeenCalledTimes(1);
});

test("link panel: the clock passing expiresAt while Ready expires the message", async () => {
  const soon = new Date(Date.now() + 150).toISOString();
  route({
    challenge: () =>
      ok({ challengeId: "c-1", message: messageFor(solflare.account.address), expiresAt: soon }),
  });
  install(solflare);
  renderPanel();
  await toReady();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  const alert = await screen.findByRole("alert", undefined, { timeout: 2000 });
  expect(alert).toHaveTextContent(messages.expired({ time: formatClockTime(soon) }));
  expect(screen.getByRole("button", { name: "Prepare a new message" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Sign with Solflare" })).not.toBeInTheDocument();
});

test("link panel: the expiry timer is cleared on leaving Ready and on unmount", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const gate = pending<{ signedMessage: Uint8Array; signature: Uint8Array }[]>();
  solflare.signMessage.mockReturnValue(gate.promise);
  install(solflare);
  const view = renderPanel();
  const settle = () => act(async () => void (await vi.advanceTimersByTimeAsync(0)));

  fireEvent.click(screen.getByRole("button", { name: "Connect Solflare" }));
  await settle();
  expect(screen.getByRole("button", { name: "Sign with Solflare" })).toBeVisible();
  expect(vi.getTimerCount()).toBe(1);

  fireEvent.click(screen.getByRole("button", { name: "Sign with Solflare" }));
  await settle();
  expect(screen.getByRole("button", { name: "Waiting for Solflare" })).toBeVisible();
  expect(vi.getTimerCount()).toBe(0);

  await act(async () => gate.resolve([]));
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

test("link panel: the timer is cleared when the panel unmounts in Ready", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  install(solflare);
  const view = renderPanel();
  fireEvent.click(screen.getByRole("button", { name: "Connect Solflare" }));
  await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
  expect(vi.getTimerCount()).toBe(1);
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

test("link panel: WALLET_ALREADY_LINKED", async () => {
  route({ challenge: () => issued(), link: () => failure("WALLET_ALREADY_LINKED", 409) });
  install(solflare);
  renderPanel();
  await toLinkedAttempt();
  expect(await screen.findByRole("alert")).toHaveTextContent(messages.alreadyLinked);
  expect(screen.getByText(messages.alreadyLinkedHelp)).toBeVisible();
  expect(screen.getByRole("button", { name: "Choose another wallet" })).toBeVisible();
});

test("link panel: NOT_AUTHORISED on the challenge says the membership ended and reloads memberships", async () => {
  route({ challenge: () => failure("NOT_AUTHORISED", 403) });
  install(solflare);
  const { reloadMemberships } = renderPanel();
  fireEvent.click(await connectButton("Solflare"));
  expect(await screen.findByRole("alert")).toHaveTextContent(messages.notMember({ org: ORG.name }));
  expect(reloadMemberships).toHaveBeenCalledTimes(1);
  expect(await connectButton("Solflare")).toBeVisible();
});

test("link panel: WALLET_INVALID asks for a Solana account and offers Connect", async () => {
  route({ challenge: () => failure("WALLET_INVALID", 422) });
  install(solflare);
  renderPanel();
  fireEvent.click(await connectButton("Solflare"));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    messages.walletInvalid({ wallet: "Solflare" }),
  );
  expect(screen.getByRole("button", { name: "Connect Solflare" })).toBeEnabled();
});

test("link panel: VALIDATION on the link POST is Could not complete without a reconcile", async () => {
  route({ challenge: () => issued(), link: () => failure("VALIDATION", 400) });
  install(solflare);
  const { reloadLinks } = renderPanel();
  await toLinkedAttempt();
  expect(await screen.findByRole("alert")).toHaveTextContent(messages.failed);
  expect(screen.getByRole("button", { name: "Prepare a new message" })).toBeVisible();
  expect(reloadLinks).not.toHaveBeenCalled();
});

test("link panel: INTERNAL on the link POST reconciles before Could not complete", async () => {
  route({ challenge: () => issued(), link: () => failure("INTERNAL", 500) });
  install(solflare);
  const { reloadLinks } = renderPanel();
  await toLinkedAttempt();
  expect(await screen.findByRole("alert")).toHaveTextContent(messages.failed);
  expect(reloadLinks).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Prepare a new message" })).toBeVisible();
});

test("link panel: INTERNAL on the link POST shows Linked when the reconcile finds the wallet active", async () => {
  route({ challenge: () => issued(), link: () => failure("INTERNAL", 500) });
  install(solflare);
  const reloadLinks = vi.fn(async () => [
    { id: "l-9", wallet: solflare.account.address, organisation_id: "o-1", revoked_at: null },
  ]);
  renderPanel({ reloadLinks });
  await toLinkedAttempt();
  expect(await screen.findByRole("heading", { name: "Wallet linked" })).toBeVisible();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("link panel: an account change during a pending completion still reconciles, and the panel stays reset", async () => {
  const gate = pending<ApiResult<unknown>>();
  route({ challenge: () => issued(), link: () => gate.promise });
  install(solflare);
  const reloadLinks = vi.fn(async () => []);
  renderPanel({ reloadLinks });
  await toReadySubscribed();
  fireEvent.click(screen.getByRole("button", { name: "Sign with Solflare" }));
  await screen.findByRole("button", { name: "Checking signature" });

  act(() => solflare.emitChange({ accounts: [] }));
  expect(await connectButton("Solflare")).toBeVisible();
  expect(reloadLinks).not.toHaveBeenCalled();

  await act(async () => gate.resolve(failure("NETWORK", 0)));
  await waitFor(() => expect(reloadLinks).toHaveBeenCalledTimes(1));
  expect(screen.getByRole("button", { name: "Connect Solflare" })).toBeVisible();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Wallet linked" })).not.toBeInTheDocument();
});

test("link panel: a failed reconcile is Link not confirmed, offers only Check again, and Check again can reach Linked", async () => {
  route({ challenge: () => issued(), link: () => failure("NETWORK", 0) });
  install(solflare);
  const active = [
    { id: "l-9", wallet: solflare.account.address, organisation_id: "o-1", revoked_at: null },
  ];
  const reloadLinks = vi
    .fn<() => Promise<typeof active | null>>()
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(active);
  renderPanel({ reloadLinks });
  await toLinkedAttempt();

  expect(await screen.findByRole("alert")).toHaveTextContent(
    messages.unconfirmed({ wallet: "Solflare" }),
  );
  expect(screen.queryByRole("button", { name: "Prepare a new message" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Sign with Solflare" })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  await waitFor(() => expect(reloadLinks).toHaveBeenCalledTimes(2));
  expect(await screen.findByRole("button", { name: "Check again" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Prepare a new message" })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  expect(await screen.findByRole("heading", { name: "Wallet linked" })).toBeVisible();
  expect(reloadLinks).toHaveBeenCalledTimes(3);
});

test("link panel: Check again that finds no link ends in Could not complete", async () => {
  route({ challenge: () => issued(), link: () => failure("NETWORK", 0) });
  install(solflare);
  const reloadLinks = vi
    .fn<() => Promise<never[] | null>>()
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce([]);
  renderPanel({ reloadLinks });
  await toLinkedAttempt();
  fireEvent.click(await screen.findByRole("button", { name: "Check again" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(messages.failed));
  expect(screen.getByRole("button", { name: "Prepare a new message" })).toBeVisible();
});

test("link panel: Linked drops the 'now appears' sentence when the list reload failed", async () => {
  install(solflare);
  const reloadLinks = vi.fn(async () => null);
  renderPanel({ reloadLinks });
  await toLinkedAttempt();
  await screen.findByRole("heading", { name: "Wallet linked" });
  await waitFor(() => expect(reloadLinks).toHaveBeenCalledTimes(1));
  expect(
    await screen.findByText(
      "Signing for Lender One Bank also needs an on-chain delegation, which an admin records.",
    ),
  ).toBeVisible();
  expect(screen.queryByText(/It now appears under Linked wallets/)).not.toBeInTheDocument();
});

test("link panel: Sign checks expiresAt on click and never opens the wallet after it", async () => {
  const soon = new Date(Date.now() + 5000).toISOString();
  route({
    challenge: () =>
      ok({ challengeId: "c-1", message: messageFor(solflare.account.address), expiresAt: soon }),
  });
  install(solflare);
  renderPanel();
  await toReady();
  const sign = screen.getByRole("button", { name: "Sign with Solflare" });
  const realNow = Date.now;
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + 60_000);
  try {
    fireEvent.click(sign);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      messages.expired({ time: formatClockTime(soon) }),
    );
  } finally {
    vi.restoreAllMocks();
  }
  expect(solflare.signMessage).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Prepare a new message" })).toBeVisible();
  expect(api.apiPost).toHaveBeenCalledTimes(1);
});

test("link panel: each request reads the access token when it is made", async () => {
  install(solflare);
  getAccessToken.mockResolvedValueOnce("tok-a").mockResolvedValueOnce("tok-b");
  renderPanel();
  await toLinkedAttempt();
  await screen.findByRole("heading", { name: "Wallet linked" });
  expect(getAccessToken).toHaveBeenCalledTimes(2);
  expect(api.apiPost.mock.calls.map((call) => call[2])).toEqual(["tok-a", "tok-b"]);
});

test("link panel: no session when a request is made hands over to the session-expired redirect", async () => {
  install(solflare);
  getAccessToken.mockResolvedValueOnce(null);
  const { onSessionExpired } = renderPanel();
  fireEvent.click(await connectButton("Solflare"));
  await waitFor(() => expect(onSessionExpired).toHaveBeenCalledTimes(1));
  expect(api.apiPost).not.toHaveBeenCalled();
});

test("link panel: a failed challenge request returns to Choose with link.failed", async () => {
  route({ challenge: () => failure("INTERNAL", 500) });
  install(solflare);
  renderPanel();
  fireEvent.click(await connectButton("Solflare"));
  expect(await screen.findByRole("alert")).toHaveTextContent(messages.failed);
  expect(screen.getByRole("button", { name: "Connect Solflare" })).toBeVisible();
});

test("link panel: a network failure on the link POST reloads the list first and shows Linked when the wallet is now active", async () => {
  const order: string[] = [];
  route({
    challenge: () => issued(),
    link: () => {
      order.push("post");
      return failure("NETWORK", 0);
    },
  });
  install(solflare);
  const reloadLinks = vi.fn(async () => {
    order.push("reload");
    return [
      { id: "l-9", wallet: solflare.account.address, organisation_id: "o-1", revoked_at: null },
    ];
  });
  renderPanel({ reloadLinks });
  await toLinkedAttempt();
  expect(await screen.findByRole("heading", { name: "Wallet linked" })).toBeVisible();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(order).toEqual(["post", "reload"]);
  expect(reloadLinks).toHaveBeenCalledTimes(1);
});

test.each([
  ["another organisation", [{ id: "l-1", wallet: "x", organisation_id: "o-9", revoked_at: null }]],
  [
    "a revoked link",
    [{ id: "l-1", wallet: "ADDR", organisation_id: "o-1", revoked_at: "2026-11-23T10:00:00Z" }],
  ],
  ["no row", []],
])(
  "link panel: a network failure shows Could not complete when the reload finds %s",
  async (_name, rows) => {
    route({ challenge: () => issued(), link: () => failure("NETWORK", 0) });
    install(solflare);
    const list = rows?.map((row) => ({
      ...row,
      wallet: row.wallet === "ADDR" ? solflare.account.address : row.wallet,
    }));
    const reloadLinks = vi.fn(async () => list ?? []);
    renderPanel({ reloadLinks });
    await toLinkedAttempt();
    expect(await screen.findByRole("alert")).toHaveTextContent(messages.failed);
    expect(screen.queryByRole("heading", { name: "Wallet linked" })).not.toBeInTheDocument();
    expect(reloadLinks).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Prepare a new message" })).toBeVisible();
  },
);

test("link panel: a 401 on the challenge or the link POST hands over to the session-expired redirect", async () => {
  route({ challenge: () => failure("NOT_AUTHENTICATED", 401) });
  install(solflare);
  const first = renderPanel();
  fireEvent.click(await connectButton("Solflare"));
  await waitFor(() => expect(first.onSessionExpired).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  cleanup();

  route({ challenge: () => issued(), link: () => failure("NOT_AUTHENTICATED", 401) });
  const second = renderPanel();
  await toLinkedAttempt();
  await waitFor(() => expect(second.onSessionExpired).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(second.reloadLinks).not.toHaveBeenCalled();
});

test("link panel: several memberships give an organisation select, and the choice goes into the request", async () => {
  install(solflare);
  renderPanel({ memberships: [ORG, ORG_TWO] });
  const select = await screen.findByRole("combobox", { name: "For organisation" });
  expect(
    within(select)
      .getAllByRole("option")
      .map((o) => o.textContent),
  ).toEqual(["Lender One Bank", "Terminal Two"]);
  fireEvent.change(select, { target: { value: "o-2" } });
  fireEvent.click(await connectButton("Solflare"));
  await screen.findByRole("button", { name: "Sign with Solflare" });
  expect(api.apiPost).toHaveBeenCalledWith(
    "/v1/wallet-links/challenges",
    { organisationId: "o-2", wallet: solflare.account.address },
    TOKEN,
  );
});

test("link panel: changing the organisation while Ready discards the challenge", async () => {
  install(solflare);
  renderPanel({ memberships: [ORG, ORG_TWO] });
  await toReady();
  fireEvent.change(screen.getByRole("combobox", { name: "For organisation" }), {
    target: { value: "o-2" },
  });
  expect(await connectButton("Solflare")).toBeVisible();
  expect(screen.queryByLabelText(/^Link message/)).not.toBeInTheDocument();
});

test("link panel: an account change in the wallet discards the challenge and returns to Choose", async () => {
  install(solflare);
  renderPanel();
  await toReadySubscribed();

  act(() => solflare.emitChange({ accounts: [] }));
  expect(await connectButton("Solflare")).toBeVisible();
  expect(screen.queryByLabelText(/^Link message/)).not.toBeInTheDocument();
  await waitFor(() => expect(solflare.listeners.size).toBe(0));
});

test("link panel: a change that leaves the account alone does nothing", async () => {
  install(solflare);
  renderPanel();
  await toReadySubscribed();
  act(() => solflare.emitChange({ accounts: [solflare.account] }));
  act(() => solflare.emitChange({}));
  expect(screen.getByRole("button", { name: "Sign with Solflare" })).toBeVisible();
});

test("link panel: a late reply after an account change is ignored", async () => {
  const gate = pending<ApiResult<unknown>>();
  route({ challenge: () => gate.promise });
  install(solflare);
  renderPanel();
  fireEvent.click(await connectButton("Solflare"));
  await screen.findByRole("button", { name: "Preparing message" });
  await waitFor(() => expect(solflare.listeners.size).toBe(1));
  act(() => solflare.emitChange({ accounts: [] }));
  await connectButton("Solflare");
  await act(async () => gate.resolve(issued()));
  expect(screen.queryByRole("button", { name: "Sign with Solflare" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Connect Solflare" })).toBeVisible();
});

test("link panel: the wallet's change listener is removed on unmount", async () => {
  install(solflare);
  const view = renderPanel();
  await toReadySubscribed();
  view.unmount();
  expect(solflare.listeners.size).toBe(0);
});
