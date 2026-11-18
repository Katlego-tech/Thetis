mod common;

use common::{ps_address, Fixture, PROGRAM, QUANTITY_KG};
use solana_signer::Signer;
use spl_ed25519_signer_interface::{self as signer, error::Error as SignerError};
use spl_message_executor_interface::{self as executor, error::Error as ExecutorError};

const WRONG_SIGNER: u32 = 6000;
const EXPIRED: u32 = 6001;
const STALE_SEQUENCE: u32 = 6002;
const QUANTITY_MISMATCH: u32 = 6003;
const SAME_PARTY: u32 = 6006;

#[test]
fn same_party_both_roles() {
    Fixture::new().assert_same_party_refused(SAME_PARTY);
    println!("D32 same party both roles: refused (SameParty)");
}

#[test]
fn relay_sizes() {
    Fixture::new().assert_relay_sizes();
}

#[test]
fn two_authorities_handover_in_one_instruction() {
    let mut fixture = Fixture::new();
    let initial_nonce = fixture.nonce_value();
    fixture.relay(fixture.approve_handover().submit());
    fixture.assert_batch(1, true);
    assert_ne!(fixture.nonce_value(), initial_nonce);
    println!("D32 two-authority handover: accepted (sequence 1, handed_over true, nonce advanced)");
}

#[test]
fn sponsor_is_the_only_fee_payer() {
    let mut fixture = Fixture::new();
    let party_balances = fixture.party_balances();
    let sponsor_balance = fixture.sponsor_balance();
    let metadata = fixture.relay(fixture.approve_handover().submit());

    fixture.assert_batch(1, true);
    assert_eq!(fixture.party_balances(), party_balances);
    assert!(metadata.fee > 0);
    assert_eq!(sponsor_balance - fixture.sponsor_balance(), metadata.fee);
    println!(
        "D32 sponsor fee: paid {} lamports (Alice and Bob unchanged)",
        metadata.fee
    );
}

#[test]
fn replay_of_same_authorization() {
    let mut fixture = Fixture::new();
    let submit = fixture.approve_handover().submit();
    fixture.relay(submit.clone());
    fixture.assert_batch(1, true);

    fixture.assert_refused(
        "replay",
        submit,
        executor::ID,
        "NonceMismatch",
        ExecutorError::NonceMismatch as u32,
    );
}

#[test]
fn only_alice_authorizes() {
    let mut fixture = Fixture::new();
    let mut handover = fixture.handover(QUANTITY_KG, 0);
    // Deliver Bob's PDA as an unsigned account so Anchor can return WrongSigner.
    handover.accounts[4].is_signer = false;
    let submit = fixture.endorse(handover, &[&fixture.alice]).submit();

    fixture.assert_refused("only Alice", submit, PROGRAM, "WrongSigner", WRONG_SIGNER);
}

#[test]
fn mallory_authorizes_in_place_of_bob() {
    let mut fixture = Fixture::new();
    let mut handover = fixture.handover(QUANTITY_KG, 0);
    handover.accounts[4].pubkey = ps_address(&fixture.mallory.pubkey());
    let submit = fixture
        .endorse(handover, &[&fixture.alice, &fixture.mallory])
        .submit();

    fixture.assert_refused(
        "Mallory in place of Bob",
        submit,
        PROGRAM,
        "WrongSigner",
        WRONG_SIGNER,
    );
}

#[test]
fn authorization_byte_changed_after_signing() {
    let mut fixture = Fixture::new();
    let mut authorization = fixture.approve_handover();
    *authorization.message.instructions[0]
        .data
        .last_mut()
        .unwrap() ^= 1;

    fixture.assert_refused(
        "altered authorization byte",
        authorization.submit(),
        signer::ID,
        "InvalidSignature",
        SignerError::InvalidSignature as u32,
    );
}

#[test]
fn authority_signatures_swapped() {
    let mut fixture = Fixture::new();
    let mut authorization = fixture.approve_handover();
    assert!(authorization.signatures[0].is_none());
    assert!(authorization.signatures[1..].iter().all(Option::is_some));
    authorization.signatures.swap(1, 2);

    fixture.assert_refused(
        "swapped signatures",
        authorization.submit(),
        signer::ID,
        "InvalidSignature",
        SignerError::InvalidSignature as u32,
    );
}

#[test]
fn relayer_substitutes_submit_account() {
    let mut fixture = Fixture::new();
    let mut submit = fixture.approve_handover().submit();
    submit
        .accounts
        .iter_mut()
        .find(|meta| meta.pubkey == fixture.batch)
        .unwrap()
        .pubkey = fixture.mallory.pubkey();

    fixture.assert_refused(
        "substituted Submit account",
        submit,
        signer::ID,
        "AccountKeyMismatch",
        SignerError::AccountKeyMismatch as u32,
    );
}

#[test]
fn authorization_expired() {
    let mut fixture = Fixture::new();
    let submit = fixture.approve_handover().submit();
    fixture.warp_past_expiry();

    fixture.assert_refused("expired", submit, PROGRAM, "Expired", EXPIRED);
}

#[test]
fn stale_sequence_with_fresh_nonce() {
    let mut fixture = Fixture::new();
    let old_nonce = fixture.nonce_value();
    fixture.relay(fixture.approve_handover().submit());
    fixture.assert_batch(1, true);
    assert_ne!(fixture.nonce_value(), old_nonce);
    let submit = fixture.approve_handover().submit();

    fixture.assert_refused(
        "stale sequence",
        submit,
        PROGRAM,
        "StaleSequence",
        STALE_SEQUENCE,
    );
}

#[test]
fn signed_quantity_differs_from_batch() {
    let mut fixture = Fixture::new();
    let submit = fixture
        .endorse(
            fixture.handover(QUANTITY_KG + 1, 0),
            &[&fixture.alice, &fixture.bob],
        )
        .submit();

    fixture.assert_refused(
        "quantity mismatch",
        submit,
        PROGRAM,
        "QuantityMismatch",
        QUANTITY_MISMATCH,
    );
}

#[test]
fn direct_wallet_transaction_cannot_handover() {
    let mut fixture = Fixture::new();
    let mut direct = fixture.handover(QUANTITY_KG, 0);
    direct.accounts[3].pubkey = fixture.alice.pubkey();
    direct.accounts[4].pubkey = fixture.bob.pubkey();

    fixture.assert_refused(
        "direct wallets",
        direct,
        PROGRAM,
        "WrongSigner",
        WRONG_SIGNER,
    );
}
