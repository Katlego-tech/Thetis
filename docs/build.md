# Build sequence, acceptance and demonstration

The criteria below define the evidence required during implementation.

> **Phase-0 progress, 18 November 2026.** Item 1 is done: Token-2022 restriction is proven and D25 confirmed ([ADR 0001](adr/0001-receipt-enforcement.md)). Item 2 is partly done: the on-chain half (two parties authorising one instruction through the Programmatic Signer, with the sponsor paying) passes offline in PR #10, using raw keys. Still open, and still gating the program account layout: real wallets (the Mock MWA Wallet on the emulator, Solflare and Phantom on the two phones) returning signatures over exactly the authorization bytes; what each wallet displays; and the sponsor relaying those wallet-produced signatures on devnet. Item 3 is partly done: the toolchain is pinned, and generated program clients wait for the Thetis program. Item 4 is partly done: the database access rules are proven (`supabase/`, 102 tests in CI); invitation login, the wallet-link API and the web-wallet provider choice remain. Item 6 is done (`packages/domain` and its fixtures). Item 7 is done: in checkouts with the hooks enabled, one gate runs locally before every push, and CI runs the same checks on every pull request whether or not the hooks were enabled. Item 8 is decided (demo assumptions, confirmed by the user; nothing here runs yet):
>
> - **Route:** inland mine stockpile → rail siding → port terminal stockyard at a generic east-coast port. No real port, corridor or operator is named.
> - **Synthetic organisations,** each labelled synthetic on screen: Khunou Ore Exports (exporter), Kopano Stockyard Custody (custodian), Mosela Haulage (transporter), Port Terminal T1, Lender One Bank, Lender Two Bank and Buyer Smelter Co.
> - **Lot:** chrome ore lot CR-0001 of 5,000 t, valued at USD 200/t with a USD 600,000 advance. A buyer takes 2,000 t for USD 400,000. Facility currency is USD.
> - **Manifest grouping:** one labelled synthetic batch (D21).
> - **Loading document:** a synthetic bill of lading PDF whose SHA-256 is recorded. The demo never claims it secures the loan.
>
> Item 5 remains.

## 1. Phase 0 choices and proof

> **Updated 18 November 2026.** Item 2 is replaced by D27 (the signed-message test), and toolchain choices follow the "Phase-0 notes" in the [decision register](decisions.md). Acceptance A10–A11 are applied to signed intent messages (D23).

Before the program account layout is fixed:

1. Demonstrate receipt restriction enforcement or select program-only fallback. Test direct token-program paths, not only app buttons.
2. Prove two-wallet partial signing of the same message using the chosen mobile/web wallet combination on real devices; include expiry and timeout reconciliation. Verify custom Expo/native-module compatibility.
3. Pin compatible Rust/Anchor/Solana, Node/TypeScript, Next.js/Expo, wallet and provider versions. Generate shared program client types; preserve integer strings at API boundaries.
4. Confirm Supabase invitation/login, entity-scoped RLS, private original-file identity and wallet linking. Choose web-wallet provider and recovery behavior.
5. Run minimal ElevenLabs client navigation plus an authorised backend lookup on web and Android; prove normal typed fallback and expiry failure handling.
6. Write the domain calculation fixtures, including the release examples in [domain](domain.md), using exact integers and named rounding rules.
7. Create a single verification command shared by local work and CI. Missing required tools/checks must fail visibly, never produce a success by skipping the core.
8. Decide one demo route, named synthetic organisations, facility currency, manifest grouping and loading-document example. Record all demo assumptions.

The Hackathon kit can provide judged-format documentation and gate patterns at scaffold time. Use a custom/no-stack option compatible with Anchor + Next.js + Expo, rather than letting a default unrelated stack replace the agreed architecture. Do not import automatic phase cutoffs that conflict with the team's requirement that any completed, verified phase is eligible for submission. Event configuration must not fabricate scoring weights.

## 2. Phases retained from the revised project

| Phase | Work | Required completion evidence |
|---|---|---|
| 0 Foundations | Technical spikes, scaffold, schemas, gate, source ledger | Token/authority decision, working two-device proof, reliable gate, no hidden mocks |
| 1 Lot records | Organisations, delegates, independent custody policy, origin, intake identity, capacity, positions, restricted transfer/split, joint collection, original evidence | Duplicate, wrong-owner, related-custodian, missing-origin, over-capacity and single-party collection refusal; immutable stored originals |
| 2 Locks and settlement | Facilities, valuations, exact locks, accrual, advances, intents, confirmations, repayment, residual-limit releases, recovery, isolated adapters | Cross-lender refusal, currency/purpose binding, exact accounting and single consumption; no live bank/USDC claim |
| 3 Custody and exits | Routes, batch manifests, destination reservations, dual signing, partial arrival, port release eligibility, loading hand-offs, observations/shortfalls | Missing batch cannot finish arrival; expiry/replay refused; loading preserves unpaid debt and approvals; custody persists through recovery |
| 4 Apps and demo | Task queues, dossier, mobile signing, web lender workbench, price references, ElevenLabs, labelled seed scenarios | End-to-end demo from clean setup; actual wallet receipts, typed fallback, recorded runs below limit |
| 5 Hardening | Policy-versioned document allowances, route changes, disputes, payout order, correction tooling | No allowance duplication, no released reservation before diversion secured, no duplicated compensation |
| 6 Interchangeable stock | Cohorts/grade stock, arrival/merge lineage, oldest-expiry-first withdrawals, split for loading | Mass/claim/debt conservation and grade eligibility across each operation; required if pilot cannot preserve separate lots |
| 7 Report/evidence versioning | Revision history, source manifests, immutable dossiers, stale detection and historical retrieval | New evidence creates new version; stale reports labelled; access denied across unrelated parties |
| 8 Extraction/orchestration | Assay, weighbridge, origin and transport-document extraction; reviewed dossiers; bounded agent jobs | Labelled fixture metrics and review routes; malicious/uncertain input cannot attest or mutate value |
| 9 ETA/logistics | Stage-level observations, historic baselines, intervals, delayed-event handling | Replay metrics, interval coverage, stale/unavailable behavior and source freshness |

Build in order with integration checkpoints. How these phases fit the calendar is the team's decision. No phase is automatically reserved for after the hackathon; unfinished capability remains disabled and labelled planned.

## 3. Acceptance scenarios

| ID | Scenario and expected result |
|---|---|
| A01 | Reissue consumed intake under same custodian, including after final retirement: refuse without capacity/supply changes |
| A02 | Direct receipt transfer/burn/delegate/authority-change outside program: cannot bypass permissions or invalidate accounting |
| A03 | Concurrent lender pledges on same available units: at most one succeeds; distinct genuinely free quantities may be financed |
| A04 | Cross-lender valuation update or payment confirmation: refused |
| A05 | Reuse payment reference on another loan or new operation: refused; same API retry returns the original outcome |
| A06 | Right amount but wrong currency, buyer, loan, purpose or intent digest: no release |
| A07 | 2,000 t sale at USD400k on synthetic USD600k debt leaves USD200k debt on 3,000 t; USD210k sale requires USD30k top-up |
| A08 | Bank-received payment, expired intent or failed chain transaction: money is recorded as unresolved; no fake completion or automatic reallocation |
| A09 | Confirmed sale followed by bank correction: append exception, do not reverse customer balances silently |
| A10 | Wrong-party, wrong-sequence, different-manifest or one-signature handover: refused |
| A11 | Expired co-signed transaction: reconcile then require both fresh signatures; no copied signature accepted |
| A12 | Two batches depart and only one arrives: accurate partial occupancy/reservation; aggregate remains InTransit, lot-wide sale blocked |
| A13 | Concurrent destination reservations: cannot overbook; route diversion retains old reservation until replacement secured |
| A14 | Document expires/revokes after preparation: departure recheck blocks it; repayment remains possible |
| A15 | File replaced at an upload path: cannot change the original behind an existing attestation; correction gets new identity |
| A16 | Partial port sale after complete arrival: permitted; a prepared next shipment blocks sale |
| A17 | Loading with changed document, stale approval or one missing lender: refused; successful unpaid loading preserves ExternalHandoff debt |
| A18 | Single-party or pledged collection: refused; final valid collection burns units, frees capacity and preserves intake tombstone |
| A19 | Liquidation mid-transit: recovery ownership changes, custody and reservation remain; seized ore is not liquid pool cash |
| A20 | Repeated shortfall observation or within-tolerance reading: no duplicate payout or automatic slash |
| A21 | Ordinary login attempts lender mutation without delegation, or other-org access to evidence: refused independently in API/database/program as applicable |
| A22 | Agent prompt injection, fake route or request to sign: cannot invoke mutation authority; uncertainty escalates to review |
| A23 | New evidence after report generation: previous report remains immutable and is marked stale; new version references changed input |
| A24 | Offline mobile draft or unavailable audio: no completed custody event; touch/type draft recovery remains available |
| A25 | Loan amount near integer limit, repeated accrual, rounding, partial repayment: checked arithmetic and conservation across both settlement adapters |
| A26 | Capacity and claim corrections after measured shortage: physical quantity and liability remain distinct; reviewed resolution is attributable |

Tests should establish invariants, concurrency and refusal behavior, not count toward beating another team. Keep property/scenario fixtures for quantity and money conservation, with negative tests for every externally controlled identifier and permission boundary.

## 4. Revised demo specification

> **Superseded where different (18 November 2026).** The decided running order, tagline and settlement mode are D20, D22 and D26 in the [decision register](decisions.md). The text below is kept for reference.

Target **2:50**, leaving margin under the captured strict three-minute rule. Use one narrative and deterministic reset; an extended walkthrough covers batch-scale and correction cases.

| Time | Action | Honest evidence |
|---|---|---|
| 0:00–0:15 | Named illustrative exporter and a documented custody-review problem | Source for general in-transit risk; no claimed customer or savings |
| 0:15–0:35 | Custodian issues 5,000 t synthetic chrome lot with origin/assay evidence | Actual devnet registry action, labelled fixture |
| 0:35–0:55 | Lender locks and records advance; second lender tries same units | Refusal: **same registered units already pledged**, not universal fraud prevention |
| 0:55–1:30 | Two phones complete custody transfer; wrong driver refused; terminal accepts arrival | Actual signatures and receipts; one synthetic batch, further stages condensed honestly |
| 1:30–1:45 | Voice opens dossier or explains missing documents | Real tool-backed response; agent cannot sign |
| 1:45–2:10 | At Stored port lot, buyer takes 2,000 t through exact release workflow | Use one declared settlement mode: demo USDC transfer or simulated bank-credit attestation; show debt and quantity arithmetic |
| 2:10–2:20 | Labelled lender-valuation stress | Current computed coverage; no scraped reference promoted to authoritative value |
| 2:20–2:40 | Terminal/owner and lender complete loading hand-off | Actual registry retirement, transport fixture, debt visibly retained if unpaid |
| 2:40–2:50 | Close with scope, SDK contributions and links | Working features only; interview count if genuinely completed |

Recommended tagline: **“Every handover signed. Every registered pledge checked.”** The revised “No tonne financed twice” should appear only with an explicit within-Thetis boundary; the protocol cannot rule out outside pledges or false duplicate intake identities.

Do not claim that a database cannot reject duplicate pledges. Demonstrate shared participation across companies, inspectable controls and actual user value. Do not describe a differing document hash as proven forgery. If extraction is implemented, show inconsistency flagged for review; otherwise use duplicate-ID refusal.

Rehearse five timed runs including an offline presentation fallback. A recording is labelled a recording, not offline operation of Solana. Keep reset instructions, seed version, program address, verified transaction links, live web URL and tested APK installation path. Show code ownership, setup and before/during-event work in the public repository README.

## 5. Event and release evidence

The retained [FAQ](../references/dev3pack_faq_capture/faq_answers.md) supplies the captured event rules: Solana eligibility, open source, maximum four members, earlier-code transparency, AI-code responsibility, public demo/repository links and strict video duration. Its judging signals include product clarity, impact, demo, deployment, repo and SDK depth; no numerical weights are invented. Exact 29 November deadline hour must be checked in the dashboard.

Choose an appropriate open-source licence with the team before publishing. Do not fabricate team identities, contributor ownership, program addresses or sponsor-track qualification. Selecting the licence and public publication are later actions; this design package does not publish anything.

Before any live financing, require counterparty-approved custody/security and hand-off terms, actual pricing/insurance, tested settlement route, review of the deployed contract, incident recovery and explicit capital provision. A passed demo gate is not that production approval.
