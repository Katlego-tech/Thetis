import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, type Mock, test, vi } from "vitest";
import { InviteAccept } from "@/components/access/invite-accept";
import { accessMessages } from "@/lib/access-messages";

type AuthMock = { getSession: Mock; signOut: Mock };
type Reply = {
  data: unknown;
  error: { code: string; message: string } | null;
  status: number;
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
const TOKEN = "a".repeat(64);
const NEXT = `/invite?token=${TOKEN}`;
const SESSION = { user: { id: "u-1", email: EMAIL } };

const INVALID: Reply = {
  data: null,
  error: { code: "P0001", message: "INVITATION_INVALID" },
  status: 400,
};
const EXPIRED: Reply = {
  data: null,
  error: { code: "PGRST301", message: "JWT expired" },
  status: 401,
};

function joinedReply(role: "member" | "admin"): Reply {
  return {
    data: { id: "m-1", member_role: role, organisations: { name: "Lender One Bank" } },
    error: null,
    status: 200,
  };
}

function joinedChain(result: () => Promise<Reply>) {
  const chain = { select: vi.fn(), eq: vi.fn(), single: vi.fn() };
  chain.select.mockReturnValue(chain);
  chain.eq.mockReturnValue(chain);
  chain.single.mockImplementation(result);
  return chain;
}

function acceptOk(): Reply {
  return { data: "m-1", error: null, status: 200 };
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

beforeEach(() => {
  mocks.replace.mockReset();
  mocks.push.mockReset();
  mocks.rpc.mockReset();
  mocks.from.mockReset();
  mocks.auth = {
    getSession: vi.fn().mockResolvedValue({ data: { session: SESSION }, error: null }),
    signOut: vi.fn().mockResolvedValue({ error: null }),
  };
});

afterEach(() => {
  cleanup();
});

async function renderReady() {
  render(<InviteAccept token={TOKEN} />);
  return screen.findByRole("button", { name: "Accept invitation" });
}

async function accept() {
  const button = await renderReady();
  fireEvent.click(button);
}

function expectNoAcceptControls() {
  expect(screen.queryByRole("button", { name: "Accept invitation" })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Accept invitation" })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Sign in to accept" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Sign in to accept" })).not.toBeInTheDocument();
}

test("invite: link incomplete when the token is missing", () => {
  render(<InviteAccept token={null} />);
  expect(screen.getByRole("heading", { name: "This invitation link is incomplete" })).toBeVisible();
  expect(screen.getByText(accessMessages.invite.incomplete)).toBeVisible();
  expectNoAcceptControls();
});

test("invite: link incomplete when the token is not 64 hex characters", () => {
  for (const token of ["ABC", "A".repeat(64)]) {
    render(<InviteAccept token={token} />);
    expect(
      screen.getByRole("heading", { name: "This invitation link is incomplete" }),
    ).toBeVisible();
    expect(screen.getByText(accessMessages.invite.incomplete)).toBeVisible();
    expectNoAcceptControls();
    cleanup();
  }
});

test("invite: signed out sends the person through /login and back", async () => {
  mocks.auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
  render(<InviteAccept token={TOKEN} />);
  expect(await screen.findByRole("heading", { name: "You have an invitation" })).toBeVisible();
  expect(
    screen.getByText(
      "Sign in with the email address this invitation was sent to. You come back here to accept it.",
    ),
  ).toBeVisible();
  const link = screen.getByRole("link", { name: "Sign in to accept" });
  const url = new URL(link.getAttribute("href") ?? "", "http://h");
  expect(url.pathname).toBe("/login");
  expect(url.searchParams.get("next")).toBe(NEXT);
  expect(url.searchParams.get("reason")).toBeNull();
  expect(mocks.rpc).not.toHaveBeenCalled();
});

test("invite: ready shows the signed-in email and the accept button", async () => {
  const button = await renderReady();
  expect(screen.getByRole("heading", { name: "Accept your invitation" })).toBeVisible();
  expect(
    byContent(
      `You are signed in as ${EMAIL}. Accepting makes you a member of the organisation that invited this address.`,
    ),
  ).toBeVisible();
  expect(
    screen.getByText(
      "Membership shows you that organisation's work. It does not let you sign for it: signing needs a linked wallet and an on-chain delegation.",
    ),
  ).toBeVisible();
  expect(button).toBeEnabled();
  expect(mocks.rpc).not.toHaveBeenCalled();
});

test("invite: accepting disables the button", async () => {
  let release: (value: Reply) => void = () => {};
  mocks.rpc.mockReturnValue(
    new Promise<Reply>((resolve) => {
      release = resolve;
    }),
  );
  mocks.from.mockReturnValue(joinedChain(async () => joinedReply("member")));
  await accept();
  const busy = await screen.findByRole("button", { name: "Accepting" });
  expect(busy).toBeDisabled();
  expect(busy).toHaveAttribute("aria-busy", "true");
  expect(mocks.rpc).toHaveBeenCalledWith("accept_invitation", { token: TOKEN });
  await act(async () => {
    release(INVALID);
  });
});

test("invite: joined names the organisation from memberships", async () => {
  const chain = joinedChain(async () => joinedReply("member"));
  mocks.from.mockReturnValue(chain);
  mocks.rpc.mockResolvedValue(acceptOk());
  await accept();
  const heading = await screen.findByRole("heading", { name: "You joined Lender One Bank" });
  await waitFor(() => expect(heading).toHaveFocus());
  expect(mocks.from).toHaveBeenCalledWith("memberships");
  expect(chain.select).toHaveBeenCalledWith("id, member_role, organisations(name)");
  expect(chain.eq).toHaveBeenCalledWith("id", "m-1");
  expect(
    byContent("Your role is Member. You can now see Lender One Bank's work in Thetis."),
  ).toBeVisible();
  expect(
    byContent("To sign for Lender One Bank later, link a wallet to your account."),
  ).toBeVisible();
  expect(screen.getByRole("link", { name: "Link a wallet" })).toHaveAttribute("href", "/account");
  expect(screen.queryByRole("button", { name: "Accept invitation" })).not.toBeInTheDocument();
});

test("invite: joined shows the Admin role for an admin", async () => {
  mocks.from.mockReturnValue(joinedChain(async () => joinedReply("admin")));
  mocks.rpc.mockResolvedValue(acceptOk());
  await accept();
  await screen.findByRole("heading", { name: "You joined Lender One Bank" });
  expect(
    byContent("Your role is Admin. You can now see Lender One Bank's work in Thetis."),
  ).toBeVisible();
});

test("invite: INVITATION_INVALID shows the one message", async () => {
  mocks.rpc.mockResolvedValue(INVALID);
  await accept();
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(accessMessages.invite.invalid);
  expect(screen.getByText(accessMessages.invite.invalidHelp)).toBeVisible();
  expect(screen.getByRole("link", { name: "Go to your account" })).toHaveAttribute(
    "href",
    "/account",
  );
  expect(screen.getByRole("button", { name: "Sign out and use another email" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Accept invitation" })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Sign out and use another email" }));
  await waitFor(() => expect(mocks.replace).toHaveBeenCalledTimes(1));
  expect(mocks.auth.signOut).toHaveBeenCalledTimes(1);
  const url = replacedUrl();
  expect(url.pathname).toBe("/login");
  expect(url.searchParams.get("next")).toBe(NEXT);
  expect(url.searchParams.get("reason")).toBeNull();
});

test("invite: could not accept on network failure", async () => {
  mocks.rpc.mockRejectedValue(new TypeError("fetch failed"));
  await accept();
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(accessMessages.invite.failed);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Accept invitation" })).toBeEnabled(),
  );
});

test("invite: could not accept on another error", async () => {
  mocks.rpc.mockResolvedValue({
    data: null,
    error: { code: "XX000", message: "boom" },
    status: 500,
  });
  await accept();
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(accessMessages.invite.failed);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Accept invitation" })).toBeEnabled(),
  );
});

test("invite: a 401 redirects to login with reason=expired", async () => {
  mocks.rpc.mockResolvedValue(EXPIRED);
  await accept();
  await waitFor(() => expect(mocks.replace).toHaveBeenCalledTimes(1));
  const url = replacedUrl();
  expect(url.pathname).toBe("/login");
  expect(url.searchParams.get("next")).toBe(NEXT);
  expect(url.searchParams.get("reason")).toBe("expired");
});

test("invite: a 401 on the joined select redirects to login with reason=expired", async () => {
  mocks.rpc.mockResolvedValue(acceptOk());
  mocks.from.mockReturnValue(joinedChain(async () => EXPIRED));
  await accept();
  await waitFor(() => expect(mocks.replace).toHaveBeenCalledTimes(1));
  const url = replacedUrl();
  expect(url.pathname).toBe("/login");
  expect(url.searchParams.get("next")).toBe(NEXT);
  expect(url.searchParams.get("reason")).toBe("expired");
});

test("invite: joined select failure goes to the account page", async () => {
  mocks.rpc.mockResolvedValue(acceptOk());
  mocks.from.mockReturnValue(
    joinedChain(async () => ({
      data: null,
      error: { code: "XX000", message: "boom" },
      status: 500,
    })),
  );
  await accept();
  await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/account"));
  expect(screen.queryByText(/Could not/)).not.toBeInTheDocument();
  expect(screen.queryByText(accessMessages.invite.failed)).not.toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
