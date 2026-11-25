import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { getWallets } from "@wallet-standard/app";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AccountScreen } from "@/components/access/account-screen";
import { accessMessages } from "@/lib/access-messages";
import { fakeWallet } from "./fake-wallet";

type Reply = { data: unknown; error: { code: string; message: string } | null; status: number };

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  getSession: vi.fn(),
  from: vi.fn(),
  apiPost: vi.fn(),
}));

vi.mock("@/lib/supabase-browser", () => ({
  supabaseBrowser: () => ({
    auth: { getSession: mocks.getSession },
    rpc: vi.fn(),
    from: mocks.from,
  }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: mocks.replace }) }));
vi.mock("@/lib/api", () => ({ apiPost: mocks.apiPost }));

const SESSION = {
  access_token: "tok-1",
  user: { id: "u-1", email: "naledi.dube@lender-one.example" },
};
const ORG = {
  id: "o-1",
  slug: "lender-one",
  name: "Lender One Bank",
  kind: "lender",
  synthetic: true,
};
const MEMBERSHIP = {
  id: "m-1",
  member_role: "member",
  created_at: "2026-11-18T14:05:00Z",
  organisations: ORG,
};
const EXPIRES_AT = "2099-11-23T12:46:07.218Z";

const queues: Record<string, Reply[]> = {};
let selects: Record<string, number> = {};
const unregister: (() => void)[] = [];

function reply(data: unknown): Reply {
  return { data, error: null, status: 200 };
}

function queue(table: string, ...replies: Reply[]) {
  queues[table] = replies;
}

function linkRow(wallet: string, id = "l-1") {
  return {
    id,
    wallet,
    organisation_id: "o-1",
    linked_at: "2026-11-23T12:42:00Z",
    revoked_at: null,
  };
}

beforeEach(() => {
  mocks.replace.mockReset();
  mocks.apiPost.mockReset();
  mocks.getSession.mockResolvedValue({ data: { session: SESSION }, error: null });
  selects = {};
  for (const key of Object.keys(queues)) delete queues[key];
  mocks.from.mockImplementation((table: string) => {
    const chain = {
      select: () => {
        selects[table] = (selects[table] ?? 0) + 1;
        return chain;
      },
      eq: () => chain,
      is: () => chain,
      order: () => chain,
      // biome-ignore lint/suspicious/noThenProperty: the Supabase query builder is awaited as a thenable
      then: (resolve: (value: Reply) => unknown, reject: (reason: unknown) => unknown) => {
        const list = queues[table] ?? [reply([])];
        const next = (list.length > 1 ? list.shift() : list[0]) ?? reply([]);
        return Promise.resolve(next).then(resolve, reject);
      },
    };
    return chain;
  });
});

afterEach(() => {
  cleanup();
  for (const off of unregister.splice(0)) off();
});

function challengeFor(address: string) {
  return {
    ok: true,
    data: { challengeId: "c-1", message: `link ${address}`, expiresAt: EXPIRES_AT },
  };
}

test("account: the link panel sits in the right column beside the lists", async () => {
  queue("memberships", reply([MEMBERSHIP]));
  queue("signer_links", reply([]));
  render(<AccountScreen />);
  const panel = await screen.findByRole("region", { name: "Link a wallet" });
  const columns = panel.parentElement;
  expect(columns).toHaveClass("access-cols");
  expect(columns?.children).toHaveLength(2);
  expect(columns?.lastElementChild).toBe(panel);
  const left = columns?.firstElementChild as HTMLElement;
  expect(within(left).getByRole("heading", { name: "Linked wallets" })).toBeVisible();
  expect(within(left).getByRole("heading", { name: "Organisations" })).toBeVisible();
  expect(within(left).getByText(accessMessages.account.noWallets)).toBeVisible();
});

test("account: with no membership the panel says why it cannot link", async () => {
  queue("memberships", reply([]));
  queue("signer_links", reply([]));
  render(<AccountScreen />);
  expect(await screen.findByRole("button", { name: "Connect a wallet" })).toBeDisabled();
  expect(screen.getByText(accessMessages.account.noMembership)).toBeVisible();
});

test("account: the panel is not drawn when the lists failed to load", async () => {
  queue("memberships", { data: null, error: { code: "XX000", message: "boom" }, status: 500 });
  queue("signer_links", reply([]));
  render(<AccountScreen />);
  expect(await screen.findByText(accessMessages.account.loadFailed)).toBeVisible();
  expect(screen.queryByRole("region", { name: "Link a wallet" })).not.toBeInTheDocument();
});

test("account: Linked reloads the wallets list and the new row appears at the top", async () => {
  const fake = fakeWallet("Solflare");
  unregister.push(getWallets().register(fake.wallet));
  const existing = linkRow("HsYGW12CXiT1uxEwrJXyerBP9LcR7VU4XDXLgRvok8nX", "l-0");
  queue("memberships", reply([MEMBERSHIP]));
  queue("signer_links", reply([existing]), reply([linkRow(fake.account.address), existing]));
  mocks.apiPost.mockImplementation(async (path: string) =>
    path.endsWith("/challenges")
      ? challengeFor(fake.account.address)
      : { ok: true, data: { linkId: "l-1", wallet: fake.account.address, organisationId: "o-1" } },
  );
  render(<AccountScreen />);
  await screen.findByText(existing.wallet);
  expect(screen.queryAllByText(fake.account.address)).toHaveLength(0);

  fireEvent.click(await screen.findByRole("button", { name: "Connect Solflare" }));
  fireEvent.click(await screen.findByRole("button", { name: "Sign with Solflare" }));
  await screen.findByRole("heading", { name: "Wallet linked" });

  const left = screen
    .getByRole("heading", { name: "Linked wallets" })
    .closest("section") as HTMLElement;
  await waitFor(() => expect(within(left).getByText(fake.account.address)).toBeVisible());
  const rows = within(left).getAllByRole("row");
  expect(rows[1]).toHaveTextContent(fake.account.address);
  expect(rows[2]).toHaveTextContent(existing.wallet);
  expect(selects.signer_links).toBe(2);
  expect(mocks.apiPost).toHaveBeenCalledWith("/v1/wallet-links", expect.any(Object), "tok-1");
});

test("account: a network failure on the link POST reloads the list and shows Linked when the wallet is active", async () => {
  const fake = fakeWallet("Solflare");
  unregister.push(getWallets().register(fake.wallet));
  queue("memberships", reply([MEMBERSHIP]));
  queue("signer_links", reply([]), reply([linkRow(fake.account.address)]));
  mocks.apiPost.mockImplementation(async (path: string) =>
    path.endsWith("/challenges")
      ? challengeFor(fake.account.address)
      : { ok: false, code: "NETWORK", status: 0 },
  );
  render(<AccountScreen />);
  fireEvent.click(await screen.findByRole("button", { name: "Connect Solflare" }));
  fireEvent.click(await screen.findByRole("button", { name: "Sign with Solflare" }));
  expect(await screen.findByRole("heading", { name: "Wallet linked" })).toBeVisible();
  expect(selects.signer_links).toBe(2);
  expect(screen.queryByText(accessMessages.link.failed)).not.toBeInTheDocument();
});

test("account: a failed reconcile keeps the tables, shows refreshFailed and Link not confirmed, and Check again reaches Linked", async () => {
  const fake = fakeWallet("Solflare");
  unregister.push(getWallets().register(fake.wallet));
  const existing = linkRow("HsYGW12CXiT1uxEwrJXyerBP9LcR7VU4XDXLgRvok8nX", "l-0");
  queue("memberships", reply([MEMBERSHIP]));
  queue(
    "signer_links",
    reply([existing]),
    { data: null, error: { code: "XX000", message: "boom" }, status: 500 },
    reply([existing, linkRow(fake.account.address)]),
  );
  mocks.apiPost.mockImplementation(async (path: string) =>
    path.endsWith("/challenges")
      ? challengeFor(fake.account.address)
      : { ok: false, code: "INTERNAL", status: 500 },
  );
  render(<AccountScreen />);
  await screen.findByText(existing.wallet);
  fireEvent.click(await screen.findByRole("button", { name: "Connect Solflare" }));
  fireEvent.click(await screen.findByRole("button", { name: "Sign with Solflare" }));

  expect(
    await screen.findByText(accessMessages.link.unconfirmed({ wallet: "Solflare" })),
  ).toBeVisible();
  expect(screen.getByText(accessMessages.account.refreshFailed)).toBeVisible();
  expect(screen.getByRole("button", { name: "Refresh list" })).toBeVisible();
  expect(screen.getByText(existing.wallet)).toBeVisible();
  expect(screen.queryByText(accessMessages.account.loadFailed)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Prepare a new message" })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  expect(await screen.findByRole("heading", { name: "Wallet linked" })).toBeVisible();
  await waitFor(() =>
    expect(screen.queryByText(accessMessages.account.refreshFailed)).not.toBeInTheDocument(),
  );
  const rows = screen.getAllByRole("row").map((row) => row.textContent ?? "");
  expect(rows.some((text) => text.includes(fake.account.address))).toBe(true);
});

test("account: Refresh list reloads both lists and clears the notice", async () => {
  const fake = fakeWallet("Solflare");
  unregister.push(getWallets().register(fake.wallet));
  queue("memberships", reply([MEMBERSHIP]));
  queue(
    "signer_links",
    reply([]),
    { data: null, error: { code: "XX000", message: "boom" }, status: 500 },
    reply([linkRow(fake.account.address)]),
  );
  mocks.apiPost.mockImplementation(async (path: string) =>
    path.endsWith("/challenges")
      ? challengeFor(fake.account.address)
      : { ok: true, data: { linkId: "l-1", wallet: fake.account.address, organisationId: "o-1" } },
  );
  render(<AccountScreen />);
  fireEvent.click(await screen.findByRole("button", { name: "Connect Solflare" }));
  fireEvent.click(await screen.findByRole("button", { name: "Sign with Solflare" }));
  await screen.findByText(accessMessages.account.refreshFailed);
  expect(screen.getByText(accessMessages.account.noWallets)).toBeVisible();
  expect(
    screen.getByText(
      "Signing for Lender One Bank also needs an on-chain delegation, which an admin records.",
    ),
  ).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: "Refresh list" }));
  await waitFor(() =>
    expect(screen.queryByText(accessMessages.account.refreshFailed)).not.toBeInTheDocument(),
  );
  expect(selects.memberships).toBe(2);
  expect(screen.getAllByText(fake.account.address).length).toBeGreaterThan(0);
});

test("account: every link request sends the token current when it is made, not the one from mount", async () => {
  const fake = fakeWallet("Solflare");
  unregister.push(getWallets().register(fake.wallet));
  queue("memberships", reply([MEMBERSHIP]));
  queue("signer_links", reply([]));
  mocks.apiPost.mockImplementation(async (path: string) =>
    path.endsWith("/challenges")
      ? challengeFor(fake.account.address)
      : { ok: true, data: { linkId: "l-1", wallet: fake.account.address, organisationId: "o-1" } },
  );
  render(<AccountScreen />);
  const connect = await screen.findByRole("button", { name: "Connect Solflare" });

  mocks.getSession.mockResolvedValue({
    data: { session: { ...SESSION, access_token: "tok-2" } },
    error: null,
  });
  fireEvent.click(connect);
  const sign = await screen.findByRole("button", { name: "Sign with Solflare" });
  mocks.getSession.mockResolvedValue({
    data: { session: { ...SESSION, access_token: "tok-3" } },
    error: null,
  });
  fireEvent.click(sign);
  await screen.findByRole("heading", { name: "Wallet linked" });

  expect(mocks.apiPost.mock.calls.map((call) => [call[0], call[2]])).toEqual([
    ["/v1/wallet-links/challenges", "tok-2"],
    ["/v1/wallet-links", "tok-3"],
  ]);
});

test("account: NOT_AUTHORISED on the challenge reloads the memberships", async () => {
  const fake = fakeWallet("Solflare");
  unregister.push(getWallets().register(fake.wallet));
  queue("memberships", reply([MEMBERSHIP]), reply([]));
  queue("signer_links", reply([]));
  mocks.apiPost.mockResolvedValue({ ok: false, code: "NOT_AUTHORISED", status: 403 });
  render(<AccountScreen />);
  fireEvent.click(await screen.findByRole("button", { name: "Connect Solflare" }));
  expect(await screen.findByText(accessMessages.link.notMember({ org: ORG.name }))).toBeVisible();
  await waitFor(() => expect(selects.memberships).toBe(2));
  expect(await screen.findByRole("button", { name: "Connect a wallet" })).toBeDisabled();
  expect(screen.getByText(accessMessages.account.noMembership)).toBeVisible();
});

test("account: a session that has gone when a link request is made goes to the session-expired login", async () => {
  const fake = fakeWallet("Solflare");
  unregister.push(getWallets().register(fake.wallet));
  queue("memberships", reply([MEMBERSHIP]));
  queue("signer_links", reply([]));
  render(<AccountScreen />);
  const connect = await screen.findByRole("button", { name: "Connect Solflare" });
  mocks.getSession.mockResolvedValue({ data: { session: null }, error: null });
  fireEvent.click(connect);
  await waitFor(() =>
    expect(mocks.replace).toHaveBeenCalledWith("/login?next=%2Faccount&reason=expired"),
  );
  expect(mocks.apiPost).not.toHaveBeenCalled();
});

test("account: a 401 from the link API goes to the session-expired login", async () => {
  const fake = fakeWallet("Solflare");
  unregister.push(getWallets().register(fake.wallet));
  queue("memberships", reply([MEMBERSHIP]));
  queue("signer_links", reply([]));
  mocks.apiPost.mockResolvedValue({ ok: false, code: "NOT_AUTHENTICATED", status: 401 });
  render(<AccountScreen />);
  fireEvent.click(await screen.findByRole("button", { name: "Connect Solflare" }));
  await waitFor(() =>
    expect(mocks.replace).toHaveBeenCalledWith("/login?next=%2Faccount&reason=expired"),
  );
});
