"use client";

import type { Session } from "@supabase/supabase-js";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { accessAuth } from "./access-auth";

export function TestBanner() {
  return (
    <div className="access-banner">
      <strong>Test environment.</strong> Organisations are synthetic, and nothing on these pages is
      recorded on chain.
    </div>
  );
}

export function TopBar() {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    const auth = accessAuth();
    if (!auth) return;

    let active = true;
    let receivedAuthEvent = false;

    try {
      const sessionLookup = auth.getSession();
      const {
        data: { subscription },
      } = auth.onAuthStateChange((_event, newSession) => {
        receivedAuthEvent = true;
        if (active) setSession(newSession);
      });

      void sessionLookup.then(
        ({ data, error }) => {
          if (active && !receivedAuthEvent) setSession(error ? null : data.session);
        },
        () => {
          if (active && !receivedAuthEvent) setSession(null);
        },
      );

      return () => {
        active = false;
        subscription.unsubscribe();
      };
    } catch {
      setSession(null);
    }
  }, []);

  async function signOut() {
    setSigningOut(true);
    try {
      await accessAuth()?.signOut();
    } catch {
      // Return to the sign-in screen even if the service is unreachable.
    } finally {
      setSession(null);
      setSigningOut(false);
      router.replace("/login");
    }
  }

  return (
    <header className="access-topbar">
      {session ? (
        <>
          <Link className="access-wordmark" href="/account">
            THETIS
          </Link>
          <div className="access-who">
            <span className="access-email">{session.user.email}</span>
            <button
              className="access-sign-out"
              type="button"
              disabled={signingOut}
              onClick={signOut}
            >
              Sign out
            </button>
          </div>
        </>
      ) : (
        <span className="access-wordmark">THETIS</span>
      )}
    </header>
  );
}
