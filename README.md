# Thetis

Design baseline · 18 November 2026 · implementation not yet started

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

A reviewable specification, not a deployed app, security audit, legal opinion or evidence of customer demand. Architecture, account names and API contracts are proposed implementation contracts. Version pinning, token enforcement and device integration require phase-0 proof before implementation is treated as verified.

Production-path behavior means lender-attested bank records; it does **not** mean permission to deploy with live assets. Both settlement adapters will first run in isolated test environments. The devnet token pool is labelled simulation. The open production lending pool remains a longer-term business hypothesis.

## Destination

Master copy: `/home/kirito/Documents/projects/personal/Thetis` (this folder; git initialised 18 November 2026). The staged copy in the feasibility workspace (`Thetis/` and `Thetis-design-package.tar.gz`) is retired and must not be edited; see D28 in the [decision register](docs/decisions.md). All package-authored links are relative.

Device coverage: mobile signing is tested with the Mock MWA Wallet on an Android emulator, and with Solflare and Phantom on Android phones. It has **not** been tested on a Solana Seeker, so Seed Vault Wallet prompts and Seeker Connect are unverified (D27).

Design-review decisions of 18 November 2026 (settlement mode, tagline, durable nonces, fee sponsor, Token-2022 configuration, demo running order) are D20–D30 in the [decision register](docs/decisions.md).

## Source provenance

[Input manifest](references/manifest.json) records original absolute paths and hashes. [Revised project](references/revised-project.md), [combined research with addendum](references/combined-research.md), and [original project](references/original-project.md) are unchanged snapshots. Their original relative links refer to the feasibility workspace and are not rewritten; use the source paths in the manifest for those attachments.

The [retained FAQ evidence](references/dev3pack_faq_capture/faq_answers.md) resolves the earlier extraction uncertainty. Its raw script hash was checked against the captured value. This checks local integrity, not whether the organiser has changed the live rules since capture. Exact submission hour and team membership remain to be filled in.

## Documentation checks

```bash
python3 scripts/check_design.py
```

This checks package-authored links and snapshot integrity. It does not test an application. Future implementation must add the single program/app verification gate described in the build plan; no mock gate or fake passing test count is included here.
