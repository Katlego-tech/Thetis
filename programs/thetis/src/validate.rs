use anchor_lang::prelude::*;

use crate::{error::ThetisError, state::Authority};

pub(crate) const CUSTODY_WINDOW_SECS: i64 = 600;

pub(crate) fn valid_code(code: &str, limit: usize) -> bool {
    (1..=limit).contains(&code.len())
        && code
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'-')
}

pub(crate) fn code_seed(code: &str, limit: usize) -> Result<&[u8]> {
    // Anchor derives the address before running the handler. An oversized
    // seed must return InvalidField before it reaches find_program_address.
    require!(valid_code(code, limit), ThetisError::InvalidField);
    Ok(code.as_bytes())
}

pub(crate) fn check_authority(authority: &Authority, now: i64, required_scope: u16) -> Result<()> {
    require!(
        authority.revoked_at.is_none(),
        ThetisError::AuthorityRevoked
    );
    require!(authority.expires_at > now, ThetisError::AuthorityExpired);
    require!(
        authority.scopes & required_scope != 0,
        ThetisError::ScopeMissing
    );
    Ok(())
}
