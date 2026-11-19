# ADR 0003: Parties sign a readable text; the program rebuilds it and checks the Ed25519 precompile

**Status:** accepted offline (19 November 2026); the phone check is still to run · **Decision:**
D32 as re-decided on 18 November 2026 holds offline (LiteSVM with the real Ed25519 precompile); expiry moves from a slot to chain time ·
**Sources:** D23, D24, D32; [ADR 0002](0002-two-party-signing.md)

## Context

ADR 0002 showed that real wallets would not sign an Anza Programmatic Signer authorization
readably. Phantom blind-signed it behind an "unsafe" override, and Solflare refused it. The user
re-decided D32 as in-house verification:
- each party's wallet signs a plain-text intent with ordinary message signing;
- the sponsor submits a native Ed25519 verify instruction followed by the Thetis instruction;
- Thetis rebuilds the text from chain state and accepts only if the verify instruction checked
  exactly that text, for the registered wallets.

This ADR records the offline proof. The phone session adds its own section below.

## What was tested

`programs/intent-spike` (PR #16) is a spike, not the Thetis program. Its `handover` stands in for a
custody handover between two registered parties.

**The signed text** is twelve ASCII lines joined by `\n`:
- a title (`Thetis authorisation v1`);
- the network and the program id;
- the action;
- the lot and batch;
- the quantity in tonnes;
- both parties' display names;
- the sequence;
- `Valid until <time> SAST`;
- a test-network notice.

Display names (printable ASCII, single spaces) and lot ids (`A–Z 0–9 -`) are validated when
written, so a name can't add a line.

**The transaction** is `[Ed25519 verify (2 signatures, 1 shared message), handover]`. The sponsor
is the only signer and fee payer; there is no nonce account and no lookup table. `handover`
checks, in order:
1. it is a top-level call;
2. `now <= valid_until` and `valid_until − now <= 600 s`;
3. the expected sequence;
4. the quantity;
5. the batch is not already handed over;
6. the instruction immediately before it is the Ed25519 program's;
7. that instruction has exactly two entries, every offset index is `0xFFFF` (its own data), entry 0
   is the sender's wallet, entry 1 the receiver's, and both messages equal the rebuilt text byte for
   byte.

The runtime verifies both signatures before any program runs.

**Test setup:** LiteSVM 0.15 with its `precompiles` feature, so the real Ed25519 check runs. The
known-answer strings were computed in Python before the Rust existed.

## Results (`anchor build -p intent_spike && cargo test -p intent-spike -- --nocapture`)

```text
D32-inhouse honest handover: 936 bytes
D32-inhouse no verify instruction: refused (MissingVerification)
D32-inhouse verify instruction not adjacent: refused (MissingVerification)
D32-inhouse cross-instruction offsets: refused (CrossInstructionReference)
D32-inhouse sender signature only: refused (WrongSignatureCount)
D32-inhouse swapped signers: refused (WrongSigner)
D32-inhouse Mallory replaces receiver: refused (WrongSigner)
D32-inhouse sender signs twice: refused (WrongSigner)
D32-inhouse signed different quantity: refused (MessageMismatch)
D32-inhouse signed mainnet text: refused (MessageMismatch)
D32-inhouse signed for another program: refused (MessageMismatch)
D32-inhouse signed for another batch: refused (MessageMismatch)
D32-inhouse signed trailing byte: refused (MessageMismatch)
D32-inhouse sponsor extends signed expiry: refused (MessageMismatch)
D32-inhouse message changed after signing: refused (Ed25519 precompile)
D32-inhouse replay: refused (StaleSequence)
D32-inhouse expired: refused (Expired)
D32-inhouse window too long: refused (WindowTooLong)
D32-inhouse fake instructions sysvar: refused (ConstraintAddress)
D32-inhouse truncated verification: refused (Ed25519 precompile on chain; parser alone: MalformedVerification)
D32-inhouse invalid display name: refused (InvalidDisplayName)   (newline, non-ASCII, 49 bytes)
D32-inhouse invalid lot id: refused (InvalidLotId)               (lowercase, 17 bytes)
```

Four formatting tests also pass: tonnes and SAST known answers, and two full messages matched by
bytes, length and SHA-256. Every refusal asserts that the `Batch` account is byte-identical
afterwards. An independent review (PR #16) found no blockers. It confirmed that the bytes the
precompile verifies and the bytes the program compares can't diverge, because both are read from
the same instruction data at the same offsets.

## Decision

- **D32's in-house route holds offline** (LiteSVM with the real Ed25519 precompile; no devnet
  transaction has run it yet). Two readable signatures authorise one instruction. The
  sponsor alone signs and pays. The transaction is 936 bytes against the 1,232-byte limit,
  without a lookup table.
- **Expiry is chain time, not a slot.** The text says when it stops working in a form a person
  can read, and the program enforces a ceiling per action class (the spike implements only
  custody; money and the default are design ceilings for the real program):
  - custody: 600 s;
  - money: 300 s;
  - anything later: 600 s unless its catalogue row says otherwise.

  The relay is to set `valid_until` to the chain's current time plus the window, kept 30 s inside
  the ceiling so clock drift can't push it over, and never from a device clock (the relay change
  is built separately). D23 and D32 are amended to match.
- **The sequence is the replay guard.** A signature that was never used dies at its expiry.

## Limits and what is not proven

- **`NotTopLevel` is untested.** Refusing a call routed through another program would need a
  second, hostile program to test. It is defence in depth: the text and keys must still match, so
  wrapping the call gains nothing.
- **The verify-data parser's `MalformedVerification` path can't be reached through a transaction.**
  The precompile rejects truncated data first. The test checks the parser directly.
- **`register_party` and `open_batch` have no authority check.** That is spike scope; the real
  `Authority` record (D32 (1)) replaces `Party`.
- **The test harness carries an old Ed25519 library.** LiteSVM's `precompiles` feature brings
  `ed25519-dalek` 1.0.1 into the test graph only. Its advisories are accepted under #5 until
  2026-12-02.
- **No wallet has signed this text yet.** Whether Phantom and Solflare sign the raw bytes, and what
  they display, is the phone check below.

## Phone session

*To be recorded:* both wallets' prompts (screenshots), whether each signed the exact bytes, and
the devnet outcome of the two-party handover.
