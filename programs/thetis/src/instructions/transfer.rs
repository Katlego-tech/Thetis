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
    events::UnitsTransferred,
    intent::{
        message::transfer_message,
        verify::{check_ed25519_instruction, previous_instruction},
    },
    receipts::{self, VAULT_AUTHORITY_SEED},
    state::*,
    validate::{check_authority, CUSTODY_WINDOW_SECS},
};

#[derive(Accounts)]
pub struct Transfer<'info> {
    #[account(mut)]
    pub sponsor: Signer<'info>,
    pub protocol: Box<Account<'info, Protocol>>,
    pub authority: Box<Account<'info, Authority>>,
    #[account(mut)]
    pub lot: Box<Account<'info, Lot>>,
    #[account(seeds = [b"mint", lot.key().as_ref()], bump)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub owner: Box<Account<'info, Organisation>>,
    #[account(mut)]
    pub from_position: Box<Account<'info, Position>>,
    /// CHECK: The seeds identify the source vault's token authority.
    #[account(seeds = [VAULT_AUTHORITY_SEED, from_position.key().as_ref()], bump)]
    pub from_vault_authority: UncheckedAccount<'info>,
    /// CHECK: The address is canonical and Token-2022 validates it during the transfer.
    #[account(
        mut,
        address = get_associated_token_address_with_program_id(
            &from_vault_authority.key(), &mint.key(), &token_program.key(),
        ),
    )]
    pub from_vault: UncheckedAccount<'info>,
    pub recipient: Box<Account<'info, Organisation>>,
    // Allow the handler to reject self-transfers with InvalidField.
    #[account(
        init_if_needed,
        dup,
        payer = sponsor,
        space = Position::DISCRIMINATOR.len() + Position::INIT_SPACE,
        seeds = [b"position", lot.key().as_ref(), recipient.key().as_ref()],
        bump,
    )]
    pub to_position: Box<Account<'info, Position>>,
    /// CHECK: The seeds identify the destination vault's token authority.
    #[account(seeds = [VAULT_AUTHORITY_SEED, to_position.key().as_ref()], bump)]
    pub to_vault_authority: UncheckedAccount<'info>,
    /// CHECK: The address is canonical and the associated token program creates or validates it.
    #[account(
        mut,
        address = get_associated_token_address_with_program_id(
            &to_vault_authority.key(), &mint.key(), &token_program.key(),
        ),
    )]
    pub to_vault: UncheckedAccount<'info>,
    /// CHECK: The address constraint pins the Instructions sysvar.
    #[account(address = solana_sdk_ids::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn transfer(
    ctx: Context<Transfer>,
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
        protocol.pause_flags & pause::TRANSFER == 0,
        ThetisError::Paused
    );

    let now = Clock::get()?.unix_timestamp;
    require!(now <= valid_until, ThetisError::Expired);
    let window = valid_until
        .checked_sub(now)
        .ok_or(ThetisError::WindowTooLong)?;
    require!(window <= CUSTODY_WINDOW_SECS, ThetisError::WindowTooLong);

    let authority = &accounts.authority;
    check_authority(authority, now, scope::TRANSFER)?;

    let protocol_key = protocol.key();
    let owner = &accounts.owner;
    let recipient = &accounts.recipient;
    let lot = &mut accounts.lot;
    let lot_key = lot.key();
    let from = &mut accounts.from_position;
    let to = &mut accounts.to_position;
    let new_position = to.lot == Pubkey::default();
    require!(
        authority.protocol == protocol_key
            && owner.protocol == protocol_key
            && recipient.protocol == protocol_key
            && lot.protocol == protocol_key
            && from.protocol == protocol_key
            && from.lot == lot_key
            && lot.mint == accounts.mint.key()
            && from.owner == owner.key()
            && authority.organisation == owner.key()
            && (new_position || to.protocol == protocol_key),
        ThetisError::WrongOrganisation
    );
    require_eq!(from.revision, expected_revision, ThetisError::StaleRevision);
    require!(lot.state == LotState::Stored, ThetisError::LotNotStored);
    require!(
        lot.restriction == Restriction::Normal,
        ThetisError::Restricted
    );
    require!(
        matches!(recipient.role, Role::Exporter | Role::Buyer),
        ThetisError::RecipientNotApproved
    );
    require!(recipient.key() != owner.key(), ThetisError::InvalidField);
    require!(quantity_kg > 0, ThetisError::ZeroQuantity);
    let available = from
        .quantity_kg
        .checked_sub(from.locked_kg)
        .and_then(|unlocked| unlocked.checked_sub(from.reserved_kg))
        .ok_or(ThetisError::InsufficientAvailable)?;
    require!(quantity_kg <= available, ThetisError::InsufficientAvailable);

    let text = transfer_message(
        ctx.program_id,
        &protocol.instance_id,
        &lot.lot_id,
        quantity_kg,
        &owner.display_name,
        &recipient.display_name,
        expected_revision,
        valid_until,
    );
    let verification = previous_instruction(&accounts.instructions)?;
    check_ed25519_instruction(&verification, &[authority.wallet], &text)?;

    receipts::create_vault(
        accounts.associated_token_program.key(),
        Create {
            payer: accounts.sponsor.to_account_info(),
            associated_token: accounts.to_vault.to_account_info(),
            authority: accounts.to_vault_authority.to_account_info(),
            mint: accounts.mint.to_account_info(),
            system_program: accounts.system_program.to_account_info(),
            token_program: accounts.token_program.to_account_info(),
        },
    )?;
    receipts::transfer_receipts(
        accounts.token_program.key(),
        TransferChecked {
            from: accounts.from_vault.to_account_info(),
            mint: accounts.mint.to_account_info(),
            to: accounts.to_vault.to_account_info(),
            authority: accounts.from_vault_authority.to_account_info(),
        },
        ctx.bumps.from_vault_authority,
        from.key(),
        quantity_kg,
    )?;

    from.quantity_kg = from
        .quantity_kg
        .checked_sub(quantity_kg)
        .ok_or(ThetisError::ArithmeticOverflow)?;
    from.revision = from
        .revision
        .checked_add(1)
        .ok_or(ThetisError::ArithmeticOverflow)?;
    if new_position {
        to.set_inner(Position {
            protocol: protocol_key,
            lot: lot_key,
            owner: recipient.key(),
            quantity_kg,
            locked_kg: 0,
            reserved_kg: 0,
            revision: 0,
            bump: ctx.bumps.to_position,
        });
    } else {
        to.quantity_kg = to
            .quantity_kg
            .checked_add(quantity_kg)
            .ok_or(ThetisError::ArithmeticOverflow)?;
        to.revision = to
            .revision
            .checked_add(1)
            .ok_or(ThetisError::ArithmeticOverflow)?;
    }
    lot.revision = lot
        .revision
        .checked_add(1)
        .ok_or(ThetisError::ArithmeticOverflow)?;

    receipts::check_vault_balance(&accounts.from_vault, from.quantity_kg)?;
    receipts::check_vault_balance(&accounts.to_vault, to.quantity_kg)?;
    emit!(UnitsTransferred {
        lot: lot_key,
        from: owner.key(),
        to: recipient.key(),
        quantity_kg,
        revision: lot.revision,
    });
    Ok(())
}
