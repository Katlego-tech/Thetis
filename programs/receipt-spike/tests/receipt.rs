mod common;

use common::{Fixture, Holding};
use solana_signer::Signer;
use spl_token_2022_interface::{
    error::TokenError,
    instruction::{self as token, AuthorityType},
    ID as TOKEN,
};

macro_rules! direct_refusals {
    ($($name:ident, $label:literal, $error:ident, |$fixture:ident, $signer:ident| $instruction:expr;)*) => {
        mod alice {
            $(
                #[test]
                fn $name() {
                    super::$name(false);
                }
            )*
        }

        mod mallory {
            $(
                #[test]
                fn $name() {
                    super::$name(true);
                }
            )*
        }

        $(
            fn $name(mallory: bool) {
                let mut $fixture = Fixture::new();
                let $signer = if mallory { $fixture.mallory.pubkey() } else { $fixture.alice.owner.pubkey() };
                let ix = $instruction.unwrap();
                let actor = if mallory { "Mallory" } else { "Alice" };
                $fixture.refuse_token(&format!("{} ({actor})", $label), ix, mallory, TokenError::$error);
            }
        )*
    };
}

direct_refusals! {
    transfer, "Transfer", OwnerMismatch, |f, signer|
        #[allow(deprecated)]
        token::transfer(&TOKEN, &f.alice.vault, &f.bob.vault, &signer, &[], 1);
    transfer_checked, "TransferChecked", OwnerMismatch, |f, signer|
        token::transfer_checked(&TOKEN, &f.alice.vault, &f.mint, &f.bob.vault, &signer, &[], 1, 0);
    burn, "Burn", OwnerMismatch, |f, signer|
        token::burn(&TOKEN, &f.alice.vault, &f.mint, &signer, &[], 1);
    burn_checked, "BurnChecked", OwnerMismatch, |f, signer|
        token::burn_checked(&TOKEN, &f.alice.vault, &f.mint, &signer, &[], 1, 0);
    approve, "Approve", OwnerMismatch, |f, signer|
        token::approve(&TOKEN, &f.alice.vault, &f.bob.owner.pubkey(), &signer, &[], 1);
    approve_checked, "ApproveChecked", OwnerMismatch, |f, signer|
        token::approve_checked(&TOKEN, &f.alice.vault, &f.mint, &f.bob.owner.pubkey(), &signer, &[], 1, 0);
    close_account, "CloseAccount", NonNativeHasBalance, |f, signer|
        token::close_account(&TOKEN, &f.alice.vault, &signer, &signer, &[]);
    close_empty_vault, "CloseAccount empty vault", OwnerMismatch, |f, signer| {
        f.move_as_alice(1_000);
        token::close_account(&TOKEN, &f.alice.vault, &signer, &signer, &[])
    };
    set_vault_owner, "SetAuthority vault owner", OwnerMismatch, |f, signer|
        token::set_authority(&TOKEN, &f.alice.vault, Some(&signer), AuthorityType::AccountOwner, &signer, &[]);
    set_vault_close_authority, "SetAuthority vault close", OwnerMismatch, |f, signer|
        token::set_authority(&TOKEN, &f.alice.vault, Some(&signer), AuthorityType::CloseAccount, &signer, &[]);
    set_mint_authority, "SetAuthority mint", OwnerMismatch, |f, signer|
        token::set_authority(&TOKEN, &f.mint, Some(&signer), AuthorityType::MintTokens, &signer, &[]);
    set_freeze_authority, "SetAuthority freeze", OwnerMismatch, |f, signer|
        token::set_authority(&TOKEN, &f.mint, Some(&signer), AuthorityType::FreezeAccount, &signer, &[]);
    mint_to, "MintTo", OwnerMismatch, |f, signer|
        token::mint_to(&TOKEN, &f.mint, &f.alice.vault, &signer, &[], 1);
    freeze_account, "FreezeAccount", OwnerMismatch, |f, signer|
        token::freeze_account(&TOKEN, &f.alice.vault, &f.mint, &signer, &[]);
    thaw_account, "ThawAccount", OwnerMismatch, |f, signer| {
        f.freeze_fixture_vault();
        token::thaw_account(&TOKEN, &f.alice.vault, &f.mint, &signer, &[])
    };
    transfer_to_personal_ata, "TransferChecked to Alice's ATA", OwnerMismatch, |f, signer|
        token::transfer_checked(&TOKEN, &f.alice.vault, &f.mint, &f.personal_ata, &signer, &[], 1, 0);
    mint_to_personal_ata, "MintTo Alice's ATA", OwnerMismatch, |f, signer|
        token::mint_to(&TOKEN, &f.mint, &f.personal_ata, &signer, &[], 1);
}

#[test]
fn alice_moves_units_and_both_positions_match_their_vaults() {
    Fixture::new().move_as_alice(250);
}

#[test]
fn mallory_cannot_move_alices_units() {
    let mut fixture = Fixture::new();
    let ix = fixture.move_units(&fixture.mallory, &fixture.bob, 250);
    fixture.refuse_move("move_units (Mallory)", ix, true, "WrongOwner");
}

#[test]
fn alice_cannot_move_more_than_her_position() {
    let mut fixture = Fixture::new();
    let ix = fixture.move_units(&fixture.alice.owner, &fixture.bob, 1_001);
    fixture.refuse_move(
        "move_units over quantity (Alice)",
        ix,
        false,
        "InsufficientQuantity",
    );
}

#[test]
fn alice_cannot_move_to_the_same_position() {
    let mut fixture = Fixture::new();
    let ix = fixture.move_units(&fixture.alice.owner, &fixture.alice, 1);
    fixture.refuse_move(
        "move_units same position (Alice)",
        ix,
        false,
        "SamePosition",
    );
}

#[test]
fn alice_cannot_move_units_to_her_personal_ata() {
    let mut fixture = Fixture::new();
    let mut ix = fixture.move_units(&fixture.alice.owner, &fixture.bob, 1);
    ix.accounts[7].pubkey = fixture.personal_ata;
    fixture.refuse_move(
        "move_units to Alice's ATA (Alice)",
        ix,
        false,
        "ConstraintTokenOwner",
    );
}

#[test]
fn issuing_zero_rolls_back_position_and_vault_creation() {
    let mut fixture = Fixture::new();
    let holding = Holding::new(fixture.mint);
    fixture.refuse_issue("issue zero", &holding, 0, false, "ZeroQuantity");
}

#[test]
fn issuing_twice_to_the_same_position_fails() {
    let mut fixture = Fixture::new();
    let holding = Holding::new(fixture.mint);
    fixture.precreate_and_issue(&holding, 1);
    fixture.refuse_issue("issue twice", &holding, 1, false, "already in use");
}

#[test]
fn issuing_uses_a_precreated_vault_ata() {
    let mut fixture = Fixture::new();
    let holding = Holding::new(fixture.mint);
    fixture.precreate_and_issue(&holding, 1);
}

#[test]
fn mallory_cannot_issue_receipts_for_an_existing_mint() {
    let mut fixture = Fixture::new();
    let holding = Holding::new(fixture.mint);
    fixture.refuse_issue("issue (Mallory)", &holding, 1, true, "ConstraintHasOne");
}
