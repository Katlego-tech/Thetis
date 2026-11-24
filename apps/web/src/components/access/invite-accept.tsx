"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { accessMessages } from "@/lib/access-messages";
import { supabaseBrowser } from "@/lib/supabase-browser";
import { isExpiredResponse, loginHref } from "./session-expired";

const messages = accessMessages.invite;

type JoinedMembership = {
  member_role: "admin" | "member";
  organisations: { name: string } | null;
};

type Acceptance =
  | { phase: "ready" | "accepting" | "failed" | "invalid" | "redirecting" }
  | { phase: "joined"; name: string; role: "admin" | "member" };

export function InviteAccept({ token }: { token: string | null }) {
  return (
    <div className="access-gate">
      {token && /^[0-9a-f]{64}$/.test(token) && token.length === 64 ? (
        <Invitation key={token} token={token} />
      ) : (
        <div className="access-card">
          <h1 className="access-title">This invitation link is incomplete</h1>
          <p className="access-intro">{messages.incomplete}</p>
        </div>
      )}
    </div>
  );
}

function Invitation({ token }: { token: string }) {
  const { replace } = useRouter();
  const next = `/invite?token=${token}`;
  const [session, setSession] = useState<{ email: string | undefined } | null>();
  const [acceptance, setAcceptance] = useState<Acceptance>({ phase: "ready" });
  const [signingOut, setSigningOut] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(false);
  const { phase } = acceptance;

  useEffect(() => {
    let active = true;
    mounted.current = true;

    async function checkSession() {
      try {
        const { data, error } = await supabaseBrowser().auth.getSession();
        if (!active) return;
        if (error?.status === 401) {
          replace(loginHref(next, true));
          return;
        }
        setSession(!error && data.session ? { email: data.session.user.email } : null);
      } catch {
        if (active) setSession(null);
      }
    }

    void checkSession();
    return () => {
      active = false;
      mounted.current = false;
    };
  }, [next, replace]);

  useEffect(() => {
    if (phase === "joined" || phase === "invalid" || phase === "failed") heading.current?.focus();
  }, [phase]);

  function redirect(href: string) {
    setAcceptance({ phase: "redirecting" });
    replace(href);
  }

  async function accept() {
    if (phase !== "ready" && phase !== "failed") return;
    setAcceptance({ phase: "accepting" });

    let membershipId: string;
    try {
      const result = await supabaseBrowser().rpc("accept_invitation", { token });
      if (!mounted.current) return;
      if (isExpiredResponse(result)) {
        redirect(loginHref(next, true));
        return;
      }
      if (result.error?.code === "P0001" && result.error.message === "INVITATION_INVALID") {
        setAcceptance({ phase: "invalid" });
        return;
      }
      if (result.error || typeof result.data !== "string") {
        setAcceptance({ phase: "failed" });
        return;
      }
      membershipId = result.data;
    } catch {
      if (mounted.current) setAcceptance({ phase: "failed" });
      return;
    }

    try {
      const result = await supabaseBrowser()
        .from("memberships")
        .select("id, member_role, organisations(name)")
        .eq("id", membershipId)
        .single();
      if (!mounted.current) return;
      if (isExpiredResponse(result)) {
        redirect(loginHref(next, true));
        return;
      }
      // This embed follows the membership's foreign key to one organisation.
      const membership = result.data as JoinedMembership | null;
      if (!result.error && membership?.organisations) {
        setAcceptance({
          phase: "joined",
          name: membership.organisations.name,
          role: membership.member_role,
        });
        return;
      }
    } catch {
      // The invitation was already accepted. The account can show the new membership.
    }
    if (mounted.current) redirect("/account");
  }

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await supabaseBrowser().auth.signOut();
    } catch {
      // Follow the access shell's sign-out navigation when the service is unreachable.
    }
    if (mounted.current) redirect(loginHref(next, false));
  }

  if (session === undefined || phase === "redirecting") {
    return <div className="access-card" aria-busy="true" />;
  }

  if (!session) {
    return (
      <div className="access-card">
        <h1 className="access-title">You have an invitation</h1>
        <p className="access-intro">
          Sign in with the email address this invitation was sent to. You come back here to accept
          it.
        </p>
        <Link className="access-primary access-primary-link" href={loginHref(next, false)}>
          Sign in to accept
        </Link>
      </div>
    );
  }

  if (acceptance.phase === "joined") {
    const { name, role } = acceptance;
    return (
      <div className="access-card">
        <h1 className="access-title" ref={heading} tabIndex={-1}>
          You joined {name}
        </h1>
        <p className="access-note">
          Your role is <strong>{role === "admin" ? "Admin" : "Member"}</strong>. You can now see{" "}
          {name}'s work in Thetis.
        </p>
        <p className="access-intro">To sign for {name} later, link a wallet to your account.</p>
        <Link className="access-primary access-primary-link" href="/account">
          Link a wallet
        </Link>
      </div>
    );
  }

  return (
    <div className="access-card">
      <h1 className="access-title" ref={heading} tabIndex={-1}>
        Accept your invitation
      </h1>
      {phase === "invalid" ? (
        <>
          <div className="access-error" role="alert">
            {messages.invalid}
          </div>
          <p className="access-intro">{messages.invalidHelp}</p>
          <div className="access-actions">
            <Link className="access-link" href="/account">
              Go to your account
            </Link>
            <button className="access-link" type="button" disabled={signingOut} onClick={signOut}>
              Sign out and use another email
            </button>
          </div>
        </>
      ) : (
        <>
          {phase === "failed" ? (
            <div className="access-error" role="alert">
              {messages.failed}
            </div>
          ) : (
            <>
              <p className="access-intro">
                You are signed in as <strong className="access-address">{session.email}</strong>.
                Accepting makes you a member of the organisation that invited this address.
              </p>
              <p className="access-intro">
                Membership shows you that organisation's work. It does not let you sign for it:
                signing needs a linked wallet and an on-chain delegation.
              </p>
            </>
          )}
          <button
            className="access-primary"
            type="button"
            onClick={accept}
            disabled={phase === "accepting"}
            aria-busy={phase === "accepting" || undefined}
          >
            {phase === "accepting" ? "Accepting" : "Accept invitation"}
          </button>
        </>
      )}
    </div>
  );
}
