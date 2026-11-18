# ADR 0001: Receipts are Token-2022 units in program-held accounts

**Status:** accepted, 18 November 2026 · **Decision:** D25 confirmed · **Acceptance:** A02

## Context

D25 chose Token-2022 receipts that users can move only through Thetis instructions. Phase 0
had to prove that before the account layout is frozen: a user must not be able to transfer,
burn, approve, close, reassign or mint receipts by calling the token program directly. A
transfer hook alone was not assumed to cover every token instruction (DESIGN §5).

## What was tested

The spike program `programs/receipt-spike` (not the Thetis program, not deployed) uses the
configuration under test:

- a Token-2022 mint with **no extensions**, decimals 0 (1 unit = 1 kg), whose mint and freeze
  authority is the PDA `["mint_authority", mint]`;
- one vault per position: the associated token account owned by the PDA `["vault", position]`,
  never by a user wallet;
- a `Position` account per owner and mint holding `quantity`, which must equal its vault's
  balance after every instruction.

Its only movement path, `move_units`, requires the from-position owner's signature, makes a
`transfer_checked` CPI signed by the vault PDA, re-reads both vaults and checks they equal the
updated positions.

What ran:

- **The Token-2022 program that refused every attempt:** the SPL Token-2022 **11.0.0** binary
  bundled in LiteSVM 0.15.0 (`spl_token_2022-11.0.0.so`), with its bundled associated-token
  program 1.1.1.
- **Instructions built with:** spl-token-2022-interface 2.1.0 and
  spl-associated-token-account-interface 2.0.0.
- **Program built with:** Anchor 1.2.2 and anchor-spl 1.2.2, Rust 1.89.0, and Solana
  platform-tools v1.57. That is the toolchain `anchor build` selects under Anchor 1.2.2, locally
  and in CI.

## Evidence

Alice owns a 1,000-unit position; Mallory owns nothing. Each line is a separate test that
asserts the transaction fails and that balances and authorities are unchanged afterwards:

```text
A02 Transfer (Alice): refused (OwnerMismatch; InstructionError(0, Custom(4)))
A02 Transfer (Mallory): refused (OwnerMismatch; InstructionError(0, Custom(4)))
A02 TransferChecked (Alice): refused (OwnerMismatch; InstructionError(0, Custom(4)))
A02 TransferChecked (Mallory): refused (OwnerMismatch; InstructionError(0, Custom(4)))
A02 Burn (Alice): refused (OwnerMismatch; InstructionError(0, Custom(4)))
A02 Burn (Mallory): refused (OwnerMismatch; InstructionError(0, Custom(4)))
A02 BurnChecked (Alice): refused (OwnerMismatch; InstructionError(0, Custom(4)))
A02 BurnChecked (Mallory): refused (OwnerMismatch; InstructionError(0, Custom(4)))
A02 Approve (Alice): refused (OwnerMismatch; InstructionError(0, Custom(4)))
A02 Approve (Mallory): refused (OwnerMismatch; InstructionError(0, Custom(4)))
A02 ApproveChecked (Alice): refused (OwnerMismatch; InstructionError(0, Custom(4)))
A02 ApproveChecked (Mallory): refused (OwnerMismatch; InstructionError(0, Custom(4)))
A02 CloseAccount (Alice): refused (NonNativeHasBalance; InstructionError(0, Custom(11)))
A02 CloseAccount (Mallory): refused (NonNativeHasBalance; InstructionError(0, Custom(11)))
A02 CloseAccount empty vault (Alice): refused (OwnerMismatch; InstructionError(0, Custom(4)))
A02 CloseAccount empty vault (Mallory): refused (OwnerMismatch; InstructionError(0, Custom(4)))
A02 SetAuthority vault owner (Alice): refused (OwnerMismatch; InstructionError(0, Custom(4)))
A02 SetAuthority vault owner (Mallory): refused (OwnerMismatch; InstructionError(0, Custom(4)))
A02 SetAuthority vault close (Alice): refused (OwnerMismatch; InstructionError(0, Custom(4)))
A02 SetAuthority vault close (Mallory): refused (OwnerMismatch; InstructionError(0, Custom(4)))
A02 SetAuthority mint (Alice): refused (OwnerMismatch; InstructionError(0, Custom(4)))
A02 SetAuthority mint (Mallory): refused (OwnerMismatch; InstructionError(0, Custom(4)))
A02 SetAuthority freeze (Alice): refused (OwnerMismatch; InstructionError(0, Custom(4)))
A02 SetAuthority freeze (Mallory): refused (OwnerMismatch; InstructionError(0, Custom(4)))
A02 MintTo (Alice): refused (OwnerMismatch; InstructionError(0, Custom(4)))
A02 MintTo (Mallory): refused (OwnerMismatch; InstructionError(0, Custom(4)))
A02 FreezeAccount (Alice): refused (OwnerMismatch; InstructionError(0, Custom(4)))
A02 FreezeAccount (Mallory): refused (OwnerMismatch; InstructionError(0, Custom(4)))
A02 ThawAccount (Alice): refused (OwnerMismatch; InstructionError(0, Custom(4)))
A02 ThawAccount (Mallory): refused (OwnerMismatch; InstructionError(0, Custom(4)))
A02 TransferChecked to Alice's ATA (Alice): refused (OwnerMismatch; InstructionError(0, Custom(4)))
A02 TransferChecked to Alice's ATA (Mallory): refused (OwnerMismatch; InstructionError(0, Custom(4)))
A02 MintTo Alice's ATA (Alice): refused (OwnerMismatch; InstructionError(0, Custom(4)))
A02 MintTo Alice's ATA (Mallory): refused (OwnerMismatch; InstructionError(0, Custom(4)))
A02 move_units (Mallory): refused (WrongOwner; InstructionError(0, Custom(6002)))
A02 move_units over quantity (Alice): refused (InsufficientQuantity; InstructionError(0, Custom(6003)))
A02 move_units same position (Alice): refused (SamePosition; InstructionError(0, Custom(6004)))
A02 move_units to Alice's ATA (Alice): refused (ConstraintTokenOwner; InstructionError(0, Custom(2015)))
```

The permitted path passes: Alice's `move_units` succeeds, and both vaults equal both positions
afterwards. 43 tests in total, with `cargo fmt` and `cargo clippy -D warnings` clean.

## Decision

D25 stands as written. Thetis receipts use this configuration: no Token-2022 extensions (in
particular no permanent delegate and no transfer hook), PDA mint and freeze authority, and
vaults owned by per-position PDAs. Users act only through Thetis instructions. Program-only
positions without tokens, the fallback in DESIGN §5, is not needed.

## Consequences

- Every Thetis instruction that moves receipts must follow the spike's pattern: owner signature
  checked on the position, PDA-signed `transfer_checked`, token program pinned to Token-2022,
  and a balance-equals-position check after the CPI.
- Anyone can create their own token account for the mint, but it can only ever hold zero: no
  path mints or transfers into it.
- Adding any Token-2022 extension later reopens this ADR and needs the same tests run again.
- These tests ran against Token-2022 11.0.0 as bundled in LiteSVM. Before mainnet, repeat them
  against the Token-2022 version deployed on that cluster.
