# Thetis

Design baseline 18 November 2026 · Phase 0 under way: the domain package, the receipt spike and the AWS infrastructure definition are built and tested, and nothing is deployed

Thetis coordinates evidence, collateral locks, payment-confirmed releases and custody of mineral lots on the inland journey from stockpile to port. The initial transaction network is one exporter, an independent custodian, a terminal and a professional lender. Chrome leads; manganese demonstrates configurable policies.

This package develops the revised project and the combined research **including Claude's 18 November addendum**. The revised project controls product scope; research informs commercial hypotheses and trust boundaries. Proposed implementation decisions are identified in [decisions](docs/decisions.md). No source research or project documents were edited.

## Read in order

1. [Product and workflows](docs/product.md): roles, screens, mobile interactions and pilot measurement.
2. [System design](DESIGN.md): architecture, authority, deployment boundaries and technical decisions.
3. [Domain and transaction contracts](docs/domain.md): quantities, states, settlement and custody invariants.
4. [Data and integration contracts](docs/contracts.md): authentication, evidence, API, indexing, voice and jobs.
5. [Build and verification](docs/build.md): all ten phases, acceptance scenarios and reproducible demo.
6. [Decision register](docs/decisions.md): adopted scope, proposed refinements, unresolved production conditions.
7. [Research-to-design traceability](docs/traceability.md): evidence, implications and retained qualifications.

## What this delivers

A reviewable specification and the first phase-0 code. It is not a deployed app, a security audit, a legal opinion or evidence of customer demand. Architecture, account names and API contracts are proposed implementation contracts. Device integration (D27) and the Thetis program's account layout (D29) still need phase-0 proof before they are treated as verified.

## Built so far

| Area | Where | State |
|---|---|---|
| Domain calculations | `packages/domain` | Exact-integer available quantity, storage capacity, payment-confirmed release preview with the residual-limit top-up, and simple-interest accrual. Tested against the synthetic examples in [domain](docs/domain.md) §4 (`fixtures/domain/release-examples.json`). |
| Receipt enforcement | `programs/receipt-spike`, [ADR 0001](docs/adr/0001-receipt-enforcement.md) | Phase-0 spike only, not the Thetis program. 34 direct Token-2022 bypass attempts and 4 unauthorised or invalid program-level moves are refused, so D25 is confirmed. |
| AWS infrastructure | `infra`, `services/{api,sponsor,worker}` | CDK definitions for the API, the fee sponsor and the worker, plus secrets, alarms, budget and the release role (D33). Each service is a health endpoint for now. **Not deployed.** |
| Data layer | `supabase/` | Invitation-only membership, access rules scoped by membership and per-document grants, write-once private originals whose fingerprint only the server sets, one-time wallet-link challenges and an audit log. Proved by 102 database tests (pgTAP) in CI. The login and wallet-link API, and a hosted Supabase project, come next. |
| Two-party signing | `programs/signing-spike` (PR #10, in review) | Phase-0 spike: two parties authorise one handover through the Ed25519 Programmatic Signer, the fee sponsor pays, and 11 attacks are refused. These results come from offline tests against the Programmatic Signer's **devnet-only, not yet fully audited** binaries; they do not validate it for production. On real phones (Phantom and Solflare on Android, 18 November 2026) neither wallet showed a readable intent. Only Phantom produced a signature, behind an "unsafe" override, so the signing approach (D32) is reopened (ADR 0002). |
| Thetis program, apps, voice | — | Not started. |

Toolchain: Node 24 LTS with pnpm 11, TypeScript 7.0.2, Vitest 5.1.0 and Biome 2.6.4; Rust 1.89.0 (pinned in `rust-toolchain.toml`), Solana 3.1.10 and Anchor 1.2.2; AWS CDK 2.275.0 (library) and 2.1147.0 (command-line tool).

```bash
pnpm install --frozen-lockfile
anchor build && cargo test --workspace     # Anchor programs first: the relay tests load the build
pnpm lint && pnpm test                     # TypeScript packages, infra, services and tools
supabase start -x studio,imgproxy,edge-runtime,logflare,vector,realtime,postgres-meta,supavisor
supabase test db                           # database access rules (Supabase CLI 2.122.1)
```

To reproduce CI exactly, rebuild the database from the committed migrations and seed first:

```bash
# Destructive: deletes everything in the local database. Disposable local instances only.
supabase db reset --local && supabase test db
```

The gate and CI always reset before testing, so an older local schema or seed cannot change
their result.

CI runs these checks on every pull request, plus a secret scan of the whole history, a dependency advisory scan and a duplication check. Each run keeps its step logs as an artifact for 90 days. CDK synthesis is a separate local check, not run in CI:

```bash
pnpm --filter @thetis/infra synth          # CloudFormation templates, no AWS credentials needed
```

The infra tests that CI runs do synthesize each stack in memory. Accepted advisories with no available fix are listed in `osv-scanner.toml` and tracked in issues #4 and #5.

Production-path behavior means lender-attested bank records; it does **not** mean permission to deploy with live assets. Both settlement adapters will first run in isolated test environments. The devnet token pool is labelled simulation. The open production lending pool remains a longer-term business hypothesis.

## Built before vs. during the event

Everything in this repository today was built **before** the Dev3Pack build window (27–29
November 2026), as phase 0. Work done during the window will be listed here, by pull request,
when it lands. Every reused template, generated file and third-party binary, and the original
pre-event deliverables, are recorded in the [reuse manifest](docs/reuse-manifest.md).

## Destination

Master copy: `/home/kirito/Documents/projects/personal/Thetis` (this folder; git initialised 18 November 2026). The staged copy in the feasibility workspace (`Thetis/` and `Thetis-design-package.tar.gz`) is retired and must not be edited; see D28 in the [decision register](docs/decisions.md). All package-authored links are relative.

Device coverage: mobile signing **is planned to be tested** with the Mock MWA Wallet on an Android emulator, and with Solflare and Phantom on Android phones; that phase-0 spike (D27) has not run yet. It will not be tested on a Solana Seeker, so Seed Vault Wallet prompts and Seeker Connect stay unverified.

Design-review decisions of 18 November 2026 (settlement mode, tagline, durable nonces, fee sponsor, Token-2022 configuration, demo running order) are D20–D30 in the [decision register](docs/decisions.md).

## Source provenance

[Input manifest](references/manifest.json) records original absolute paths and hashes. [Revised project](references/revised-project.md), [combined research with addendum](references/combined-research.md), and [original project](references/original-project.md) are unchanged snapshots. Their original relative links refer to the feasibility workspace and are not rewritten; use the source paths in the manifest for those attachments.

The [retained FAQ evidence](references/dev3pack_faq_capture/faq_answers.md) resolves the earlier extraction uncertainty. Its raw script hash was checked against the captured value. This checks local integrity, not whether the organiser has changed the live rules since capture. Exact submission hour and team membership remain to be filled in.

## Documentation checks

```bash
python3 scripts/check_design.py
```

This checks package-authored links and snapshot integrity. It does not test an application. The program and app checks are under [Built so far](#built-so-far).
