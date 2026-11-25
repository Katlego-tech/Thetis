use anchor_lang::{
    prelude::*,
    solana_program::instruction::{get_stack_height, TRANSACTION_LEVEL_STACK_HEIGHT},
};
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::{
    error::ThetisError,
    events::{PaymentConfirmed, PaymentCorrected, Repaid},
    lending_math::{accrue, apply_payment},
    state::*,
    validate::{check_lending_authority, nonzero_digest},
};

#[derive(Accounts)]
#[instruction(payment_id: [u8; 32])]
pub struct ConfirmPayment<'info> {
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
    #[account(mut)]
    pub loan: Box<Account<'info, Loan>>,
    /// CHECK: The loan, a release intent or the corrected payment; the handler binds it to the
    /// purpose.
    pub subject: UncheckedAccount<'info>,
    #[account(mut)]
    pub target: Option<Box<Account<'info, PaymentAttestation>>>,
    #[account(
        init,
        payer = payer,
        space = PaymentAttestation::DISCRIMINATOR.len() + PaymentAttestation::INIT_SPACE,
        seeds = [
            b"payment",
            protocol.key().as_ref(),
            lender_org.key().as_ref(),
            payment_id.as_ref(),
        ],
        bump,
    )]
    pub payment: Box<Account<'info, PaymentAttestation>>,
    pub system_program: Program<'info, System>,
}

/// Records money the lender's bank received, once per lender and payment identity. A
/// `Correction` voids an unconsumed record, or marks a consumed one as an exception. Nothing
/// here moves a balance, and neither the pause bits nor the valuation are read: money that has
/// arrived is always recorded.
pub fn confirm_payment(
    ctx: Context<ConfirmPayment>,
    payment_id: [u8; 32],
    purpose: PaymentPurpose,
    amount: u64,
    currency: [u8; 3],
    evidence_digest: [u8; 32],
    observed_at: i64,
) -> Result<()> {
    let accounts = ctx.accounts;
    let protocol = &accounts.protocol;
    let protocol_key = protocol.key();

    // Step 0: a payment is a fiat-mode record.
    require!(
        protocol.settlement_mode == SettlementMode::FiatAttestationTest,
        ThetisError::WrongSettlementMode
    );
    // Step 1: top level. Recording a payment is never paused.
    require_eq!(
        get_stack_height(),
        TRANSACTION_LEVEL_STACK_HEIGHT,
        ThetisError::NotTopLevel
    );

    // Step 2: the facility lender's authority.
    let now = Clock::get()?.unix_timestamp;
    let facility = &accounts.facility;
    let loan = &accounts.loan;
    let authority = &accounts.authority;
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

    // Step 3: bindings. The target is exempt from the protocol rule; its row checks it.
    require!(
        facility.protocol == protocol_key && loan.protocol == protocol_key,
        ThetisError::WrongOrganisation
    );
    let loan_key = loan.key();
    require!(
        loan.facility == facility.key(),
        ThetisError::WrongOrganisation
    );

    // Step 5: refusals. Everything is computed into temporaries; nothing is written yet.
    require!(currency == facility.currency, ThetisError::CurrencyMismatch);
    let correction = purpose == PaymentPurpose::Correction;
    require!(
        nonzero_digest(&payment_id)
            && nonzero_digest(&evidence_digest)
            && observed_at <= now
            && (amount == 0) == correction,
        ThetisError::InvalidField
    );
    require!(
        accounts.target.is_none() || correction,
        ThetisError::InvalidField
    );
    let subject = &accounts.subject;
    let mut correcting = None;
    match purpose {
        PaymentPurpose::Repayment => {
            require_keys_eq!(subject.key(), loan_key, ThetisError::PaymentNotBound);
        }
        PaymentPurpose::Release => {
            require!(*subject.owner == crate::ID, ThetisError::PaymentNotBound);
            let intent = {
                let data = subject.try_borrow_data()?;
                ReleaseIntent::try_deserialize(&mut &data[..])
                    .map_err(|_| error!(ThetisError::PaymentNotBound))?
            };
            require!(
                intent.protocol == protocol_key && intent.loan == loan_key,
                ThetisError::PaymentNotBound
            );
        }
        PaymentPurpose::Correction => {
            let Some(target) = accounts.target.as_ref() else {
                return err!(ThetisError::PaymentNotBound);
            };
            require!(
                target.key() == subject.key()
                    && target.protocol == protocol_key
                    && target.lender == facility.lender
                    && target.loan == loan_key
                    && target.purpose != PaymentPurpose::Correction
                    && matches!(
                        target.status,
                        PaymentStatus::Unconsumed | PaymentStatus::Consumed
                    ),
                ThetisError::PaymentNotBound
            );
            correcting = Some(target.status);
        }
    }
    if !correction {
        require!(
            loan.status != LoanStatus::Closed,
            ThetisError::LoanNotActive
        );
    }
    // A consumed payment that is corrected becomes an exception on the loan.
    let exception = if correcting == Some(PaymentStatus::Consumed) {
        Some((
            loan.open_exceptions
                .checked_add(1)
                .ok_or(ThetisError::ArithmeticOverflow)?,
            loan.revision
                .checked_add(1)
                .ok_or(ThetisError::ArithmeticOverflow)?,
        ))
    } else {
        None
    };

    // Step 6: write and emit.
    let lender = facility.lender;
    let subject_key = subject.key();
    let payment_key = accounts.payment.key();
    accounts.payment.set_inner(PaymentAttestation {
        protocol: protocol_key,
        lender,
        loan: loan_key,
        payment_id,
        purpose,
        subject: subject_key,
        amount,
        currency,
        evidence_digest,
        observed_at,
        status: if correction {
            PaymentStatus::Consumed
        } else {
            PaymentStatus::Unconsumed
        },
        applied: 0,
        surplus: 0,
        bump: ctx.bumps.payment,
    });
    if correcting.is_none() {
        emit!(PaymentConfirmed {
            payment: payment_key,
            loan: loan_key,
            purpose,
            subject: subject_key,
            amount,
            currency,
        });
        return Ok(());
    }
    if let Some((open_exceptions, revision)) = exception {
        accounts.loan.open_exceptions = open_exceptions;
        accounts.loan.revision = revision;
    } else if let Some(target) = accounts.target.as_mut() {
        target.status = PaymentStatus::Voided;
    }
    emit!(PaymentCorrected {
        payment: payment_key,
        target: subject_key,
        loan: loan_key,
        voided: exception.is_none(),
        open_exceptions: accounts.loan.open_exceptions,
        loan_revision: accounts.loan.revision,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct Repay<'info> {
    pub signer: Signer<'info>,
    pub protocol: Box<Account<'info, Protocol>>,
    pub facility: Box<Account<'info, Facility>>,
    #[account(mut)]
    pub loan: Box<Account<'info, Loan>>,
    #[account(
        seeds = [b"authority", protocol.key().as_ref(), signer.key().as_ref()],
        bump = authority.bump,
    )]
    pub authority: Option<Box<Account<'info, Authority>>>,
    pub lender_org: Option<Box<Account<'info, Organisation>>>,
    #[account(mut)]
    pub payment: Option<Box<Account<'info, PaymentAttestation>>>,
    #[account(mut)]
    pub pool: Option<Box<Account<'info, SimulationPool>>>,
    /// CHECK: A pool slot, unused until the simulation branch checks it against the pool.
    pub pool_authority: Option<UncheckedAccount<'info>>,
    #[account(mut)]
    pub pool_vault: Option<Box<Account<'info, TokenAccount>>>,
    #[account(mut, dup)]
    pub payer_token: Option<Box<Account<'info, TokenAccount>>>,
    pub mint: Option<Box<Account<'info, Mint>>>,
    pub token_program: Option<Program<'info, Token>>,
}

/// Consumes one unconsumed `Repayment` attestation against the loan: interest first, then
/// principal. Any surplus stays on the consumed record. Neither the pause bits, the valuation,
/// the lot nor the loan's open exceptions are read, and the loan's status never changes.
pub fn repay(ctx: Context<Repay>, amount: u64) -> Result<()> {
    let accounts = ctx.accounts;
    let protocol = &accounts.protocol;
    let protocol_key = protocol.key();

    // Step 0: only the fiat adapter is built.
    require!(
        protocol.settlement_mode == SettlementMode::FiatAttestationTest,
        ThetisError::WrongSettlementMode
    );
    // Step 1: top level. Repaying is never paused.
    require_eq!(
        get_stack_height(),
        TRANSACTION_LEVEL_STACK_HEIGHT,
        ThetisError::NotTopLevel
    );
    // Step 1b: the fiat layout has the attestation, the authority and the organisation, and no
    // pool slot.
    let Some(payment) = accounts.payment.as_ref() else {
        return err!(ThetisError::PaymentMissing);
    };
    let (Some(authority), Some(lender_org)) =
        (accounts.authority.as_ref(), accounts.lender_org.as_ref())
    else {
        return err!(ThetisError::InvalidField);
    };
    require!(
        accounts.pool.is_none()
            && accounts.pool_authority.is_none()
            && accounts.pool_vault.is_none()
            && accounts.payer_token.is_none()
            && accounts.mint.is_none()
            && accounts.token_program.is_none(),
        ThetisError::InvalidField
    );

    // Step 2: the facility lender's authority.
    let now = Clock::get()?.unix_timestamp;
    let facility = &accounts.facility;
    let loan = &accounts.loan;
    require_keys_eq!(
        authority.wallet,
        accounts.signer.key(),
        ThetisError::WrongSigner
    );
    check_lending_authority(
        authority,
        protocol_key,
        facility.lender,
        Some(Role::Lender),
        lender_org,
        scope::LEND,
        now,
    )?;

    // Step 3: bindings. The attestation is exempt from the protocol rule; its refusals check it.
    require!(
        facility.protocol == protocol_key && loan.protocol == protocol_key,
        ThetisError::WrongOrganisation
    );
    let loan_key = loan.key();
    require!(
        loan.facility == facility.key(),
        ThetisError::WrongOrganisation
    );

    // Step 5: refusals.
    require!(
        loan.status != LoanStatus::Closed,
        ThetisError::LoanNotActive
    );
    require!(
        payment.status == PaymentStatus::Unconsumed,
        ThetisError::PaymentConsumed
    );
    require!(
        payment.protocol == protocol_key
            && payment.lender == facility.lender
            && payment.loan == loan_key
            && payment.purpose == PaymentPurpose::Repayment
            && payment.subject == loan_key,
        ThetisError::PaymentNotBound
    );
    require!(
        payment.currency == facility.currency,
        ThetisError::CurrencyMismatch
    );
    require!(amount == payment.amount, ThetisError::InvalidField);

    // Accrual, then the split. Nothing is written yet.
    let accrual = accrue(loan, now)?;
    let application = apply_payment(loan.principal, accrual.booked_interest, payment.amount)?;
    let revision = loan
        .revision
        .checked_add(1)
        .ok_or(ThetisError::ArithmeticOverflow)?;

    // Step 6: write and emit.
    let payment_key = payment.key();
    let loan = &mut accounts.loan;
    loan.booked_interest = application.booked_interest;
    loan.accrual_remainder = accrual.accrual_remainder;
    loan.accrued_at = accrual.accrued_at;
    loan.principal = application.principal;
    loan.revision = revision;
    let Some(payment) = accounts.payment.as_mut() else {
        return err!(ThetisError::PaymentMissing);
    };
    payment.status = PaymentStatus::Consumed;
    payment.applied = application.applied;
    payment.surplus = application.surplus;
    emit!(Repaid {
        loan: loan_key,
        payment: Some(payment_key),
        pool: None,
        pool_revision: None,
        applied: application.applied,
        from_interest: application.from_interest,
        from_principal: application.from_principal,
        surplus: application.surplus,
        principal: application.principal,
        booked_interest: application.booked_interest,
        revision,
    });
    Ok(())
}
