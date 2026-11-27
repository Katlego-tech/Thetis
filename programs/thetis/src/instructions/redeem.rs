use anchor_lang::{
    prelude::*,
    solana_program::instruction::{get_stack_height, TRANSACTION_LEVEL_STACK_HEIGHT},
};
use anchor_spl::{
    associated_token::get_associated_token_address_with_program_id,
    token_2022::{BurnChecked, Token2022},
    token_interface::Mint,
};

use crate::{
    error::ThetisError,
    events::UnitsRedeemed,
    intent::{
        message::redeem_message,
        verify::{check_ed25519_instruction, previous_instruction},
    },
    receipts::{self, VAULT_AUTHORITY_SEED},
    state::*,
    validate::{check_authority, CUSTODY_WINDOW_SECS},
};

#[derive(Accounts)]
pub struct Redeem<'info> {
    pub sponsor: Signer<'info>,
    pub protocol: Box<Account<'info, Protocol>>,
    pub owner_authority: Box<Account<'info, Authority>>,
    pub custodian_authority: Box<Account<'info, Authority>>,
    pub owner: Box<Account<'info, Organisation>>,
    pub custodian: Box<Account<'info, Organisation>>,
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
    /// CHECK: The address constraint pins the Instructions sysvar.
    #[account(address = solana_sdk_ids::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token2022>,
}

pub fn redeem(
    ctx: Context<Redeem>,
    quantity_kg: u64,
    collection_ticket: [u8; 32],
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
        protocol.pause_flags & pause::REDEEM == 0,
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
    check_authority(owner_authority, now, scope::REDEEM)?;
    check_authority(custodian_authority, now, scope::REDEEM)?;

    let protocol_key = protocol.key();
    let lot = &mut accounts.lot;
    let lot_key = lot.key();
    let owner = &accounts.owner;
    let owner_key = owner.key();
    let custodian = &accounts.custodian;
    let custodian_key = custodian.key();
    let position = &mut accounts.position;
    let site = &mut accounts.custodian_class;
    let intake = &mut accounts.intake;
    require!(
        owner_authority.protocol == protocol_key
            && custodian_authority.protocol == protocol_key
            && owner.protocol == protocol_key
            && custodian.protocol == protocol_key
            && site.protocol == protocol_key
            && lot.protocol == protocol_key
            && intake.protocol == protocol_key
            && position.protocol == protocol_key
            && owner_authority.organisation == owner_key
            && custodian_authority.organisation == custodian_key
            && lot.custodian_class == site.key()
            && site.custodian == custodian_key
            && position.lot == lot_key
            && position.owner == owner_key
            && lot.mint == accounts.mint.key()
            && intake.key() == lot.intake
            && intake.lot == lot.root,
        ThetisError::WrongOrganisation
    );
    // The intake is the issuing custodian's PDA; a lot collected at another custodian's site
    // (after a shipment) still retires its own intake.
    let intake_address = Pubkey::create_program_address(
        &[
            b"intake",
            protocol_key.as_ref(),
            intake.custodian.as_ref(),
            &intake.intake_digest,
            &[intake.bump],
        ],
        ctx.program_id,
    )
    .map_err(|_| error!(ThetisError::WrongOrganisation))?;
    require_keys_eq!(intake.key(), intake_address, ThetisError::WrongOrganisation);

    require_eq!(
        position.revision,
        expected_revision,
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
    require!(collection_ticket != [0u8; 32], ThetisError::InvalidField);

    let text = redeem_message(
        ctx.program_id,
        &protocol.instance_id,
        &lot.lot_id,
        quantity_kg,
        &owner.display_name,
        &custodian.display_name,
        &collection_ticket,
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

    position.quantity_kg = position
        .quantity_kg
        .checked_sub(quantity_kg)
        .ok_or(ThetisError::ArithmeticOverflow)?;
    position.revision = position
        .revision
        .checked_add(1)
        .ok_or(ThetisError::ArithmeticOverflow)?;
    lot.supply_kg = lot
        .supply_kg
        .checked_sub(quantity_kg)
        .ok_or(ThetisError::ArithmeticOverflow)?;
    lot.revision = lot
        .revision
        .checked_add(1)
        .ok_or(ThetisError::ArithmeticOverflow)?;
    site.occupied_kg = site
        .occupied_kg
        .checked_sub(quantity_kg)
        .ok_or(ThetisError::ArithmeticOverflow)?;

    let lot_redeemed = lot.supply_kg == 0;
    if lot_redeemed {
        lot.state = LotState::Redeemed;
        if let Some(root) = accounts.root.as_mut() {
            root.live_children = root
                .live_children
                .checked_sub(1)
                .ok_or(ThetisError::ArithmeticOverflow)?;
        }
    }
    let root = accounts.root.as_ref().unwrap_or(lot);
    if root.supply_kg == 0 && root.live_children == 0 {
        intake.retired = true;
    }

    receipts::check_vault_balance(&accounts.vault, position.quantity_kg)?;
    accounts.mint.reload()?;
    require_eq!(
        accounts.mint.supply,
        lot.supply_kg,
        ThetisError::BalanceMismatch
    );
    emit!(UnitsRedeemed {
        lot: lot_key,
        owner: owner_key,
        quantity_kg,
        collection_ticket,
        revision: lot.revision,
        lot_redeemed,
    });
    Ok(())
}
