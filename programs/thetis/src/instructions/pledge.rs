use anchor_lang::{
    prelude::*,
    solana_program::instruction::{get_stack_height, TRANSACTION_LEVEL_STACK_HEIGHT},
};

use crate::{
    error::ThetisError,
    events::Pledged,
    intent::{
        message::pledge_message,
        verify::{check_ed25519_instruction, previous_instruction},
    },
    state::*,
    validate::{check_lending_authority, MONEY_WINDOW_SECS},
};

#[derive(Accounts)]
#[instruction(loan_index: u32)]
pub struct Pledge<'info> {
    #[account(mut)]
    pub sponsor: Signer<'info>,
    pub protocol: Box<Account<'info, Protocol>>,
    pub lot: Box<Account<'info, Lot>>,
    #[account(mut)]
    pub position: Box<Account<'info, Position>>,
    pub borrower_org: Box<Account<'info, Organisation>>,
    pub borrower_authority: Box<Account<'info, Authority>>,
    pub lender_org: Box<Account<'info, Organisation>>,
    pub lender_authority: Box<Account<'info, Authority>>,
    #[account(mut)]
    pub facility: Box<Account<'info, Facility>>,
    #[account(
        init,
        payer = sponsor,
        space = Loan::DISCRIMINATOR.len() + Loan::INIT_SPACE,
        seeds = [b"loan", facility.key().as_ref(), loan_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub loan: Box<Account<'info, Loan>>,
    #[account(
        init,
        payer = sponsor,
        space = LockAllocation::DISCRIMINATOR.len() + LockAllocation::INIT_SPACE,
        seeds = [b"lock", loan.key().as_ref()],
        bump,
    )]
    pub lock: Box<Account<'info, LockAllocation>>,
    /// CHECK: The address constraint pins the Instructions sysvar.
    #[account(address = solana_sdk_ids::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn pledge(
    ctx: Context<Pledge>,
    loan_index: u32,
    quantity_kg: u64,
    expected_revision: u64,
    valid_until: i64,
) -> Result<()> {
    let accounts = ctx.accounts;
    // Step 0: a pledge is accepted in either settlement mode.
    // Step 1: top level, then the pause bit.
    require_eq!(
        get_stack_height(),
        TRANSACTION_LEVEL_STACK_HEIGHT,
        ThetisError::NotTopLevel
    );
    let protocol = &accounts.protocol;
    let protocol_key = protocol.key();
    require!(
        protocol.pause_flags & pause::PLEDGE == 0,
        ThetisError::Paused
    );

    // Step 2: freshness and the money signing window.
    let now = Clock::get()?.unix_timestamp;
    require!(now <= valid_until, ThetisError::Expired);
    let window = valid_until
        .checked_sub(now)
        .ok_or(ThetisError::WindowTooLong)?;
    require!(window <= MONEY_WINDOW_SECS, ThetisError::WindowTooLong);

    // Step 3: both Authorities, then the remaining bindings.
    let lot = &accounts.lot;
    let position = &mut accounts.position;
    let facility = &mut accounts.facility;
    let borrower_org = &accounts.borrower_org;
    let lender_org = &accounts.lender_org;
    let borrower_authority = &accounts.borrower_authority;
    let lender_authority = &accounts.lender_authority;
    check_lending_authority(
        borrower_authority,
        protocol_key,
        position.owner,
        Some(Role::Exporter),
        borrower_org,
        scope::PLEDGE,
        now,
    )?;
    check_lending_authority(
        lender_authority,
        protocol_key,
        facility.lender,
        Some(Role::Lender),
        lender_org,
        scope::LEND,
        now,
    )?;
    let lot_key = lot.key();
    require!(
        lot.protocol == protocol_key
            && position.protocol == protocol_key
            && facility.protocol == protocol_key
            && position.lot == lot_key,
        ThetisError::WrongOrganisation
    );

    // Step 4: the loan index, then the position revision.
    require_eq!(loan_index, facility.loan_count, ThetisError::StaleRevision);
    require_eq!(
        position.revision,
        expected_revision,
        ThetisError::StaleRevision
    );

    // Step 5: refusals.
    require_keys_eq!(
        facility.borrower,
        position.owner,
        ThetisError::BorrowerNotEligible
    );
    require!(lot.state == LotState::Stored, ThetisError::LotNotStored);
    require!(
        lot.restriction == Restriction::Normal,
        ThetisError::Restricted
    );
    require!(now < lot.expires_at, ThetisError::LotExpired);
    require!(quantity_kg > 0, ThetisError::ZeroQuantity);
    let available = position
        .quantity_kg
        .checked_sub(position.locked_kg)
        .and_then(|unlocked| unlocked.checked_sub(position.reserved_kg))
        .ok_or(ThetisError::InsufficientAvailable)?;
    require!(quantity_kg <= available, ThetisError::InsufficientAvailable);

    // Everything the write needs is computed before the signature check.
    let loan_count = facility
        .loan_count
        .checked_add(1)
        .ok_or(ThetisError::ArithmeticOverflow)?;
    let locked_kg = position
        .locked_kg
        .checked_add(quantity_kg)
        .ok_or(ThetisError::ArithmeticOverflow)?;
    let position_revision = position
        .revision
        .checked_add(1)
        .ok_or(ThetisError::ArithmeticOverflow)?;

    // Step 6: both parties signed one text.
    let text = pledge_message(
        ctx.program_id,
        &protocol.instance_id,
        &lot.lot_id,
        quantity_kg,
        &borrower_org.display_name,
        &lender_org.display_name,
        &facility.facility_id,
        loan_index,
        &facility.currency,
        facility.rate_bps,
        facility.max_ltv_bps,
        facility.terms_version,
        expected_revision,
        valid_until,
    );
    let verification = previous_instruction(&accounts.instructions)?;
    check_ed25519_instruction(
        &verification,
        &[borrower_authority.wallet, lender_authority.wallet],
        &text,
    )?;

    // Step 7: write and emit.
    let loan = &mut accounts.loan;
    let lock = &mut accounts.lock;
    let loan_key = loan.key();
    let lock_key = lock.key();
    let position_key = position.key();
    loan.set_inner(Loan {
        protocol: protocol_key,
        facility: facility.key(),
        borrower: position.owner,
        lot: lot_key,
        position: position_key,
        index: loan_index,
        status: LoanStatus::Active,
        rate_bps: facility.rate_bps,
        terms_version: facility.terms_version,
        principal: 0,
        booked_interest: 0,
        accrual_remainder: 0,
        accrued_at: now,
        open_exceptions: 0,
        revision: 0,
        bump: ctx.bumps.loan,
    });
    lock.set_inner(LockAllocation {
        protocol: protocol_key,
        loan: loan_key,
        position: position_key,
        quantity_kg,
        control: LockControl::Pledged,
        bump: ctx.bumps.lock,
    });
    facility.loan_count = loan_count;
    position.locked_kg = locked_kg;
    position.revision = position_revision;
    emit!(Pledged {
        loan: loan_key,
        lock: lock_key,
        position: position_key,
        lot: lot_key,
        quantity_kg,
        position_revision,
        revision: 0,
    });
    Ok(())
}
