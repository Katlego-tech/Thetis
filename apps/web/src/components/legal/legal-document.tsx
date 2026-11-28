import Link from "next/link";
import type { ReactNode } from "react";

/** The date both pages took effect; change it whenever either page's substance changes. */
export const LEGAL_EFFECTIVE = "28 November 2026";

export const PUBLISHER = "Katlego Tlhapiso, an individual developer";

export const SOURCE_URL = "https://github.com/Katlego-tech/Thetis";

export interface LegalSection {
  id: string;
  title: string;
  body: ReactNode;
}

const pages = {
  terms: { href: "/terms", title: "Terms of use" },
  privacy: { href: "/privacy", title: "Privacy notice" },
} as const;

/** The facts both pages share, set as a dossier sheet above the text. */
function AtAGlance() {
  return (
    <section className="legal-glance" aria-labelledby="legal-glance-title">
      <div className="legal-glance-head">
        <h2 id="legal-glance-title">At a glance</h2>
        <span className="legal-network">Devnet demo · no real funds</span>
      </div>
      <dl>
        <div>
          <dt>Publisher</dt>
          <dd>{PUBLISHER}</dd>
        </div>
        <div>
          <dt>Apps</dt>
          <dd>The Thetis web app and the Thetis field app for Android</dd>
        </div>
        <div>
          <dt>Network</dt>
          <dd>Solana devnet, a public test network. Thetis holds no real funds.</dd>
        </div>
        <div>
          <dt>Accounts</dt>
          <dd>By invitation only, signed in with a code sent to your email</dd>
        </div>
      </dl>
    </section>
  );
}

export function LegalDocument({
  page,
  intro,
  sections,
}: {
  page: keyof typeof pages;
  intro: ReactNode;
  sections: LegalSection[];
}) {
  const other = page === "terms" ? pages.privacy : pages.terms;
  return (
    <article className="legal-doc">
      <header className="legal-head">
        <h1>{pages[page].title}</h1>
        <p className="legal-effective">
          In effect from <time dateTime="2026-11-28">{LEGAL_EFFECTIVE}</time>
        </p>
        <div className="legal-intro">{intro}</div>
      </header>
      <AtAGlance />
      <nav className="legal-contents" aria-label="On this page">
        <ol>
          {sections.map((section) => (
            <li key={section.id}>
              <a href={`#${section.id}`}>{section.title}</a>
            </li>
          ))}
        </ol>
      </nav>
      <div className="legal-body">
        {sections.map((section) => (
          <section key={section.id} id={section.id} aria-labelledby={`${section.id}-title`}>
            <h2 id={`${section.id}-title`}>{section.title}</h2>
            {section.body}
          </section>
        ))}
      </div>
      <footer className="legal-foot">
        <span>Also read the</span> <Link href={other.href}>{other.title}</Link>
      </footer>
    </article>
  );
}
