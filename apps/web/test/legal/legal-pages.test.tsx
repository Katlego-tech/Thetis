import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import LegalLayout from "@/app/(legal)/layout";
import PrivacyPage from "@/app/(legal)/privacy/page";
import TermsPage from "@/app/(legal)/terms/page";

// The pages must render with no Supabase client and no session: any import of the browser or
// server client fails the test.
vi.mock("@/lib/supabase-browser", () => {
  throw new Error("the legal pages must not load the Supabase browser client");
});

afterEach(cleanup);

function show(page: "terms" | "privacy") {
  return render(<LegalLayout>{page === "terms" ? <TermsPage /> : <PrivacyPage />}</LegalLayout>);
}

describe.each([
  ["terms", "Terms of use"],
  ["privacy", "Privacy notice"],
] as const)("/%s", (page, title) => {
  test("renders without a session, naming the publisher and the devnet demo", () => {
    show(page);
    expect(screen.getByRole("heading", { level: 1, name: title })).toBeVisible();
    const facts = screen.getByRole("region", { name: "At a glance" });
    expect(within(facts).getByText("Katlego Tlhapiso, an individual developer")).toBeVisible();
    expect(within(facts).getByText(/Solana devnet/)).toBeVisible();
    expect(within(facts).getByText(/holds no real funds/)).toBeVisible();
    expect(screen.getByText("28 November 2026")).toBeVisible();
  });

  test("links to the other page and to sign-in, never to a signed-in screen", () => {
    show(page);
    const other = page === "terms" ? "Privacy notice" : "Terms of use";
    expect(screen.getByRole("link", { name: other })).toHaveAttribute(
      "href",
      page === "terms" ? "/privacy" : "/terms",
    );
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
    for (const link of screen.getAllByRole("link")) {
      const href = (link.getAttribute("href") ?? "").split("#")[0] ?? "";
      if (href.startsWith("/")) expect(["/login", "/terms", "/privacy"]).toContain(href);
    }
  });
});

test("the privacy notice names each kind of data the app handles", () => {
  show("privacy");
  for (const heading of [
    "Your email address and sign-in codes",
    "Organisation membership",
    "Wallet public keys",
    "Evidence files",
    "Voice",
    "Records on Solana devnet",
    "On your phone",
  ]) {
    expect(screen.getByRole("heading", { level: 3, name: heading })).toBeVisible();
  }
  expect(screen.getByText(/ElevenLabs/, { selector: "p" })).toBeVisible();
});

test("the terms say the demo is not a custody, lending or payment service", () => {
  show("terms");
  expect(screen.getByText(/not a custody, lending, payment or brokerage service/)).toBeVisible();
});
