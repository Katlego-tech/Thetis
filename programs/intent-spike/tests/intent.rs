mod common;

use anchor_lang::error::ErrorCode;
use common::*;
use intent_spike::{error::IntentError, verify::check_ed25519_instruction};
use solana_sdk_ids::compute_budget;
use solana_transaction::{Instruction, TransactionError};

fn assert_intent_refused(
    fixture: &mut Fixture,
    case: &str,
    instructions: &[Instruction],
    error: IntentError,
) {
    fixture.assert_program_refused(case, instructions, &error.name(), error.into());
}

#[test]
fn honest_handover() {
    let mut fixture = Fixture::new();
    let instructions = [
        fixture.approval(VALID_UNTIL),
        fixture.handover(VALID_UNTIL, 0),
    ];
    let [sponsor, alice, bob] = fixture.balances();

    let receipt = fixture.send_honest(&instructions);

    fixture.assert_batch(1, true);
    assert!(receipt.fee > 0);
    assert_eq!(fixture.balances(), [sponsor - receipt.fee, alice, bob]);
}

#[test]
fn no_verify_instruction() {
    let mut fixture = Fixture::new();
    let handover = fixture.handover(VALID_UNTIL, 0);
    assert_intent_refused(
        &mut fixture,
        "no verify instruction",
        &[handover],
        IntentError::MissingVerification,
    );
}

#[test]
fn verify_instruction_not_adjacent() {
    let mut fixture = Fixture::new();
    // ComputeBudget::SetComputeUnitLimit, encoded as a tag and a little-endian u32.
    let other = Instruction {
        program_id: compute_budget::ID,
        accounts: vec![],
        data: [vec![2], 200_000_u32.to_le_bytes().to_vec()].concat(),
    };
    let instructions = [
        fixture.approval(VALID_UNTIL),
        other,
        fixture.handover(VALID_UNTIL, 0),
    ];
    assert_intent_refused(
        &mut fixture,
        "verify instruction not adjacent",
        &instructions,
        IntentError::MissingVerification,
    );
}

#[test]
fn references_another_instruction() {
    let mut fixture = Fixture::new();
    let verify = fixture.approval(VALID_UNTIL);
    let mut reference = verify.clone();
    for entry in reference.data[2..30].chunks_exact_mut(14) {
        for index in [2, 6, 12] {
            entry[index..index + 2].copy_from_slice(&0_u16.to_le_bytes());
        }
    }
    reference.data.truncate(30);
    let instructions = [verify, reference, fixture.handover(VALID_UNTIL, 0)];
    assert_intent_refused(
        &mut fixture,
        "cross-instruction offsets",
        &instructions,
        IntentError::CrossInstructionReference,
    );
}

fn signer_case(case: &str, keys: [usize; 2], count: usize, error: IntentError) {
    let mut fixture = Fixture::new();
    let wallets = [&fixture.alice, &fixture.bob, &fixture.mallory];
    let signers = keys.map(|index| wallets[index]);
    let valid = fixture.approval(VALID_UNTIL);
    let verify = ed25519_instruction(&signers[..count], &valid.data[222..]);
    let instructions = [verify, fixture.handover(VALID_UNTIL, 0)];
    assert_intent_refused(&mut fixture, case, &instructions, error);
}

#[test]
fn sender_signature_only() {
    signer_case(
        "sender signature only",
        [0, 1],
        1,
        IntentError::WrongSignatureCount,
    );
}

#[test]
fn swapped_signers() {
    signer_case("swapped signers", [1, 0], 2, IntentError::WrongSigner);
}

#[test]
fn mallory_replaces_receiver() {
    signer_case(
        "Mallory replaces receiver",
        [0, 2],
        2,
        IntentError::WrongSigner,
    );
}

#[test]
fn sender_signs_twice() {
    signer_case("sender signs twice", [0, 0], 2, IntentError::WrongSigner);
}

fn message_case(case: &str, edit: impl FnOnce(String) -> String) {
    let mut fixture = Fixture::new();
    let valid = fixture.approval(VALID_UNTIL);
    let message = edit(String::from_utf8(valid.data[222..].to_vec()).unwrap());
    let instructions = [
        fixture.sign_message(message.as_bytes()),
        fixture.handover(VALID_UNTIL, 0),
    ];
    assert_intent_refused(
        &mut fixture,
        case,
        &instructions,
        IntentError::MessageMismatch,
    );
}

#[test]
fn signed_different_quantity() {
    message_case("signed different quantity", |text| {
        text.replace("2,000.000 t", "1.000 t")
    });
}

#[test]
fn signed_mainnet_text() {
    message_case("signed mainnet text", |text| {
        text.replace("Network: devnet", "Network: mainnet")
    });
}

#[test]
fn signed_for_another_program() {
    message_case("signed for another program", |text| {
        text.replace(&PROGRAM.to_string(), &compute_budget::ID.to_string())
    });
}

#[test]
fn signed_for_another_batch() {
    message_case("signed for another batch", |text| {
        text.replace(
            "00112233445566778899aabbccddeeff",
            "10112233445566778899aabbccddeeff",
        )
    });
}

#[test]
fn signed_trailing_byte() {
    message_case("signed trailing byte", |text| text + "\n");
}

#[test]
fn sponsor_extends_signed_expiry() {
    let mut fixture = Fixture::new();
    let instructions = [
        fixture.approval(VALID_UNTIL),
        fixture.handover(VALID_UNTIL + 1, 0),
    ];
    assert_intent_refused(
        &mut fixture,
        "sponsor extends signed expiry",
        &instructions,
        IntentError::MessageMismatch,
    );
}

#[test]
fn message_changed_after_signing() {
    let mut fixture = Fixture::new();
    let mut verify = fixture.approval(VALID_UNTIL);
    *verify.data.last_mut().unwrap() = b'!';
    let instructions = [verify, fixture.handover(VALID_UNTIL, 0)];
    let case = "message changed after signing";
    let failure = fixture.refusal(case, &instructions);
    assert!(
        matches!(failure.err, TransactionError::InstructionError(0, _)),
        "{failure:?}"
    );
    println!("D32-inhouse {case}: refused (Ed25519 precompile)");
}

#[test]
fn replay() {
    let mut fixture = Fixture::new();
    let instructions = [
        fixture.approval(VALID_UNTIL),
        fixture.handover(VALID_UNTIL, 0),
    ];
    fixture.send_honest(&instructions);
    fixture.assert_batch(1, true);
    assert_intent_refused(
        &mut fixture,
        "replay",
        &instructions,
        IntentError::StaleSequence,
    );
}

#[test]
fn expired() {
    let mut fixture = Fixture::new();
    let instructions = [
        fixture.approval(VALID_UNTIL),
        fixture.handover(VALID_UNTIL, 0),
    ];
    fixture.set_clock(VALID_UNTIL + 1);
    assert_intent_refused(&mut fixture, "expired", &instructions, IntentError::Expired);
}

#[test]
fn window_too_long() {
    let mut fixture = Fixture::new();
    let valid_until = NOW + 601;
    let instructions = [
        fixture.approval(valid_until),
        fixture.handover(valid_until, 0),
    ];
    assert_intent_refused(
        &mut fixture,
        "window too long",
        &instructions,
        IntentError::WindowTooLong,
    );
}

#[test]
fn fake_instructions_sysvar() {
    let mut fixture = Fixture::new();
    let mut handover = fixture.handover(VALID_UNTIL, 0);
    handover.accounts[3].pubkey = wallet_address(&fixture.alice);
    let instructions = [fixture.approval(VALID_UNTIL), handover];
    let error = ErrorCode::ConstraintAddress;
    fixture.assert_program_refused(
        "fake instructions sysvar",
        &instructions,
        &error.name(),
        error.into(),
    );
}

#[test]
fn truncated_verification() {
    let mut fixture = Fixture::new();
    let case = "truncated verification";
    let mut verify = fixture.approval(VALID_UNTIL);
    let expected_message = verify.data[222..].to_vec();
    verify.data.pop();
    let error = check_ed25519_instruction(
        &verify,
        &[wallet_address(&fixture.alice), wallet_address(&fixture.bob)],
        &expected_message,
    )
    .unwrap_err();
    assert_eq!(error, IntentError::MalformedVerification.into());
    // The enabled precompile rejects this data before the on-chain parser can run.
    let instructions = [verify, fixture.handover(VALID_UNTIL, 0)];
    let failure = fixture.refusal(case, &instructions);
    assert!(
        matches!(failure.err, TransactionError::InstructionError(0, _)),
        "{failure:?}"
    );
    println!(
        "D32-inhouse {case}: refused (Ed25519 precompile on chain; parser alone: MalformedVerification)"
    );
}

#[test]
fn invalid_display_name() {
    let mut fixture = Fixture::new();
    for display_name in ["Kopano\nQuantity: 1.000 t", "Kó pano", &"X".repeat(49)] {
        let register = fixture.register_party(wallet_address(&fixture.mallory), display_name);
        assert_intent_refused(
            &mut fixture,
            "invalid display name",
            &[register],
            IntentError::InvalidDisplayName,
        );
    }
}

#[test]
fn invalid_lot_id() {
    let mut fixture = Fixture::new();
    for lot_id in ["cr-0001", "ABCDEFGHIJKLMNOPQ"] {
        let open = fixture.open_batch(*b"another-batch-id", lot_id);
        assert_intent_refused(
            &mut fixture,
            "invalid lot id",
            &[open],
            IntentError::InvalidLotId,
        );
    }
}
