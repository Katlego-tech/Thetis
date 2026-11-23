#![allow(
    clippy::ptr_arg,
    reason = "Anchor derives an argument type check for the owned String"
)]

use anchor_lang::{
    prelude::*,
    solana_program::instruction::{get_stack_height, TRANSACTION_LEVEL_STACK_HEIGHT},
};
use anchor_spl::{
    associated_token::{get_associated_token_address_with_program_id, AssociatedToken, Create},
    token_2022::{BurnChecked, MintTo, Token2022},
    token_interface::Mint,
};

use crate::{
    error::ThetisError,
    events::LotSplit,
    intent::{
        message::split_message,
        verify::{check_ed25519_instruction, previous_instruction},
    },
    receipts::{self, MINT_AUTHORITY_SEED, VAULT_AUTHORITY_SEED},
    state::*,
    validate::{check_authority, code_seed, CUSTODY_WINDOW_SECS},
};

#[derive(Accounts)]
#[instruction(child_lot_id: String)]
pub struct Split<'info> {
    #[account(mut)]
    pub sponsor: Signer<'info>,
    pub protocol: Box<Account<'info, Protocol>>,
    pub owner_authority: Box<Account<'info, Authority>>,
    pub custodian_authority: Box<Account<'info, Authority>>,
    #[account(mut)]
    pub lot: Box<Account<'info, Lot>>,
    // The handler rejects aliasing with RootMismatch before either lot is written.
    #[account(mut, dup)]
    pub root: Option<Box<Account<'info, Lot>>>,
    pub class_policy: Box<Account<'info, ClassPolicy>>,
    pub custodian_class: Box<Account<'info, CustodianClass>>,
    pub owner: Box<Account<'info, Organisation>>,
    pub custodian: Box<Account<'info, Organisation>>,
    #[account(mut, seeds = [b"mint", lot.key().as_ref()], bump)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub position: Box<Account<'info, Position>>,
    /// CHECK: The seeds identify the parent vault's token authority.
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
    #[account(
        init,
        payer = sponsor,
        space = Lot::DISCRIMINATOR.len() + Lot::INIT_SPACE,
        seeds = [b"lot", protocol.key().as_ref(), code_seed(&child_lot_id, MAX_LOT_ID)?],
        bump,
    )]
    pub child_lot: Box<Account<'info, Lot>>,
    #[account(
        init,
        payer = sponsor,
        seeds = [b"mint", child_lot.key().as_ref()],
        bump,
        mint::decimals = 0,
        mint::authority = child_mint_authority,
        mint::freeze_authority = child_mint_authority,
        mint::token_program = token_program,
    )]
    pub child_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: The seeds identify the child mint and freeze authority.
    #[account(seeds = [MINT_AUTHORITY_SEED, child_mint.key().as_ref()], bump)]
    pub child_mint_authority: UncheckedAccount<'info>,
    #[account(
        init,
        payer = sponsor,
        space = Position::DISCRIMINATOR.len() + Position::INIT_SPACE,
        seeds = [b"position", child_lot.key().as_ref(), owner.key().as_ref()],
        bump,
    )]
    pub child_position: Box<Account<'info, Position>>,
    /// CHECK: The seeds identify the child vault's token authority.
    #[account(seeds = [VAULT_AUTHORITY_SEED, child_position.key().as_ref()], bump)]
    pub child_vault_authority: UncheckedAccount<'info>,
    /// CHECK: The address is canonical and the associated token program creates or validates it.
    #[account(
        mut,
        address = get_associated_token_address_with_program_id(
            &child_vault_authority.key(), &child_mint.key(), &token_program.key(),
        ),
    )]
    pub child_vault: UncheckedAccount<'info>,
    /// CHECK: The address constraint pins the Instructions sysvar.
    #[account(address = solana_sdk_ids::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn split(
    ctx: Context<Split>,
    child_lot_id: String,
    quantity_kg: u64,
    expected_revision: u64,
    valid_until: i64,
) -> Result<()> {
    let accounts = ctx.accounts;
    let protocol = &accounts.protocol;
    require_eq!(
        get_stack_height(),
        TRANSACTION_LEVEL_STACK_HEIGHT,
        ThetisError::NotTopLevel
    );
    require!(
        protocol.pause_flags & pause::SPLIT == 0,
        ThetisError::Paused
    );

    let now = Clock::get()?.unix_timestamp;
    require!(now <= valid_until, ThetisError::Expired);
    let window = valid_until
        .checked_sub(now)
        .ok_or(ThetisError::WindowTooLong)?;
    require!(window <= CUSTODY_WINDOW_SECS, ThetisError::WindowTooLong);

    let owner_authority = &accounts.owner_authority;
    let custodian_authority = &accounts.custodian_authority;
    check_authority(owner_authority, now, scope::SPLIT)?;
    check_authority(custodian_authority, now, scope::ISSUE)?;

    let protocol_key = protocol.key();
    let lot = &mut accounts.lot;
    let lot_key = lot.key();
    let position = &mut accounts.position;
    let owner = &accounts.owner;
    let owner_key = owner.key();
    let custodian = &accounts.custodian;
    let custodian_key = custodian.key();
    let class_policy = &accounts.class_policy;
    let custodian_class = &accounts.custodian_class;
    require!(
        owner_authority.protocol == protocol_key
            && custodian_authority.protocol == protocol_key
            && lot.protocol == protocol_key
            && position.protocol == protocol_key
            && class_policy.protocol == protocol_key
            && custodian_class.protocol == protocol_key
            && owner.protocol == protocol_key
            && custodian.protocol == protocol_key
            && position.lot == lot_key
            && lot.mint == accounts.mint.key()
            && position.owner == owner_key
            && owner_authority.organisation == owner_key
            && lot.class_policy == class_policy.key()
            && lot.custodian_class == custodian_class.key()
            && custodian_class.custodian == custodian_key
            && custodian_authority.organisation == custodian_key,
        ThetisError::WrongOrganisation
    );

    require_eq!(lot.revision, expected_revision, ThetisError::StaleRevision);
    match (lot.parent, accounts.root.as_ref()) {
        (None, None) => {}
        (Some(_), Some(root)) => require!(
            root.key() != lot_key && root.key() == lot.root && root.protocol == protocol_key,
            ThetisError::RootMismatch
        ),
        _ => return err!(ThetisError::RootMismatch),
    }

    require!(lot.state == LotState::Stored, ThetisError::LotNotStored);
    require!(
        lot.restriction == Restriction::Normal,
        ThetisError::Restricted
    );
    require!(quantity_kg > 0, ThetisError::ZeroQuantity);
    let available = position
        .quantity_kg
        .checked_sub(position.locked_kg)
        .and_then(|unlocked| unlocked.checked_sub(position.reserved_kg))
        .ok_or(ThetisError::InsufficientAvailable)?;
    require!(quantity_kg <= available, ThetisError::InsufficientAvailable);
    require!(
        class_policy.split_inherits_expiry,
        ThetisError::SplitNeedsReassay
    );
    require!(
        quantity_kg < lot.supply_kg,
        ThetisError::SplitWouldEmptyParent
    );

    let text = split_message(
        ctx.program_id,
        &protocol.instance_id,
        &lot.lot_id,
        &child_lot_id,
        quantity_kg,
        &owner.display_name,
        &custodian.display_name,
        expected_revision,
        valid_until,
    );
    check_ed25519_instruction(
        &previous_instruction(&accounts.instructions)?,
        &[owner_authority.wallet, custodian_authority.wallet],
        &text,
    )?;

    receipts::burn_receipts(
        accounts.token_program.key(),
        BurnChecked {
            mint: accounts.mint.to_account_info(),
            from: accounts.vault.to_account_info(),
            authority: accounts.vault_authority.to_account_info(),
        },
        ctx.bumps.vault_authority,
        position.key(),
        quantity_kg,
    )?;
    receipts::create_vault(
        accounts.associated_token_program.key(),
        Create {
            payer: accounts.sponsor.to_account_info(),
            associated_token: accounts.child_vault.to_account_info(),
            authority: accounts.child_vault_authority.to_account_info(),
            mint: accounts.child_mint.to_account_info(),
            system_program: accounts.system_program.to_account_info(),
            token_program: accounts.token_program.to_account_info(),
        },
    )?;
    receipts::mint_receipts(
        accounts.token_program.key(),
        MintTo {
            mint: accounts.child_mint.to_account_info(),
            to: accounts.child_vault.to_account_info(),
            authority: accounts.child_mint_authority.to_account_info(),
        },
        ctx.bumps.child_mint_authority,
        quantity_kg,
    )?;

    let child = accounts.child_lot.key();
    accounts.child_lot.set_inner(Lot {
        protocol: lot.protocol,
        lot_id: child_lot_id,
        class_policy: lot.class_policy,
        class_version: lot.class_version,
        grade: lot.grade.clone(),
        custodian_class: lot.custodian_class,
        intake: lot.intake,
        parent: Some(lot_key),
        root: lot.root,
        mint: accounts.child_mint.key(),
        supply_kg: quantity_kg,
        state: LotState::Stored,
        restriction: Restriction::Normal,
        expires_at: lot.expires_at,
        revision: 0,
        live_children: 0,
        bump: ctx.bumps.child_lot,
    });
    accounts.child_position.set_inner(Position {
        protocol: protocol_key,
        lot: child,
        owner: owner_key,
        quantity_kg,
        locked_kg: 0,
        reserved_kg: 0,
        revision: 0,
        bump: ctx.bumps.child_position,
    });
    lot.supply_kg = lot
        .supply_kg
        .checked_sub(quantity_kg)
        .ok_or(ThetisError::ArithmeticOverflow)?;
    lot.revision = lot
        .revision
        .checked_add(1)
        .ok_or(ThetisError::ArithmeticOverflow)?;
    position.quantity_kg = position
        .quantity_kg
        .checked_sub(quantity_kg)
        .ok_or(ThetisError::ArithmeticOverflow)?;
    position.revision = position
        .revision
        .checked_add(1)
        .ok_or(ThetisError::ArithmeticOverflow)?;
    let root = accounts.root.as_mut().unwrap_or(lot);
    root.live_children = root
        .live_children
        .checked_add(1)
        .ok_or(ThetisError::ArithmeticOverflow)?;

    receipts::check_vault_balance(&accounts.vault, position.quantity_kg)?;
    receipts::check_vault_balance(&accounts.child_vault, accounts.child_position.quantity_kg)?;
    accounts.mint.reload()?;
    accounts.child_mint.reload()?;
    require_eq!(
        accounts.mint.supply,
        lot.supply_kg,
        ThetisError::BalanceMismatch
    );
    require_eq!(
        accounts.child_mint.supply,
        accounts.child_lot.supply_kg,
        ThetisError::BalanceMismatch
    );
    emit!(LotSplit {
        parent: lot_key,
        child,
        owner: owner_key,
        quantity_kg,
        parent_revision: lot.revision,
    });
    Ok(())
}
