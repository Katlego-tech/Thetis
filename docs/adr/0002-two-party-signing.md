# ADR 0002: Two parties authorise one instruction through the Programmatic Signer

**Status:** accepted for the on-chain part; check (a) **failed on real wallets**, 18 November 2026 ·
**Decision:** D32 checks (b) and (c) confirmed; check (a) refuted, so D32 was reopened and **re-decided: in-house verification**, not yet proven on the phones · **Sources:**
D23, D24, D27, D32

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
- **(a) is refuted on real wallets** (phone session, 18 November 2026; results below). The
  Programmatic Signer authorization is shaped like a transaction message, so wallets either
  refuse to sign it as a message or treat it as a normal transaction they can't simulate.
  Neither wallet showed any readable intent. That meets D32's trigger for reconsidering the
  approach: two-party signing works on chain, but not through these wallets' prompts.

## Phone session: D32 check (a), 18 November 2026

**Setup:**
- **Program:** `signing-spike` deployed to devnet at `EH7cQ4xmoJ92v2y1JW1xHwVQgtCNvkkVka3jiK1ByQnb`
  (slot 523703336). `tools/signing-relay setup` opened batch
  `73M1cR5TN8NKgzQyii1Fx6huUgCGQvdwSABUiEH52kSo` with its nonce account and lookup table.
- **Phones:** the Android test app (`apps/signing-spike`, Mobile Wallet Adapter) on two phones,
  reaching the laptop relay through `adb reverse`:
  - Galaxy A50, Android 11: **Phantom 26.38.1**, sender;
  - Galaxy A32, Android 13: **Solflare 2.33.2**, receiver.

  Both wallets are new, devnet-only test wallets. Each route was sent the same authorization
  bytes, whose digest begins `772ec3f1`.
- **Not run:** the Mock MWA Wallet emulator rehearsal. It has no published APK, and building it
  from source was not done here.

| Wallet | Route | What the wallet showed | Result |
|---|---|---|---|
| Phantom | `sign_messages` | No prompt. Phantom received the request, stalled, then closed. | Timeout; no signature |
| Phantom | `sign_transactions` | Connect sheet: "This app's identity could not be verified. It may be impersonating another app". Then "Confirm transaction" with no readable intent, "Failed to simulate the results of this request" and a network fee. Then "Are you sure? Proceeding is unsafe, so Phantom blocked this request", with continuing possible only after ticking "I understand that I could lose all of my funds" and pressing "Yes, confirm (unsafe)". | ✅ Signature **verified over exactly the authorization bytes** (relay check). Blind signing behind Phantom's strongest warnings. |
| Solflare | `sign_messages` | No prompt. Solflare ended the session within 0.1 s of the request. | `CancellationException`; no signature |
| Solflare | `sign_transactions` | "Unknown site", plus a blocking "Network mismatch: your current network is set to devnet, but this transaction is for mainnet", with **Close as the only option**. With the wallet switched to mainnet, it refused because the test wallet had no SOL for the fee it believed it would pay. | ❌ Refused; no signature |

The two-party handover was therefore **not submitted**: the relay never had both signatures.

**Interpretation:**
- **The zeroed blockhash.** The authorization message's blockhash field is ignored by the
  Programmatic Signer and zeroed. Solflare appears to read it to infer the network.
- **The wrong frame.** Both wallets present the bytes as a transaction the user's wallet pays
  for, which it is not.
- **Why a real blockhash doesn't help.** Writing a real devnet blockhash into that field would
  make the signed bytes a submittable transaction for about 60–90 seconds, with the phone as fee
  payer. That is not adopted. It would still not make the intent readable, and it adds risk that
  would need a separate security review.

**Compatibility findings, fixed in the test app:**
- **Token reuse:** Phantom rejects reuse of the session token. The library sends
  `reauthorize` without the chain, giving error -1. The app now authorises afresh before each
  signature.
- **Identity URI:** Phantom auto-declines sign requests when the app identity has no URI
  ("identityUri is not defined", code -3).
- **Power saving:** Android's power-saving mode on the A50 firewalled the backgrounded test app,
  so its local connection to the wallet timed out.
- **Memory:** the A32 ran out of memory with the debug build, and Android killed the test app and
  the wallet mid-request. A restart cleared it.

**Next:** the user chose **in-house verification** (D32, 18 November 2026). Parties sign a
human-readable intent that the program rebuilds byte for byte and checks against a native
Ed25519 verification instruction. It is proved offline, then on the same phones, in its own ADR.

The three committed binaries are Apache-2.0 upstream; the licence text sits beside them in
`programs/signing-spike/tests/fixtures/LICENSE-ed25519-programmatic-signer`. The upstream
repository has no NOTICE file.

## Consequences

**Superseded in part (18 November 2026):** after check (a) failed, D32 was re-decided as in-house
verification. The points below that depend on the Programmatic Signer apply only to this spike;
the replacement is proved in its own ADR (0003).

- Phones never submit transactions (D24). Under the new decision they return one signature over a
  readable text, not over authorization bytes.
- ~~The Thetis `Authority` record stores the wallet key and its derived Programmatic Signer
  address~~: void under the new decision; the `Authority` record stores the wallet key, which
  Thetis checks directly.
- This spike's binaries stay in the repository as evidence. If anything ever depends on them
  again, re-dump them, compare their hashes and re-run
  this suite. They are devnet-only and unaudited, which must be disclosed (D32). The committed
  binaries are listed in the [reuse manifest](../reuse-manifest.md).
