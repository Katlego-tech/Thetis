#![allow(
    clippy::ptr_arg,
    reason = "Anchor derives an argument type check for the owned String"
)]

use anchor_lang::{
    prelude::*,
    solana_program::instruction::{get_stack_height, TRANSACTION_LEVEL_STACK_HEIGHT},
};

use crate::{
    error::ThetisError,
    events::ValuationSet,
    state::*,
    validate::{check_lending_authority, code_seed, nonzero_digest},
};

#[derive(Accounts)]
#[instruction(grade: String)]
pub struct SetValuation<'info> {
    pub lender: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub protocol: Box<Account<'info, Protocol>>,
    #[account(
        seeds = [b"authority", protocol.key().as_ref(), lender.key().as_ref()],
        bump = authority.bump,
    )]
    pub authority: Box<Account<'info, Authority>>,
    pub lender_org: Box<Account<'info, Organisation>>,
    pub facility: Box<Account<'info, Facility>>,
    pub class_policy: Box<Account<'info, ClassPolicy>>,
    pub custodian_class: Box<Account<'info, CustodianClass>>,
    #[account(
        init_if_needed,
        payer = payer,
        space = Valuation::DISCRIMINATOR.len() + Valuation::INIT_SPACE,
        seeds = [
            b"valuation",
            facility.key().as_ref(),
            class_policy.key().as_ref(),
            code_seed(&grade, MAX_GRADE)?,
            custodian_class.key().as_ref(),
        ],
        bump,
    )]
    pub valuation: Box<Account<'info, Valuation>>,
    pub system_program: Program<'info, System>,
}

pub fn set_valuation(
    ctx: Context<SetValuation>,
    grade: String,
    value_per_kg: u64,
    haircut_bps: u16,
    valid_until: i64,
    source_digest: [u8; 32],
) -> Result<()> {
    let accounts = ctx.accounts;
    let protocol_key = accounts.protocol.key();
    // Step 0: a valuation is set in either settlement mode.
    // Step 1: top level. Setting a valuation is never paused.
    require_eq!(
        get_stack_height(),
        TRANSACTION_LEVEL_STACK_HEIGHT,
        ThetisError::NotTopLevel
    );

    // Step 2: the lender's authority, against the facility's own lender.
    let now = Clock::get()?.unix_timestamp;
    let authority = &accounts.authority;
    let facility = &accounts.facility;
    require_keys_eq!(
        authority.wallet,
        accounts.lender.key(),
        ThetisError::WrongSigner
    );
    check_lending_authority(
        authority,
        protocol_key,
        facility.lender,
        Some(Role::Lender),
        &accounts.lender_org,
        scope::LEND,
        now,
    )?;

    // Step 3: bindings.
    let class_policy = &accounts.class_policy;
    let custodian_class = &accounts.custodian_class;
    require!(
        facility.protocol == protocol_key
            && class_policy.protocol == protocol_key
            && custodian_class.protocol == protocol_key
            && custodian_class.class_policy == class_policy.key(),
        ThetisError::WrongOrganisation,
    );
    let valuation = &mut accounts.valuation;
    let first_write = valuation.version == 0;
    require!(
        first_write
            || (valuation.protocol == protocol_key
                && valuation.facility == facility.key()
                && valuation.class_policy == class_policy.key()
                && valuation.grade == grade
                && valuation.custodian_class == custodian_class.key()),
        ThetisError::WrongOrganisation,
    );

    // Step 5: refusals.
    require!(
        class_policy.grades.contains(&grade)
            && value_per_kg >= 1
            && haircut_bps <= 10_000
            && valid_until > now
            && nonzero_digest(&source_digest),
        ThetisError::InvalidField,
    );
    let version = valuation
        .version
        .checked_add(1)
        .ok_or(ThetisError::ArithmeticOverflow)?;

    // Step 6: write and emit.
    if first_write {
        valuation.protocol = protocol_key;
        valuation.facility = facility.key();
        valuation.class_policy = class_policy.key();
        valuation.grade = grade;
        valuation.custodian_class = custodian_class.key();
        valuation.bump = ctx.bumps.valuation;
    }
    valuation.value_per_kg = value_per_kg;
    valuation.haircut_bps = haircut_bps;
    valuation.valid_until = valid_until;
    valuation.source_digest = source_digest;
    valuation.version = version;
    valuation.set_at = now;
    emit!(ValuationSet {
        valuation: valuation.key(),
        facility: facility.key(),
        version,
        value_per_kg,
        haircut_bps,
        valid_until,
        source_digest,
        set_at: now,
    });
    Ok(())
}
