//! Loading at the terminal. The owner of a position at a terminal site signs a loading intent
//! that names the bill-of-lading digest and snapshots the whole position (quantity, locked
//! quantity, revision). Every lender whose loan holds a positive lock on the position accepts
//! the hand-off, one acceptance per loan. The owner and the terminal then sign the loading: the
//! position's receipts are burned, the site's occupancy is freed, and each accepted loan keeps
//! its debt as `ExternalHandoff` (or stays `Active` with a zero lock when it owes nothing). The
//! executed LoadingIntent is the hand-off record; the bill of lading never secures a loan.

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::get_associated_token_address_with_program_id,
    token_2022::{BurnChecked, Token2022},
    token_interface::Mint,
};

use crate::{
    error::ThetisError,
    events::{LoadingAccepted, LoadingIntentCreated, LoadingRecorded, LoanHandedOff},
    instructions::shipment::{add, check_custody_window, require_top_level, sub},
    intent::{
        message::{loading_intent_message, record_loading_message},
        verify::{check_ed25519_instruction, previous_instruction},
    },
    lending_math::accrue,
    receipts::{self, VAULT_AUTHORITY_SEED},
    state::*,
    validate::{check_lending_authority, nonzero_digest},
};

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct CreateLoadingIntent<'info> {
    #[account(mut)]
    pub sponsor: Signer<'info>,
    pub protocol: Box<Account<'info, Protocol>>,
    pub owner_org: Box<Account<'info, Organisation>>,
    pub owner_authority: Box<Account<'info, Authority>>,
    pub lot: Box<Account<'info, Lot>>,
    #[account(mut)]
    pub position: Box<Account<'info, Position>>,
    pub custodian_class: Box<Account<'info, CustodianClass>>,
    pub terminal_org: Box<Account<'info, Organisation>>,
    #[account(
        init,
        payer = sponsor,
        space = LoadingIntent::DISCRIMINATOR.len() + LoadingIntent::INIT_SPACE,
        seeds = [b"loading", position.key().as_ref(), &nonce.to_le_bytes()],
        bump,
    )]
    pub intent: Box<Account<'info, LoadingIntent>>,
    /// CHECK: The address constraint pins the Instructions sysvar.
    #[account(address = solana_sdk_ids::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn create_loading_intent(
    ctx: Context<CreateLoadingIntent>,
    nonce: u64,
    document_sha256: [u8; 32],
    expires_at: i64,
    expected_revision: u64,
    valid_until: i64,
) -> Result<()> {
    let accounts = ctx.accounts;
    let protocol = &accounts.protocol;
    let protocol_key = protocol.key();

    // Step 1: top level, then the pause bit.
    require_top_level()?;
    require!(
        protocol.pause_flags & pause::LOADING == 0,
        ThetisError::Paused
    );

    // Step 2: freshness and the custody signing window.
    let now = Clock::get()?.unix_timestamp;
    check_custody_window(now, valid_until)?;

    // Step 3: the owner's Authority, the protocol rule, then the bindings.
    let owner_org = &accounts.owner_org;
    let owner_authority = &accounts.owner_authority;
    let lot = &accounts.lot;
    let position = &accounts.position;
    let custodian_class = &accounts.custodian_class;
    let terminal_org = &accounts.terminal_org;
    check_lending_authority(
        owner_authority,
        protocol_key,
        position.owner,
        None,
        owner_org,
        scope::SHIP,
        now,
    )?;
    require!(
        owner_org.protocol == protocol_key
            && owner_authority.protocol == protocol_key
            && lot.protocol == protocol_key
            && position.protocol == protocol_key
            && custodian_class.protocol == protocol_key
            && terminal_org.protocol == protocol_key,
        ThetisError::WrongOrganisation
    );
    let lot_key = lot.key();
    let custodian_class_key = custodian_class.key();
    let terminal_key = terminal_org.key();
    require!(
        position.lot == lot_key
            && lot.custodian_class == custodian_class_key
            && custodian_class.custodian == terminal_key,
        ThetisError::WrongOrganisation
    );

    // Step 4: the position's revision.
    require_eq!(
        position.revision,
        expected_revision,
        ThetisError::StaleRevision
    );

    // Step 5: refusals, then the write computed into a temporary.
    require!(lot.state == LotState::Stored, ThetisError::LotNotStored);
    require!(
        lot.restriction == Restriction::Normal,
        ThetisError::Restricted
    );
    require!(terminal_org.role == Role::Terminal, ThetisError::WrongRole);
    require!(position.quantity_kg > 0, ThetisError::ZeroQuantity);
    require!(position.reserved_kg == 0, ThetisError::PositionCommitted);
    require!(
        nonzero_digest(&document_sha256) && expires_at > now,
        ThetisError::InvalidField
    );
    let position_revision = add(position.revision, 1)?;

    // Step 6: the owner signed this exact intent.
    let text = loading_intent_message(
        ctx.program_id,
        &protocol.instance_id,
        &lot.lot_id,
        position.quantity_kg,
        &owner_org.display_name,
        &terminal_org.display_name,
        &custodian_class.site_code,
        &document_sha256,
        nonce,
        expires_at,
        expected_revision,
        valid_until,
    );
    let verification = previous_instruction(&accounts.instructions)?;
    check_ed25519_instruction(&verification, &[owner_authority.wallet], &text)?;

    // Step 7: write and emit.
    let owner_key = owner_org.key();
    let quantity_kg = position.quantity_kg;
    let locked_kg = position.locked_kg;
    let position_key = position.key();
    let intent_key = accounts.intent.key();
    accounts.intent.set_inner(LoadingIntent {
        protocol: protocol_key,
        lot: lot_key,
        position: position_key,
        owner: owner_key,
        terminal: terminal_key,
        custodian_class: custodian_class_key,
        nonce,
        quantity_kg,
        locked_kg,
        document_sha256,
        position_revision,
        expires_at,
        status: LoadingStatus::Open,
        executed_at: None,
        bump: ctx.bumps.intent,
    });
    accounts.position.revision = position_revision;
    emit!(LoadingIntentCreated {
        intent: intent_key,
        lot: lot_key,
        position: position_key,
        owner: owner_key,
        terminal: terminal_key,
        quantity_kg,
        locked_kg,
        document_sha256,
        expires_at,
        position_revision,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct AcceptLoading<'info> {
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
    pub loan: Box<Account<'info, Loan>>,
    pub lock: Box<Account<'info, LockAllocation>>,
    pub lot: Box<Account<'info, Lot>>,
    pub position: Box<Account<'info, Position>>,
    pub intent: Box<Account<'info, LoadingIntent>>,
    #[account(
        init_if_needed,
        payer = payer,
        space = HandoffAcceptance::DISCRIMINATOR.len() + HandoffAcceptance::INIT_SPACE,
        seeds = [b"handoff", intent.key().as_ref(), loan.key().as_ref()],
        bump,
    )]
    pub acceptance: Box<Account<'info, HandoffAcceptance>>,
    pub system_program: Program<'info, System>,
}

pub fn accept_loading(ctx: Context<AcceptLoading>, expected_revision: u64) -> Result<()> {
    let accounts = ctx.accounts;
    let protocol_key = accounts.protocol.key();

    // Step 1: top level. Consent is never paused.
    require_top_level()?;

    // Step 2: the signing wallet's Authority, against the facility's own lender.
    let now = Clock::get()?.unix_timestamp;
    let authority = &accounts.authority;
    let lender_org = &accounts.lender_org;
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
        lender_org,
        scope::LEND,
        now,
    )?;

    // Step 3: the protocol rule (the acceptance is checked on reuse only), then the bindings.
    let loan = &accounts.loan;
    let lock = &accounts.lock;
    let lot = &accounts.lot;
    let position = &accounts.position;
    let intent = &accounts.intent;
    require!(
        authority.protocol == protocol_key
            && lender_org.protocol == protocol_key
            && facility.protocol == protocol_key
            && loan.protocol == protocol_key
            && lock.protocol == protocol_key
            && lot.protocol == protocol_key
            && position.protocol == protocol_key
            && intent.protocol == protocol_key,
        ThetisError::WrongOrganisation
    );
    let loan_key = loan.key();
    let position_key = position.key();
    let lot_key = lot.key();
    let intent_key = intent.key();
    require!(
        loan.facility == facility.key()
            && lock.loan == loan_key
            && lock.position == position_key
            && loan.position == position_key
            && intent.position == position_key
            && intent.lot == lot_key
            && position.lot == lot_key,
        ThetisError::WrongOrganisation
    );
    let acceptance = &accounts.acceptance;
    if acceptance.version != 0 {
        require!(
            acceptance.protocol == protocol_key
                && acceptance.intent == intent_key
                && acceptance.loan == loan_key,
            ThetisError::WrongOrganisation
        );
    }

    // Step 4: the loan's revision, then the position's against the intent's snapshot.
    require_eq!(loan.revision, expected_revision, ThetisError::StaleRevision);
    require_eq!(
        intent.position_revision,
        position.revision,
        ThetisError::StaleRevision
    );

    // Step 5: refusals, then the write computed into a temporary.
    require!(
        intent.status == LoadingStatus::Open,
        ThetisError::LoadingNotOpen
    );
    require!(now < intent.expires_at, ThetisError::LoadingExpired);
    require!(
        loan.status == LoanStatus::Active,
        ThetisError::LoanNotActive
    );
    require!(loan.open_exceptions == 0, ThetisError::LoanUnderException);
    require!(lock.quantity_kg > 0, ThetisError::InsufficientLocked);
    require!(lot.state == LotState::Stored, ThetisError::LotNotStored);
    require!(
        lot.restriction == Restriction::Normal,
        ThetisError::Restricted
    );
    let version = acceptance
        .version
        .checked_add(1)
        .ok_or(ThetisError::ArithmeticOverflow)?;

    // Step 6: write and emit.
    let lock_key = lock.key();
    let lender_key = lender_org.key();
    let lock_quantity_kg = lock.quantity_kg;
    let loan_revision = loan.revision;
    let principal = loan.principal;
    let booked_interest = loan.booked_interest;
    let acceptance_key = accounts.acceptance.key();
    let acceptance = &mut accounts.acceptance;
    if acceptance.version == 0 {
        acceptance.protocol = protocol_key;
        acceptance.intent = intent_key;
        acceptance.loan = loan_key;
        acceptance.bump = ctx.bumps.acceptance;
    }
    acceptance.lock = lock_key;
    acceptance.lender = lender_key;
    acceptance.lock_quantity_kg = lock_quantity_kg;
    acceptance.loan_revision = loan_revision;
    acceptance.principal = principal;
    acceptance.booked_interest = booked_interest;
    acceptance.accepted_at = now;
    acceptance.version = version;
    emit!(LoadingAccepted {
        acceptance: acceptance_key,
        intent: intent_key,
        loan: loan_key,
        lender: lender_key,
        lock_quantity_kg,
        loan_revision,
        principal,
        booked_interest,
        version,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct RecordLoading<'info> {
    #[account(mut)]
    pub sponsor: Signer<'info>,
    pub protocol: Box<Account<'info, Protocol>>,
    pub owner_org: Box<Account<'info, Organisation>>,
    pub owner_authority: Box<Account<'info, Authority>>,
    pub terminal_org: Box<Account<'info, Organisation>>,
    pub terminal_authority: Box<Account<'info, Authority>>,
    #[account(mut)]
    pub custodian_class: Box<Account<'info, CustodianClass>>,
    #[account(mut)]
    pub lot: Box<Account<'info, Lot>>,
    // The handler rejects aliasing with RootMismatch before either lot is written.
    #[account(mut, dup)]
    pub root: Option<Box<Account<'info, Lot>>>,
    #[account(mut)]
    pub intake: Box<Account<'info, IntakeIdentity>>,
    #[account(mut, seeds = [b"mint", lot.key().as_ref()], bump)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub position: Box<Account<'info, Position>>,
    /// CHECK: The seeds identify the vault's token authority.
    #[account(seeds = [VAULT_AUTHORITY_SEED, position.key().as_ref()], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    /// CHECK: The address is canonical and Token-2022 validates it during the burn.
    #[account(
        mut,
        address = get_associated_token_address_with_program_id(
            &vault_authority.key(), &mint.key(), &token_program.key(),
        ),
    )]
    pub vault: UncheckedAccount<'info>,
    #[account(mut)]
    pub intent: Box<Account<'info, LoadingIntent>>,
    /// CHECK: The address constraint pins the Instructions sysvar.
    #[account(address = solana_sdk_ids::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token2022>,
}

/// One accepted loan of a loading, checked and computed before anything is written.
struct HandOff<'info> {
    loan: Account<'info, Loan>,
    lock: Account<'info, LockAllocation>,
    released_kg: u64,
    booked_interest: u64,
    accrual_remainder: u64,
    external_handoff: bool,
    revision: u64,
}

pub fn record_loading<'info>(
    ctx: Context<'info, RecordLoading<'info>>,
    expected_revision: u64,
    valid_until: i64,
) -> Result<()> {
    let remaining = ctx.remaining_accounts;
    let program_id = ctx.program_id;
    let accounts = ctx.accounts;
    let protocol = &accounts.protocol;
    let protocol_key = protocol.key();

    // Step 1: top level, then the pause bit.
    require_top_level()?;
    require!(
        protocol.pause_flags & pause::LOADING == 0,
        ThetisError::Paused
    );

    // Step 2: freshness and the custody signing window.
    let now = Clock::get()?.unix_timestamp;
    check_custody_window(now, valid_until)?;

    // Step 3: the owner's and the terminal's Authorities, against the intent's parties.
    let owner_org = &accounts.owner_org;
    let owner_authority = &accounts.owner_authority;
    let terminal_org = &accounts.terminal_org;
    let terminal_authority = &accounts.terminal_authority;
    let intent = &accounts.intent;
    check_lending_authority(
        owner_authority,
        protocol_key,
        intent.owner,
        None,
        owner_org,
        scope::SHIP,
        now,
    )?;
    check_lending_authority(
        terminal_authority,
        protocol_key,
        intent.terminal,
        Some(Role::Terminal),
        terminal_org,
        scope::LOAD,
        now,
    )?;

    // Step 4: the protocol rule (the root and the triples are checked where they are read),
    // then the bindings.
    let custodian_class = &accounts.custodian_class;
    let lot = &accounts.lot;
    let intake = &accounts.intake;
    let position = &accounts.position;
    require!(
        owner_org.protocol == protocol_key
            && owner_authority.protocol == protocol_key
            && terminal_org.protocol == protocol_key
            && terminal_authority.protocol == protocol_key
            && custodian_class.protocol == protocol_key
            && lot.protocol == protocol_key
            && intake.protocol == protocol_key
            && position.protocol == protocol_key
            && intent.protocol == protocol_key,
        ThetisError::WrongOrganisation
    );
    let lot_key = lot.key();
    let position_key = position.key();
    let custodian_class_key = custodian_class.key();
    let owner_key = owner_org.key();
    let terminal_key = terminal_org.key();
    require!(
        intent.position == position_key
            && intent.lot == lot_key
            && position.lot == lot_key
            && position.owner == owner_key
            && lot.custodian_class == custodian_class_key
            && intent.custodian_class == custodian_class_key
            && custodian_class.custodian == terminal_key
            && lot.mint == accounts.mint.key()
            && intake.key() == lot.intake
            && intake.lot == lot.root,
        ThetisError::WrongOrganisation
    );
    // The intake is the issuing custodian's PDA, wherever the lot is now.
    let intake_address = Pubkey::create_program_address(
        &[
            b"intake",
            protocol_key.as_ref(),
            intake.custodian.as_ref(),
            &intake.intake_digest,
            &[intake.bump],
        ],
        program_id,
    )
    .map_err(|_| error!(ThetisError::WrongOrganisation))?;
    require_keys_eq!(intake.key(), intake_address, ThetisError::WrongOrganisation);

    // Step 5: the position's revision, then the intent's snapshot of it, then the root.
    require_eq!(
        position.revision,
        expected_revision,
        ThetisError::StaleRevision
    );
    require_eq!(
        intent.position_revision,
        position.revision,
        ThetisError::StaleRevision
    );
    match (lot.parent, accounts.root.as_ref()) {
        (None, None) => {}
        (Some(_), Some(root)) => require!(
            root.key() != lot_key && root.key() == lot.root && root.protocol == protocol_key,
            ThetisError::RootMismatch
        ),
        _ => return err!(ThetisError::RootMismatch),
    }

    // Step 6: refusals, then the lot, site and family writes computed into temporaries.
    require!(
        intent.status == LoadingStatus::Open,
        ThetisError::LoadingNotOpen
    );
    require!(now < intent.expires_at, ThetisError::LoadingExpired);
    require!(lot.state == LotState::Stored, ThetisError::LotNotStored);
    require!(
        lot.restriction == Restriction::Normal,
        ThetisError::Restricted
    );
    require!(position.quantity_kg > 0, ThetisError::ZeroQuantity);
    let quantity_kg = position.quantity_kg;
    let supply_after = sub(lot.supply_kg, quantity_kg)?;
    let occupied_after = sub(custodian_class.occupied_kg, quantity_kg)?;
    let position_revision = add(position.revision, 1)?;
    let lot_revision = add(lot.revision, 1)?;
    let (root_live_children, retire) = receipts::family_after(
        supply_after,
        lot.live_children,
        accounts
            .root
            .as_ref()
            .map(|root| (root.supply_kg, root.live_children)),
    )?;

    // Step 7: the accepted loans, one triple (acceptance, loan, lock) each.
    require!(
        remaining.len() % 3 == 0 && remaining.len() / 3 <= MAX_LOADING_LOANS,
        ThetisError::InvalidField
    );
    let intent_key = intent.key();
    let mut hand_offs: Vec<HandOff<'info>> = Vec::with_capacity(remaining.len() / 3);
    let mut accepted_kg: u64 = 0;
    let mut previous_loan: Option<Pubkey> = None;
    for triple in remaining.chunks_exact(3) {
        let (acceptance_info, loan_info, lock_info) = (&triple[0], &triple[1], &triple[2]);
        require!(
            loan_info.is_writable && lock_info.is_writable,
            ThetisError::InvalidField
        );
        let acceptance = Account::<HandoffAcceptance>::try_from(acceptance_info)
            .map_err(|_| error!(ThetisError::AcceptanceMissing))?;
        let loan = Account::<Loan>::try_from(loan_info)
            .map_err(|_| error!(ThetisError::AcceptanceMissing))?;
        let lock = Account::<LockAllocation>::try_from(lock_info)
            .map_err(|_| error!(ThetisError::AcceptanceMissing))?;
        require!(
            acceptance.protocol == protocol_key
                && loan.protocol == protocol_key
                && lock.protocol == protocol_key
                && acceptance.intent == intent_key
                && acceptance.loan == loan.key()
                && acceptance.lock == lock.key()
                && lock.loan == loan.key()
                && lock.position == position_key,
            ThetisError::AcceptanceMissing
        );
        if let Some(previous) = previous_loan {
            require!(loan.key() > previous, ThetisError::InvalidField);
        }
        previous_loan = Some(loan.key());
        require!(
            loan.status == LoanStatus::Active,
            ThetisError::LoanNotActive
        );
        require!(loan.open_exceptions == 0, ThetisError::LoanUnderException);
        require!(
            acceptance.loan_revision == loan.revision
                && acceptance.lock_quantity_kg == lock.quantity_kg,
            ThetisError::AcceptanceStale
        );
        require!(lock.quantity_kg > 0, ThetisError::InsufficientLocked);
        let accrual = accrue(&loan, now)?;
        // A debt Phase 2's repay could not process is never handed off.
        loan.principal
            .checked_add(accrual.booked_interest)
            .ok_or(ThetisError::ArithmeticOverflow)?;
        let revision = add(loan.revision, 1)?;
        accepted_kg = add(accepted_kg, lock.quantity_kg)?;
        hand_offs.push(HandOff {
            released_kg: lock.quantity_kg,
            booked_interest: accrual.booked_interest,
            accrual_remainder: accrual.accrual_remainder,
            external_handoff: loan.principal > 0 || accrual.booked_interest > 0,
            revision,
            loan,
            lock,
        });
    }
    // Locks partition the locked quantity, so a lender who has not accepted leaves it short.
    require_eq!(
        accepted_kg,
        position.locked_kg,
        ThetisError::AcceptanceMissing
    );
    let loans_accepted =
        u8::try_from(hand_offs.len()).map_err(|_| error!(ThetisError::InvalidField))?;

    // Step 8: the owner and the terminal signed this exact loading, the owner first.
    let text = record_loading_message(
        program_id,
        &protocol.instance_id,
        &lot.lot_id,
        intent.quantity_kg,
        &owner_org.display_name,
        &terminal_org.display_name,
        &intent.document_sha256,
        intent.nonce,
        intent.locked_kg,
        loans_accepted,
        expected_revision,
        valid_until,
    );
    let verification = previous_instruction(&accounts.instructions)?;
    check_ed25519_instruction(
        &verification,
        &[owner_authority.wallet, terminal_authority.wallet],
        &text,
    )?;

    // Step 9: burn, write, check balances, emit.
    receipts::burn_receipts(
        accounts.token_program.key(),
        BurnChecked {
            mint: accounts.mint.to_account_info(),
            from: accounts.vault.to_account_info(),
            authority: accounts.vault_authority.to_account_info(),
        },
        ctx.bumps.vault_authority,
        position_key,
        quantity_kg,
    )?;
    let position = &mut accounts.position;
    position.quantity_kg = 0;
    position.locked_kg = 0;
    position.revision = position_revision;
    let lot = &mut accounts.lot;
    lot.supply_kg = supply_after;
    lot.revision = lot_revision;
    accounts.custodian_class.occupied_kg = occupied_after;
    let lot_loaded = supply_after == 0;
    if lot_loaded {
        lot.state = LotState::Loaded;
    }
    receipts::apply_family(
        accounts.root.as_deref_mut().map(|root| &mut **root),
        &mut accounts.intake,
        root_live_children,
        retire,
    );
    for hand_off in &mut hand_offs {
        let loan = &mut hand_off.loan;
        loan.booked_interest = hand_off.booked_interest;
        loan.accrual_remainder = hand_off.accrual_remainder;
        loan.accrued_at = now;
        if hand_off.external_handoff {
            loan.status = LoanStatus::ExternalHandoff;
        }
        loan.revision = hand_off.revision;
        hand_off.lock.quantity_kg = 0;
        loan.exit(&crate::ID)?;
        hand_off.lock.exit(&crate::ID)?;
    }
    let intent = &mut accounts.intent;
    intent.status = LoadingStatus::Executed;
    intent.executed_at = Some(now);

    receipts::check_vault_balance(&accounts.vault, 0)?;
    accounts.mint.reload()?;
    require_eq!(
        accounts.mint.supply,
        supply_after,
        ThetisError::BalanceMismatch
    );
    emit!(LoadingRecorded {
        intent: intent_key,
        lot: lot_key,
        position: position_key,
        owner: owner_key,
        terminal: terminal_key,
        quantity_kg,
        document_sha256: intent.document_sha256,
        loans_accepted,
        lot_loaded,
        lot_revision,
        position_revision,
    });
    for hand_off in &hand_offs {
        emit!(LoanHandedOff {
            loan: hand_off.loan.key(),
            intent: intent_key,
            released_kg: hand_off.released_kg,
            principal: hand_off.loan.principal,
            booked_interest: hand_off.booked_interest,
            external_handoff: hand_off.external_handoff,
            revision: hand_off.revision,
        });
    }
    Ok(())
}
