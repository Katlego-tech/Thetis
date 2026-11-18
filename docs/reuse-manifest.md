# Reuse manifest

Every component, template or code fragment in this repository that was not written during the
Dev3Pack event: third-party and generated material (§1) and the author's original pre-event work
(§2) (D34). The README's "built before vs. during the event" section is generated from,
or links to, this file. Open-source libraries are listed by their dependency manifests
(`package.json`, `pnpm-lock.yaml`, `Cargo.toml`, `Cargo.lock`), not one by one.

**Event window:** Dev3Pack build window, 27–29 November 2026. Everything below was added
before the event (phase 0) unless its date says otherwise.

## 1. Third-party, generated and template material

| Item | Source | Licence | Date reused | What was changed | Solana-related |
|---|---|---|---|---|---|
| Anchor program template (`anchor init` / `anchor new`) | Anchor 1.2.2 CLI | Apache-2.0 | 2026-11-18 | Only the workspace layout and the `Cargo.toml` and `Anchor.toml` skeletons remain; the counter example was replaced in `programs/receipt-spike` and `programs/signing-spike` | yes |
| Supabase project files (`supabase init`): `supabase/config.toml`, `supabase/.gitignore` (PR #9) | Supabase CLI 2.122.1 | MIT | 2026-11-18 | `config.toml` auth settings (sign-up off, email confirmations, site URL), otherwise the generated default; `.gitignore` unchanged | no |
| Programmatic Signer program binaries (`programs/signing-spike/tests/fixtures/*.so`) (PR #10) | Dumped from Solana devnet: `EdSigVfK…`, `ExecxgyH…`, `Noncedie…` (source: solana-program/ed25519-programmatic-signer) | Apache-2.0 (upstream repository); licence text shipped beside them as `LICENSE-ed25519-programmatic-signer` | 2026-11-18 | Unmodified; SHA-256 checked at test load (ADR 0002) | yes |
| Programmatic Signer interface crates (PR #10) | crates.io `spl-ed25519-signer-interface`, `spl-message-executor-interface`, `spl-nonce-interface` 1.0.0 | Apache-2.0 | 2026-11-18 | Unmodified; test-only dev-dependencies | yes |
| Token-2022 program binary used in tests | Bundled in LiteSVM 0.15.0 (SPL Token-2022 11.0.0), not committed | Apache-2.0 | 2026-11-18 | Unmodified (ADR 0001) | yes |
| Associated Token Account program binary used in tests | Bundled in LiteSVM 0.15.0 (SPL Associated Token Account 1.1.1), not committed | Apache-2.0 | 2026-11-18 | Unmodified (ADR 0001) | yes |
| CI tools downloaded and run by `.github/workflows/checks.yml` (exact versions and checksums pinned there): GitHub Actions `checkout`, `setup-node`, `cache`, `upload-artifact`, `supabase/setup-cli`; Gitleaks; OSV-Scanner; jscpd; Solana CLI (Agave) and Anchor CLI release binaries | Each tool's upstream release | MIT (Gitleaks, the GitHub Actions, `supabase/setup-cli`, jscpd); Apache-2.0 (OSV-Scanner, Agave, Anchor) | 2026-11-18 | Unmodified; run in CI only, not shipped | partly (Solana, Anchor) |
| Address Lookup Table program binary used in tests (PR #10) | Bundled in LiteSVM 0.15.0, not committed | Apache-2.0 | 2026-11-18 | Unmodified; creates and extends the relay lookup table (ADR 0002) | yes |
| `.gitattributes`, `scripts/check_design.py`, and the initial versions of `.github/workflows/checks.yml`, `.gitignore`, `.env.example` and `mocks/.gitkeep` (all tracked here) | Copied from the author's private project-process template; the template itself is not in this repository | The author's own work | 2026-11-18 | `check_design.py` reads only tracked `docs/*.md`; `checks.yml` gained a design-document step at bootstrap and later every Node, Rust, database and log-keeping step (§2); `.gitignore` and `.env.example` were extended for this stack; `.gitattributes` unchanged | no |
| Design baseline (`DESIGN.md`, `docs/*.md`, `references/*.md`) | The author's own pre-event research and design | The author's own work | before 2026-11-18 | Updated throughout phase 0 | partly |
| Dev3Pack FAQ capture (`references/dev3pack_faq_capture/`) | Saved from the organiser's public FAQ page for reference | Third-party; `faq_page.html` and the minified script are **not ours to redistribute** | 2026-11-18 | None. `faq_answers.md` also reproduces the organiser's answers **verbatim**, with no recorded permission. **Proposed:** remove `faq_page.html` and `faq_script_*.js`, and replace `faq_answers.md` with a sourced summary (link and capture date) unless the organiser permits reuse (awaiting the author's decision) | no |

## 2. Original pre-event work (phase 0, written for Thetis)

| Deliverable | Pull request | Date | Licence | Solana-related |
|---|---|---|---|---|
| Decisions D34, D35 (the patterns are adapted, see §3) | #1 | 2026-11-18 | not yet licensed (repository licence pending) | no |
| CI that keeps every run's step logs; local log archiver | #2 | 2026-11-18 | not yet licensed (repository licence pending) | no |
| `packages/domain`: exact-integer position, capacity, release preview and accrual calculations; CI Node workspace checks (install, lint, typecheck, test), dependency scan and duplication scan | #3 | 2026-11-18 | not yet licensed (repository licence pending) | yes (on-chain quantities and amounts) |
| `programs/receipt-spike`: Token-2022 receipt enforcement spike (ADR 0001); CI Rust and Anchor checks (verified Solana and Anchor install, fmt, clippy, build, tests) and Cargo dependency scan | #6 | 2026-11-18 | not yet licensed (repository licence pending) | yes |
| `infra/`, `services/`: AWS CDK app for the API, fee sponsor and worker (not deployed) | #7 | 2026-11-18 | not yet licensed (repository licence pending) | partly (fee sponsor) |
| Documentation updates for phase-0 progress | #8 | 2026-11-18 | not yet licensed (repository licence pending) | no |
| Supabase migrations and RLS proof; CI database tests | #9 | 2026-11-18 | not yet licensed (repository licence pending) | no |
| `programs/signing-spike`: two-party Programmatic Signer spike (ADR 0002) | #10 | 2026-11-18 | not yet licensed (repository licence pending) | yes |

## 3. Patterns adapted from the author's other projects

No code was copied; these are ideas carried over and rewritten for Thetis.

| Pattern | Source project | Where in Thetis | What is Thetis-specific | Solana-related |
|---|---|---|---|---|
| Keep a reuse manifest from the first commit for event eligibility | Panelwise (cross-project review) | D34, this file | The event rules it answers (Dev3Pack FAQ) and the row format | no |
| An indexer fails loudly on anything it does not recognise | UbuntuRemit (audit-verifier lesson) | D35 | Scoped to the Thetis program's own instructions, events and accounts, after replay deduplication | yes |

**Code from the author's non-Solana work:** the template files in §1 (`.gitattributes`,
`scripts/check_design.py` and the initial CI workflow, `.gitignore`, `.env.example`) come from the author's private, non-Solana project-process template. The Dev3Pack FAQ permits the
entrant's own pre-existing Solana code and open-source libraries, but says nothing about other
pre-existing code, so the **eligibility of these files is unconfirmed** until the organiser
confirms it (D34). No other code from the author's non-Solana projects is committed. The author's
local delegation script was adapted from another project for local use only and is not in this
repository.

**Repository licence:** none yet. Dev3Pack requires an open-source licence before submission. The
author chooses it, and then this manifest's licence column is updated.

Add a row in the same PR as any new reused component. A reused template or fragment
without a row here is a gate for submission, not a footnote.
