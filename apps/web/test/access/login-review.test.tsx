import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { TopBar } from "@/components/access/access-shell";
import { LoginForm } from "@/components/access/login-form";

const mocks = vi.hoisted(() => ({
  supabaseBrowser: vi.fn(),
  replace: vi.fn(),
  getSession: vi.fn(),
  signInWithOtp: vi.fn(),
  verifyOtp: vi.fn(),
}));

vi.mock("@/lib/supabase-browser", () => ({ supabaseBrowser: mocks.supabaseBrowser }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: mocks.replace }) }));

const email = "naledi.dube@lender-one.example";
const next = "/invite?token=ab";
const sent = { data: {}, error: null };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.supabaseBrowser.mockReturnValue({
    auth: {
      getSession: mocks.getSession.mockResolvedValue({ data: { session: null }, error: null }),
      signInWithOtp: mocks.signInWithOtp.mockResolvedValue(sent),
      verifyOtp: mocks.verifyOtp,
    },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function submitEmail() {
  fireEvent.change(screen.getByLabelText("Work email"), { target: { value: email } });
  fireEvent.click(screen.getByRole("button", { name: "Email me a code" }));
}

async function openCodeStep() {
  submitEmail();
  return screen.findByLabelText("6-digit code");
}

test("resend keeps keyboard focus and ignores activation while pending and cooling down", async () => {
  let finishResend: (() => void) | undefined;
  mocks.signInWithOtp.mockResolvedValueOnce(sent).mockReturnValueOnce(
    new Promise((resolve) => {
      finishResend = () => resolve(sent);
    }),
  );
  render(<LoginForm next={next} expired={false} />);
  await openCodeStep();
  const button = screen.getByRole("button", { name: "Send a new code" });
  button.focus();
  fireEvent.click(button);

  expect(button).toHaveAttribute("aria-disabled", "true");
  expect(button).not.toBeDisabled();
  expect(button).toHaveFocus();
  fireEvent.click(button);
  expect(mocks.signInWithOtp).toHaveBeenCalledTimes(2);

  await act(async () => finishResend?.());
  expect(button).toHaveAccessibleName("Send a new code in 1:00");
  expect(button).toHaveAttribute("aria-disabled", "true");
  expect(button).not.toBeDisabled();
  expect(button).toHaveFocus();
  fireEvent.click(button);
  expect(mocks.signInWithOtp).toHaveBeenCalledTimes(2);
});

test("keeps verification disabled after success until navigation leaves the page", async () => {
  mocks.verifyOtp.mockResolvedValue({ data: { session: { access_token: "t" } }, error: null });
  render(<LoginForm next={next} expired={false} />);
  const code = await openCodeStep();
  fireEvent.change(code, { target: { value: "482619" } });
  const button = screen.getByRole("button", { name: "Sign in" });
  fireEvent.click(button);
  await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith(next));

  expect(button).toBeDisabled();
  fireEvent.submit(screen.getByRole("form", { name: "Sign in" }));
  expect(mocks.verifyOtp).toHaveBeenCalledTimes(1);
});

test("reuses the initially empty status region when announcing a resend", async () => {
  render(<LoginForm next={next} expired={false} />);
  const status = screen.getByRole("status");
  expect(status).toBeEmptyDOMElement();
  expect(status).not.toHaveClass("access-note");
  await openCodeStep();

  fireEvent.click(screen.getByRole("button", { name: "Send a new code" }));
  await waitFor(() => expect(status).toHaveTextContent(`A new code is on its way to ${email}.`));
  expect(screen.getByRole("status")).toBe(status);
  expect(status).toHaveClass("access-note");

  fireEvent.click(screen.getByRole("button", { name: "Use a different email" }));
  expect(screen.getByRole("status")).toBe(status);
  expect(status).toBeEmptyDOMElement();
  expect(status).not.toHaveClass("access-note");
});

test("keeps auth failures out of the configuration error log", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.getSession.mockRejectedValue(new TypeError("fetch failed"));
  mocks.signInWithOtp.mockRejectedValue(new TypeError("fetch failed"));
  render(<LoginForm next={next} expired={false} />);
  submitEmail();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Check your connection and try again.",
  );
  expect(log).not.toHaveBeenCalled();
});

test("logs a configuration error once across the shell, form and submit retries", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.supabaseBrowser.mockImplementation(() => {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL is not set");
  });
  const shell = render(<TopBar />);
  expect(log).toHaveBeenCalledTimes(1);
  expect(log).toHaveBeenCalledWith(
    expect.objectContaining({
      message: "NEXT_PUBLIC_SUPABASE_URL is not set",
    }),
  );
  shell.unmount();

  render(<LoginForm next={next} expired={false} />);
  submitEmail();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Check your connection and try again.",
  );
  submitEmail();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Email me a code" })).toBeEnabled(),
  );
  expect(log).toHaveBeenCalledTimes(1);
});
