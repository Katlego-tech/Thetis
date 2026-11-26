# Thetis

Design baseline 18 November 2026 · Phase 0's non-UI work is built and tested (domain package, receipt and signing spikes, AWS definition, data layer, access and voice APIs, web visual reference); Phase 1, the Thetis program, has started. Nothing is deployed except the two signing spikes, on devnet only

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
| Data layer | `supabase/` | Invitation-only membership, access rules scoped by membership and per-document grants, write-once private originals whose fingerprint only the server sets, one-time wallet-link challenges and an audit log. Proved by 102 database tests (pgTAP) in CI. A hosted Supabase project comes later. |
| Access API | `services/api` (PR #26) | Invitations, wallet-link challenge and completion (checked against the exact signed message), evidence finalize and short-lived download links. Every read runs under the caller's own access rules. Tested against a local Supabase in CI. The login, invitation and account screens are not built yet. |
| Voice | `services/api` (PRs #25, #27) | A private ElevenLabs agent defined as code, a server-issued conversation token for signed-in callers, and a lot-evidence lookup that returns only what the caller's access rules allow. The web and Android talk clients are not built yet. |
| Web visual reference | `apps/web` (PR #17) | Work queue, exception queue, lot dossier and release review screens on labelled synthetic data. |
| Two-party signing | `programs/signing-spike` (PR #10) | Phase-0 spike: two parties authorise one handover through the Ed25519 Programmatic Signer, the fee sponsor pays, and 11 attacks are refused. These results come from offline tests against the Programmatic Signer's **devnet-only, not yet fully audited** binaries; they do not validate it for production. On real phones (Phantom and Solflare on Android, 18 November 2026) neither wallet showed a readable intent. Only Phantom produced a signature, behind an "unsafe" override, so D32 was reopened and re-decided: in-house verification of a readable signed text. That was proven on 19 November 2026: Phantom and Solflare each showed the full text and signed it, and the two-party handover is finalized on devnet, paid by the sponsor (`programs/intent-spike`, ADR 0003). |
| Thetis program | `programs/thetis` | Phase 1 started 22 November 2026 (setup, lots, positions, collection); not merged or deployed yet. |

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

## Deployments

| Cluster | Program | Address |
|---|---|---|
| Devnet | `programs/thetis` | [`jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3`](https://explorer.solana.com/address/jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3?cluster=devnet) |

Devnet only. Both scripts refuse any other cluster, and the machine's default Solana config is never used.
Keys live outside the repository in `THETIS_KEYS_DIR` (default `~/.config/thetis/devnet`); the scripts refuse a
directory inside the repository. Create and fund the upgrade authority and fee payer once:

```bash
mkdir -p ~/.config/thetis/devnet && chmod 700 ~/.config/thetis/devnet
solana-keygen new --no-bip39-passphrase -o ~/.config/thetis/devnet/deployer.json
solana-keygen pubkey ~/.config/thetis/devnet/deployer.json   # fund this address from the devnet faucet
```

Funding: `scripts/deploy-devnet.sh` prints the build-dependent minimum before it deploys, and stops with the
shortfall if the deployer holds less. A fresh deploy of the current build needs about 9 SOL. A single faucet
request may not be enough, so repeat the request or use another faucet until the balance covers it. An
upgrade of an already deployed program needs less: one buffer plus any growth of the program data.

```bash
bash scripts/deploy-devnet.sh   # checks the program id, backs up the keypairs, builds, deploys or upgrades
pnpm seed:devnet                # initializes the protocol, registers CHROME v1, accredits the seven organisations
```

`target/deploy/thetis-keypair.json` must be the program's own keypair (the script stops if its address is not
the one above). Running the deploy again upgrades the same program id. Running the seed again sends nothing
that already exists, and stops with the difference if an account holds other values. The seed writes every
transaction link, with the protocol address, to `seed-log.json` in the keys directory. Each transaction is logged
as `pending` before it is sent and `confirmed` after; a rerun settles any `pending` entry first.

### Seed transactions

Deployed 25 Nov 2026 in devnet slot 526242298 ([deploy transaction](https://explorer.solana.com/tx/vtK8h43bEg8zDn5w7u319t6VfNztCKB87nYBJ7LN6bsgFmMR2cFKA2iVLKgve8spmhri9mQJbSk28amZthbVviE?cluster=devnet)).
Protocol instance `fiat-attestation`: [`G9GNDdbYKQY14xv1xgNw1D6EY8SFnZxgHrDBdEbHsoo3`](https://explorer.solana.com/address/G9GNDdbYKQY14xv1xgNw1D6EY8SFnZxgHrDBdEbHsoo3?cluster=devnet).

| Step | Transaction |
|---|---|
| initialize_protocol | [`rgv5YvKhLUviW6AD…`](https://explorer.solana.com/tx/rgv5YvKhLUviW6ADZMNv9yfHufTR5CxnRcV39G5XTyeBA3Zudc1dsSLgGXVtP6fh78x5Y4s7ku2UDFvkst6KFJs?cluster=devnet) |
| register_class CHROME v1 | [`5MkYcvm7PWDUwmxv…`](https://explorer.solana.com/tx/5MkYcvm7PWDUwmxv9VUYq2dKDARFfRDKmQUjfPKsPDz2qfoCp4F3Q6EKwBATNK236ZryiBQ9KeY8yceaLYWXSUYK?cluster=devnet) |
| accredit_organisation khunou | [`5DQeU9wvhkWPwFzc…`](https://explorer.solana.com/tx/5DQeU9wvhkWPwFzcq6YahCeSSvzu3f9jXHrsQ8gRDXCi7k6FguEibwXPzkHBk8x9s5qLkR5sZxyop8ih9oogFjhi?cluster=devnet) |
| accredit_organisation kopano | [`PNGDPksmPvFsuUkQ…`](https://explorer.solana.com/tx/PNGDPksmPvFsuUkQBmVGVRhojdduLFBdJ1RvhtdfuHUQLHEp5GDs1UkoaVM8qg29sYghNdrJLWbNGwCBYtRBiM5?cluster=devnet) |
| accredit_organisation mosela | [`2LyJv477yxaGzToH…`](https://explorer.solana.com/tx/2LyJv477yxaGzToHG5sLCEA5BFJXQTLYJGFqzFvYzud7YNstyoae4j3LsfRefthRq91WxqVNk3gAMrg9iFeqxk2B?cluster=devnet) |
| accredit_organisation port-t1 | [`5SG7ENRBg6C8muR5…`](https://explorer.solana.com/tx/5SG7ENRBg6C8muR5RKqiaB8aJnxo693UnsuU8UktQMUVdNKZnWeTm5urTwhTsWySo3PqhQP9FMmqc8tKJp8ERn3G?cluster=devnet) |
| accredit_organisation lender-one | [`MhDFt1EeZrSvTrUi…`](https://explorer.solana.com/tx/MhDFt1EeZrSvTrUiNwTtQsz4a7qmispwZAs39vMXrZ4c9FgRpPyN2dXeEDCDKCsofVzsH8RAVw3f5nGG68L9ip9?cluster=devnet) |
| accredit_organisation lender-two | [`2T2uHiARneHHwgvu…`](https://explorer.solana.com/tx/2T2uHiARneHHwgvu1Pt8RTnmEKc8wo6SVENLTJvpQtpCmY5TZXDWa1k3htifs2GxrL3MgrDk5FGwDn215RxKfwzM?cluster=devnet) |
| accredit_organisation buyer-smelter | [`xuCcAnPWMEFouMrr…`](https://explorer.solana.com/tx/xuCcAnPWMEFouMrrcF4gENgiWEjZygjxPf72WF73o7GK37qiixb1gD51AnNeuHhFEGz9VDocVXBN1MWDFAAQs4B?cluster=devnet) |

### Simulation instance

A second protocol instance, `token-simulation`, runs in `DEVNET_TOKEN_SIMULATION` mode with a test token pool. The token has no
real value. A Thetis-minted token is labelled "test USDC (Thetis-minted)" wherever it is shown, never as Circle's USDC. It is seeded by the same script and the same program, on devnet only. Run one instance at a time: both write the same `seed-log.json`.

```bash
pnpm seed:devnet --instance token-simulation   # the same as: node scripts/seed-demo.ts --instance token-simulation
```

With no `--instance` the script seeds `fiat-attestation` exactly as above. The simulation run needs the deployed program,
a funded `deployer.json`, and the same `admin.json`, `accreditor.json` and `org-<slug>.json` keys as the fiat instance. It
creates two more keys in the keys directory, only when missing, each with mode 600: `sim-mint.json` (the test mint itself,
so a rerun finds the same mint) and `sim-mint-authority.json` (the mint authority). In order, it sends:

1. `initialize_protocol`: instance id `token-simulation`, mode `DevnetTokenSimulation`.
2. `create_test_mint`: a classic SPL Token mint (not Token-2022) with 2 decimals (USD cents), no freeze authority, the mint
   authority above and an initial supply of 0, created and initialised in one transaction.
3. `open_pool USD`: sent by the admin on that mint. The pool and its vault are the program's own derived addresses.
4. `register_class CHROME v1` and `accredit_organisation` for the same seven organisations, with the same fixed ids and keys
   as the fiat instance.

Before it sends anything, the script reads the pool and then the test mint, so a pool left on another mint (for example after
`sim-mint.json` was lost) stops the run before a new mint is paid for. Before each of the other steps it reads that step's
account. An account that already holds the wanted values is skipped. An account that
holds other values stops the run and prints the difference. For the mint the wanted values are: owned by the classic Token
program, initialised, 2 decimals, no freeze authority, and `sim-mint-authority.json`'s address as mint authority (the supply
is not compared, because it grows once test tokens are minted). For the pool they are the protocol, mint, vault, currency
`USD` and 2 decimals (the counters are not compared).

`seed-log.json` keeps the fiat transactions at the top level, as before, and the simulation's under
`instances["token-simulation"]`, with its protocol, mint, pool and vault addresses and its own transaction links. Each
transaction is `pending` before it is sent and `confirmed` after, and a rerun settles any `pending` entry first.

Filled in from `seed-log.json` after the run:

| Item | Address or transaction |
|---|---|
| Protocol instance `token-simulation` | [`7fQ15qzKyWGX1dfXG78tS3pEWjPDsDbaYVHNUgi3HoGa`](https://explorer.solana.com/address/7fQ15qzKyWGX1dfXG78tS3pEWjPDsDbaYVHNUgi3HoGa?cluster=devnet) |
| Test mint (classic SPL Token, 2 decimals, no freeze authority) | [`Fiqy3yyLy1jDDMzkiH4dTREUwiUJZYuwdwwKTh4yBewZ`](https://explorer.solana.com/address/Fiqy3yyLy1jDDMzkiH4dTREUwiUJZYuwdwwKTh4yBewZ?cluster=devnet) |
| Pool | [`CNVSV73hCbc2hkj9SeStmo6MTyakFMNxTF2KVV9tRvDr`](https://explorer.solana.com/address/CNVSV73hCbc2hkj9SeStmo6MTyakFMNxTF2KVV9tRvDr?cluster=devnet) |
| Pool vault | [`FrfmMucMFcx3kSxNjTbqcQrJcc6zuNaMj83337TY7Cf9`](https://explorer.solana.com/address/FrfmMucMFcx3kSxNjTbqcQrJcc6zuNaMj83337TY7Cf9?cluster=devnet) |
| Seeded on | 26 Nov 2026, devnet slot 526561622 |

| Step | Transaction |
|---|---|
| initialize_protocol | [`3n7fGNCXhjjFvi2i…`](https://explorer.solana.com/tx/3n7fGNCXhjjFvi2ii6VBa5AY9BFcNZcnE3ji6rQd8Cfj9Qi1RAmTuJMLcSzL5P8eMoo87W2MbqMPnjZRNxyZiyGZ?cluster=devnet) |
| create_test_mint | [`5S5iSjh6B2gBjdf6…`](https://explorer.solana.com/tx/5S5iSjh6B2gBjdf6ESAeJGTWydpchSQtKuynZQDDFD2DKa4ujctNtLJaHXBktJvXtU1XD8spTfaYNyQGBAkRjDd5?cluster=devnet) |
| open_pool USD | [`2qdjk6MdarfQ7F2j…`](https://explorer.solana.com/tx/2qdjk6MdarfQ7F2jFxhRUraL8zxwabtLJrE1gESo15xe8S2YX8fAEYmRc5dds6WKbeZT66aRY2wktDLFcqiWWKmA?cluster=devnet) |
| register_class CHROME v1 | [`29icaKtV4c4sEG4p…`](https://explorer.solana.com/tx/29icaKtV4c4sEG4p1Xe93QSv7uVguzWEEw5vXC6dCSnqSDZ9frRu1yseszyPGUU8QLqzUvqKAJ6YdN61PhRTYc8N?cluster=devnet) |
| accredit_organisation khunou | [`3CwSwoT52izMRzMU…`](https://explorer.solana.com/tx/3CwSwoT52izMRzMUhgZ2gsozwisvMvcjPFjTDAFg8t43YqxjsMFqTgcB9RNTtiuAX31kud3JeyDndL4UMTHQu3S9?cluster=devnet) |
| accredit_organisation kopano | [`4odCpNhrPjrpEDwy…`](https://explorer.solana.com/tx/4odCpNhrPjrpEDwyeXprens8HFXHaA6TKX9bJZXZNkKW7SN2NnMBZRsfRn34kgZjcUR3KgesXCdnykxzUGXxbDMD?cluster=devnet) |
| accredit_organisation mosela | [`v37LecCYd1RoGA92…`](https://explorer.solana.com/tx/v37LecCYd1RoGA92D7rBPbRpeqUheyQ6mnZqnp2Z48uhn6Dve72JwstjPfsvibQ9RavAtCZ7r5F6pvPRRazKPTE?cluster=devnet) |
| accredit_organisation port-t1 | [`3bhGsc4NVUkN4iXy…`](https://explorer.solana.com/tx/3bhGsc4NVUkN4iXybaM6XrLuQcUiyg1e2wTXTh4GXBf4MTLLW7w7dHscRVTVQgZrfjvizjXytg2i9XUAQ7fJFqQJ?cluster=devnet) |
| accredit_organisation lender-one | [`HRQMPF2z3EiSdkhr…`](https://explorer.solana.com/tx/HRQMPF2z3EiSdkhrXbDeieLRXhm3r3joE62sVFiDFNeyT2wBYCSvxaaKG6P2cpNRTGvcXyigr8Zf4Pm6MUivsWo?cluster=devnet) |
| accredit_organisation lender-two | [`3QVomAKvDARkQJcx…`](https://explorer.solana.com/tx/3QVomAKvDARkQJcx1uddPKBzDZRjYPkCPkkYo8HqKam7pGYQZeRG9mezi1ubndquYDGBEWKRYGH3zg8WA8rsP3QR?cluster=devnet) |
| accredit_organisation buyer-smelter | [`3DEUaHL73iRaQPSz…`](https://explorer.solana.com/tx/3DEUaHL73iRaQPSzpgEPcqyVcz2CczXSGJMPA8skbXue6UkCigWBENgbmy1PQcBDtZwGoszQHkNST19cKCjcYRxe?cluster=devnet) |

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

## Licence

Apache License 2.0: see [LICENSE](LICENSE) and [NOTICE](NOTICE). Code and templates reused from elsewhere keep their own licences, listed in [docs/reuse-manifest.md](docs/reuse-manifest.md).
