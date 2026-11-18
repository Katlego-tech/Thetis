use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::{self, get_associated_token_address_with_program_id, AssociatedToken},
    token_2022::{self, Token2022},
    token_interface::{Mint, TokenAccount},
};

mod error;
mod state;

use error::ReceiptError;
pub use state::{MintAuthority, Position};

declare_id!("CBKfw6VcsKcQNXL5ZmjgsAu99qMswxreozhqBYeSUAqj");

const MINT_AUTHORITY_SEED: &[u8] = b"mint_authority";
const POSITION_SEED: &[u8] = b"position";
const VAULT_SEED: &[u8] = b"vault";
const DECIMALS: u8 = 0;

#[program]
pub mod receipt_spike {
    use super::*;

    pub fn create_receipt_mint(ctx: Context<CreateReceiptMint>, decimals: u8) -> Result<()> {
        require_eq!(decimals, DECIMALS, ReceiptError::InvalidDecimals);
        ctx.accounts.mint_authority.issuer = ctx.accounts.issuer.key();
        Ok(())
    }

    pub fn issue(ctx: Context<Issue>, owner: Pubkey, quantity: u64) -> Result<()> {
        require_gt!(quantity, 0, ReceiptError::ZeroQuantity);
        let accounts = ctx.accounts;

        associated_token::create_idempotent(CpiContext::new(
            accounts.associated_token_program.key(),
            associated_token::Create {
                payer: accounts.issuer.to_account_info(),
                associated_token: accounts.vault.to_account_info(),
                authority: accounts.vault_authority.to_account_info(),
                mint: accounts.mint.to_account_info(),
                system_program: accounts.system_program.to_account_info(),
                token_program: accounts.token_program.to_account_info(),
            },
        ))?;

        let mint = accounts.mint.key();
        let seeds: &[&[u8]] = &[
            MINT_AUTHORITY_SEED,
            mint.as_ref(),
            &[ctx.bumps.mint_authority],
        ];
        token_2022::mint_to(
            CpiContext::new_with_signer(
                accounts.token_program.key(),
                token_2022::MintTo {
                    mint: accounts.mint.to_account_info(),
                    to: accounts.vault.to_account_info(),
                    authority: accounts.mint_authority.to_account_info(),
                },
                &[seeds],
            ),
            quantity,
        )?;

        let vault_data = accounts.vault.try_borrow_data()?;
        let vault = TokenAccount::try_deserialize(&mut &vault_data[..])?;
        require_eq!(vault.amount, quantity, ReceiptError::VaultBalanceMismatch);
        accounts.position.set_inner(Position {
            owner,
            mint,
            quantity,
            bump: ctx.bumps.position,
        });
        Ok(())
    }

    pub fn move_units(ctx: Context<MoveUnits>, quantity: u64) -> Result<()> {
        let accounts = ctx.accounts;
        let from_quantity = accounts
            .from_position
            .quantity
            .checked_sub(quantity)
            .ok_or(ReceiptError::InsufficientQuantity)?;
        let to_quantity = accounts
            .to_position
            .quantity
            .checked_add(quantity)
            .ok_or(ReceiptError::QuantityOverflow)?;

        let from_position = accounts.from_position.key();
        let seeds: &[&[u8]] = &[
            VAULT_SEED,
            from_position.as_ref(),
            &[ctx.bumps.from_vault_authority],
        ];
        token_2022::transfer_checked(
            CpiContext::new_with_signer(
                accounts.token_program.key(),
                token_2022::TransferChecked {
                    from: accounts.from_vault.to_account_info(),
                    mint: accounts.mint.to_account_info(),
                    to: accounts.to_vault.to_account_info(),
                    authority: accounts.from_vault_authority.to_account_info(),
                },
                &[seeds],
            ),
            quantity,
            DECIMALS,
        )?;

        accounts.from_vault.reload()?;
        accounts.to_vault.reload()?;
        require_eq!(
            accounts.from_vault.amount,
            from_quantity,
            ReceiptError::VaultBalanceMismatch
        );
        require_eq!(
            accounts.to_vault.amount,
            to_quantity,
            ReceiptError::VaultBalanceMismatch
        );
        accounts.from_position.quantity = from_quantity;
        accounts.to_position.quantity = to_quantity;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct CreateReceiptMint<'info> {
    #[account(mut)]
    pub issuer: Signer<'info>,
    #[account(
        init,
        payer = issuer,
        mint::decimals = DECIMALS,
        mint::authority = mint_authority,
        mint::freeze_authority = mint_authority,
        mint::token_program = token_program,
    )]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        init,
        payer = issuer,
        space = MintAuthority::DISCRIMINATOR.len() + MintAuthority::INIT_SPACE,
        seeds = [MINT_AUTHORITY_SEED, mint.key().as_ref()],
        bump,
    )]
    pub mint_authority: Account<'info, MintAuthority>,
    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(owner: Pubkey)]
pub struct Issue<'info> {
    #[account(mut)]
    pub issuer: Signer<'info>,
    #[account(
        mut,
        mint::authority = mint_authority,
        mint::token_program = token_program,
    )]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(seeds = [MINT_AUTHORITY_SEED, mint.key().as_ref()], bump, has_one = issuer)]
    pub mint_authority: Account<'info, MintAuthority>,
    #[account(
        init,
        payer = issuer,
        space = Position::DISCRIMINATOR.len() + Position::INIT_SPACE,
        seeds = [POSITION_SEED, mint.key().as_ref(), owner.as_ref()],
        bump,
    )]
    pub position: Account<'info, Position>,
    /// CHECK: The seeds identify the vault's token authority.
    #[account(seeds = [VAULT_SEED, position.key().as_ref()], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    /// CHECK: The address is canonical, and the ATA program creates or validates the account.
    #[account(
        mut,
        address = get_associated_token_address_with_program_id(
            &vault_authority.key(), &mint.key(), &token_program.key()
        ),
    )]
    pub vault: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MoveUnits<'info> {
    pub owner: Signer<'info>,
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        seeds = [POSITION_SEED, mint.key().as_ref(), from_position.owner.as_ref()],
        bump = from_position.bump,
        has_one = mint,
        has_one = owner @ ReceiptError::WrongOwner,
    )]
    pub from_position: Account<'info, Position>,
    /// CHECK: The seeds identify the source vault's token authority.
    #[account(seeds = [VAULT_SEED, from_position.key().as_ref()], bump)]
    pub from_vault_authority: UncheckedAccount<'info>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = from_vault_authority,
        associated_token::token_program = token_program,
    )]
    pub from_vault: InterfaceAccount<'info, TokenAccount>,
    // Check distinct positions with the instruction's own refusal code.
    #[account(
        mut, dup,
        seeds = [POSITION_SEED, mint.key().as_ref(), to_position.owner.as_ref()],
        bump = to_position.bump,
        has_one = mint,
        constraint = to_position.key() != from_position.key() @ ReceiptError::SamePosition,
    )]
    pub to_position: Account<'info, Position>,
    /// CHECK: The seeds identify the destination vault's token authority.
    #[account(seeds = [VAULT_SEED, to_position.key().as_ref()], bump)]
    pub to_vault_authority: UncheckedAccount<'info>,
    #[account(
        mut, dup,
        associated_token::mint = mint,
        associated_token::authority = to_vault_authority,
        associated_token::token_program = token_program,
    )]
    pub to_vault: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Program<'info, Token2022>,
}
