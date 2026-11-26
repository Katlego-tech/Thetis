use anchor_lang::{
    prelude::*,
    solana_program::instruction::{get_stack_height, TRANSACTION_LEVEL_STACK_HEIGHT},
};

use crate::{
    error::ThetisError,
    events::{Liquidated, LoanClosed},
    lending_math::{accrue, release_preview},
    state::*,
    validate::check_lending_authority,
};

#[derive(Accounts)]
pub struct Liquidate<'info> {
    pub lender: Signer<'info>,
    pub protocol: Box<Account<'info, Protocol>>,
    #[account(
        seeds = [b"authority", protocol.key().as_ref(), lender.key().as_ref()],
        bump = authority.bump,
    )]
    pub authority: Box<Account<'info, Authority>>,
    pub lender_org: Box<Account<'info, Organisation>>,
    pub facility: Box<Account<'info, Facility>>,
    #[account(mut)]
    pub loan: Box<Account<'info, Loan>>,
    #[account(mut)]
    pub lock: Box<Account<'info, LockAllocation>>,
    pub lot: Box<Account<'info, Lot>>,
    pub valuation: Box<Account<'info, Valuation>>,
}

/// Moves a loan that is over its limit on a fresh valuation to Recovery. Control of the lock
/// changes; no units, owner, custody or money move.
pub fn liquidate(ctx: Context<Liquidate>, expected_revision: u64) -> Result<()> {
    let accounts = ctx.accounts;
    let protocol = &accounts.protocol;
    let protocol_key = protocol.key();

    // Step 1: top level, then the pause bit. Both settlement modes are allowed.
    require_eq!(
        get_stack_height(),
        TRANSACTION_LEVEL_STACK_HEIGHT,
        ThetisError::NotTopLevel
    );
    require!(
        protocol.pause_flags & pause::LIQUIDATE == 0,
        ThetisError::Paused
    );

    // Step 2: the lender's Authority.
    let now = Clock::get()?.unix_timestamp;
    let facility = &accounts.facility;
    let loan = &accounts.loan;
    let lock = &accounts.lock;
    let lot = &accounts.lot;
    require_keys_eq!(
        accounts.authority.wallet,
        accounts.lender.key(),
        ThetisError::WrongSigner
    );
    check_lending_authority(
        &accounts.authority,
        protocol_key,
        facility.lender,
        Some(Role::Lender),
        &accounts.lender_org,
        scope::LEND,
        now,
    )?;

    // Step 3: the protocol fields, then the bindings. The valuation is exempt (it is checked
    // below as the fresh valuation).
    require!(
        facility.protocol == protocol_key
            && loan.protocol == protocol_key
            && lock.protocol == protocol_key
            && lot.protocol == protocol_key,
        ThetisError::WrongOrganisation
    );
    let loan_key = loan.key();
    require!(
        loan.facility == facility.key()
            && lock.loan == loan_key
            && lock.position == loan.position
            && loan.lot == lot.key(),
        ThetisError::WrongOrganisation
    );

    // Step 4: the loan's revision.
    require_eq!(loan.revision, expected_revision, ThetisError::StaleRevision);

    // Step 5: refusals. Everything is computed into temporaries; nothing is written yet.
    require!(
        loan.status == LoanStatus::Active,
        ThetisError::LoanNotActive
    );
    let valuation = &accounts.valuation;
    require!(
        valuation.protocol == protocol_key
            && valuation.facility == facility.key()
            && valuation.class_policy == lot.class_policy
            && valuation.grade == lot.grade
            && valuation.custodian_class == lot.custodian_class,
        ThetisError::ValuationMismatch
    );
    require!(now <= valuation.valid_until, ThetisError::ValuationStale);
    let accrual = accrue(loan, now)?;
    let preview = release_preview(
        loan.principal,
        accrual.booked_interest,
        0,
        0,
        0,
        lock.quantity_kg,
        0,
        valuation.value_per_kg,
        u64::from(valuation.haircut_bps),
        u64::from(facility.max_ltv_bps),
    )?;
    require!(!preview.allowed, ThetisError::LoanHealthy);
    let revision = loan
        .revision
        .checked_add(1)
        .ok_or(ThetisError::ArithmeticOverflow)?;

    // Step 6: write and emit.
    let lock_key = lock.key();
    let loan = &mut accounts.loan;
    loan.booked_interest = accrual.booked_interest;
    loan.accrual_remainder = accrual.accrual_remainder;
    loan.accrued_at = accrual.accrued_at;
    loan.status = LoanStatus::Recovery;
    loan.revision = revision;
    accounts.lock.control = LockControl::Recovery;
    emit!(Liquidated {
        loan: loan_key,
        lock: lock_key,
        debt: preview.debt_before,
        limit: preview.limit_after,
        revision,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct CloseLoan<'info> {
    pub lender: Signer<'info>,
    pub protocol: Box<Account<'info, Protocol>>,
    #[account(
        seeds = [b"authority", protocol.key().as_ref(), lender.key().as_ref()],
        bump = authority.bump,
    )]
    pub authority: Box<Account<'info, Authority>>,
    pub lender_org: Box<Account<'info, Organisation>>,
    pub facility: Box<Account<'info, Facility>>,
    #[account(mut)]
    pub loan: Box<Account<'info, Loan>>,
    #[account(mut)]
    pub lock: Box<Account<'info, LockAllocation>>,
    #[account(mut)]
    pub position: Box<Account<'info, Position>>,
}

/// Closes a loan whose debt is zero and that has no open exception. The lock is released from
/// the position; the Loan and the LockAllocation stay as tombstones.
pub fn close_loan(ctx: Context<CloseLoan>, expected_revision: u64) -> Result<()> {
    let accounts = ctx.accounts;
    let protocol = &accounts.protocol;
    let protocol_key = protocol.key();

    // Step 1: top level. Closing is never paused.
    require_eq!(
        get_stack_height(),
        TRANSACTION_LEVEL_STACK_HEIGHT,
        ThetisError::NotTopLevel
    );

    // Step 2: the lender's Authority.
    let now = Clock::get()?.unix_timestamp;
    let facility = &accounts.facility;
    let loan = &accounts.loan;
    let lock = &accounts.lock;
    let position = &accounts.position;
    require_keys_eq!(
        accounts.authority.wallet,
        accounts.lender.key(),
        ThetisError::WrongSigner
    );
    check_lending_authority(
        &accounts.authority,
        protocol_key,
        facility.lender,
        Some(Role::Lender),
        &accounts.lender_org,
        scope::LEND,
        now,
    )?;

    // Step 3: the protocol fields, then the bindings. No valuation is read.
    require!(
        facility.protocol == protocol_key
            && loan.protocol == protocol_key
            && lock.protocol == protocol_key
            && position.protocol == protocol_key,
        ThetisError::WrongOrganisation
    );
    let loan_key = loan.key();
    let position_key = position.key();
    require!(
        loan.facility == facility.key()
            && lock.loan == loan_key
            && loan.position == position_key
            && lock.position == position_key
            && position.lot == loan.lot,
        ThetisError::WrongOrganisation
    );

    // Step 4: the loan's revision.
    require_eq!(loan.revision, expected_revision, ThetisError::StaleRevision);

    // Step 5: refusals. Everything is computed into temporaries; nothing is written yet.
    require!(
        loan.status != LoanStatus::Closed,
        ThetisError::LoanNotActive
    );
    let accrual = accrue(loan, now)?;
    let debt = u128::from(loan.principal) + u128::from(accrual.booked_interest);
    require!(debt == 0, ThetisError::DebtOutstanding);
    require!(loan.open_exceptions == 0, ThetisError::LiveObligation);
    let released_kg = lock.quantity_kg;
    let locked_kg = position
        .locked_kg
        .checked_sub(released_kg)
        .ok_or(ThetisError::ArithmeticOverflow)?;
    let position_revision = position
        .revision
        .checked_add(1)
        .ok_or(ThetisError::ArithmeticOverflow)?;
    let revision = loan
        .revision
        .checked_add(1)
        .ok_or(ThetisError::ArithmeticOverflow)?;

    // Step 6: write and emit.
    let loan = &mut accounts.loan;
    loan.booked_interest = accrual.booked_interest;
    loan.accrual_remainder = accrual.accrual_remainder;
    loan.accrued_at = accrual.accrued_at;
    loan.status = LoanStatus::Closed;
    loan.revision = revision;
    let position = &mut accounts.position;
    position.locked_kg = locked_kg;
    position.revision = position_revision;
    accounts.lock.quantity_kg = 0;
    emit!(LoanClosed {
        loan: loan_key,
        position: position_key,
        released_kg,
        revision,
    });
    Ok(())
}
