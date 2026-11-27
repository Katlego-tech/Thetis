use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::{self, Create},
    token_2022::{self, BurnChecked, MintTo, TransferChecked},
    token_interface::TokenAccount,
};

use crate::{
    error::ThetisError,
    state::{IntakeIdentity, Lot},
};

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

pub(crate) fn burn_receipts(
    program: Pubkey,
    accounts: BurnChecked<'_>,
    vault_authority_bump: u8,
    position: Pubkey,
    quantity: u64,
) -> Result<()> {
    let seeds: &[&[u8]] = &[
        VAULT_AUTHORITY_SEED,
        position.as_ref(),
        &[vault_authority_bump],
    ];
    token_2022::burn_checked(
        CpiContext::new_with_signer(program, accounts, &[seeds]),
        quantity,
        0,
    )
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

/// A lot family's bookkeeping after units of one lot are burned (by a collection or a loading),
/// computed but not written: given the burned lot's new supply, its own `live_children`, and the
/// passed root's `(supply_kg, live_children)` when the lot is a child, returns the root's new
/// `live_children` (one fewer when the child's supply reaches 0) and whether the intake retires
/// (the family root holds no units and has no live child).
pub(crate) fn family_after(
    lot_supply_after: u64,
    lot_live_children: u32,
    root: Option<(u64, u32)>,
) -> Result<(Option<u32>, bool)> {
    match root {
        Some((root_supply, root_live_children)) => {
            let live_children = if lot_supply_after == 0 {
                root_live_children
                    .checked_sub(1)
                    .ok_or(ThetisError::ArithmeticOverflow)?
            } else {
                root_live_children
            };
            Ok((Some(live_children), root_supply == 0 && live_children == 0))
        }
        None => Ok((None, lot_supply_after == 0 && lot_live_children == 0)),
    }
}

/// Writes what `family_after` computed: the root's `live_children` when a root was passed, and
/// the intake's retirement.
pub(crate) fn apply_family(
    root: Option<&mut Lot>,
    intake: &mut IntakeIdentity,
    root_live_children: Option<u32>,
    retire: bool,
) {
    if let (Some(root), Some(live_children)) = (root, root_live_children) {
        root.live_children = live_children;
    }
    if retire {
        intake.retired = true;
    }
}
