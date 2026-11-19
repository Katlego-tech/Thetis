use anchor_lang::{prelude::*, solana_program::instruction::Instruction};
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};
use solana_sdk_ids::ed25519_program;

use crate::error::IntentError;

const HEADER_LEN: usize = 2;
const OFFSETS_LEN: usize = 14;
const SELF_INDEX: u16 = u16::MAX;

pub(crate) fn previous_instruction(sysvar: &AccountInfo<'_>) -> Result<Instruction> {
    let index = load_current_index_checked(sysvar)?
        .checked_sub(1)
        .ok_or(IntentError::MissingVerification)?;
    load_instruction_at_checked(usize::from(index), sysvar)
        .map_err(|_| error!(IntentError::MissingVerification))
}

/// Bind runtime verification to the expected roles and text.
pub fn check_ed25519_instruction(
    ix: &Instruction,
    expected_signers: &[Pubkey; 2],
    expected_message: &[u8],
) -> Result<()> {
    require_keys_eq!(
        ix.program_id,
        ed25519_program::ID,
        IntentError::MissingVerification
    );
    let data = &ix.data;
    let header = checked_slice(data, 0, HEADER_LEN)?;
    let [count, padding] = <[u8; HEADER_LEN]>::try_from(header)
        .map_err(|_| error!(IntentError::MalformedVerification))?;
    let table_len = usize::from(count)
        .checked_mul(OFFSETS_LEN)
        .ok_or(IntentError::MalformedVerification)?;
    let table = checked_slice(data, HEADER_LEN, table_len)?;
    require_eq!(padding, 0, IntentError::MalformedVerification);
    require_eq!(
        usize::from(count),
        expected_signers.len(),
        IntentError::WrongSignatureCount
    );

    let entries = [
        read_offsets(checked_slice(table, 0, OFFSETS_LEN)?)?,
        read_offsets(checked_slice(table, OFFSETS_LEN, OFFSETS_LEN)?)?,
    ];
    for [_, signature_index, _, key_index, _, _, message_index] in entries {
        require!(
            [signature_index, key_index, message_index] == [SELF_INDEX; 3],
            IntentError::CrossInstructionReference
        );
    }

    let mut key_slices = [&[][..]; 2];
    let mut message_slices = [&[][..]; 2];
    for (index, [signature, _, key, _, message, size, _]) in entries.into_iter().enumerate() {
        checked_slice(data, usize::from(signature), 64)?;
        key_slices[index] = checked_slice(data, usize::from(key), 32)?;
        message_slices[index] = checked_slice(data, usize::from(message), usize::from(size))?;
    }
    for (key, expected) in key_slices.into_iter().zip(expected_signers) {
        require!(key == expected.as_ref(), IntentError::WrongSigner);
    }
    for message in message_slices {
        require!(message == expected_message, IntentError::MessageMismatch);
    }
    Ok(())
}

fn checked_slice(data: &[u8], start: usize, size: usize) -> Result<&[u8]> {
    let end = start
        .checked_add(size)
        .ok_or(IntentError::MalformedVerification)?;
    data.get(start..end)
        .ok_or_else(|| error!(IntentError::MalformedVerification))
}

fn read_offsets(entry: &[u8]) -> Result<[u16; 7]> {
    let mut fields = [0; 7];
    for (field, encoded) in fields.iter_mut().zip(entry.chunks_exact(2)) {
        *field = u16::from_le_bytes(
            encoded
                .try_into()
                .map_err(|_| error!(IntentError::MalformedVerification))?,
        );
    }
    Ok(fields)
}
