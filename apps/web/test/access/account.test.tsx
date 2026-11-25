import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, type Mock, test, vi } from "vitest";
import { AccountScreen } from "@/components/access/account-screen";
import { accessMessages } from "@/lib/access-messages";
import { formatDateTime } from "@/lib/format";

type AuthMock = { getSession: Mock; signOut: Mock };
type Reply = {
  data: unknown;
  error: { code: string; message: string } | null;
  status: number;
};
type Responder = () => Promise<Reply>;
type Chain = {
  table: string;
  select: Mock;
  eq: Mock;
  is: Mock;
  order: Mock;
  then: (resolve: (value: Reply) => unknown, reject: (reason: unknown) => unknown) => unknown;
};

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  push: vi.fn(),
  auth: {} as unknown as AuthMock,
  rpc: vi.fn(),
  from: vi.fn(),
}));

vi.mock("@/lib/supabase-browser", () => ({
  supabaseBrowser: () => ({ auth: mocks.auth, rpc: mocks.rpc, from: mocks.from }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace, push: mocks.push }),
}));

const EMAIL = "naledi.dube@lender-one.example";
const SESSION = { user: { id: "u-1", email: EMAIL } };
const WALLET_ACTIVE = "3G9CfbeXutKaD3uFDLgY9z14uF799WxrJpWaE8NPrd3J";
const WALLET_REVOKED = "HsYGW12CXiT1uxEwrJXyerBP9LcR7VU4XDXLgRvok8nX";
const LINKED_AT = "2026-11-18T14:05:00Z";
const LINKED_AT_OLD = "2026-11-12T07:40:00Z";
const REVOKED_AT = "2026-11-18T10:00:00Z";
const LIST_REVOKED_AT = "2026-11-18T15:30:00Z";

const MEMBERSHIPS = [
  {
    id: "m-1",
    member_role: "member",
    created_at: LINKED_AT,
    organisations: {
      id: "o-1",
      slug: "lender-one",
      name: "Lender One Bank",
      kind: "lender",
      synthetic: true,
    },
  },
];

const LINKS = [
  {
    id: "l-1",
    wallet: WALLET_ACTIVE,
    organisation_id: "o-1",
    linked_at: LINKED_AT,
    revoked_at: null,
  },
  {
    id: "l-2",
    wallet: WALLET_REVOKED,
    organisation_id: "o-1",
    linked_at: LINKED_AT_OLD,
    revoked_at: REVOKED_AT,
  },
];

const LINKS_AFTER_REVOKE = [{ ...LINKS[0], revoked_at: LIST_REVOKED_AT }, LINKS[1]];

const EXPIRED: Reply = {
  data: null,
  error: { code: "PGRST301", message: "JWT expired" },
  status: 401,
};
const SELECT_ERROR: Reply = {
  data: null,
  error: { code: "XX000", message: "boom" },
  status: 500,
};

const state = {
  queues: {} as Record<string, Responder[]>,
  chains: [] as Chain[],
};

function ok(data: unknown): Responder {
  return async () => ({ data, error: null, status: 200 });
}

function reply(value: Reply): Responder {
  return async () => value;
}

function never(): Responder {
  return () => new Promise<Reply>(() => {});
}

function rejects(): Responder {
  return () => Promise.reject(new TypeError("fetch failed"));
}

function setTable(table: string, ...responders: Responder[]) {
  state.queues[table] = responders;
}

function nextResponder(table: string): Responder {
  const queue = state.queues[table] ?? [];
  const responder = queue.length > 1 ? queue.shift() : queue[0];
  return responder ?? ok([]);
}

function buildChain(table: string): Chain {
  const chain: Chain = {
    table,
    select: vi.fn(),
    eq: vi.fn(),
    is: vi.fn(),
    order: vi.fn(),
    // biome-ignore lint/suspicious/noThenProperty: the Supabase query builder is awaited as a thenable
    then: (resolve, reject) => nextResponder(table)().then(resolve, reject),
  };
  chain.select.mockReturnValue(chain);
  chain.eq.mockReturnValue(chain);
  chain.is.mockReturnValue(chain);
  chain.order.mockReturnValue(chain);
  return chain;
}

function chainsFor(table: string): Chain[] {
  return state.chains.filter((chain) => chain.table === table);
}

function firstChain(table: string): Chain {
  const chain = chainsFor(table)[0];
  if (!chain) throw new Error(`from("${table}") was never called`);
  return chain;
}

function selectCount(table: string): number {
  return chainsFor(table).reduce((sum, chain) => sum + chain.select.mock.calls.length, 0);
}

function replacedUrl(): URL {
  const call = mocks.replace.mock.calls.at(-1);
  return new URL(String(call?.[0]), "http://h");
}

function byContent(text: string): HTMLElement {
  return screen.getByText((_content, element) => {
    if (!element || element.textContent !== text) return false;
    return !Array.from(element.children).some((child) => child.textContent === text);
  });
}

function rowOf(address: string): HTMLElement {
  const row = screen.getByText(address).closest("tr");
  if (!row) throw new Error(`no table row holds ${address}`);
  return row;
}

beforeEach(() => {
  mocks.replace.mockReset();
  mocks.push.mockReset();
  mocks.rpc.mockReset();
  mocks.rpc.mockResolvedValue({ data: null, error: null, status: 200 });
  mocks.from.mockReset();
  state.chains = [];
  state.queues = {};
  setTable("memberships", ok(MEMBERSHIPS));
  setTable("signer_links", ok(LINKS));
  mocks.from.mockImplementation((table: string) => {
    const chain = buildChain(table);
    state.chains.push(chain);
    return chain;
  });
  mocks.auth = {
    getSession: vi.fn().mockResolvedValue({ data: { session: SESSION }, error: null }),
    signOut: vi.fn().mockResolvedValue({ error: null }),
  };
});

afterEach(() => {
  cleanup();
});

async function renderLoaded() {
  render(<AccountScreen />);
  await screen.findByText(WALLET_ACTIVE);
}

async function openConfirm() {
  await renderLoaded();
  fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
  return screen.findByRole("button", { name: "Revoke link" });
}

test("account: no session redirects to login without reason", async () => {
  mocks.auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
  render(<AccountScreen />);
  await waitFor(() => expect(mocks.replace).toHaveBeenCalledTimes(1));
  const url = replacedUrl();
  expect(url.pathname).toBe("/login");
  expect(url.searchParams.get("next")).toBe("/account");
  expect(url.searchParams.get("reason")).toBeNull();
});

test("account: loading shows skeletons and no message", async () => {
  setTable("memberships", never());
  setTable("signer_links", never());
  const { container } = render(<AccountScreen />);
  await waitFor(() => expect(mocks.from).toHaveBeenCalled());
  expect(screen.getByRole("heading", { name: "Linked wallets" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "Organisations" })).toBeVisible();
  for (const message of Object.values(accessMessages.account)) {
    expect(screen.queryByText(message)).not.toBeInTheDocument();
  }
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
});

test("account: lists memberships and own links from the selects", async () => {
  await renderLoaded();

  const membershipChain = firstChain("memberships");
  expect(membershipChain.select).toHaveBeenCalledWith(
    "id, member_role, created_at, organisations(id, slug, name, kind, synthetic)",
  );
  expect(membershipChain.eq).toHaveBeenCalledWith("user_id", "u-1");
  expect(membershipChain.is).toHaveBeenCalledWith("revoked_at", null);
  const linkChain = firstChain("signer_links");
  expect(linkChain.select).toHaveBeenCalledWith(
    "id, wallet, organisation_id, linked_at, revoked_at",
  );
  expect(linkChain.eq).toHaveBeenCalledWith("user_id", "u-1");
  expect(linkChain.order).toHaveBeenCalledWith("linked_at", { ascending: false });

  expect(screen.getByRole("heading", { level: 1, name: "Your account" })).toBeVisible();
  expect(screen.getByText(EMAIL)).toBeVisible();
  const header = screen.getByRole("heading", { level: 1, name: "Your account" }).closest("header");
  if (!header) throw new Error("page header missing");
  expect(within(header).getByText("Session only", { exact: false })).toBeVisible();
  expect(within(header).getByText("No signing authority", { exact: false })).toBeVisible();

  const active = rowOf(WALLET_ACTIVE);
  const revoked = rowOf(WALLET_REVOKED);
  expect(byContent(`For Lender One Bank. Linked ${formatDateTime(LINKED_AT)}`)).toBeVisible();
  expect(byContent(`For Lender One Bank. Linked ${formatDateTime(LINKED_AT_OLD)}`)).toBeVisible();
  expect(active.textContent).toMatch(/Link\s*Active/);
  const revokedDate = formatDateTime(REVOKED_AT).split(",")[0] ?? "";
  expect(revoked.textContent).toMatch(new RegExp(`Link\\s*Revoked\\s*${revokedDate}`));
  expect(screen.getAllByRole("button", { name: "Revoke" })).toHaveLength(1);
  expect(within(active).getByRole("button", { name: "Revoke" })).toBeVisible();
  expect(within(revoked).queryByRole("button", { name: "Revoke" })).not.toBeInTheDocument();
  expect(
    screen.getByText(
      "A link records the wallet as yours in Thetis. It is not on chain and gives no signing authority by itself.",
    ),
  ).toBeVisible();

  const orgRow = screen
    .getAllByRole("row")
    .find((row) => within(row).queryByText("Lender, synthetic"));
  if (!orgRow) throw new Error("no organisations row");
  expect(orgRow).toHaveTextContent("Lender One Bank");
  expect(orgRow).toHaveTextContent("Member");
  expect(orgRow).toHaveTextContent(formatDateTime(LINKED_AT).split(",")[0] ?? "");
});

test("account: no wallets yet", async () => {
  setTable("signer_links", ok([]));
  render(<AccountScreen />);
  expect(await screen.findByText(accessMessages.account.noWallets)).toBeVisible();
  expect(screen.queryByRole("button", { name: "Revoke" })).not.toBeInTheDocument();
});

test("account: not a member", async () => {
  setTable("memberships", ok([]));
  render(<AccountScreen />);
  expect(await screen.findByText(accessMessages.account.noMembership)).toBeVisible();
});

test("account: lists failed on a select error", async () => {
  setTable("memberships", reply(SELECT_ERROR));
  render(<AccountScreen />);
  const alerts = await screen.findAllByRole("alert");
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toHaveTextContent(accessMessages.account.loadFailed);
  expect(screen.queryAllByRole("row")).toHaveLength(0);
  expect(screen.queryByText(WALLET_ACTIVE)).not.toBeInTheDocument();
});

test("account: lists failed on network failure", async () => {
  setTable("signer_links", rejects());
  render(<AccountScreen />);
  const alerts = await screen.findAllByRole("alert");
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toHaveTextContent(accessMessages.account.loadFailed);
  expect(screen.queryAllByRole("row")).toHaveLength(0);
  expect(screen.queryByText(WALLET_ACTIVE)).not.toBeInTheDocument();
});

test("account: a 401 from a select redirects with reason=expired", async () => {
  setTable("signer_links", reply(EXPIRED));
  render(<AccountScreen />);
  await waitFor(() => expect(mocks.replace).toHaveBeenCalled());
  const url = replacedUrl();
  expect(url.pathname).toBe("/login");
  expect(url.searchParams.get("next")).toBe("/account");
  expect(url.searchParams.get("reason")).toBe("expired");
});

test("account: revoke confirms inline and focuses Keep link", async () => {
  await openConfirm();
  expect(
    byContent(
      "Revoke this link? Thetis stops treating this wallet as yours for Lender One Bank. You can link it again later.",
    ),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Revoke link" })).toBeVisible();
  const keep = screen.getByRole("button", { name: "Keep link" });
  await waitFor(() => expect(keep).toHaveFocus());
  expect(mocks.rpc).not.toHaveBeenCalled();

  fireEvent.click(keep);
  expect(await screen.findByRole("button", { name: "Revoke" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Revoke link" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Keep link" })).not.toBeInTheDocument();
  expect(screen.getByText(WALLET_ACTIVE)).toBeVisible();
  expect(mocks.rpc).not.toHaveBeenCalled();
});

test("account: revoke link calls the rpc and reloads from the server", async () => {
  setTable("signer_links", ok(LINKS), ok(LINKS_AFTER_REVOKE));
  const confirm = await openConfirm();
  fireEvent.click(confirm);
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Revoke" })).not.toBeInTheDocument(),
  );
  expect(mocks.rpc).toHaveBeenCalledWith("revoke_wallet_link", { link_id: "l-1" });
  expect(screen.queryByRole("button", { name: "Revoke link" })).not.toBeInTheDocument();
  await waitFor(() => expect(rowOf(WALLET_ACTIVE).textContent).toMatch(/Revoked/));
  expect(selectCount("signer_links")).toBe(2);
});

test("account: revoke never shows Revoked until the server's list says so", async () => {
  setTable("signer_links", ok(LINKS), ok(LINKS));
  const confirm = await openConfirm();
  fireEvent.click(confirm);
  await waitFor(() => expect(selectCount("signer_links")).toBe(2));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Keep link" })).not.toBeInTheDocument(),
  );
  expect(rowOf(WALLET_ACTIVE).textContent).toMatch(/Link\s*Active/);
  expect(screen.getByRole("button", { name: "Revoke" })).toHaveFocus();
});

test("account: revoke link is disabled and busy while the rpc is pending", async () => {
  let release: (value: Reply) => void = () => {};
  mocks.rpc.mockReturnValue(
    new Promise<Reply>((resolve) => {
      release = resolve;
    }),
  );
  const confirm = await openConfirm();
  fireEvent.click(confirm);
  await waitFor(() => expect(screen.getByRole("button", { name: "Revoke link" })).toBeDisabled());
  expect(screen.getByRole("button", { name: "Revoke link" })).toHaveAttribute("aria-busy", "true");
  expect(screen.getByRole("button", { name: "Keep link" })).toBeDisabled();
  await act(async () => {
    release({ data: null, error: null, status: 200 });
  });
});

test("account: revoke LINK_INVALID says already revoked and reloads", async () => {
  mocks.rpc.mockResolvedValue({
    data: null,
    error: { code: "P0001", message: "LINK_INVALID" },
    status: 400,
  });
  const confirm = await openConfirm();
  fireEvent.click(confirm);
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(accessMessages.account.revokeAlready);
  await waitFor(() => expect(selectCount("signer_links")).toBe(2));
  expect(screen.queryByRole("button", { name: "Revoke link" })).not.toBeInTheDocument();
});

test("account: revoke NOT_AUTHORISED says not allowed", async () => {
  mocks.rpc.mockResolvedValue({
    data: null,
    error: { code: "P0001", message: "NOT_AUTHORISED" },
    status: 400,
  });
  const confirm = await openConfirm();
  fireEvent.click(confirm);
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(accessMessages.account.revokeNotAllowed);
  expect(screen.queryByRole("button", { name: "Revoke link" })).not.toBeInTheDocument();
});

test("account: a 401 on revoke redirects with reason=expired", async () => {
  mocks.rpc.mockResolvedValue(EXPIRED);
  const confirm = await openConfirm();
  fireEvent.click(confirm);
  await waitFor(() => expect(mocks.replace).toHaveBeenCalled());
  const url = replacedUrl();
  expect(url.pathname).toBe("/login");
  expect(url.searchParams.get("next")).toBe("/account");
  expect(url.searchParams.get("reason")).toBe("expired");
});

test("account: a link for an organisation not in memberships shows no org name", async () => {
  setTable(
    "signer_links",
    ok([
      {
        id: "l-9",
        wallet: WALLET_ACTIVE,
        organisation_id: "o-9",
        linked_at: LINKED_AT,
        revoked_at: null,
      },
    ]),
  );
  await renderLoaded();
  expect(byContent(`Linked ${formatDateTime(LINKED_AT)}`)).toBeVisible();
  expect(screen.queryByText(/^For /)).not.toBeInTheDocument();
});

test("account: a rejected revoke rpc says it is not confirmed, closes the row and reloads", async () => {
  mocks.rpc.mockRejectedValue(new TypeError("fetch failed"));
  const confirm = await openConfirm();
  fireEvent.click(confirm);
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(accessMessages.account.revokeFailed);
  await waitFor(() => expect(selectCount("signer_links")).toBe(2));
  expect(screen.queryByRole("button", { name: "Revoke link" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Keep link" })).not.toBeInTheDocument();
  expect(screen.getByText(WALLET_ACTIVE)).toBeVisible();
  expect(screen.queryByText(accessMessages.account.loadFailed)).not.toBeInTheDocument();
});

test("account: a non-P0001 revoke error says it is not confirmed, closes the row and reloads", async () => {
  mocks.rpc.mockResolvedValue({
    data: null,
    error: { code: "XX000", message: "boom" },
    status: 500,
  });
  const confirm = await openConfirm();
  fireEvent.click(confirm);
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(accessMessages.account.revokeFailed);
  await waitFor(() => expect(selectCount("signer_links")).toBe(2));
  expect(screen.queryByRole("button", { name: "Revoke link" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Keep link" })).not.toBeInTheDocument();
});

test("account: revoke followed by a failed reload keeps the tables and shows refreshFailed", async () => {
  setTable("signer_links", ok(LINKS), reply(SELECT_ERROR));
  const confirm = await openConfirm();
  fireEvent.click(confirm);
  await waitFor(() => expect(selectCount("signer_links")).toBe(2));
  expect(await screen.findByText(accessMessages.account.refreshFailed)).toBeVisible();
  expect(screen.getByRole("button", { name: "Refresh list" })).toBeVisible();
  expect(screen.queryByText(accessMessages.account.loadFailed)).not.toBeInTheDocument();
  expect(screen.getByText(WALLET_ACTIVE)).toBeVisible();
  expect(screen.getByText(WALLET_REVOKED)).toBeVisible();
  expect(screen.getByText("Lender, synthetic")).toBeVisible();
});

test("account: an unconfirmed revoke whose reload also fails keeps the tables", async () => {
  mocks.rpc.mockRejectedValue(new TypeError("fetch failed"));
  setTable("signer_links", ok(LINKS), rejects());
  const confirm = await openConfirm();
  fireEvent.click(confirm);
  expect(await screen.findByText(accessMessages.account.revokeFailed)).toBeVisible();
  expect(await screen.findByText(accessMessages.account.refreshFailed)).toBeVisible();
  expect(screen.getByText(WALLET_ACTIVE)).toBeVisible();
  expect(screen.queryByText(accessMessages.account.loadFailed)).not.toBeInTheDocument();
});
