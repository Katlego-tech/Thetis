"use client";

import type { Session } from "@supabase/supabase-js";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { accessAuth } from "@/components/access/access-auth";
import { useAccessSession } from "@/components/access/use-access-session";

function SignedInAccount({ session }: { session: Session }) {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  async function signOut() {
    setSigningOut(true);
    try {
      await accessAuth()?.signOut();
    } catch {
      // Return to the sign-in screen even if the service is unreachable.
    } finally {
      setSigningOut(false);
      router.replace("/login");
    }
  }

  return (
    <nav className="rail-account" aria-label="Account">
      <small className="rail-email">{session.user.email}</small>
      <Link className="rail-link" href="/account">
        Your account
      </Link>
      <button className="rail-link" type="button" disabled={signingOut} onClick={signOut}>
        Sign out
      </button>
    </nav>
  );
}

/** The signed-in person's email, Your account and Sign out (navigation.md §5.3); nothing without a session. */
export function AccountBlock() {
  const session = useAccessSession();
  return session ? <SignedInAccount session={session} /> : null;
}
