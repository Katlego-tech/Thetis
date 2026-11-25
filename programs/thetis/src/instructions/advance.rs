use anchor_lang::{
    prelude::*,
    solana_program::instruction::{get_stack_height, TRANSACTION_LEVEL_STACK_HEIGHT},
};

use crate::{
    error::ThetisError,
    events::AdvanceRecorded,
    intent::{
        message::advance_message,
        verify::{check_ed25519_instruction, previous_instruction},
    },
    lending_math::{accrue, release_preview},
    state::*,
    validate::{check_lending_authority, MONEY_WINDOW_SECS},
};

#[derive(Accounts)]
pub struct RecordAdvance<'info> {
    pub lender: Signer<'info>,
    pub protocol: Box<Account<'info, Protocol>>,
    #[account(
        seeds = [b"authority", protocol.key().as_ref(), lender.key().as_ref()],
        bump = lender_authority.bump,
    )]
    pub lender_authority: Box<Account<'info, Authority>>,
    pub lender_org: Box<Account<'info, Organisation>>,
    pub facility: Box<Account<'info, Facility>>,
    #[account(mut)]
    pub loan: Box<Account<'info, Loan>>,
    pub lock: Box<Account<'info, LockAllocation>>,
    pub lot: Box<Account<'info, Lot>>,
    pub valuation: Box<Account<'info, Valuation>>,
    pub borrower_org: Box<Account<'info, Organisation>>,
    pub borrower_authority: Box<Account<'info, Authority>>,
    /// CHECK: The address constraint pins the Instructions sysvar.
    #[account(address = solana_sdk_ids::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
}

pub fn record_advance(
    ctx: Context<RecordAdvance>,
    amount: u64,
    currency: [u8; 3],
    expected_revision: u64,
    valid_until: i64,
) -> Result<()> {
    let accounts = ctx.accounts;
    let protocol = &accounts.protocol;
    let protocol_key = protocol.key();

    // Step 0: an advance is a fiat-mode action.
    require!(
        protocol.settlement_mode == SettlementMode::FiatAttestationTest,
        ThetisError::WrongSettlementMode
    );
    // Step 1: top level, then the pause bit.
    require_eq!(
        get_stack_height(),
        TRANSACTION_LEVEL_STACK_HEIGHT,
        ThetisError::NotTopLevel
    );
    require!(
        protocol.pause_flags & pause::ADVANCE == 0,
        ThetisError::Paused
    );

    // Step 2: freshness and the money signing window.
    let now = Clock::get()?.unix_timestamp;
    require!(now <= valid_until, ThetisError::Expired);
    let window = valid_until
        .checked_sub(now)
        .ok_or(ThetisError::WindowTooLong)?;
    require!(window <= MONEY_WINDOW_SECS, ThetisError::WindowTooLong);

    // Step 3: both Authorities, then the protocol fields, then the bindings.
    let facility = &accounts.facility;
    let loan = &accounts.loan;
    let lock = &accounts.lock;
    let lot = &accounts.lot;
    let lender_org = &accounts.lender_org;
    let borrower_org = &accounts.borrower_org;
    let lender_authority = &accounts.lender_authority;
    let borrower_authority = &accounts.borrower_authority;
    require_keys_eq!(
        lender_authority.wallet,
        accounts.lender.key(),
        ThetisError::WrongSigner
    );
    check_lending_authority(
        lender_authority,
        protocol_key,
        facility.lender,
        Some(Role::Lender),
        lender_org,
        scope::LEND,
        now,
    )?;
    check_lending_authority(
        borrower_authority,
        protocol_key,
        loan.borrower,
        Some(Role::Exporter),
        borrower_org,
        scope::PLEDGE,
        now,
    )?;
    require!(
        facility.protocol == protocol_key
            && loan.protocol == protocol_key
            && lock.protocol == protocol_key
            && lot.protocol == protocol_key,
        ThetisError::WrongOrganisation
    );
    let loan_key = loan.key();
    require!(
        facility.lender == lender_org.key()
            && loan.facility == facility.key()
            && lock.loan == loan_key
            && lock.position == loan.position
            && loan.lot == lot.key()
            && loan.borrower == borrower_org.key(),
        ThetisError::WrongOrganisation
    );

    // Step 4: the loan's revision.
    require_eq!(loan.revision, expected_revision, ThetisError::StaleRevision);

    // Step 5: refusals. Everything is computed into temporaries; nothing is written yet.
    require!(
        loan.status == LoanStatus::Active,
        ThetisError::LoanNotActive
    );
    require!(currency == facility.currency, ThetisError::CurrencyMismatch);
    require!(amount > 0, ThetisError::InvalidField);
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
    let principal_after = loan
        .principal
        .checked_add(amount)
        .ok_or(ThetisError::ArithmeticOverflow)?;
    let preview = release_preview(
        principal_after,
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
    require!(preview.allowed, ThetisError::OverLimit);
    let revision = loan
        .revision
        .checked_add(1)
        .ok_or(ThetisError::ArithmeticOverflow)?;

    // Step 6: the borrower signed this exact advance.
    let text = advance_message(
        ctx.program_id,
        &protocol.instance_id,
        &lot.lot_id,
        &borrower_org.display_name,
        &lender_org.display_name,
        &facility.facility_id,
        loan.index,
        amount,
        principal_after,
        &facility.currency,
        facility.currency_decimals,
        loan.rate_bps,
        loan.terms_version,
        expected_revision,
        valid_until,
    );
    let verification = previous_instruction(&accounts.instructions)?;
    check_ed25519_instruction(&verification, &[borrower_authority.wallet], &text)?;

    // Step 7: write and emit.
    let loan = &mut accounts.loan;
    loan.booked_interest = accrual.booked_interest;
    loan.accrual_remainder = accrual.accrual_remainder;
    loan.accrued_at = accrual.accrued_at;
    loan.principal = principal_after;
    loan.revision = revision;
    emit!(AdvanceRecorded {
        loan: loan_key,
        amount,
        principal: principal_after,
        booked_interest: accrual.booked_interest,
        revision,
    });
    Ok(())
}
