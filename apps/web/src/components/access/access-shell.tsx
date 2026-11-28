"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { accessAuth } from "./access-auth";
import { useAccessSession } from "./use-access-session";

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
  const session = useAccessSession();
  // The session signed out from; a later session (signing back in) shows the links again.
  const [signedOutToken, setSignedOutToken] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  async function signOut() {
    setSigningOut(true);
    try {
      await accessAuth()?.signOut();
    } catch {
      // Return to the sign-in screen even if the service is unreachable.
    } finally {
      setSignedOutToken(session?.access_token ?? null);
      setSigningOut(false);
      router.replace("/login");
    }
  }

  return (
    <header className="access-topbar">
      {session && session.access_token !== signedOutToken ? (
        <>
          <Link className="access-wordmark" href="/account">
            THETIS
          </Link>
          <div className="access-who">
            <span className="access-email">{session.user.email}</span>
            <Link className="access-sign-out" href="/">
              Work queue
            </Link>
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
