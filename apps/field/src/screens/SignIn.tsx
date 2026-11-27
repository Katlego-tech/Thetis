import type { SupabaseClient } from "@supabase/supabase-js";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { Head } from "../components/Blocks";
import { Button, TextLink } from "../components/Button";
import { Field } from "../components/Field";
import { Frame } from "../components/Frame";
import { ErrorBlock, Note } from "../components/Note";
import { Txt } from "../components/Txt";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UNREACHABLE =
  "Thetis could not reach the sign-in service. Check your connection and try again.";
const TIMED_OUT =
  "The sign-in service did not answer within 8 seconds. Nothing changed. Try again.";

type Busy = "sending" | "checking" | null;

function authProblem(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /did not answer in time/.test(message) ? TIMED_OUT : UNREACHABLE;
}

function errorCode(error: unknown): string | null {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : null;
}

export function SignIn(props: { db: SupabaseClient; online: boolean; expired: boolean }) {
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [resent, setResent] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown(cooldown - 1), 1_000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  async function sendCode(again: boolean) {
    if (!EMAIL.test(email.trim())) {
      setFieldError("Enter a full email address, like name@company.com.");
      return;
    }
    setFieldError(null);
    setError(null);
    setBusy("sending");
    try {
      const { error: authError } = await props.db.auth.signInWithOtp({
        email: email.trim(),
        options: { shouldCreateUser: false },
      });
      const codeName = errorCode(authError);
      if (authError && codeName === "over_email_send_rate_limit") {
        setError("Too many codes were requested for this address. Wait a minute, then try again.");
        return;
      }
      // An address with no account (otp_disabled, signup_disabled) looks the same as one with
      // an account: the code step. Only an unreachable or failing service stays on this step.
      if (authError && !(authError.status && authError.status >= 400 && authError.status < 500)) {
        setError(authProblem(authError));
        return;
      }
      setStep("code");
      setCode("");
      setResent(again);
      if (again) setCooldown(60);
    } catch (thrown) {
      setError(authProblem(thrown));
    } finally {
      setBusy(null);
    }
  }

  async function verify() {
    const digits = code.replace(/\s/g, "");
    if (!/^\d{6}$/.test(digits)) {
      setFieldError("Enter the 6 digits from the email.");
      return;
    }
    setFieldError(null);
    setError(null);
    setBusy("checking");
    try {
      const { error: authError } = await props.db.auth.verifyOtp({
        email: email.trim(),
        token: digits,
        type: "email",
      });
      if (authError) {
        const name = errorCode(authError);
        setError(
          name === "otp_expired" || authError.status === 403 || authError.status === 401
            ? "That code is wrong or has expired. Check the newest email, or send a new code."
            : authProblem(authError),
        );
      }
    } catch (thrown) {
      setError(authProblem(thrown));
    } finally {
      setBusy(null);
    }
  }

  const offline = !props.online;
  if (step === "email") {
    return (
      <Frame
        footer={
          <>
            <Button
              label={busy === "sending" ? "Sending code" : "Email me a code"}
              disabled={offline || busy !== null}
              onPress={() => void sendCode(false)}
            />
            {offline ? (
              <Txt variant="small" tone="ink2">
                Connect to a network to get a code.
              </Txt>
            ) : null}
          </>
        }
      >
        <Head title="Sign in" />
        {offline ? (
          <Note>Offline. Signing in needs a connection. Your drafts are still on this phone.</Note>
        ) : null}
        {!offline && props.expired ? (
          <Note>
            Your session ended. Sign in again to continue where you were. Your drafts are still on
            this phone.
          </Note>
        ) : null}
        {!offline && !props.expired ? (
          <Txt tone="ink2" style={{ fontSize: 14 }}>
            Thetis emails you a 6-digit code. Accounts are created by invitation, so use the address
            your invitation was sent to.
          </Txt>
        ) : null}
        <Field
          label="Work email"
          value={email}
          onChangeText={(text) => {
            setEmail(text);
            setFieldError(null);
          }}
          keyboardType="email-address"
          autoCapitalize="none"
          autoComplete="email"
          textContentType="emailAddress"
          error={fieldError}
        />
        {error ? <ErrorBlock>{error}</ErrorBlock> : null}
      </Frame>
    );
  }

  return (
    <Frame
      footer={
        <Button
          label={busy === "checking" ? "Checking code" : "Sign in"}
          disabled={offline || busy !== null}
          onPress={() => void verify()}
        />
      }
    >
      <Head title="Sign in" />
      <Txt style={{ fontSize: 14 }}>
        {resent
          ? `A new code is on its way to ${email.trim()}. Earlier codes no longer work.`
          : `Enter the code sent to ${email.trim()}. It works once and expires after one hour.`}
      </Txt>
      <Field
        label="6-digit code"
        value={code}
        onChangeText={(text) => {
          setCode(text.replace(/\s/g, "").slice(0, 6));
          setFieldError(null);
        }}
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        autoComplete="off"
        maxLength={7}
        mono
        help="Only the newest code works."
        error={fieldError}
      />
      {error ? <ErrorBlock>{error}</ErrorBlock> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 16 }}>
        {cooldown > 0 ? (
          <TextLink
            label={`Send a new code in 0:${cooldown.toString().padStart(2, "0")}`}
            disabled
            onPress={() => {}}
          />
        ) : (
          <TextLink
            label="Send a new code"
            disabled={offline || busy !== null}
            onPress={() => void sendCode(true)}
          />
        )}
        <TextLink
          label="Use a different email"
          onPress={() => {
            setStep("email");
            setError(null);
            setResent(false);
          }}
        />
      </View>
    </Frame>
  );
}
