//! The devnet token simulation: the admin opens one pool per instance, lenders deposit and
//! withdraw test tokens against 1:1 shares keyed by their organisation, a borrower draws on the
//! facility lender's own deposits with a signed text, and any wallet repays a simulated loan.
//! This is a labelled test simulation, never real yield, lending capital or recovery.

use anchor_lang::{
    prelude::*,
    solana_program::instruction::{get_stack_height, TRANSACTION_LEVEL_STACK_HEIGHT},
};
use anchor_spl::{
    associated_token::{get_associated_token_address, AssociatedToken, Create},
    token::{self, spl_token, Mint, Token, TokenAccount, TransferChecked},
};

use super::payment::Repay;
use crate::{
    error::ThetisError,
    events::{Borrowed, Deposited, PoolOpened, Repaid, Withdrawn},
    intent::{
        message::borrow_message,
        verify::{check_ed25519_instruction, previous_instruction},
    },
    lending_math::{accrue, apply_payment, release_preview},
    receipts,
    state::*,
    validate::{check_lending_authority, valid_currency, MONEY_WINDOW_SECS},
};

const POOL_AUTHORITY_SEED: &[u8] = b"pool_authority";
const MAX_CURRENCY_DECIMALS: u8 = 9;

fn require_simulation(protocol: &Protocol) -> Result<()> {
    require!(
        protocol.settlement_mode == SettlementMode::DevnetTokenSimulation,
        ThetisError::WrongSettlementMode
    );
    Ok(())
}

fn require_top_level() -> Result<()> {
    require_eq!(
        get_stack_height(),
        TRANSACTION_LEVEL_STACK_HEIGHT,
        ThetisError::NotTopLevel
    );
    Ok(())
}

fn add(left: u64, right: u64) -> Result<u64> {
    left.checked_add(right)
        .ok_or_else(|| error!(ThetisError::ArithmeticOverflow))
}

fn sub(left: u64, right: u64) -> Result<u64> {
    left.checked_sub(right)
        .ok_or_else(|| error!(ThetisError::ArithmeticOverflow))
}

/// Moves tokens out of an account its owner signs for.
fn transfer_in<'info>(
    program: Pubkey,
    accounts: TransferChecked<'info>,
    amount: u64,
    decimals: u8,
) -> Result<()> {
    token::transfer_checked(CpiContext::new(program, accounts), amount, decimals)
}

/// Moves tokens out of the pool vault, signed by the pool authority.
fn transfer_out<'info>(
    program: Pubkey,
    accounts: TransferChecked<'info>,
    pool: Pubkey,
    bump: u8,
    amount: u64,
    decimals: u8,
) -> Result<()> {
    let seeds: &[&[u8]] = &[POOL_AUTHORITY_SEED, pool.as_ref(), &[bump]];
    token::transfer_checked(
        CpiContext::new_with_signer(program, accounts, &[seeds]),
        amount,
        decimals,
    )
}

/// Reloads the vault after a transfer and requires exactly the expected balance.
fn check_vault_balance(vault: &mut Account<'_, TokenAccount>, expected: u64) -> Result<()> {
    vault.reload()?;
    require_eq!(vault.amount, expected, ThetisError::BalanceMismatch);
    Ok(())
}

/// The pool and token bindings `deposit` and `withdraw` share.
fn check_depositor_slots(
    pool: &SimulationPool,
    protocol: Pubkey,
    mint: &Account<'_, Mint>,
    vault: &Account<'_, TokenAccount>,
    depositor_token: &Account<'_, TokenAccount>,
    depositor: Pubkey,
) -> Result<()> {
    require!(pool.protocol == protocol, ThetisError::WrongOrganisation);
    require!(
        mint.key() == pool.mint && vault.key() == pool.vault && depositor_token.mint == pool.mint,
        ThetisError::MintMismatch
    );
    require!(
        depositor_token.owner == depositor && depositor_token.key() != vault.key(),
        ThetisError::InvalidField
    );
    Ok(())
}

#[derive(Accounts)]
pub struct OpenPool<'info> {
    pub admin: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub protocol: Box<Account<'info, Protocol>>,
    #[account(
        init,
        payer = payer,
        space = SimulationPool::DISCRIMINATOR.len() + SimulationPool::INIT_SPACE,
        seeds = [b"pool", protocol.key().as_ref()],
        bump,
    )]
    pub pool: Box<Account<'info, SimulationPool>>,
    /// CHECK: The seeds identify the vault's token authority.
    #[account(seeds = [POOL_AUTHORITY_SEED, pool.key().as_ref()], bump)]
    pub pool_authority: UncheckedAccount<'info>,
    pub mint: Box<Account<'info, Mint>>,
    /// CHECK: The address is canonical and the associated token program creates or validates it.
    #[account(
        mut,
        address = get_associated_token_address(&pool_authority.key(), &mint.key()),
    )]
    pub pool_vault: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Opens the one pool of a simulation instance on an SPL Token mint. A balance already in the
/// vault is unattributed credit: every counter still starts at zero.
pub fn open_pool(ctx: Context<OpenPool>, currency: [u8; 3]) -> Result<()> {
    let accounts = ctx.accounts;
    let protocol = &accounts.protocol;

    // Step 0: the pool is a simulation-mode account.
    require_simulation(protocol)?;
    // Step 1: top level. Opening the pool is never paused.
    require_top_level()?;
    // Step 2: only the protocol admin opens it.
    require_keys_eq!(accounts.admin.key(), protocol.admin, ThetisError::NotAdmin);

    // Step 5: refusals.
    require!(valid_currency(&currency), ThetisError::InvalidField);
    let mint = &accounts.mint;
    require!(
        mint.key() != spl_token::native_mint::ID && mint.decimals <= MAX_CURRENCY_DECIMALS,
        ThetisError::MintMismatch
    );

    // Step 6: create the vault, write and emit.
    receipts::create_vault(
        accounts.associated_token_program.key(),
        Create {
            payer: accounts.payer.to_account_info(),
            associated_token: accounts.pool_vault.to_account_info(),
            authority: accounts.pool_authority.to_account_info(),
            mint: mint.to_account_info(),
            system_program: accounts.system_program.to_account_info(),
            token_program: accounts.token_program.to_account_info(),
        },
    )?;
    let protocol_key = protocol.key();
    let currency_decimals = mint.decimals;
    let mint_key = mint.key();
    let vault = accounts.pool_vault.key();
    let pool = &mut accounts.pool;
    pool.set_inner(SimulationPool {
        protocol: protocol_key,
        mint: mint_key,
        vault,
        currency,
        currency_decimals,
        cash_minor: 0,
        total_shares: 0,
        lent_minor: 0,
        income_minor: 0,
        revision: 0,
        bump: ctx.bumps.pool,
    });
    emit!(PoolOpened {
        pool: pool.key(),
        mint: mint_key,
        currency,
        currency_decimals,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    pub depositor: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub protocol: Box<Account<'info, Protocol>>,
    #[account(
        seeds = [b"authority", protocol.key().as_ref(), depositor.key().as_ref()],
        bump = authority.bump,
    )]
    pub authority: Box<Account<'info, Authority>>,
    pub depositor_org: Box<Account<'info, Organisation>>,
    #[account(mut)]
    pub pool: Box<Account<'info, SimulationPool>>,
    #[account(
        init_if_needed,
        payer = payer,
        space = PoolShare::DISCRIMINATOR.len() + PoolShare::INIT_SPACE,
        seeds = [b"pool_share", pool.key().as_ref(), depositor_org.key().as_ref()],
        bump,
    )]
    pub share: Box<Account<'info, PoolShare>>,
    // Allow the handler to reject the vault as the source with InvalidField.
    #[account(mut, dup)]
    pub depositor_token: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub pool_vault: Box<Account<'info, TokenAccount>>,
    pub mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Moves test tokens from the depositor's account into the pool vault for 1:1 shares of the
/// depositor's organisation.
pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    let accounts = ctx.accounts;
    let protocol = &accounts.protocol;
    let protocol_key = protocol.key();

    // Step 0: the pool is a simulation-mode account.
    require_simulation(protocol)?;
    // Step 1: top level, then the pool pause bit.
    require_top_level()?;
    require!(protocol.pause_flags & pause::POOL == 0, ThetisError::Paused);

    // Step 2: the depositor's authority.
    let now = Clock::get()?.unix_timestamp;
    let depositor = accounts.depositor.key();
    let org = &accounts.depositor_org;
    let authority = &accounts.authority;
    require_keys_eq!(authority.wallet, depositor, ThetisError::WrongSigner);
    check_lending_authority(
        authority,
        protocol_key,
        org.key(),
        Some(Role::Lender),
        org,
        scope::POOL,
        now,
    )?;

    // Step 3: bindings, then the share.
    let pool = &accounts.pool;
    check_depositor_slots(
        pool,
        protocol_key,
        &accounts.mint,
        &accounts.pool_vault,
        &accounts.depositor_token,
        depositor,
    )?;
    let pool_key = pool.key();
    let org_key = org.key();
    let share = &accounts.share;
    let first_write = share.organisation == Pubkey::default();
    require!(
        first_write || (share.pool == pool_key && share.organisation == org_key),
        ThetisError::WrongOrganisation
    );

    // Step 5: refusals. Everything is computed into temporaries; nothing is written yet.
    require!(amount > 0, ThetisError::InvalidField);
    let cash_minor = add(pool.cash_minor, amount)?;
    let shares = add(share.shares, amount)?;
    let total_shares = add(pool.total_shares, amount)?;
    let revision = add(pool.revision, 1)?;

    // Step 6: move the tokens, check the balance, write and emit.
    let expected = add(accounts.pool_vault.amount, amount)?;
    transfer_in(
        accounts.token_program.key(),
        TransferChecked {
            from: accounts.depositor_token.to_account_info(),
            mint: accounts.mint.to_account_info(),
            to: accounts.pool_vault.to_account_info(),
            authority: accounts.depositor.to_account_info(),
        },
        amount,
        accounts.mint.decimals,
    )?;
    check_vault_balance(&mut accounts.pool_vault, expected)?;

    let share = &mut accounts.share;
    if first_write {
        share.pool = pool_key;
        share.organisation = org_key;
        share.lent_minor = 0;
        share.bump = ctx.bumps.share;
    }
    share.shares = shares;
    let pool = &mut accounts.pool;
    pool.cash_minor = cash_minor;
    pool.total_shares = total_shares;
    pool.revision = revision;
    emit!(Deposited {
        pool: pool_key,
        organisation: org_key,
        wallet: depositor,
        amount,
        shares,
        pool_revision: revision,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub depositor: Signer<'info>,
    pub protocol: Box<Account<'info, Protocol>>,
    #[account(
        seeds = [b"authority", protocol.key().as_ref(), depositor.key().as_ref()],
        bump = authority.bump,
    )]
    pub authority: Box<Account<'info, Authority>>,
    pub depositor_org: Box<Account<'info, Organisation>>,
    #[account(mut)]
    pub pool: Box<Account<'info, SimulationPool>>,
    #[account(mut)]
    pub share: Box<Account<'info, PoolShare>>,
    // Allow the handler to reject the vault as the destination with InvalidField.
    #[account(mut, dup)]
    pub depositor_token: Box<Account<'info, TokenAccount>>,
    /// CHECK: The seeds identify the vault's token authority.
    #[account(seeds = [POOL_AUTHORITY_SEED, pool.key().as_ref()], bump)]
    pub pool_authority: UncheckedAccount<'info>,
    #[account(mut)]
    pub pool_vault: Box<Account<'info, TokenAccount>>,
    pub mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
}

/// Returns test tokens from the pool vault to the depositor's account, against the
/// organisation's shares that are not lent out.
pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
    let accounts = ctx.accounts;
    let protocol = &accounts.protocol;
    let protocol_key = protocol.key();

    // Step 0: the pool is a simulation-mode account.
    require_simulation(protocol)?;
    // Step 1: top level, then the pool pause bit.
    require_top_level()?;
    require!(protocol.pause_flags & pause::POOL == 0, ThetisError::Paused);

    // Step 2: the depositor's authority.
    let now = Clock::get()?.unix_timestamp;
    let depositor = accounts.depositor.key();
    let org = &accounts.depositor_org;
    let authority = &accounts.authority;
    require_keys_eq!(authority.wallet, depositor, ThetisError::WrongSigner);
    check_lending_authority(
        authority,
        protocol_key,
        org.key(),
        Some(Role::Lender),
        org,
        scope::POOL,
        now,
    )?;

    // Step 3: bindings, then the share.
    let pool = &accounts.pool;
    check_depositor_slots(
        pool,
        protocol_key,
        &accounts.mint,
        &accounts.pool_vault,
        &accounts.depositor_token,
        depositor,
    )?;
    let pool_key = pool.key();
    let org_key = org.key();
    let share = &accounts.share;
    require!(
        share.pool == pool_key && share.organisation == org_key,
        ThetisError::WrongOrganisation
    );

    // Step 5: refusals. Everything is computed into temporaries; nothing is written yet.
    require!(amount > 0, ThetisError::InvalidField);
    require!(amount <= share.shares, ThetisError::InsufficientShares);
    let free = share
        .shares
        .checked_sub(share.lent_minor)
        .ok_or(ThetisError::ArithmeticOverflow)?;
    require!(amount <= free, ThetisError::InsufficientLiquidity);
    require!(
        amount <= pool.cash_minor,
        ThetisError::InsufficientLiquidity
    );
    let cash_minor = sub(pool.cash_minor, amount)?;
    let shares = sub(share.shares, amount)?;
    let total_shares = sub(pool.total_shares, amount)?;
    let revision = add(pool.revision, 1)?;

    // Step 6: move the tokens, check the balance, write and emit.
    let expected = sub(accounts.pool_vault.amount, amount)?;
    transfer_out(
        accounts.token_program.key(),
        TransferChecked {
            from: accounts.pool_vault.to_account_info(),
            mint: accounts.mint.to_account_info(),
            to: accounts.depositor_token.to_account_info(),
            authority: accounts.pool_authority.to_account_info(),
        },
        pool_key,
        ctx.bumps.pool_authority,
        amount,
        accounts.mint.decimals,
    )?;
    check_vault_balance(&mut accounts.pool_vault, expected)?;

    accounts.share.shares = shares;
    let pool = &mut accounts.pool;
    pool.cash_minor = cash_minor;
    pool.total_shares = total_shares;
    pool.revision = revision;
    emit!(Withdrawn {
        pool: pool_key,
        organisation: org_key,
        wallet: depositor,
        amount,
        shares,
        pool_revision: revision,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct Borrow<'info> {
    #[account(mut)]
    pub sponsor: Signer<'info>,
    pub protocol: Box<Account<'info, Protocol>>,
    pub borrower_org: Box<Account<'info, Organisation>>,
    pub borrower_authority: Box<Account<'info, Authority>>,
    pub lender_org: Box<Account<'info, Organisation>>,
    pub facility: Box<Account<'info, Facility>>,
    #[account(mut)]
    pub loan: Box<Account<'info, Loan>>,
    pub lock: Box<Account<'info, LockAllocation>>,
    pub lot: Box<Account<'info, Lot>>,
    pub valuation: Box<Account<'info, Valuation>>,
    #[account(mut)]
    pub pool: Box<Account<'info, SimulationPool>>,
    #[account(mut)]
    pub lender_share: Box<Account<'info, PoolShare>>,
    /// CHECK: The seeds identify the vault's token authority.
    #[account(seeds = [POOL_AUTHORITY_SEED, pool.key().as_ref()], bump)]
    pub pool_authority: UncheckedAccount<'info>,
    #[account(mut)]
    pub pool_vault: Box<Account<'info, TokenAccount>>,
    pub mint: Box<Account<'info, Mint>>,
    // Allow the handler to reject the vault as the destination with InvalidField.
    #[account(mut, dup)]
    pub destination: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    /// CHECK: The address constraint pins the Instructions sysvar.
    #[account(address = solana_sdk_ids::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
}

/// Pays test tokens from the pool to the borrower's own token account against the pledged lot.
/// The loan's debt is raised first by accrual, then by the amount; only the facility lender's
/// deposits that are not already lent out can fund it.
pub fn borrow(
    ctx: Context<Borrow>,
    amount: u64,
    expected_revision: u64,
    valid_until: i64,
) -> Result<()> {
    let accounts = ctx.accounts;
    let protocol = &accounts.protocol;
    let protocol_key = protocol.key();

    // Step 0: a borrow is a simulation-mode action.
    require_simulation(protocol)?;
    // Step 1: top level, then the pause bit.
    require_top_level()?;
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

    // Step 3: the borrower's Authority, then the protocol fields, then the bindings.
    let facility = &accounts.facility;
    let loan = &accounts.loan;
    let lock = &accounts.lock;
    let lot = &accounts.lot;
    let pool = &accounts.pool;
    let lender_org = &accounts.lender_org;
    let borrower_org = &accounts.borrower_org;
    let borrower_authority = &accounts.borrower_authority;
    let lender_share = &accounts.lender_share;
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
        lender_org.protocol == protocol_key
            && facility.protocol == protocol_key
            && loan.protocol == protocol_key
            && lock.protocol == protocol_key
            && lot.protocol == protocol_key
            && pool.protocol == protocol_key,
        ThetisError::WrongOrganisation
    );
    let loan_key = loan.key();
    let pool_key = pool.key();
    require!(
        facility.lender == lender_org.key()
            && loan.facility == facility.key()
            && lock.loan == loan_key
            && lock.position == loan.position
            && loan.lot == lot.key(),
        ThetisError::WrongOrganisation
    );
    require!(
        lender_share.pool == pool_key && lender_share.organisation == facility.lender,
        ThetisError::WrongOrganisation
    );

    // Step 4: the loan's revision.
    require_eq!(loan.revision, expected_revision, ThetisError::StaleRevision);

    // Step 5: refusals. Everything is computed into temporaries; nothing is written yet.
    require!(
        loan.status == LoanStatus::Active,
        ThetisError::LoanNotActive
    );
    // No new debt while the lot ships or is restricted.
    require!(lot.state == LotState::Stored, ThetisError::LotNotStored);
    require!(
        lot.restriction == Restriction::Normal,
        ThetisError::Restricted
    );
    require!(amount > 0, ThetisError::InvalidField);
    let destination = &accounts.destination;
    require!(
        accounts.mint.key() == pool.mint
            && accounts.pool_vault.key() == pool.vault
            && destination.mint == pool.mint,
        ThetisError::MintMismatch
    );
    require!(
        destination.owner == borrower_authority.wallet
            && destination.key() != accounts.pool_vault.key(),
        ThetisError::InvalidField
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
    let principal_after = add(loan.principal, amount)?;
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
    let free = lender_share
        .shares
        .checked_sub(lender_share.lent_minor)
        .ok_or(ThetisError::ArithmeticOverflow)?;
    require!(amount <= free, ThetisError::InsufficientLiquidity);
    require!(
        amount <= pool.cash_minor,
        ThetisError::InsufficientLiquidity
    );
    let cash_minor = sub(pool.cash_minor, amount)?;
    let lent_minor = add(pool.lent_minor, amount)?;
    let share_lent_minor = add(lender_share.lent_minor, amount)?;
    let revision = add(loan.revision, 1)?;
    let pool_revision = add(pool.revision, 1)?;

    // Step 6: the borrower signed this exact borrow.
    let text = borrow_message(
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
        &destination.key(),
        loan.rate_bps,
        expected_revision,
        valid_until,
    );
    let verification = previous_instruction(&accounts.instructions)?;
    check_ed25519_instruction(&verification, &[borrower_authority.wallet], &text)?;

    // Step 7: move the tokens, check the balance, write and emit.
    let expected = sub(accounts.pool_vault.amount, amount)?;
    transfer_out(
        accounts.token_program.key(),
        TransferChecked {
            from: accounts.pool_vault.to_account_info(),
            mint: accounts.mint.to_account_info(),
            to: accounts.destination.to_account_info(),
            authority: accounts.pool_authority.to_account_info(),
        },
        pool_key,
        ctx.bumps.pool_authority,
        amount,
        accounts.mint.decimals,
    )?;
    check_vault_balance(&mut accounts.pool_vault, expected)?;

    let loan = &mut accounts.loan;
    loan.booked_interest = accrual.booked_interest;
    loan.accrual_remainder = accrual.accrual_remainder;
    loan.accrued_at = accrual.accrued_at;
    loan.principal = principal_after;
    loan.revision = revision;
    let pool = &mut accounts.pool;
    pool.cash_minor = cash_minor;
    pool.lent_minor = lent_minor;
    pool.revision = pool_revision;
    accounts.lender_share.lent_minor = share_lent_minor;
    emit!(Borrowed {
        loan: loan_key,
        pool: pool_key,
        amount,
        principal: principal_after,
        booked_interest: accrual.booked_interest,
        revision,
        pool_revision,
    });
    Ok(())
}

/// The simulation branch of `repay`, entered after the top-level check. Any wallet may repay:
/// only the amount applied to the debt moves, interest first and then principal.
pub(crate) fn repay_simulation(ctx: Context<Repay>, amount: u64) -> Result<()> {
    let accounts = ctx.accounts;
    let protocol_key = accounts.protocol.key();

    // Step 1b: the simulation layout has the pool slots and no attestation, authority or
    // organisation, and the facility lender's share as the one writable remaining account.
    require!(
        accounts.authority.is_none() && accounts.lender_org.is_none() && accounts.payment.is_none(),
        ThetisError::InvalidField
    );
    let (
        Some(pool),
        Some(pool_authority),
        Some(pool_vault),
        Some(payer_token),
        Some(mint),
        Some(token_program),
    ) = (
        accounts.pool.as_mut(),
        accounts.pool_authority.as_ref(),
        accounts.pool_vault.as_mut(),
        accounts.payer_token.as_ref(),
        accounts.mint.as_ref(),
        accounts.token_program.as_ref(),
    )
    else {
        return err!(ThetisError::InvalidField);
    };
    let [lender_share_info] = ctx.remaining_accounts else {
        return err!(ThetisError::InvalidField);
    };
    require!(lender_share_info.is_writable, ThetisError::InvalidField);

    // Step 3: bindings.
    let facility = &accounts.facility;
    let loan = &accounts.loan;
    require!(
        facility.protocol == protocol_key
            && loan.protocol == protocol_key
            && pool.protocol == protocol_key,
        ThetisError::WrongOrganisation
    );
    require!(
        loan.facility == facility.key(),
        ThetisError::WrongOrganisation
    );
    let pool_key = pool.key();
    let (derived_authority, _) =
        Pubkey::find_program_address(&[POOL_AUTHORITY_SEED, pool_key.as_ref()], &crate::ID);
    require_keys_eq!(
        derived_authority,
        pool_authority.key(),
        ThetisError::MintMismatch
    );
    require!(
        mint.key() == pool.mint && pool_vault.key() == pool.vault && payer_token.mint == pool.mint,
        ThetisError::MintMismatch
    );
    let signer = accounts.signer.key();
    require!(
        payer_token.owner == signer && payer_token.key() != pool_vault.key(),
        ThetisError::InvalidField
    );
    let mut lender_share = Account::<PoolShare>::try_from(lender_share_info)?;
    require!(
        lender_share.pool == pool_key && lender_share.organisation == facility.lender,
        ThetisError::WrongOrganisation
    );

    // Step 4: refusals.
    require!(
        loan.status != LoanStatus::Closed,
        ThetisError::LoanNotActive
    );
    require!(amount > 0, ThetisError::InvalidField);

    // Step 5: accrual, then the split. Nothing is written yet.
    let now = Clock::get()?.unix_timestamp;
    let accrual = accrue(loan, now)?;
    let application = apply_payment(loan.principal, accrual.booked_interest, amount)?;
    // Nothing is owed, so nothing moves.
    require!(application.applied > 0, ThetisError::InvalidField);
    let cash_minor = add(pool.cash_minor, application.applied)?;
    let lent_minor = sub(pool.lent_minor, application.from_principal)?;
    let income_minor = add(pool.income_minor, application.from_interest)?;
    let share_lent_minor = sub(lender_share.lent_minor, application.from_principal)?;
    let pool_revision = add(pool.revision, 1)?;
    let revision = add(loan.revision, 1)?;

    // Step 6: move exactly the applied amount, check the balance, write and emit.
    let expected = add(pool_vault.amount, application.applied)?;
    transfer_in(
        token_program.key(),
        TransferChecked {
            from: payer_token.to_account_info(),
            mint: mint.to_account_info(),
            to: pool_vault.to_account_info(),
            authority: accounts.signer.to_account_info(),
        },
        application.applied,
        mint.decimals,
    )?;
    check_vault_balance(pool_vault, expected)?;

    pool.cash_minor = cash_minor;
    pool.lent_minor = lent_minor;
    pool.income_minor = income_minor;
    pool.revision = pool_revision;
    lender_share.lent_minor = share_lent_minor;
    lender_share.exit(&crate::ID)?;
    let loan_key = accounts.loan.key();
    let loan = &mut accounts.loan;
    loan.booked_interest = application.booked_interest;
    loan.accrual_remainder = accrual.accrual_remainder;
    loan.accrued_at = accrual.accrued_at;
    loan.principal = application.principal;
    loan.revision = revision;
    emit!(Repaid {
        loan: loan_key,
        payment: None,
        pool: Some(pool_key),
        pool_revision: Some(pool_revision),
        applied: application.applied,
        from_interest: application.from_interest,
        from_principal: application.from_principal,
        surplus: 0,
        principal: application.principal,
        booked_interest: application.booked_interest,
        revision,
    });
    Ok(())
}
