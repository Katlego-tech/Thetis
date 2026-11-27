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
  const [signedOut, setSignedOut] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  async function signOut() {
    setSigningOut(true);
    try {
      await accessAuth()?.signOut();
    } catch {
      // Return to the sign-in screen even if the service is unreachable.
    } finally {
      setSignedOut(true);
      setSigningOut(false);
      router.replace("/login");
    }
  }

  return (
    <header className="access-topbar">
      {session && !signedOut ? (
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
