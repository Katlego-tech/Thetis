"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { accessMessages } from "@/lib/access-messages";
import { accessAuth } from "./access-auth";

const messages = accessMessages.login;
const resendSeconds = 60;
const hiddenAccountCodes = new Set(["otp_disabled", "signup_disabled", "user_not_found"]);

type LoginError = { field: boolean; message: string };
type PendingAction = "send" | "verify" | "resend" | null;

export function LoginForm({ next, expired }: { next: string; expired: boolean }) {
  const router = useRouter();
  const replace = router.replace;
  const [email, setEmail] = useState("");
  const [codeStep, setCodeStep] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<LoginError | null>(null);
  const [pending, setPending] = useState<PendingAction>(null);
  const [resent, setResent] = useState(false);
  const [resendUntil, setResendUntil] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const errorBlock = useRef<HTMLDivElement>(null);
  const sessionCheck = useRef<Promise<void> | undefined>(undefined);

  useEffect(() => {
    let active = true;

    async function checkSession() {
      const auth = accessAuth();
      if (!auth) return;

      try {
        const { data, error } = await auth.getSession();
        if (!active || error || !data.session) return;
        if (expired) {
          await auth.signOut({ scope: "local" });
        } else {
          replace(next);
        }
      } catch {
        // Leave the email form available if the initial session check fails.
      }
    }

    sessionCheck.current = checkSession();
    return () => {
      active = false;
    };
  }, [expired, next, replace]);

  useEffect(() => {
    if (codeStep) input.current?.focus();
  }, [codeStep]);

  useEffect(() => {
    if (error?.field) input.current?.focus();
    else if (error) errorBlock.current?.focus();
  }, [error]);

  useEffect(() => {
    if (!resendUntil) return;
    const timer = window.setInterval(() => {
      const remaining = Math.max(0, Math.ceil((resendUntil - Date.now()) / 1000));
      setSecondsLeft(remaining);
      if (remaining === 0) setResendUntil(0);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [resendUntil]);

  async function sendCode(resend: boolean) {
    if (pending || (resend && secondsLeft > 0)) return;
    setError(null);
    setResent(false);
    const address = email.trim();

    if (
      !resend &&
      (!/^[^@\s]+@[^@.\s]+(?:\.[^@.\s]+)+$/.test(address) || input.current?.validity.typeMismatch)
    ) {
      setError({ field: true, message: messages.emailInvalid });
      return;
    }

    const auth = accessAuth();
    if (!auth) {
      setError({ field: false, message: messages.unreachable });
      return;
    }

    setPending(resend ? "resend" : "send");
    try {
      if (expired) await sessionCheck.current;
      const { error } = await auth.signInWithOtp({
        email: address,
        options: { shouldCreateUser: false },
      });

      if (error && (error.status === 0 || !hiddenAccountCodes.has(error.code ?? ""))) {
        setError({
          field: false,
          message:
            error.status !== 0 && error.code === "over_email_send_rate_limit"
              ? messages.rateLimited
              : messages.unreachable,
        });
        return;
      }

      setEmail(address);
      setCode("");
      setCodeStep(true);
      if (resend) {
        setResent(true);
        setSecondsLeft(resendSeconds);
        setResendUntil(Date.now() + resendSeconds * 1000);
      }
    } catch {
      setError({ field: false, message: messages.unreachable });
    } finally {
      setPending(null);
    }
  }

  async function verifyCode() {
    if (pending) return;
    setError(null);
    setResent(false);
    const token = code.replace(/\s/g, "");
    if (!/^[0-9]{6}$/.test(token)) {
      setError({ field: true, message: messages.codeShape });
      return;
    }

    const auth = accessAuth();
    if (!auth) {
      setError({ field: false, message: messages.unreachable });
      return;
    }

    setPending("verify");
    try {
      const { data, error } = await auth.verifyOtp({
        email,
        token,
        type: "email",
      });
      if (error?.status !== 0 && error?.code === "otp_expired") {
        setError({ field: true, message: messages.codeRejected });
      } else if (error || !data.session) {
        setError({ field: false, message: messages.unreachable });
      } else {
        replace(next);
        return;
      }
    } catch {
      setError({ field: false, message: messages.unreachable });
    }
    setPending(null);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (codeStep) void verifyCode();
    else void sendCode(false);
  }

  function changeEmail() {
    setCodeStep(false);
    setCode("");
    setError(null);
    setResent(false);
    setResendUntil(0);
    setSecondsLeft(0);
    // The field changes from code to email as the state update is committed.
    requestAnimationFrame(() => input.current?.focus());
  }

  const fieldError = error?.field ? error.message : undefined;
  const fieldId = codeStep ? "access-code" : "access-work-email";
  const descriptionId =
    [codeStep ? "access-code-help" : "", fieldError ? "access-field-error" : ""]
      .filter(Boolean)
      .join(" ") || undefined;
  const busy = pending === "send" || pending === "verify";
  const submitLabel = codeStep
    ? pending === "verify"
      ? "Checking code"
      : "Sign in"
    : pending === "send"
      ? "Sending code"
      : "Email me a code";
  const countdown = `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")}`;
  const resendDisabled = pending !== null || secondsLeft > 0;
  const note = resent
    ? messages.codeResent({ email })
    : !codeStep && expired
      ? messages.sessionEnded
      : "";

  return (
    <div className="access-gate">
      <form
        className="access-card"
        aria-labelledby="access-login-title"
        noValidate
        onSubmit={submit}
      >
        <h1 className="access-title" id="access-login-title">
          Sign in
        </h1>
        <p className="access-intro">
          {codeStep ? (
            <>
              Enter the code sent to <strong className="access-address">{email}</strong>. It works
              once and expires after one hour.
            </>
          ) : (
            "Thetis emails you a 6-digit code. Accounts are created by invitation, so use the address your invitation was sent to."
          )}
        </p>
        <p className={note ? "access-status access-note" : "access-status"} role="status">
          {note}
        </p>
        <div className="access-field">
          <label className="access-label" htmlFor={fieldId}>
            {codeStep ? "6-digit code" : "Work email"}
          </label>
          <input
            key={fieldId}
            ref={input}
            id={fieldId}
            className={codeStep ? "access-input access-code" : "access-input"}
            type={codeStep ? "text" : "email"}
            inputMode={codeStep ? "numeric" : undefined}
            autoComplete={codeStep ? "one-time-code" : "email"}
            aria-invalid={fieldError ? true : undefined}
            aria-describedby={descriptionId}
            readOnly={pending !== null}
            value={codeStep ? code : email}
            onChange={(event) => {
              if (codeStep) setCode(event.target.value);
              else setEmail(event.target.value);
            }}
          />
          {fieldError && (
            <span id="access-field-error" className="access-field-error">
              {fieldError}
            </span>
          )}
          {codeStep && (
            <span id="access-code-help" className="access-help">
              Only the newest code works.
            </span>
          )}
        </div>
        {error && !error.field && (
          <div className="access-error" role="alert" tabIndex={-1} ref={errorBlock}>
            {error.message}
          </div>
        )}
        <button
          className="access-primary"
          type="submit"
          disabled={pending !== null}
          aria-busy={busy || undefined}
        >
          {submitLabel}
        </button>
        {codeStep && (
          <div className="access-actions">
            <button
              className="access-link"
              type="button"
              aria-disabled={resendDisabled || undefined}
              onClick={() => void sendCode(true)}
            >
              {secondsLeft > 0 ? `Send a new code in ${countdown}` : "Send a new code"}
            </button>
            <button
              className="access-link"
              type="button"
              disabled={pending !== null}
              onClick={changeEmail}
            >
              Use a different email
            </button>
          </div>
        )}
      </form>
    </div>
  );
}
