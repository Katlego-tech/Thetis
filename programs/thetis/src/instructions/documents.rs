use anchor_lang::prelude::*;

use crate::{
    error::ThetisError,
    events::{DocumentAttested, DocumentRevoked},
    state::{scope, Authority, DocumentAttestation, DocumentKind, Organisation, Protocol, Role},
};

#[derive(Accounts)]
#[instruction(kind: DocumentKind, subject: [u8; 32], version: u32)]
pub struct AttestDocument<'info> {
    pub protocol: Account<'info, Protocol>,
    #[account(has_one = protocol @ ThetisError::WrongOrganisation)]
    pub organisation: Account<'info, Organisation>,
    #[account(
        has_one = protocol @ ThetisError::WrongOrganisation,
        has_one = organisation @ ThetisError::WrongOrganisation,
        has_one = wallet @ ThetisError::WrongSigner,
    )]
    pub authority: Account<'info, Authority>,
    #[account(
        init,
        payer = payer,
        space = DocumentAttestation::DISCRIMINATOR.len() + DocumentAttestation::INIT_SPACE,
        seeds = [
            b"document",
            protocol.key().as_ref(),
            &document_kind_seed(kind),
            subject.as_ref(),
            &version.to_le_bytes(),
        ],
        bump,
    )]
    pub document: Account<'info, DocumentAttestation>,
    pub wallet: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn attest_document(
    ctx: Context<AttestDocument>,
    kind: DocumentKind,
    subject: [u8; 32],
    version: u32,
    sha256: [u8; 32],
    valid_until: i64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    check_attest_authority(&ctx.accounts.authority, now, kind)?;
    let eligible = match kind {
        DocumentKind::Origin => matches!(ctx.accounts.organisation.role, Role::DocumentIssuer),
        DocumentKind::Departure => matches!(
            ctx.accounts.organisation.role,
            Role::DocumentIssuer | Role::Custodian | Role::Terminal
        ),
    };
    require!(eligible, ThetisError::WrongRole);
    require!(valid_until > now, ThetisError::InvalidField);
    require!(version != 0, ThetisError::InvalidField);

    ctx.accounts.document.set_inner(DocumentAttestation {
        protocol: ctx.accounts.protocol.key(),
        kind,
        subject,
        version,
        issuer: ctx.accounts.organisation.key(),
        sha256,
        valid_until,
        revoked_at: None,
        bump: ctx.bumps.document,
    });
    emit!(DocumentAttested {
        document: ctx.accounts.document.key(),
        kind,
        subject,
        version,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct RevokeDocument<'info> {
    pub protocol: Account<'info, Protocol>,
    #[account(has_one = protocol @ ThetisError::WrongOrganisation)]
    pub organisation: Account<'info, Organisation>,
    #[account(
        has_one = protocol @ ThetisError::WrongOrganisation,
        has_one = organisation @ ThetisError::WrongOrganisation,
        has_one = wallet @ ThetisError::WrongSigner,
    )]
    pub authority: Account<'info, Authority>,
    #[account(mut, has_one = protocol @ ThetisError::WrongOrganisation)]
    pub document: Account<'info, DocumentAttestation>,
    pub wallet: Signer<'info>,
}

pub fn revoke_document(ctx: Context<RevokeDocument>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    check_attest_authority(&ctx.accounts.authority, now, ctx.accounts.document.kind)?;
    let document = &mut ctx.accounts.document;
    require_keys_eq!(
        ctx.accounts.organisation.key(),
        document.issuer,
        ThetisError::NotIssuer
    );
    require!(document.revoked_at.is_none(), ThetisError::DocumentRevoked);

    document.revoked_at = Some(now);
    emit!(DocumentRevoked {
        document: document.key(),
        at: now,
    });
    Ok(())
}

/// The scope a document kind needs to be attested or revoked.
fn kind_scope(kind: DocumentKind) -> u16 {
    match kind {
        DocumentKind::Origin => scope::ATTEST_ORIGIN,
        DocumentKind::Departure => scope::ATTEST_TRANSPORT,
    }
}

fn check_attest_authority(authority: &Authority, now: i64, kind: DocumentKind) -> Result<()> {
    require!(
        authority.revoked_at.is_none(),
        ThetisError::AuthorityRevoked
    );
    require!(authority.expires_at > now, ThetisError::AuthorityExpired);
    require!(
        authority.scopes & kind_scope(kind) != 0,
        ThetisError::ScopeMissing
    );
    Ok(())
}

fn document_kind_seed(kind: DocumentKind) -> [u8; 1] {
    // Anchor's IDL cannot describe an enum cast in a seed. Clients derive the PDA.
    [kind as u8]
}
