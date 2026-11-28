import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, type Mock, test, vi } from "vitest";
import { TestBanner, TopBar } from "@/components/access/access-shell";

type AuthMock = { getSession: Mock; onAuthStateChange: Mock; signOut: Mock };

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  auth: {} as unknown as AuthMock,
}));

vi.mock("@/lib/supabase-browser", () => ({
  supabaseBrowser: () => ({ auth: mocks.auth }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace, push: vi.fn() }),
}));

const EMAIL = "naledi.dube@lender-one.example";

beforeEach(() => {
  mocks.replace.mockReset();
  mocks.auth = {
    getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
    onAuthStateChange: vi
      .fn()
      .mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } }),
    signOut: vi.fn().mockResolvedValue({ error: null }),
  };
});

afterEach(cleanup);

test("shows the test environment banner", () => {
  render(<TestBanner />);
  expect(screen.getByText(/Test environment\./)).toBeVisible();
  expect(
    screen.getByText(
      /Organisations are synthetic, and nothing on these pages is recorded on chain\./,
    ),
  ).toBeVisible();
});

test("shows only the wordmark when signed out", async () => {
  render(<TopBar />);
  await waitFor(() => expect(mocks.auth.getSession).toHaveBeenCalled());
  await act(async () => {});
  expect(screen.getByText("THETIS")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
});

test("shows the email and signs out to /login", async () => {
  mocks.auth.getSession.mockResolvedValue({
    data: { session: { access_token: "t", user: { email: EMAIL } } },
    error: null,
  });
  render(<TopBar />);
  expect(await screen.findByText(EMAIL)).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

  await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/login"));
  expect(mocks.auth.signOut).toHaveBeenCalledTimes(1);
});

test("returns to login when sign-out rejects", async () => {
  mocks.auth.getSession.mockResolvedValue({
    data: { session: { access_token: "t", user: { email: EMAIL } } },
    error: null,
  });
  mocks.auth.signOut.mockRejectedValue(new TypeError("fetch failed"));
  render(<TopBar />);
  fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
  await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/login"));
});

test("shows the account links again when a new session arrives after sign-out", async () => {
  let onChange: (event: string, session: unknown) => void = () => {};
  mocks.auth.onAuthStateChange.mockImplementation((callback: typeof onChange) => {
    onChange = callback;
    return { data: { subscription: { unsubscribe: vi.fn() } } };
  });
  mocks.auth.getSession.mockResolvedValue({
    data: { session: { access_token: "first", user: { email: EMAIL } } },
    error: null,
  });
  render(<TopBar />);
  fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
  await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/login"));
  expect(screen.queryByText(EMAIL)).not.toBeInTheDocument();

  act(() => onChange("SIGNED_IN", { access_token: "second", user: { email: EMAIL } }));

  expect(await screen.findByText(EMAIL)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
});
