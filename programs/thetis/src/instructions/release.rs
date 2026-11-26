use anchor_lang::{
    prelude::*,
    solana_program::instruction::{get_stack_height, TRANSACTION_LEVEL_STACK_HEIGHT},
};
use anchor_spl::{
    associated_token::{get_associated_token_address_with_program_id, AssociatedToken, Create},
    token_2022::{Token2022, TransferChecked},
    token_interface::Mint,
};

use crate::{
    error::ThetisError,
    events::{PledgedSold, ReleaseIntentCreated},
    intent::{
        message::{buy_pledged_message, release_intent_message},
        verify::{check_ed25519_instruction, previous_instruction},
    },
    lending_math::{accrue, apply_payment, release_preview},
    receipts::{self, VAULT_AUTHORITY_SEED},
    state::*,
    validate::{check_lending_authority, MONEY_WINDOW_SECS},
};

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct CreateReleaseIntent<'info> {
    #[account(mut)]
    pub sponsor: Signer<'info>,
    pub protocol: Box<Account<'info, Protocol>>,
    pub seller_org: Box<Account<'info, Organisation>>,
    pub seller_authority: Box<Account<'info, Authority>>,
    pub buyer_org: Box<Account<'info, Organisation>>,
    pub lender_org: Box<Account<'info, Organisation>>,
    pub facility: Box<Account<'info, Facility>>,
    pub loan: Box<Account<'info, Loan>>,
    pub lock: Box<Account<'info, LockAllocation>>,
    pub lot: Box<Account<'info, Lot>>,
    pub position: Box<Account<'info, Position>>,
    #[account(
        init,
        payer = sponsor,
        space = ReleaseIntent::DISCRIMINATOR.len() + ReleaseIntent::INIT_SPACE,
        seeds = [b"release", loan.key().as_ref(), nonce.to_le_bytes().as_ref()],
        bump,
    )]
    pub intent: Box<Account<'info, ReleaseIntent>>,
    /// CHECK: The address constraint pins the Instructions sysvar.
    #[account(address = solana_sdk_ids::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Records the seller's signed terms for selling part of a pledged lot. The terms never change.
/// Nothing is reserved: the sale is checked against the debt and collateral when it executes.
#[allow(
    clippy::too_many_arguments,
    reason = "the arguments are the signed intent's terms"
)]
pub fn create_release_intent(
    ctx: Context<CreateReleaseIntent>,
    nonce: u64,
    quantity_kg: u64,
    price: u64,
    top_up: u64,
    expires_at: i64,
    expected_revision: u64,
    valid_until: i64,
) -> Result<()> {
    let accounts = ctx.accounts;
    let protocol = &accounts.protocol;
    let protocol_key = protocol.key();

    // Step 0: a release is a fiat-mode action.
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
        protocol.pause_flags & pause::RELEASE == 0,
        ThetisError::Paused
    );

    // Step 2: freshness and the money signing window.
    let now = Clock::get()?.unix_timestamp;
    require!(now <= valid_until, ThetisError::Expired);
    let window = valid_until
        .checked_sub(now)
        .ok_or(ThetisError::WindowTooLong)?;
    require!(window <= MONEY_WINDOW_SECS, ThetisError::WindowTooLong);

    // Step 3: the seller, then the protocol fields, then the bindings.
    let seller_org = &accounts.seller_org;
    let buyer_org = &accounts.buyer_org;
    let lender_org = &accounts.lender_org;
    let facility = &accounts.facility;
    let loan = &accounts.loan;
    let lock = &accounts.lock;
    let lot = &accounts.lot;
    let position = &accounts.position;
    let seller_authority = &accounts.seller_authority;
    check_lending_authority(
        seller_authority,
        protocol_key,
        loan.borrower,
        Some(Role::Exporter),
        seller_org,
        scope::PLEDGE,
        now,
    )?;
    require!(
        position.owner == loan.borrower,
        ThetisError::WrongOrganisation
    );
    require!(
        lender_org.protocol == protocol_key
            && facility.protocol == protocol_key
            && loan.protocol == protocol_key
            && lock.protocol == protocol_key
            && lot.protocol == protocol_key
            && position.protocol == protocol_key,
        ThetisError::WrongOrganisation
    );
    let loan_key = loan.key();
    let position_key = position.key();
    let lot_key = lot.key();
    require!(
        facility.lender == lender_org.key()
            && loan.facility == facility.key()
            && loan.position == position_key
            && lock.loan == loan_key
            && lock.position == position_key
            && lot_key == loan.lot
            && position.lot == lot_key,
        ThetisError::WrongOrganisation
    );

    // Step 4: the position's revision.
    require_eq!(
        position.revision,
        expected_revision,
        ThetisError::StaleRevision
    );

    // Step 5: refusals.
    require!(
        loan.status == LoanStatus::Active,
        ThetisError::LoanNotActive
    );
    require!(loan.open_exceptions == 0, ThetisError::LoanUnderException);
    require!(lot.state == LotState::Stored, ThetisError::LotNotStored);
    require!(
        lot.restriction == Restriction::Normal,
        ThetisError::Restricted
    );
    require!(position.reserved_kg == 0, ThetisError::PositionCommitted);
    require!(
        buyer_org.protocol == protocol_key && buyer_org.role == Role::Buyer,
        ThetisError::RecipientNotApproved
    );
    require!(
        buyer_org.key() != seller_org.key(),
        ThetisError::InvalidField
    );
    require!(quantity_kg > 0, ThetisError::ZeroQuantity);
    require!(
        quantity_kg <= lock.quantity_kg,
        ThetisError::InsufficientLocked
    );
    require!(price > 0 && expires_at > now, ThetisError::InvalidField);
    price
        .checked_add(top_up)
        .ok_or(ThetisError::ArithmeticOverflow)?;

    // Step 6: the seller signed these exact terms.
    let text = release_intent_message(
        ctx.program_id,
        &protocol.instance_id,
        &lot.lot_id,
        quantity_kg,
        &seller_org.display_name,
        &buyer_org.display_name,
        &lender_org.display_name,
        &facility.facility_id,
        loan.index,
        nonce,
        price,
        top_up,
        &facility.currency,
        facility.currency_decimals,
        expires_at,
        expected_revision,
        valid_until,
    );
    let verification = previous_instruction(&accounts.instructions)?;
    check_ed25519_instruction(&verification, &[seller_authority.wallet], &text)?;

    // Step 7: write and emit.
    let intent_key = accounts.intent.key();
    let seller = seller_org.key();
    let buyer = buyer_org.key();
    let currency = facility.currency;
    let position_revision = position.revision;
    accounts.intent.set_inner(ReleaseIntent {
        protocol: protocol_key,
        loan: loan_key,
        lot: lot_key,
        position: position_key,
        seller,
        buyer,
        nonce,
        quantity_kg,
        price,
        top_up,
        currency,
        expires_at,
        position_revision,
        status: IntentStatus::Open,
        bump: ctx.bumps.intent,
    });
    emit!(ReleaseIntentCreated {
        intent: intent_key,
        loan: loan_key,
        seller,
        buyer,
        quantity_kg,
        price,
        top_up,
        expires_at,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct SellPledged<'info> {
    #[account(mut)]
    pub sponsor: Signer<'info>,
    pub protocol: Box<Account<'info, Protocol>>,
    pub facility: Box<Account<'info, Facility>>,
    pub lender_org: Box<Account<'info, Organisation>>,
    #[account(mut)]
    pub loan: Box<Account<'info, Loan>>,
    #[account(mut)]
    pub lock: Box<Account<'info, LockAllocation>>,
    pub valuation: Box<Account<'info, Valuation>>,
    #[account(mut)]
    pub intent: Box<Account<'info, ReleaseIntent>>,
    #[account(mut)]
    pub payment: Box<Account<'info, PaymentAttestation>>,
    #[account(mut)]
    pub lot: Box<Account<'info, Lot>>,
    #[account(seeds = [b"mint", lot.key().as_ref()], bump)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub seller_org: Box<Account<'info, Organisation>>,
    pub buyer_org: Box<Account<'info, Organisation>>,
    pub buyer_authority: Box<Account<'info, Authority>>,
    #[account(mut)]
    pub seller_position: Box<Account<'info, Position>>,
    /// CHECK: The seeds identify the source vault's token authority.
    #[account(seeds = [VAULT_AUTHORITY_SEED, seller_position.key().as_ref()], bump)]
    pub seller_vault_authority: UncheckedAccount<'info>,
    /// CHECK: The address is canonical and Token-2022 validates it during the transfer.
    #[account(
        mut,
        address = get_associated_token_address_with_program_id(
            &seller_vault_authority.key(), &mint.key(), &token_program.key(),
        ),
    )]
    pub seller_vault: UncheckedAccount<'info>,
    // Allow the handler to reject a sale to the seller's own position with InvalidField.
    #[account(
        init_if_needed,
        dup,
        payer = sponsor,
        space = Position::DISCRIMINATOR.len() + Position::INIT_SPACE,
        seeds = [b"position", lot.key().as_ref(), buyer_org.key().as_ref()],
        bump,
    )]
    pub buyer_position: Box<Account<'info, Position>>,
    /// CHECK: The seeds identify the destination vault's token authority.
    #[account(seeds = [VAULT_AUTHORITY_SEED, buyer_position.key().as_ref()], bump)]
    pub buyer_vault_authority: UncheckedAccount<'info>,
    /// CHECK: The address is canonical and the associated token program creates or validates it.
    #[account(
        mut,
        address = get_associated_token_address_with_program_id(
            &buyer_vault_authority.key(), &mint.key(), &token_program.key(),
        ),
    )]
    pub buyer_vault: UncheckedAccount<'info>,
    /// CHECK: The address constraint pins the Instructions sysvar.
    #[account(address = solana_sdk_ids::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Executes an open release intent the buyer accepts, against the lender's confirmed payment:
/// the units move to the buyer, the payment is applied to the loan (interest first), and the
/// sale is refused unless the debt left fits the limit on the collateral left.
pub fn sell_pledged(
    ctx: Context<SellPledged>,
    expected_revision: u64,
    valid_until: i64,
) -> Result<()> {
    let accounts = ctx.accounts;
    let protocol = &accounts.protocol;
    let protocol_key = protocol.key();

    // Step 0: a release is a fiat-mode action.
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
        protocol.pause_flags & pause::RELEASE == 0,
        ThetisError::Paused
    );

    // Step 2: freshness and the money signing window.
    let now = Clock::get()?.unix_timestamp;
    require!(now <= valid_until, ThetisError::Expired);
    let window = valid_until
        .checked_sub(now)
        .ok_or(ThetisError::WindowTooLong)?;
    require!(window <= MONEY_WINDOW_SECS, ThetisError::WindowTooLong);

    // The intent's own state, before any revision or binding.
    let intent = &accounts.intent;
    require!(
        intent.status == IntentStatus::Open,
        ThetisError::IntentNotOpen
    );
    require!(now < intent.expires_at, ThetisError::IntentExpired);

    // Step 3: the buyer, then the protocol fields, then the bindings.
    let facility = &accounts.facility;
    let lender_org = &accounts.lender_org;
    let loan = &accounts.loan;
    let lock = &accounts.lock;
    let lot = &accounts.lot;
    let seller_org = &accounts.seller_org;
    let buyer_org = &accounts.buyer_org;
    let buyer_authority = &accounts.buyer_authority;
    let seller_position = &accounts.seller_position;
    let buyer_position = &accounts.buyer_position;
    check_lending_authority(
        buyer_authority,
        protocol_key,
        intent.buyer,
        Some(Role::Buyer),
        buyer_org,
        scope::BUY,
        now,
    )?;
    let new_position = buyer_position.lot == Pubkey::default();
    require!(
        facility.protocol == protocol_key
            && lender_org.protocol == protocol_key
            && loan.protocol == protocol_key
            && lock.protocol == protocol_key
            && intent.protocol == protocol_key
            && lot.protocol == protocol_key
            && seller_org.protocol == protocol_key
            && seller_position.protocol == protocol_key
            && (new_position || buyer_position.protocol == protocol_key),
        ThetisError::WrongOrganisation
    );
    let loan_key = loan.key();
    let lot_key = lot.key();
    let seller_position_key = seller_position.key();
    let buyer_position_key = buyer_position.key();
    require!(
        intent.loan == loan_key
            && loan.facility == facility.key()
            && facility.lender == lender_org.key()
            && lock.loan == loan_key
            && lock.position == loan.position
            && loan.position == intent.position
            && intent.position == seller_position_key
            && intent.lot == lot_key
            && lot_key == seller_position.lot
            && loan.lot == lot_key
            && intent.seller == seller_org.key()
            && seller_org.key() == seller_position.owner
            && seller_position.owner == loan.borrower,
        ThetisError::WrongOrganisation
    );
    require!(
        buyer_position_key != seller_position_key,
        ThetisError::InvalidField
    );
    require!(
        new_position || (buyer_position.lot == lot_key && buyer_position.owner == buyer_org.key()),
        ThetisError::WrongOrganisation
    );

    // Step 4: the seller position's revision, and the one the intent was signed against.
    require!(
        expected_revision == seller_position.revision
            && expected_revision == intent.position_revision,
        ThetisError::StaleRevision
    );

    // Step 5: refusals. Everything is computed into temporaries; nothing is written yet.
    require!(
        loan.status == LoanStatus::Active,
        ThetisError::LoanNotActive
    );
    require!(loan.open_exceptions == 0, ThetisError::LoanUnderException);
    require!(lot.state == LotState::Stored, ThetisError::LotNotStored);
    require!(
        lot.restriction == Restriction::Normal,
        ThetisError::Restricted
    );
    require!(
        seller_position.reserved_kg == 0,
        ThetisError::PositionCommitted
    );
    let payment = &accounts.payment;
    require!(
        payment.status == PaymentStatus::Unconsumed,
        ThetisError::PaymentConsumed
    );
    let expected_amount = intent
        .price
        .checked_add(intent.top_up)
        .ok_or(ThetisError::ArithmeticOverflow)?;
    let intent_key = intent.key();
    require!(
        payment.protocol == protocol_key
            && payment.lender == facility.lender
            && payment.loan == loan_key
            && payment.purpose == PaymentPurpose::Release
            && payment.subject == intent_key
            && payment.amount == expected_amount,
        ThetisError::PaymentNotBound
    );
    require!(
        payment.currency == facility.currency && intent.currency == facility.currency,
        ThetisError::CurrencyMismatch
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
    let quantity_kg = intent.quantity_kg;
    require!(
        quantity_kg <= lock.quantity_kg && quantity_kg <= seller_position.locked_kg,
        ThetisError::InsufficientLocked
    );
    let accrual = accrue(loan, now)?;
    let preview = release_preview(
        loan.principal,
        accrual.booked_interest,
        0,
        intent.price,
        intent.top_up,
        lock.quantity_kg,
        quantity_kg,
        valuation.value_per_kg,
        u64::from(valuation.haircut_bps),
        u64::from(facility.max_ltv_bps),
    )?;
    require!(preview.allowed, ThetisError::ResidualOverLimit);
    let application = apply_payment(loan.principal, accrual.booked_interest, payment.amount)?;

    let lock_quantity = lock
        .quantity_kg
        .checked_sub(quantity_kg)
        .ok_or(ThetisError::ArithmeticOverflow)?;
    let seller_quantity = seller_position
        .quantity_kg
        .checked_sub(quantity_kg)
        .ok_or(ThetisError::ArithmeticOverflow)?;
    let seller_locked = seller_position
        .locked_kg
        .checked_sub(quantity_kg)
        .ok_or(ThetisError::ArithmeticOverflow)?;
    let buyer_quantity = if new_position {
        quantity_kg
    } else {
        buyer_position
            .quantity_kg
            .checked_add(quantity_kg)
            .ok_or(ThetisError::ArithmeticOverflow)?
    };
    let lot_revision = lot
        .revision
        .checked_add(1)
        .ok_or(ThetisError::ArithmeticOverflow)?;
    let seller_revision = seller_position
        .revision
        .checked_add(1)
        .ok_or(ThetisError::ArithmeticOverflow)?;
    let loan_revision = loan
        .revision
        .checked_add(1)
        .ok_or(ThetisError::ArithmeticOverflow)?;
    let buyer_revision = if new_position {
        0
    } else {
        buyer_position
            .revision
            .checked_add(1)
            .ok_or(ThetisError::ArithmeticOverflow)?
    };

    // Step 6: the buyer signed these exact terms.
    let text = buy_pledged_message(
        ctx.program_id,
        &protocol.instance_id,
        &lot.lot_id,
        quantity_kg,
        &seller_org.display_name,
        &buyer_org.display_name,
        &lender_org.display_name,
        &facility.facility_id,
        loan.index,
        intent.nonce,
        intent.price,
        intent.top_up,
        &facility.currency,
        facility.currency_decimals,
        expected_revision,
        valid_until,
    );
    let verification = previous_instruction(&accounts.instructions)?;
    check_ed25519_instruction(&verification, &[buyer_authority.wallet], &text)?;

    // Step 7: move the units, write and emit.
    let payment_key = payment.key();
    let buyer_key = buyer_org.key();
    receipts::create_vault(
        accounts.associated_token_program.key(),
        Create {
            payer: accounts.sponsor.to_account_info(),
            associated_token: accounts.buyer_vault.to_account_info(),
            authority: accounts.buyer_vault_authority.to_account_info(),
            mint: accounts.mint.to_account_info(),
            system_program: accounts.system_program.to_account_info(),
            token_program: accounts.token_program.to_account_info(),
        },
    )?;
    receipts::transfer_receipts(
        accounts.token_program.key(),
        TransferChecked {
            from: accounts.seller_vault.to_account_info(),
            mint: accounts.mint.to_account_info(),
            to: accounts.buyer_vault.to_account_info(),
            authority: accounts.seller_vault_authority.to_account_info(),
        },
        ctx.bumps.seller_vault_authority,
        seller_position_key,
        quantity_kg,
    )?;

    let loan = &mut accounts.loan;
    loan.booked_interest = application.booked_interest;
    loan.accrual_remainder = accrual.accrual_remainder;
    loan.accrued_at = accrual.accrued_at;
    loan.principal = application.principal;
    loan.revision = loan_revision;
    accounts.lock.quantity_kg = lock_quantity;
    let seller_position = &mut accounts.seller_position;
    seller_position.quantity_kg = seller_quantity;
    seller_position.locked_kg = seller_locked;
    seller_position.revision = seller_revision;
    let buyer_position = &mut accounts.buyer_position;
    if new_position {
        buyer_position.set_inner(Position {
            protocol: protocol_key,
            lot: lot_key,
            owner: buyer_key,
            quantity_kg: buyer_quantity,
            locked_kg: 0,
            reserved_kg: 0,
            revision: buyer_revision,
            bump: ctx.bumps.buyer_position,
        });
    } else {
        buyer_position.quantity_kg = buyer_quantity;
        buyer_position.revision = buyer_revision;
    }
    accounts.lot.revision = lot_revision;
    accounts.intent.status = IntentStatus::Executed;
    accounts.payment.status = PaymentStatus::Consumed;
    accounts.payment.applied = application.applied;
    accounts.payment.surplus = application.surplus;

    receipts::check_vault_balance(&accounts.seller_vault, accounts.seller_position.quantity_kg)?;
    receipts::check_vault_balance(&accounts.buyer_vault, accounts.buyer_position.quantity_kg)?;
    emit!(PledgedSold {
        intent: intent_key,
        loan: loan_key,
        payment: payment_key,
        lot: lot_key,
        seller_position: seller_position_key,
        buyer_position: buyer_position_key,
        quantity_kg,
        applied: application.applied,
        surplus: application.surplus,
        principal: application.principal,
        booked_interest: application.booked_interest,
        lot_revision,
        revision: loan_revision,
    });
    Ok(())
}
