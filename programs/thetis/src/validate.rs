use anchor_lang::prelude::*;

use crate::{
    error::ThetisError,
    state::{Authority, Organisation, Role},
};

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

pub(crate) fn valid_currency(currency: &[u8; 3]) -> bool {
    currency.iter().all(u8::is_ascii_uppercase)
}

/// The lending counterpart of `check_authority`: also binds the authority to the organisation
/// the instruction acts for, and to its role.
pub(crate) fn check_lending_authority(
    authority: &Authority,
    protocol: Pubkey,
    expected_org: Pubkey,
    required_role: Option<Role>,
    org: &Account<'_, Organisation>,
    required_scope: u16,
    now: i64,
) -> Result<()> {
    require!(
        authority.protocol == protocol && org.protocol == protocol,
        ThetisError::WrongOrganisation
    );
    require!(
        authority.revoked_at.is_none(),
        ThetisError::AuthorityRevoked
    );
    require!(authority.expires_at > now, ThetisError::AuthorityExpired);
    require!(
        authority.organisation == expected_org && expected_org == org.key(),
        ThetisError::WrongOrganisation
    );
    if let Some(role) = required_role {
        require!(org.role == role, ThetisError::WrongRole);
    }
    require!(
        authority.scopes & required_scope != 0,
        ThetisError::ScopeMissing
    );
    Ok(())
}

pub(crate) fn nonzero_digest(digest: &[u8; 32]) -> bool {
    digest.iter().any(|byte| *byte != 0)
}
