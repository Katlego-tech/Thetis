use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::{self, Create},
    token_2022::{self, MintTo, TransferChecked},
    token_interface::TokenAccount,
};

use crate::error::ThetisError;

pub(crate) const MINT_AUTHORITY_SEED: &[u8] = b"mint_authority";
pub(crate) const VAULT_AUTHORITY_SEED: &[u8] = b"vault";

pub(crate) fn create_vault(program: Pubkey, accounts: Create<'_>) -> Result<()> {
    associated_token::create_idempotent(CpiContext::new(program, accounts))
}

pub(crate) fn mint_receipts(
    program: Pubkey,
    accounts: MintTo<'_>,
    mint_authority_bump: u8,
    quantity: u64,
) -> Result<()> {
    let mint = accounts.mint.key();
    let seeds: &[&[u8]] = &[MINT_AUTHORITY_SEED, mint.as_ref(), &[mint_authority_bump]];
    token_2022::mint_to(
        CpiContext::new_with_signer(program, accounts, &[seeds]),
        quantity,
    )
}

pub(crate) fn check_vault_balance(vault: &AccountInfo<'_>, quantity: u64) -> Result<()> {
    let data = vault.try_borrow_data()?;
    let vault = TokenAccount::try_deserialize(&mut data.as_ref())?;
    require_eq!(vault.amount, quantity, ThetisError::BalanceMismatch);
    Ok(())
}

pub(crate) fn transfer_receipts(
    program: Pubkey,
    accounts: TransferChecked<'_>,
    vault_authority_bump: u8,
    from_position: Pubkey,
    quantity: u64,
) -> Result<()> {
    let seeds: &[&[u8]] = &[
        VAULT_AUTHORITY_SEED,
        from_position.as_ref(),
        &[vault_authority_bump],
    ];
    token_2022::transfer_checked(
        CpiContext::new_with_signer(program, accounts, &[seeds]),
        quantity,
        0,
    )
}
