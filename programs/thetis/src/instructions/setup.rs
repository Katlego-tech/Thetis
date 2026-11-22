#![allow(
    clippy::ptr_arg,
    reason = "Anchor derives an argument type check for the owned String"
)]

use anchor_lang::prelude::*;

use crate::{error::ThetisError, events::*, state::*};

#[derive(Accounts)]
#[instruction(instance_id: [u8; 16])]
pub struct InitializeProtocol<'info> {
    #[account(
        init,
        payer = payer,
        space = Protocol::DISCRIMINATOR.len() + Protocol::INIT_SPACE,
        seeds = [b"protocol", instance_id.as_ref()],
        bump,
    )]
    pub protocol: Account<'info, Protocol>,
    pub admin: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn initialize_protocol(
    ctx: Context<InitializeProtocol>,
    instance_id: [u8; 16],
    settlement_mode: SettlementMode,
    admin: Pubkey,
    accreditor: Pubkey,
) -> Result<()> {
    require_keys_eq!(ctx.accounts.admin.key(), admin, ThetisError::NotAdmin);
    ctx.accounts.protocol.set_inner(Protocol {
        instance_id,
        settlement_mode,
        admin,
        accreditor,
        pause_flags: 0,
        bump: ctx.bumps.protocol,
    });
    emit!(ProtocolInitialized {
        protocol: ctx.accounts.protocol.key(),
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(class_code: String, version: u32)]
pub struct RegisterClass<'info> {
    #[account(has_one = accreditor @ ThetisError::NotAccreditor)]
    pub protocol: Account<'info, Protocol>,
    #[account(
        init,
        payer = payer,
        space = ClassPolicy::DISCRIMINATOR.len() + ClassPolicy::INIT_SPACE,
        seeds = [b"class", protocol.key().as_ref(), code_seed(&class_code, MAX_CLASS_CODE)?, &version.to_le_bytes()],
        bump,
    )]
    pub class_policy: Account<'info, ClassPolicy>,
    pub accreditor: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn register_class(
    ctx: Context<RegisterClass>,
    class_code: String,
    version: u32,
    grades: Vec<String>,
    origin_required: bool,
    lot_validity_secs: i64,
    split_inherits_expiry: bool,
) -> Result<()> {
    require!(lot_validity_secs > 0, ThetisError::InvalidField);
    require!(
        (1..=MAX_GRADES).contains(&grades.len()),
        ThetisError::InvalidField
    );
    for (index, grade) in grades.iter().enumerate() {
        require!(
            valid_code(grade, MAX_GRADE) && !grades[..index].contains(grade),
            ThetisError::InvalidField,
        );
    }

    ctx.accounts.class_policy.set_inner(ClassPolicy {
        protocol: ctx.accounts.protocol.key(),
        class_code,
        version,
        unit: QuantityUnit::Kilogram,
        grades,
        origin_required,
        lot_validity_secs,
        split_inherits_expiry,
        bump: ctx.bumps.class_policy,
    });
    emit!(ClassRegistered {
        class_policy: ctx.accounts.class_policy.key(),
        version,
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(org_id: [u8; 16])]
pub struct AccreditOrganisation<'info> {
    #[account(has_one = accreditor @ ThetisError::NotAccreditor)]
    pub protocol: Account<'info, Protocol>,
    #[account(
        init,
        payer = payer,
        space = Organisation::DISCRIMINATOR.len() + Organisation::INIT_SPACE,
        seeds = [b"org", protocol.key().as_ref(), org_id.as_ref()],
        bump,
    )]
    pub organisation: Account<'info, Organisation>,
    pub accreditor: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn accredit_organisation(
    ctx: Context<AccreditOrganisation>,
    org_id: [u8; 16],
    role: Role,
    display_name: String,
    admin: Pubkey,
) -> Result<()> {
    require!(valid_display_name(&display_name), ThetisError::InvalidField);
    ctx.accounts.organisation.set_inner(Organisation {
        protocol: ctx.accounts.protocol.key(),
        org_id,
        role,
        display_name,
        admin,
        related: Vec::new(),
        bump: ctx.bumps.organisation,
    });
    emit!(OrganisationAccredited {
        organisation: ctx.accounts.organisation.key(),
        role,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct DeclareRelationship<'info> {
    #[account(has_one = accreditor @ ThetisError::NotAccreditor)]
    pub protocol: Account<'info, Protocol>,
    #[account(mut, has_one = protocol @ ThetisError::WrongOrganisation)]
    pub a: Account<'info, Organisation>,
    // Let the relationship rule return InvalidField when the two accounts coincide.
    #[account(mut, dup, has_one = protocol @ ThetisError::WrongOrganisation)]
    pub b: Account<'info, Organisation>,
    pub accreditor: Signer<'info>,
}

pub fn declare_relationship(ctx: Context<DeclareRelationship>) -> Result<()> {
    let a = &mut ctx.accounts.a;
    let b = &mut ctx.accounts.b;
    require!(
        a.key() != b.key()
            && a.related.len() < MAX_RELATED
            && b.related.len() < MAX_RELATED
            && !a.related.contains(&b.key())
            && !b.related.contains(&a.key()),
        ThetisError::InvalidField,
    );
    a.related.push(b.key());
    b.related.push(a.key());
    emit!(RelationshipDeclared {
        a: a.key(),
        b: b.key()
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(wallet: Pubkey)]
pub struct DelegateAuthority<'info> {
    pub protocol: Account<'info, Protocol>,
    #[account(
        has_one = protocol @ ThetisError::WrongOrganisation,
        has_one = admin @ ThetisError::NotOrganisationAdmin,
    )]
    pub organisation: Account<'info, Organisation>,
    #[account(
        init,
        payer = payer,
        space = Authority::DISCRIMINATOR.len() + Authority::INIT_SPACE,
        seeds = [b"authority", protocol.key().as_ref(), wallet.as_ref()],
        bump,
    )]
    pub authority: Account<'info, Authority>,
    pub admin: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn delegate_authority(
    ctx: Context<DelegateAuthority>,
    wallet: Pubkey,
    scopes: u16,
    expires_at: i64,
) -> Result<()> {
    use scope::{ATTEST_ORIGIN, ISSUE, REDEEM, SPLIT, TRANSFER};

    let organisation = &ctx.accounts.organisation;
    let allowed = match organisation.role {
        Role::Exporter | Role::Buyer => TRANSFER | SPLIT | REDEEM,
        Role::Custodian => ISSUE | REDEEM,
        Role::DocumentIssuer => ATTEST_ORIGIN,
        Role::Transporter | Role::Terminal | Role::Lender | Role::Inspector => 0,
    };
    require!(scopes & !allowed == 0, ThetisError::ScopeNotAllowed);
    require!(
        expires_at > Clock::get()?.unix_timestamp,
        ThetisError::InvalidField
    );
    ctx.accounts.authority.set_inner(Authority {
        protocol: ctx.accounts.protocol.key(),
        organisation: organisation.key(),
        wallet,
        scopes,
        expires_at,
        revoked_at: None,
        bump: ctx.bumps.authority,
    });
    emit!(AuthorityDelegated {
        authority: ctx.accounts.authority.key(),
        organisation: organisation.key(),
        scopes,
        expires_at,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct RevokeAuthority<'info> {
    pub protocol: Account<'info, Protocol>,
    #[account(has_one = protocol @ ThetisError::WrongOrganisation)]
    pub organisation: Account<'info, Organisation>,
    #[account(
        mut,
        has_one = protocol @ ThetisError::WrongOrganisation,
        has_one = organisation @ ThetisError::WrongOrganisation,
    )]
    pub authority: Account<'info, Authority>,
    pub signer: Signer<'info>,
}

pub fn revoke_authority(ctx: Context<RevokeAuthority>) -> Result<()> {
    let signer = ctx.accounts.signer.key();
    require!(
        signer == ctx.accounts.organisation.admin || signer == ctx.accounts.protocol.accreditor,
        ThetisError::NotOrganisationAdmin,
    );
    let authority = &mut ctx.accounts.authority;
    require!(
        authority.revoked_at.is_none(),
        ThetisError::AuthorityRevoked
    );
    let at = Clock::get()?.unix_timestamp;
    authority.revoked_at = Some(at);
    emit!(AuthorityRevoked {
        authority: authority.key(),
        at
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(site_code: String)]
pub struct AccreditCustodianClass<'info> {
    #[account(has_one = accreditor @ ThetisError::NotAccreditor)]
    pub protocol: Account<'info, Protocol>,
    #[account(has_one = protocol @ ThetisError::WrongOrganisation)]
    pub custodian: Account<'info, Organisation>,
    #[account(has_one = protocol @ ThetisError::WrongOrganisation)]
    pub class_policy: Account<'info, ClassPolicy>,
    #[account(
        init,
        payer = payer,
        space = CustodianClass::DISCRIMINATOR.len() + CustodianClass::INIT_SPACE,
        seeds = [
            b"custodian_class",
            protocol.key().as_ref(),
            custodian.key().as_ref(),
            class_policy.key().as_ref(),
            code_seed(&site_code, MAX_SITE_CODE)?,
        ],
        bump,
    )]
    pub custodian_class: Account<'info, CustodianClass>,
    pub accreditor: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn accredit_custodian_class(
    ctx: Context<AccreditCustodianClass>,
    site_code: String,
    approved_capacity_kg: u64,
) -> Result<()> {
    require!(
        ctx.accounts.custodian.role == Role::Custodian,
        ThetisError::WrongRole
    );
    require!(approved_capacity_kg > 0, ThetisError::InvalidField);
    ctx.accounts.custodian_class.set_inner(CustodianClass {
        protocol: ctx.accounts.protocol.key(),
        custodian: ctx.accounts.custodian.key(),
        class_policy: ctx.accounts.class_policy.key(),
        site_code,
        approved_capacity_kg,
        occupied_kg: 0,
        reserved_inbound_kg: 0,
        bump: ctx.bumps.custodian_class,
    });
    emit!(CustodianClassAccredited {
        custodian_class: ctx.accounts.custodian_class.key(),
        approved_capacity_kg,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct SetPause<'info> {
    #[account(mut, has_one = admin @ ThetisError::NotAdmin)]
    pub protocol: Account<'info, Protocol>,
    pub admin: Signer<'info>,
}

pub fn set_pause(ctx: Context<SetPause>, flags: u16, paused: bool) -> Result<()> {
    require!(flags & !pause::ALL == 0, ThetisError::InvalidField);
    let current = &mut ctx.accounts.protocol.pause_flags;
    let next = if paused {
        *current | flags
    } else {
        *current & !flags
    };
    if next != *current {
        *current = next;
        emit!(PauseChanged { flags: next });
    }
    Ok(())
}

fn valid_display_name(name: &str) -> bool {
    (1..=MAX_DISPLAY_NAME).contains(&name.len())
        && name.bytes().all(|byte| (0x20..=0x7e).contains(&byte))
        && !name.starts_with(' ')
        && !name.ends_with(' ')
        && !name.contains("  ")
}

fn valid_code(code: &str, limit: usize) -> bool {
    (1..=limit).contains(&code.len())
        && code
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'-')
}

fn code_seed(code: &str, limit: usize) -> Result<&[u8]> {
    // Anchor derives the address before running the handler. An oversized
    // seed must return InvalidField before it reaches find_program_address.
    require!(valid_code(code, limit), ThetisError::InvalidField);
    Ok(code.as_bytes())
}
