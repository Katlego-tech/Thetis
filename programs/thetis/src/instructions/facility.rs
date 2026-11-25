use anchor_lang::{
    prelude::*,
    solana_program::instruction::{get_stack_height, TRANSACTION_LEVEL_STACK_HEIGHT},
};

use crate::{
    error::ThetisError,
    events::FacilityOpened,
    state::*,
    validate::{check_lending_authority, nonzero_digest, valid_currency},
};

#[derive(Accounts)]
#[instruction(facility_id: [u8; 16])]
pub struct OpenFacility<'info> {
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
    pub borrower_org: Box<Account<'info, Organisation>>,
    #[account(
        init,
        payer = payer,
        space = Facility::DISCRIMINATOR.len() + Facility::INIT_SPACE,
        seeds = [
            b"facility",
            protocol.key().as_ref(),
            lender_org.key().as_ref(),
            facility_id.as_ref(),
        ],
        bump,
    )]
    pub facility: Box<Account<'info, Facility>>,
    #[account(seeds = [b"pool", protocol.key().as_ref()], bump)]
    pub pool: Option<Box<Account<'info, SimulationPool>>>,
    pub system_program: Program<'info, System>,
}

#[allow(
    clippy::too_many_arguments,
    reason = "the arguments are the facility terms"
)]
pub fn open_facility(
    ctx: Context<OpenFacility>,
    facility_id: [u8; 16],
    currency: [u8; 3],
    currency_decimals: u8,
    terms_version: u32,
    rate_bps: u16,
    max_ltv_bps: u16,
    terms_digest: [u8; 32],
) -> Result<()> {
    let accounts = ctx.accounts;
    let protocol = &accounts.protocol;
    let protocol_key = protocol.key();
    // Step 0: a facility opens in either settlement mode.
    // Step 1: top level. Opening a facility is never paused.
    require_eq!(
        get_stack_height(),
        TRANSACTION_LEVEL_STACK_HEIGHT,
        ThetisError::NotTopLevel
    );

    // Step 2: the lender's authority.
    let now = Clock::get()?.unix_timestamp;
    let authority = &accounts.authority;
    require_keys_eq!(
        authority.wallet,
        accounts.lender.key(),
        ThetisError::WrongSigner
    );
    check_lending_authority(
        authority,
        protocol_key,
        accounts.lender_org.key(),
        Some(Role::Lender),
        &accounts.lender_org,
        scope::LEND,
        now,
    )?;

    // Step 3: bindings.
    let borrower_org = &accounts.borrower_org;
    require!(
        borrower_org.protocol == protocol_key
            && accounts
                .pool
                .as_ref()
                .is_none_or(|pool| pool.protocol == protocol_key),
        ThetisError::WrongOrganisation,
    );

    // Step 5: refusals.
    require!(borrower_org.role == Role::Exporter, ThetisError::WrongRole);
    require!(
        valid_currency(&currency)
            && currency_decimals <= 9
            && rate_bps <= 10_000
            && (1..=10_000).contains(&max_ltv_bps)
            && terms_version >= 1
            && nonzero_digest(&terms_digest),
        ThetisError::InvalidField,
    );
    match (protocol.settlement_mode, accounts.pool.as_ref()) {
        (SettlementMode::FiatAttestationTest, None) => {}
        (SettlementMode::DevnetTokenSimulation, Some(pool)) => require!(
            currency == pool.currency && currency_decimals == pool.currency_decimals,
            ThetisError::CurrencyMismatch,
        ),
        (SettlementMode::FiatAttestationTest, Some(_))
        | (SettlementMode::DevnetTokenSimulation, None) => return err!(ThetisError::InvalidField),
    }

    // Step 6: write and emit.
    let lender = accounts.lender_org.key();
    let borrower = borrower_org.key();
    let facility = &mut accounts.facility;
    facility.set_inner(Facility {
        protocol: protocol_key,
        lender,
        borrower,
        facility_id,
        currency,
        currency_decimals,
        terms_version,
        rate_bps,
        max_ltv_bps,
        terms_digest,
        loan_count: 0,
        bump: ctx.bumps.facility,
    });
    emit!(FacilityOpened {
        facility: facility.key(),
        lender,
        borrower,
        currency,
        currency_decimals,
        terms_version,
        rate_bps,
        max_ltv_bps,
    });
    Ok(())
}
