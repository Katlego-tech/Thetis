import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, type Mock, test, vi } from "vitest";
import { LoginForm } from "@/components/access/login-form";

type AuthMock = { getSession: Mock; signInWithOtp: Mock; verifyOtp: Mock; signOut: Mock };

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
const NEXT = "/invite?token=ab";

function authError(code: string, status: number) {
  return { data: {}, error: { code, status, message: "m" } };
}

beforeEach(() => {
  mocks.replace.mockReset();
  mocks.auth = {
    getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
    signInWithOtp: vi.fn().mockResolvedValue({ data: {}, error: null }),
    verifyOtp: vi.fn(),
    signOut: vi.fn().mockResolvedValue({ error: null }),
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderForm(props: { next?: string; expired?: boolean } = {}) {
  return render(<LoginForm next={props.next ?? NEXT} expired={props.expired ?? false} />);
}

function submitEmail(value = EMAIL) {
  fireEvent.change(screen.getByLabelText("Work email"), { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: "Email me a code" }));
}

async function openCodeStep() {
  renderForm();
  submitEmail();
  return screen.findByLabelText("6-digit code");
}

function submitCode(value: string) {
  fireEvent.change(screen.getByLabelText("6-digit code"), { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

test("shows the email step on first visit", () => {
  renderForm();
  expect(screen.getByRole("heading", { name: "Sign in" })).toBeVisible();
  expect(
    screen.getByText(
      "Thetis emails you a 6-digit code. Accounts are created by invitation, so use the address your invitation was sent to.",
    ),
  ).toBeVisible();
  expect(screen.getByRole("textbox", { name: "Work email" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Email me a code" })).toBeVisible();
});

test("shows the session-ended note when the session expired", () => {
  renderForm({ expired: true });
  expect(screen.getByRole("status")).toHaveTextContent(
    "Your session ended. Sign in again to continue where you were.",
  );
});

test("refuses a malformed email without calling Auth", () => {
  renderForm();
  submitEmail("naledi.dube@lender-one");
  expect(screen.getByText("Enter a full email address, like name@company.com.")).toBeVisible();
  expect(screen.getByLabelText("Work email")).toHaveAttribute("aria-invalid", "true");
  expect(mocks.auth.signInWithOtp).not.toHaveBeenCalled();
});

test("sends the code without creating users and opens the code step", async () => {
  await openCodeStep();
  expect(mocks.auth.signInWithOtp).toHaveBeenCalledTimes(1);
  expect(mocks.auth.signInWithOtp).toHaveBeenCalledWith({
    email: EMAIL,
    options: { shouldCreateUser: false },
  });
  expect(
    screen.getByText("It works once and expires after one hour.", { exact: false }),
  ).toBeVisible();
  expect(screen.getByText(EMAIL, { exact: false })).toBeVisible();
  expect(screen.getByRole("textbox", { name: "6-digit code" })).toBeVisible();
});

test("opens the same code step when the address has no account", async () => {
  mocks.auth.signInWithOtp.mockResolvedValue(authError("otp_disabled", 422));
  await openCodeStep();
  expect(
    screen.getByText("It works once and expires after one hour.", { exact: false }),
  ).toBeVisible();
  expect(screen.getByText(EMAIL, { exact: false })).toBeVisible();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("shows the rate-limit error and stays on the email step", async () => {
  mocks.auth.signInWithOtp.mockResolvedValue(authError("over_email_send_rate_limit", 429));
  renderForm();
  submitEmail();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Too many codes were requested for this address. Wait a minute, then try again.",
  );
  expect(screen.getByLabelText("Work email")).toBeVisible();
});

test("shows the unreachable error when Auth cannot be reached", async () => {
  mocks.auth.signInWithOtp.mockRejectedValue(new TypeError("fetch failed"));
  renderForm();
  submitEmail();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Thetis could not reach the sign-in service. Check your connection and try again.",
  );
});

test("marks the button busy while sending", async () => {
  let release: (value: unknown) => void = () => {};
  mocks.auth.signInWithOtp.mockReturnValue(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  renderForm();
  submitEmail();
  const busy = await screen.findByRole("button", { name: "Sending code" });
  expect(busy).toBeDisabled();
  expect(busy).toHaveAttribute("aria-busy", "true");
  await act(async () => {
    release({ data: {}, error: null });
  });
});

test("refuses a code that is not six digits without calling verifyOtp", async () => {
  await openCodeStep();
  submitCode("4826");
  expect(screen.getByText("Enter the 6 digits from the email.")).toBeVisible();
  expect(mocks.auth.verifyOtp).not.toHaveBeenCalled();
});

test("rejects a wrong or expired code and keeps the digits", async () => {
  mocks.auth.verifyOtp.mockResolvedValue(authError("otp_expired", 403));
  await openCodeStep();
  submitCode("482691");
  expect(
    await screen.findByText(
      "That code is wrong or has expired. Check the newest email, or send a new code.",
    ),
  ).toBeVisible();
  expect(screen.getByLabelText("6-digit code")).toHaveValue("482691");
});

test("signs in and replaces the route with next", async () => {
  mocks.auth.verifyOtp.mockResolvedValue({
    data: { session: { access_token: "t" } },
    error: null,
  });
  await openCodeStep();
  submitCode("482619");
  await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/invite?token=ab"));
  expect(mocks.auth.verifyOtp).toHaveBeenCalledWith({
    email: EMAIL,
    token: "482619",
    type: "email",
  });
});

test("strips spaces from a pasted code", async () => {
  mocks.auth.verifyOtp.mockResolvedValue({
    data: { session: { access_token: "t" } },
    error: null,
  });
  await openCodeStep();
  submitCode("482 619");
  await waitFor(() => expect(mocks.auth.verifyOtp).toHaveBeenCalledTimes(1));
  expect(mocks.auth.verifyOtp).toHaveBeenCalledWith({
    email: EMAIL,
    token: "482619",
    type: "email",
  });
});

test("redirects at once when a session already exists", async () => {
  mocks.auth.getSession.mockResolvedValue({
    data: { session: { access_token: "t" } },
    error: null,
  });
  renderForm();
  await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/invite?token=ab"));
});

test("sends a new code with a one minute cooldown", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  await openCodeStep();
  expect(mocks.auth.signInWithOtp).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByRole("button", { name: "Send a new code" }));

  expect(await screen.findByRole("status")).toHaveTextContent(
    "A new code is on its way to naledi.dube@lender-one.example. Earlier codes no longer work.",
  );
  expect(mocks.auth.signInWithOtp).toHaveBeenCalledTimes(2);

  const cooling = await screen.findByRole("button", { name: "Send a new code in 1:00" });
  expect(cooling.hasAttribute("disabled") || cooling.getAttribute("aria-disabled") === "true").toBe(
    true,
  );

  await act(async () => {
    vi.advanceTimersByTime(19000);
  });
  expect(screen.getByRole("button", { name: "Send a new code in 0:41" })).toBeVisible();

  await act(async () => {
    vi.advanceTimersByTime(41000);
  });
  const again = screen.getByRole("button", { name: "Send a new code" });
  expect(again).not.toBeDisabled();
  expect(again).not.toHaveAttribute("aria-disabled", "true");
});

test("returns to the email step with the address kept", async () => {
  await openCodeStep();
  fireEvent.click(screen.getByRole("button", { name: "Use a different email" }));
  expect(screen.getByRole("textbox", { name: "Work email" })).toHaveValue(EMAIL);
});

test("marks the button busy while checking the code", async () => {
  let release: ((value: unknown) => void) | undefined;
  mocks.auth.verifyOtp.mockReturnValue(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  await openCodeStep();
  submitCode("482619");
  const busy = screen.getByRole("button", { name: "Checking code" });
  expect(busy).toBeDisabled();
  expect(busy).toHaveAttribute("aria-busy", "true");
  await act(async () => {
    release?.({ data: { session: { access_token: "t" } }, error: null });
  });
});

test.each(["signup_disabled", "user_not_found"])("opens the code step for %s", async (code) => {
  mocks.auth.signInWithOtp.mockResolvedValue(authError(code, 422));
  const input = await openCodeStep();
  // Focus moves in an effect after the step renders.
  await waitFor(() => expect(input).toHaveFocus());
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test.each(["otp_disabled", "signup_disabled"])(
  "shows the normal resend note for %s",
  async (code) => {
    mocks.auth.signInWithOtp.mockResolvedValue(authError(code, 422));
    await openCodeStep();
    fireEvent.click(screen.getByRole("button", { name: "Send a new code" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "A new code is on its way to naledi.dube@lender-one.example. Earlier codes no longer work.",
    );
    // The cooldown runs on the real clock; under load a second can pass first.
    expect(
      screen.getByRole("button", { name: /^Send a new code in (1:00|0:5\d)$/ }),
    ).toHaveAttribute("aria-disabled", "true");
  },
);

test("shows an error when verifying yields neither an error nor a session", async () => {
  mocks.auth.verifyOtp.mockResolvedValue({ data: { session: null }, error: null });
  await openCodeStep();
  submitCode("482619");
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(
    "Thetis could not reach the sign-in service. Check your connection and try again.",
  );
  await waitFor(() => expect(alert).toHaveFocus());
  expect(mocks.replace).not.toHaveBeenCalled();
});

test("clears a lingering local session when the requested reason is expired", async () => {
  mocks.auth.getSession.mockResolvedValue({
    data: { session: { access_token: "t" } },
    error: null,
  });
  renderForm({ expired: true });
  await waitFor(() => expect(mocks.auth.signOut).toHaveBeenCalledWith({ scope: "local" }));
  expect(screen.getByLabelText("Work email")).toBeVisible();
  expect(mocks.replace).not.toHaveBeenCalled();
});

test("treats a failed session lookup as signed out", async () => {
  mocks.auth.getSession.mockRejectedValue(new TypeError("fetch failed"));
  renderForm();
  await act(async () => {});
  expect(screen.getByLabelText("Work email")).toBeVisible();
  expect(mocks.replace).not.toHaveBeenCalled();
});
