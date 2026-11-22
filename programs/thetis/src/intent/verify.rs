use anchor_lang::{prelude::*, solana_program::instruction::Instruction};
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};
use solana_sdk_ids::ed25519_program;

use crate::error::ThetisError;

const HEADER_LEN: usize = 2;
const OFFSETS_LEN: usize = 14;
const SELF_INDEX: u16 = u16::MAX;

pub fn previous_instruction(sysvar: &AccountInfo<'_>) -> Result<Instruction> {
    let index = load_current_index_checked(sysvar)?
        .checked_sub(1)
        .ok_or(ThetisError::MissingVerification)?;
    load_instruction_at_checked(usize::from(index), sysvar)
        .map_err(|_| error!(ThetisError::MissingVerification))
}

/// Bind runtime verification to the expected roles and text.
pub fn check_ed25519_instruction(
    ix: &Instruction,
    expected_signers: &[Pubkey],
    expected_message: &[u8],
) -> Result<()> {
    require_keys_eq!(
        ix.program_id,
        ed25519_program::ID,
        ThetisError::MissingVerification
    );
    let data = &ix.data;
    let header = checked_slice(data, 0, HEADER_LEN)?;
    let [count, padding] = <[u8; HEADER_LEN]>::try_from(header)
        .map_err(|_| error!(ThetisError::MalformedVerification))?;
    let table_len = usize::from(count)
        .checked_mul(OFFSETS_LEN)
        .ok_or(ThetisError::MalformedVerification)?;
    let table = checked_slice(data, HEADER_LEN, table_len)?;
    require_eq!(padding, 0, ThetisError::MalformedVerification);
    require!(
        (1..=2).contains(&expected_signers.len()),
        ThetisError::WrongSignatureCount
    );
    require_eq!(
        usize::from(count),
        expected_signers.len(),
        ThetisError::WrongSignatureCount
    );

    let entries = table.chunks_exact(OFFSETS_LEN).map(read_offsets);
    for entry in entries.clone() {
        let [_, signature_index, _, key_index, _, _, message_index] = entry?;
        require!(
            [signature_index, key_index, message_index] == [SELF_INDEX; 3],
            ThetisError::CrossInstructionReference
        );
    }

    let mut payloads = Vec::with_capacity(usize::from(count));
    for entry in entries {
        let [signature, _, key, _, message, size, _] = entry?;
        checked_slice(data, usize::from(signature), 64)?;
        let key = checked_slice(data, usize::from(key), 32)?;
        let message = checked_slice(data, usize::from(message), usize::from(size))?;
        payloads.push((key, message));
    }
    for ((key, _), expected) in payloads.iter().zip(expected_signers) {
        require!(*key == expected.as_ref(), ThetisError::WrongSigner);
    }
    for (_, message) in payloads {
        require!(message == expected_message, ThetisError::MessageMismatch);
    }
    Ok(())
}

fn checked_slice(data: &[u8], start: usize, size: usize) -> Result<&[u8]> {
    let end = start
        .checked_add(size)
        .ok_or(ThetisError::MalformedVerification)?;
    data.get(start..end)
        .ok_or_else(|| error!(ThetisError::MalformedVerification))
}

fn read_offsets(entry: &[u8]) -> Result<[u16; 7]> {
    let mut fields = [0; 7];
    for (field, encoded) in fields.iter_mut().zip(entry.chunks_exact(2)) {
        *field = u16::from_le_bytes(
            encoded
                .try_into()
                .map_err(|_| error!(ThetisError::MalformedVerification))?,
        );
    }
    Ok(fields)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ThetisError;

    const SELF_INDEX: u16 = u16::MAX;
    const MESSAGE: &[u8] = b"Thetis authorisation v1\nNetwork: devnet\nAction: Transfer receipts\nLot: CR-0001\nQuantity: 2,000.000 t\nTest network only. Synthetic data.";

    /// Instruction-index fields of one 14-byte offsets entry.
    #[derive(Clone, Copy)]
    enum Field {
        Signature,
        Key,
        Message,
    }

    /// Builds Ed25519 precompile instruction data. Signatures are arbitrary bytes because the
    /// function under test never checks them cryptographically; the precompile does.
    struct Ed25519Data {
        keys: Vec<Pubkey>,
        messages: Vec<Vec<u8>>,
        share_message: bool,
        // Per entry: [signature, key, message] instruction indexes.
        indexes: Vec<[u16; 3]>,
    }

    impl Ed25519Data {
        fn new(keys: &[Pubkey], message: &[u8]) -> Self {
            Self::with_messages(keys, &vec![message; keys.len()])
        }

        fn with_messages(keys: &[Pubkey], messages: &[&[u8]]) -> Self {
            assert_eq!(keys.len(), messages.len());
            Self {
                keys: keys.to_vec(),
                messages: messages.iter().map(|message| message.to_vec()).collect(),
                share_message: false,
                indexes: vec![[SELF_INDEX; 3]; keys.len()],
            }
        }

        fn shared(mut self) -> Self {
            self.share_message = true;
            self
        }

        fn index(mut self, entry: usize, field: Field, value: u16) -> Self {
            self.indexes[entry][field as usize] = value;
            self
        }

        fn instruction(&self) -> Instruction {
            self.instruction_for(solana_sdk_ids::ed25519_program::ID)
        }

        fn instruction_for(&self, program_id: Pubkey) -> Instruction {
            let count = self.keys.len();
            let mut payload = Vec::new();
            let mut offsets = Vec::new();
            let payload_start = 2 + count * 14;
            let mut shared_at = None;
            for (entry, key) in self.keys.iter().enumerate() {
                let signature = payload_start + payload.len();
                payload.extend_from_slice(&[0xA5 + entry as u8; 64]);
                let key_at = payload_start + payload.len();
                payload.extend_from_slice(key.as_ref());
                let message = &self.messages[entry];
                let message_at = if self.share_message {
                    // Placeholder, patched below once the one shared payload is placed.
                    0
                } else {
                    let at = payload_start + payload.len();
                    payload.extend_from_slice(message);
                    at
                };
                offsets.push((signature, key_at, message_at, message.len()));
            }
            if self.share_message {
                shared_at = Some(payload_start + payload.len());
                payload.extend_from_slice(&self.messages[0]);
            }

            let mut data = vec![count as u8, 0];
            for (entry, (signature, key, message, size)) in offsets.into_iter().enumerate() {
                let [signature_index, key_index, message_index] = self.indexes[entry];
                for field in [
                    signature as u16,
                    signature_index,
                    key as u16,
                    key_index,
                    shared_at.unwrap_or(message) as u16,
                    size as u16,
                    message_index,
                ] {
                    data.extend_from_slice(&field.to_le_bytes());
                }
            }
            data.extend_from_slice(&payload);
            Instruction {
                program_id,
                accounts: vec![],
                data,
            }
        }
    }

    fn keys() -> (Pubkey, Pubkey) {
        (Pubkey::new_unique(), Pubkey::new_unique())
    }

    fn assert_refused(result: Result<()>, expected: ThetisError) {
        assert_eq!(result.unwrap_err(), expected.into());
    }

    #[test]
    fn verify_accepts_one_signer() {
        let (k1, _) = keys();
        let ix = Ed25519Data::new(&[k1], MESSAGE).instruction();
        check_ed25519_instruction(&ix, &[k1], MESSAGE).unwrap();
    }

    #[test]
    fn verify_accepts_two_signers_in_order() {
        let (k1, k2) = keys();
        let ix = Ed25519Data::new(&[k1, k2], MESSAGE).instruction();
        check_ed25519_instruction(&ix, &[k1, k2], MESSAGE).unwrap();

        let shared = Ed25519Data::new(&[k1, k2], MESSAGE).shared().instruction();
        check_ed25519_instruction(&shared, &[k1, k2], MESSAGE).unwrap();
    }

    #[test]
    fn verify_rejects_wrong_signature_count() {
        let (k1, k2) = keys();
        let k3 = Pubkey::new_unique();
        let one = Ed25519Data::new(&[k1], MESSAGE).instruction();
        assert_refused(
            check_ed25519_instruction(&one, &[k1, k2], MESSAGE),
            ThetisError::WrongSignatureCount,
        );
        let two = Ed25519Data::new(&[k1, k2], MESSAGE).instruction();
        assert_refused(
            check_ed25519_instruction(&two, &[k1], MESSAGE),
            ThetisError::WrongSignatureCount,
        );
        let none = Ed25519Data::new(&[], MESSAGE).instruction();
        assert_refused(
            check_ed25519_instruction(&none, &[], MESSAGE),
            ThetisError::WrongSignatureCount,
        );
        let three = Ed25519Data::new(&[k1, k2, k3], MESSAGE).instruction();
        assert_refused(
            check_ed25519_instruction(&three, &[k1, k2, k3], MESSAGE),
            ThetisError::WrongSignatureCount,
        );
    }

    #[test]
    fn verify_rejects_cross_instruction_offsets() {
        let (k1, k2) = keys();
        for entry in 0..2 {
            for field in [Field::Signature, Field::Key, Field::Message] {
                let ix = Ed25519Data::new(&[k1, k2], MESSAGE)
                    .index(entry, field, 0)
                    .instruction();
                assert_refused(
                    check_ed25519_instruction(&ix, &[k1, k2], MESSAGE),
                    ThetisError::CrossInstructionReference,
                );
            }
        }
    }

    #[test]
    fn verify_rejects_wrong_signer() {
        let (k1, k2) = keys();
        let other = Pubkey::new_unique();
        let one = Ed25519Data::new(&[other], MESSAGE).instruction();
        assert_refused(
            check_ed25519_instruction(&one, &[k1], MESSAGE),
            ThetisError::WrongSigner,
        );
        let reversed = Ed25519Data::new(&[k2, k1], MESSAGE).instruction();
        assert_refused(
            check_ed25519_instruction(&reversed, &[k1, k2], MESSAGE),
            ThetisError::WrongSigner,
        );
    }

    #[test]
    fn verify_rejects_wrong_text() {
        let (k1, k2) = keys();
        let mut altered = MESSAGE.to_vec();
        altered[MESSAGE.len() - 2] ^= 1;
        let one = Ed25519Data::new(&[k1], &altered).instruction();
        assert_refused(
            check_ed25519_instruction(&one, &[k1], MESSAGE),
            ThetisError::MessageMismatch,
        );
        let second_differs =
            Ed25519Data::with_messages(&[k1, k2], &[MESSAGE, &altered]).instruction();
        assert_refused(
            check_ed25519_instruction(&second_differs, &[k1, k2], MESSAGE),
            ThetisError::MessageMismatch,
        );
    }

    #[test]
    fn verify_rejects_other_programs() {
        let (k1, _) = keys();
        let ix = Ed25519Data::new(&[k1], MESSAGE).instruction_for(Pubkey::new_unique());
        assert_refused(
            check_ed25519_instruction(&ix, &[k1], MESSAGE),
            ThetisError::MissingVerification,
        );
    }

    #[test]
    fn verify_rejects_malformed_data() {
        let (k1, k2) = keys();
        let good = Ed25519Data::new(&[k1, k2], MESSAGE).instruction();
        let mut cases = vec![vec![], vec![2], good.data[..20].to_vec()];
        let mut padded = good.data.clone();
        padded[1] = 1;
        cases.push(padded);
        let mut truncated = good.data.clone();
        truncated.truncate(truncated.len() - 1);
        cases.push(truncated);
        for data in cases {
            let ix = Instruction {
                data,
                ..good.clone()
            };
            assert_refused(
                check_ed25519_instruction(&ix, &[k1, k2], MESSAGE),
                ThetisError::MalformedVerification,
            );
        }
    }
}
