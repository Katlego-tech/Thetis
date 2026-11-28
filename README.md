# Thetis

**Every handover signed. Every registered pledge checked.**

Thetis is a shared record, on Solana, of who holds a lot of export minerals and what is pledged against it, on the inland journey from stockpile to port. An exporter, an independent custodian, a terminal and a lender each sign their own step, and the program refuses the steps that should not happen.

> Dev3Pack Global Hackathon, 27–29 November 2026 · Best App Overall on Solana · devnet only, synthetic organisations

### In 30 seconds

- **What:** a custodian records a lot of chrome ore and signs it onto devnet. A lender locks it as collateral and records an advance. Each handover on the road is signed by both the party giving and the party receiving. A buyer's release happens only after the lender confirms payment.
- **The new part: refusals enforced by the program.** A second lender asking to pledge units that are already pledged is refused (`InsufficientAvailable`). A driver whose wallet holds no authority for the receiving organisation cannot sign a handover. The same intake ticket cannot issue a second lot. These are program checks, not app checks.
- **See it:** the program is live on devnet at [`jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3`](https://explorer.solana.com/address/jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3?cluster=devnet), with its [seed transactions](#seed-transactions) below. The web app and the Android field app run from this repository ([Run it](#run-it)).

## The problem

Lenders do put goods in transit into borrowing bases, but keep that share "typically kept small" because of diversion, carrier liens and jurisdiction risk ([Mayer Brown, Sept 2023](https://www.mayerbrown.com/de/insights/publications/2023/09/mbitesize-goods-in-transit)). Ore on a truck between a stockyard and a port passes through organisations that do not report to each other, so a lender cannot easily see who holds it or whether the same tonnes were pledged elsewhere. Thetis checks pledges registered in Thetis. It cannot rule out a pledge made outside it or a false duplicate intake identity (see [build and verification](docs/build.md) and decision D22 in the [decision register](docs/decisions.md)).

## What it does

The organisations and figures below are synthetic. Each step says what a party does and what the program enforces.

1. The custodian records lot CR-0001 (5,000 t of chrome, intake ticket WB2611-0042, three files) and signs the issue.
2. The exporter pledges the lot to a lender. The lender locks it as collateral and records an advance of USD600,000. Settlement is a lender-attested "test bank confirmation"; no money moves.
3. A second lender asks to pledge the same units and is refused (`InsufficientAvailable`). The first lender's record does not change.
4. The custodian and the haulier each sign the handover on their own phone. The program verifies both signatures in one transaction.
5. A driver whose wallet holds no authority for the receiving organisation tries to sign the same handover and is refused.
6. The haulier records a border observation. It is an observation, never a change of holder.
7. The terminal signs the arrival at the port.
8. The owner creates a release of 2,000 t for USD400,000. The lender confirms payment, then the buyer accepts. The debt falls to USD200,000 on 3,000 t.
9. The terminal, the owner and the lender sign the loading hand-off. The loan stays recorded as an external hand-off.
10. The same intake ticket is submitted again and is refused. No second lot exists.

| | |
|---|---|
| **Program** | [`jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3`](https://explorer.solana.com/address/jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3?cluster=devnet) on devnet. 39 instructions, 24 account types, 40 events, 73 error codes. Anchor 1.2.2, Rust 1.89.0. Last upgraded 28 Nov 2026, devnet slot 527006254. |
| **Protocol instances** | `fiat-attestation`: [`G9GNDdbYKQY14xv1xgNw1D6EY8SFnZxgHrDBdEbHsoo3`](https://explorer.solana.com/address/G9GNDdbYKQY14xv1xgNw1D6EY8SFnZxgHrDBdEbHsoo3?cluster=devnet). `token-simulation`: [`7fQ15qzKyWGX1dfXG78tS3pEWjPDsDbaYVHNUgi3HoGa`](https://explorer.solana.com/address/7fQ15qzKyWGX1dfXG78tS3pEWjPDsDbaYVHNUgi3HoGa?cluster=devnet). |
| **Tests** | 525 Rust tests in `programs/thetis`, 493 database assertions (pgTAP) and over 1,200 TypeScript test cases across the packages, services and apps. All run in CI on every pull request. |
| **Refusal suites** | The Token-2022 receipt spike refuses 34 direct bypass attempts and 4 unauthorised or invalid program-level moves ([ADR 0001](docs/adr/0001-receipt-enforcement.md)). The signing spike refuses 11 attacks ([ADR 0002](docs/adr/0002-two-party-signing.md)). The Phase 3 bypass sweep covers foreign-protocol custody accounts (PR #86, `programs/thetis/tests/bypass_custody.rs`). |
| **Signing** | Each party signs a readable intent message. The program verifies the Ed25519 signatures itself, two for a handover, in one transaction (decision D32, [ADR 0003](docs/adr/0003-inhouse-intent-verification.md)). Verified on two Android phones with Solflare and Phantom on devnet. Not tested on a Solana Seeker. |
| **Fees** | A fee sponsor pays for every transaction a user signs, from an allowlist of Thetis instructions, so a driver or yard clerk needs no SOL. The relay sends v0 transactions with a per-instance address lookup table. |
| **Solana libraries** | `anchor-lang` and `anchor-spl` (Token-2022) in `programs/thetis`; LiteSVM in the `programs/thetis` tests; `@solana/kit` in `packages/contracts`, `services/api`, `services/sponsor`, `services/worker` and `apps/field`; `@solana-program/token`, `@solana-program/compute-budget` and `@solana-program/address-lookup-table` in `services/api`; Wallet Standard packages in `apps/web`; Mobile Wallet Adapter (`@solana-mobile/mobile-wallet-adapter-protocol`) in `apps/field`. |
| **Why Solana** | Four organisations that do not report to each other need one record of who holds a lot and what is pledged against it. None of them can keep that record for the others. On Solana the lot, its positions, the pledge and every handover are accounts owned by the program: a second pledge on the same units is refused by the program, and a handover needs both parties' signatures in one transaction. Fees are low enough to record every handover and observation, and the fee sponsor means field staff never hold SOL. |
| **Licence** | Apache-2.0 ([LICENSE](LICENSE)). |

## What is in the repository

| Area | Where | State |
|---|---|---|
| Thetis program | `programs/thetis` | Lots, positions, locks and loans, payment-confirmed release, shipments, two-signature handover, observations, loading, shortfall and restriction. Deployed on devnet. |
| Shared contracts | `packages/contracts` | Instruction builders and account decoders used by the relay and the web app, with an IDL drift check in CI. |
| Domain calculations | `packages/domain` | Exact-integer available quantity, storage capacity, payment-confirmed release preview with the residual-limit top-up, and simple-interest accrual. Tested against the synthetic examples in [domain](docs/domain.md) §4 (`fixtures/domain/release-examples.json`). |
| Access API and relay | `services/api` | Invitations, wallet links, evidence; turns signed intents into sponsor-paid transactions. |
| Fee sponsor | `services/sponsor` | Co-signs only allowlisted Thetis instructions. |
| Indexer | `services/worker` | Indexes every instruction (39 of 39) and event (40 of 40) into the read model; halts on anything it does not recognise. |
| Web app | `apps/web` | Next.js. Work queue, exceptions, lot dossier, lender actions, release, loading, and voice navigation with a typed fallback. |
| Field app | `apps/field` | Expo, Android. Sign in, wallet, intake and issue, handover, border observation, loading. |
| Data layer | `supabase/` | Invitation-only membership, access rules scoped by membership and per-document grants, write-once private originals whose fingerprint only the server sets, one-time wallet-link challenges and an audit log. Proved by 493 database assertions (pgTAP) in CI. |
| AWS infrastructure | `infra` | CDK definitions for the API, fee sponsor and worker. **Not deployed.** |
| Spikes | `programs/receipt-spike`, `programs/signing-spike`, `apps/signing-spike` | Phase-0 proofs behind ADRs; not part of the product. |

## Limits

- Devnet only. Every organisation, lot, quantity and amount is synthetic and labelled so.
- Settlement is a lender-attested test bank confirmation. No money moves. The `token-simulation` instance uses a Thetis-minted test token with no value, never labelled as Circle's USDC.
- There is no hosted demo yet: the web app, the API, the indexer and the database run locally against devnet. The AWS definitions in `infra` are not deployed.
- This README links the deployment and seed transactions. It does not yet list the transactions of a start-to-finish run.
- The program is upgradeable by a single devnet key held by the team.
- No security audit, no legal opinion and no customer validation.
- Thetis checks only pledges registered in Thetis.

## Run it

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

### Demo reset

Every rehearsal runs on a fresh protocol instance with the same synthetic cast, and the local Supabase is reset to the
same users, so each run starts from the same state. Devnet only; the local Supabase only.

```bash
pnpm demo:reset --scenario phone --run next           # dry run: prints the plan and its cost, sends nothing
pnpm demo:reset --scenario phone --run next --yes     # sends the plan, then resets the local Supabase
pnpm demo:check --run fiat-demo-run-01                # after the services are up and the wallets linked
```

Two scenarios:

- `phone` (`fiat-demo-run-NN`), the demo itself, 18 transactions:
  - `initialize_protocol` (`FiatAttestationTest`), `register_class CHROME v1`, and `accredit_organisation` for the
    seven seed organisations;
  - the custodian classes `KOPANO-YARD-1` (10,000 t) and `PORT-T1` (5,000 t);
  - one Authority for each of the seven owner-supplied wallets. Each gets every scope its role allows, except that the
    lenders get `LEND` only, and each expires 30 days after the run started.
  The refused driver's wallet gets no Authority, and no lot exists: CR-0001 is issued live on the phone.
- `lender` (`fiat-lend-run-NN`) adds 4 transactions, for checking the web lender flow without the phones:
  - an ISSUE-only Authority for a seed-held Kopano key (`kopano-seed-issuer.json`, created when missing);
  - an address lookup table (created, then extended);
  - `issue_lot CR-0001`: 5,000 t at `KOPANO-YARD-1`, owned by Khunou.
  This scenario needs the relay's `issueLotMessage` (T067r). Until that is merged, it refuses before anything is sent.

`--run next` takes the smallest free `NN`. A rerun of the same `NN` sends only what is missing. Every transaction is
logged in `runs/<instance id>.json` in the keys directory, `pending` before it is sent and `confirmed` after. The env
lines the API, worker and web app take for the run are in `runs/<instance id>.env`, which holds nothing secret. The
phones need no change.

The owner's public keys and the users' `.test` emails go in `demo-cast.json` in the keys directory. When the file is
missing, the command prints a blank template and stops. After the chain stage, the command wipes the local database
(`supabase db reset --local`) unless it already holds this run's cast. It then creates the six users, confirmed and
with no password, and their memberships. Sign-in codes arrive in Mailpit. Wallets are linked again on each device
after every reset.

Every run is refused before anything is sent or wiped when:
- a cluster other than devnet is named;
- the keys directory is inside the repository, an operator key is missing, or the cast is invalid. A cast is invalid
  when a wallet is an operator key or is listed twice, an email is not a `.test` address, or the six users are wrong;
- a seed organisation is not marked synthetic;
- Supabase is not the local stack;
- the instance holds other values, or the run is used up: its CR-0001 exists (phone), or Khunou's position in
  CR-0001 has moved (lender);
- the refused driver's wallet holds an Authority.

With `--yes`, the command is also refused when the API (port 3200) or the web app (3100) is running, when the worker
polled in the last 120 s, or when the deployer holds less than the plan's cost plus 0.1 SOL.

Cost: about 0.053 SOL per `phone` run and 0.07 SOL per `lender` run, almost all of it rent. The dry run prints the
exact figure.

## Built before and during the event

Design and phase 0–2 work (pull requests #1–#62) was merged 18–26 November 2026, before the build window, which the organisers allow. Every reused template, generated file and third-party binary is in the [reuse manifest](docs/reuse-manifest.md).

Merged during the window (27–28 November 2026):

| PR | Date | What |
|---|---|---|
| [#63](https://github.com/Katlego-tech/Thetis/pull/63) | 27 Nov | program: prepare, register and cancel shipments |
| [#64](https://github.com/Katlego-tech/Thetis/pull/64) | 27 Nov | relay: lender commands and the sponsor allowlist |
| [#65](https://github.com/Katlego-tech/Thetis/pull/65) | 27 Nov | worker: index lending events and accounts |
| [#66](https://github.com/Katlego-tech/Thetis/pull/66) | 27 Nov | field: sign in, home, wallet, intake and issue review |
| [#67](https://github.com/Katlego-tech/Thetis/pull/67) | 27 Nov | program: two-signature handover with partial arrival |
| [#68](https://github.com/Katlego-tech/Thetis/pull/68) | 27 Nov | demo: one-command demo reset |
| [#69](https://github.com/Katlego-tech/Thetis/pull/69) | 27 Nov | relay: issue_lot and handover |
| [#70](https://github.com/Katlego-tech/Thetis/pull/70) | 27 Nov | program: record_observation |
| [#71](https://github.com/Katlego-tech/Thetis/pull/71), [#74](https://github.com/Katlego-tech/Thetis/pull/74), [#77](https://github.com/Katlego-tech/Thetis/pull/77), [#78](https://github.com/Katlego-tech/Thetis/pull/78), [#82](https://github.com/Katlego-tech/Thetis/pull/82) | 27 Nov | worker: index shipments and batches, custody handovers, observations, loading and loan hand-offs, shortfalls and restrictions |
| [#72](https://github.com/Katlego-tech/Thetis/pull/72) | 27 Nov | relay: record_observation |
| [#73](https://github.com/Katlego-tech/Thetis/pull/73) | 27 Nov | program: loading intents, acceptance and loading |
| [#75](https://github.com/Katlego-tech/Thetis/pull/75) | 27 Nov | web: lender actions and the live release screen |
| [#76](https://github.com/Katlego-tech/Thetis/pull/76) | 27 Nov | relay: loading kinds |
| [#79](https://github.com/Katlego-tech/Thetis/pull/79) | 27 Nov | program: shortfall attestation and restrictions |
| [#80](https://github.com/Katlego-tech/Thetis/pull/80) | 27 Nov | relay: accept_loading |
| [#81](https://github.com/Katlego-tech/Thetis/pull/81) | 27 Nov | scripts: demo reset fix |
| [#83](https://github.com/Katlego-tech/Thetis/pull/83) | 27 Nov | web: loading pages and Accept loading |
| [#84](https://github.com/Katlego-tech/Thetis/pull/84) | 28 Nov | relay: compute unit price |
| [#85](https://github.com/Katlego-tech/Thetis/pull/85) | 28 Nov | web: navigation |
| [#86](https://github.com/Katlego-tech/Thetis/pull/86) | 28 Nov | program tests: Phase 3 bypass sweep |
| [#87](https://github.com/Katlego-tech/Thetis/pull/87) | 28 Nov | api: field read routes |
| [#88](https://github.com/Katlego-tech/Thetis/pull/88) | 28 Nov | field: handover, observation and loading screens |
| [#89](https://github.com/Katlego-tech/Thetis/pull/89) | 28 Nov | worker: unknown enums halt |
| [#90](https://github.com/Katlego-tech/Thetis/pull/90) | 28 Nov | field: tab bar and Account |
| [#91](https://github.com/Katlego-tech/Thetis/pull/91) | 28 Nov | web: per-position loading view |
| [#92](https://github.com/Katlego-tech/Thetis/pull/92) | 28 Nov | relay: lookup table and size refusals |
| [#94](https://github.com/Katlego-tech/Thetis/pull/94) | 28 Nov | web: voice navigation with typed fallback |
| [#95](https://github.com/Katlego-tech/Thetis/pull/95) | 28 Nov | relay, web: shared contracts package |

## Design documents

Read these in order. They are the design baseline of 18 November 2026; the code follows them.

1. [Product and workflows](docs/product.md): roles, screens, mobile interactions and pilot measurement.
2. [System design](DESIGN.md): architecture, authority, deployment boundaries and technical decisions.
3. [Domain and transaction contracts](docs/domain.md): quantities, states, settlement and custody invariants.
4. [Data and integration contracts](docs/contracts.md): authentication, evidence, API, indexing, voice and jobs.
5. [Build and verification](docs/build.md): all ten phases, acceptance scenarios and reproducible demo.
6. [Decision register](docs/decisions.md): adopted scope, proposed refinements, unresolved production conditions.
7. [Research-to-design traceability](docs/traceability.md): evidence, implications and retained qualifications.

## Source provenance

[Input manifest](references/manifest.json) records original absolute paths and hashes. [Revised project](references/revised-project.md), [combined research with addendum](references/combined-research.md), and [original project](references/original-project.md) are unchanged snapshots. Their original relative links refer to the feasibility workspace and are not rewritten; use the source paths in the manifest for those attachments.

The [retained FAQ evidence](references/dev3pack_faq_capture/faq_answers.md) resolves the earlier extraction uncertainty. Its raw script hash was checked against the captured value. This checks local integrity, not whether the organiser has changed the live rules since capture. Exact submission hour and team membership remain to be filled in.

## Documentation checks

```bash
python3 scripts/check_design.py
```

This checks package-authored links and snapshot integrity. It does not test an application. The program and app checks are under [What is in the repository](#what-is-in-the-repository).

## Licence

Apache License 2.0: see [LICENSE](LICENSE) and [NOTICE](NOTICE). Code and templates reused from elsewhere keep their own licences, listed in [docs/reuse-manifest.md](docs/reuse-manifest.md).
