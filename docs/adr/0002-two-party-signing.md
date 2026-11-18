# ADR 0002: Two parties authorise one instruction through the Programmatic Signer

**Status:** accepted for the on-chain part, 18 November 2026 · **Decision:** D32 checks (b) and (c)
confirmed; check (a) still open (needs the phones) · **Sources:** D23, D24, D27, D32

## Context

D32 chose Anza's Ed25519 Programmatic Signer to verify signed intent messages. Before the Thetis
account layout is frozen, phase 0 has to show three things:

- **(a)** what a wallet displays when it signs an authorization;
- **(b)** whether two parties' authorizations can make both of their derived accounts signers of
  one Thetis instruction;
- **(c)** whether this works with the fee sponsor as relayer and fee payer, and with Anchor 1.x
  cross-program calls.

If (b) failed, the fallback was a same-transaction two-step with a transient approval account.

## What was tested

The spike program `programs/signing-spike` is not the Thetis program and is not deployed. Its
`handover` instruction stands in for a custody handover:
- it requires **both** parties' Programmatic Signer accounts as signers. Each is derived on chain
  from `["programmatic-signer", wallet]` under `EdSigVfK1DkeMrjFNDMjwfQaJPhPTtX7jW8uPv3oKEgN`
  and recorded on a `Party` account;
- it checks its own expiry slot and an expected sequence number, because the Programmatic Signer
  has no expiry and its nonce does not detect stale business state.

**What ran:**
- **The Programmatic Signer programs:** the three devnet binaries, dumped on 18 November 2026 and
  loaded at their real IDs in LiteSVM 0.15. The test checks each SHA-256 before loading:

  | Program | ID | Last deployed (devnet slot) | SHA-256 |
  |---|---|---|---|
  | Ed25519 Signer | `EdSigVfK1DkeMrjFNDMjwfQaJPhPTtX7jW8uPv3oKEgN` | 520437108 | `4824c901…c80b` |
  | Message Executor | `ExecxgyHYsAXB4c5dZodV1zJZ9hqfsDCYkRDRATrpkFR` | 520437180 | `276692a0…0344` |
  | Nonce | `Noncediea1fH12usShuQAz28UhgAeuE5Maf32LsMUQB` | 520437035 | `095be5b6…d3f7` |

  The programs are still upgradeable by their authority, `Br2LeifQQeQpAw1r3yE4Fpk3Xo23HrsksE9adbCTqZ2g`.
  These results hold for these binaries only.
- **The messages:** the authorization messages were built with the published interface crates
  `spl-ed25519-signer-interface`, `spl-message-executor-interface` and `spl-nonce-interface`,
  all 1.0.0.
- **The parties:** Alice and Bob are plain Ed25519 keys. They sign **only the serialized
  authorization message**. A separate sponsor key creates the nonce account, then signs and pays
  for the relay transaction.

## Results (`cargo test -p signing-spike -- --nocapture`)

```text
D32 two-authority handover: accepted (sequence 1, handed_over true, nonce advanced)
D32 sponsor fee: paid 5000 lamports (Alice and Bob unchanged)
D32 replay: refused (NonceMismatch)
D32 only Alice: refused (WrongSigner)
D32 Mallory in place of Bob: refused (WrongSigner)
D32 altered authorization byte: refused (InvalidSignature)
D32 swapped signatures: refused (InvalidSignature)
D32 substituted Submit account: refused (AccountKeyMismatch)
D32 expired: refused (Expired)
D32 stale sequence: refused (StaleSequence)
D32 quantity mismatch: refused (QuantityMismatch)
D32 direct wallets: refused (WrongSigner)
D32 same party both roles: refused (SameParty)
```

Every refusal also checks that the `Batch` account is byte-identical afterwards.

## Decision

- **(b) is confirmed.** One authorization listing both authorities makes both derived accounts
  signers of the same instruction. The same-transaction two-step fallback is not needed.
- **(c) is confirmed.** The sponsor alone signs and pays for the relay. Anchor 1.2.2 receives the
  call with both signer flags set. The parties never pay fees and never sign a transaction.
- **Expiry and sequence belong to Thetis.**
  - The Programmatic Signer nonce stops replay of the same authorization.
  - A stale-but-fresh authorization is refused only by Thetis's own `expected_sequence` check.
  - A late one is refused only by its `expiry_slot`, as D32 (2) and (3) require.
- **New constraint: transaction size.** Measured on the signed relay transaction
  (`relay_sizes` test):

  | Address lookup table holds | Signed relay size |
  |---|---|
  | nothing | 1,464 bytes |
  | only fixed addresses (the three Programmatic Signer programs, the program, system program, sysvars) | **1,376 bytes: over the 1,232-byte limit** |
  | fixed addresses plus the handover's own accounts (nonce account, batch, both party records, both wallets, both derived signers) | 1,128 bytes |

  A fixed table is not enough, but not every per-handover account has to be in it either. Each
  account left inline adds about 31 bytes, and the full-table relay has 104 bytes of headroom, so
  about three of the per-handover accounts can stay inline. The sponsor should add each party's
  long-lived accounts (wallet, derived signer, party record) to a lookup table when that party
  is accredited, and should add each approval's nonce account when the approval is created (one
  nonce account per independently pending approval; see D24). Whether batch accounts need an entry
  depends on the real instruction's account count. Measure that instead of assuming it.
- **Don't trade authority checks for bytes.** Storing the derived signers on the batch could
  replace reading the two party records only if the instruction still checks, at execution
  time, that each signer's delegation is accredited, unexpired and unrevoked (D32 (1)). A cached
  key alone would keep accepting a delegation that was revoked after the batch was opened.
  Re-measure the size with those live checks in place. A table extension is usable only from the
  next slot, so this never happens at handover time. The Thetis account layout should also cut
  per-handover accounts where it can, for example by storing the derived signer on the batch
  Re-measure once the real instruction exists.
- **Still open, (a):** what the wallets show when asked to sign these bytes. A wallet's
  message-signing prompt may show them as unreadable bytes or refuse them as transaction-like; its
  transaction-signing prompt would sign the same bytes but display an Executor `Execute`
  instruction. Both routes will be tried on Solflare and on Phantom, on real Android phones
  through Mobile Wallet Adapter, and on the Mock MWA Wallet. The rule applies **per wallet and
  per signing route**: wherever a prompt shows only unreadable bytes, the app shows the decoded
  intent beside it and that wallet's blind signing is disclosed, even if the other wallet is
  readable. If both wallets refuse both routes, D32 is reopened.

The three committed binaries are Apache-2.0 upstream; the licence text sits beside them in
`programs/signing-spike/tests/fixtures/LICENSE-ed25519-programmatic-signer`. The upstream
repository has no NOTICE file.

## Consequences

- Phones never submit transactions; they return one signature over the authorization bytes (D24).
- The Thetis `Authority` record stores the wallet key and its derived Programmatic Signer address
  (D32 (1)), as `Party` does here.
- Before the main demo depends on these programs, re-dump them, compare their hashes and re-run
  this suite. They are devnet-only and unaudited, which must be disclosed (D32). The committed
  binaries are listed in the [reuse manifest](../reuse-manifest.md).
