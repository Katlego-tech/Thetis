import Link from "next/link";
import type { ReactNode } from "react";
import "./legal.css";

/** Public pages: no session, no Supabase client, readable before anyone is invited. */
export default function LegalLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <header className="legal-topbar">
        <span className="legal-wordmark">THETIS</span>
        <Link className="legal-signin" href="/login">
          Sign in
        </Link>
      </header>
      <main className="legal-main">{children}</main>
    </>
  );
}
