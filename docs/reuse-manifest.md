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
| Supabase project config (`supabase init`), **pending PR #9** | Supabase CLI 2.122.1 | MIT | 2026-11-18 | `supabase/config.toml` auth settings (sign-up off, email confirmations, site URL); everything else is the generated default | no |
| Programmatic Signer program binaries (`programs/signing-spike/tests/fixtures/*.so`), **pending PR #10** | Dumped from Solana devnet: `EdSigVfK…`, `ExecxgyH…`, `Noncedie…` (source: solana-program/ed25519-programmatic-signer) | Apache-2.0 (upstream repository) | 2026-11-18 | Unmodified; SHA-256 checked at test load (ADR 0002) | yes |
| Programmatic Signer interface crates, **pending PR #10** | crates.io `spl-ed25519-signer-interface`, `spl-message-executor-interface`, `spl-nonce-interface` 1.0.0 | Apache-2.0 | 2026-11-18 | Unmodified; test-only dev-dependencies | yes |
| Token-2022 program binary used in tests | Bundled in LiteSVM 0.15.0 (SPL Token-2022 11.0.0), not committed | Apache-2.0 | 2026-11-18 | Unmodified (ADR 0001) | yes |
| Associated Token Account program binary used in tests | Bundled in LiteSVM 0.15.0 (SPL Associated Token Account 1.1.1), not committed | Apache-2.0 | 2026-11-18 | Unmodified (ADR 0001) | yes |
| `.gitattributes`, `scripts/check_design.py` (both tracked here) | Copied from the author's private project-process template; the template itself is not in this repository | The author's own work | 2026-11-18 | `check_design.py` reads only tracked `docs/*.md`; `.gitattributes` unchanged | no |
| Design baseline (`DESIGN.md`, `docs/*.md`, `references/*.md`) | The author's own pre-event research and design | The author's own work | before 2026-11-18 | Updated throughout phase 0 | partly |
| Dev3Pack FAQ capture (`references/dev3pack_faq_capture/`) | Saved from the organiser's public FAQ page for reference | Third-party; `faq_page.html` and the minified script are **not ours to redistribute** | before 2026-11-18 | None. **Proposed for removal** of `faq_page.html` and `faq_script_*.js`, keeping `faq_answers.md` (awaiting the author's decision) | no |

## 2. Original pre-event work (phase 0, written for Thetis)

| Deliverable | Pull request | Date | Licence | Solana-related |
|---|---|---|---|---|
| Decisions D34, D35 | #1 | 2026-11-18 | not yet licensed (repository licence pending) | no |
| CI that keeps every run's step logs; local log archiver | #2 | 2026-11-18 | not yet licensed (repository licence pending) | no |
| `packages/domain`: exact-integer position, capacity, release preview and accrual calculations | #3 | 2026-11-18 | not yet licensed (repository licence pending) | yes (on-chain quantities and amounts) |
| `programs/receipt-spike`: Token-2022 receipt enforcement spike (ADR 0001) | #6 | 2026-11-18 | not yet licensed (repository licence pending) | yes |
| `infra/`, `services/`: AWS CDK app for the API, fee sponsor and worker (not deployed) | #7 | 2026-11-18 | not yet licensed (repository licence pending) | partly (fee sponsor) |
| Documentation updates for phase-0 progress | #8 | 2026-11-18 | not yet licensed (repository licence pending) | no |
| Supabase migrations and RLS proof | #9 (pending) | 2026-11-18 | not yet licensed (repository licence pending) | no |
| `programs/signing-spike`: two-party Programmatic Signer spike (ADR 0002) | #10 (pending) | 2026-11-18 | not yet licensed (repository licence pending) | yes |

**Code from the author's non-Solana work:** `.gitattributes` and `scripts/check_design.py` (§1)
come from the author's private, non-Solana project-process template. The Dev3Pack FAQ permits the
entrant's own pre-existing Solana code and open-source libraries, but says nothing about other
pre-existing code, so the **eligibility of these two files is unconfirmed** until the organiser
confirms it (D34). No other code from the author's non-Solana projects is committed. The author's
local delegation script was adapted from another project for local use only and is not in this
repository.

**Repository licence:** none yet. Dev3Pack requires an open-source licence before submission. The
author chooses it, and then this manifest's licence column is updated.

Add a row in the same PR as any new reused component. A reused template or fragment
without a row here is a gate for submission, not a footnote.
