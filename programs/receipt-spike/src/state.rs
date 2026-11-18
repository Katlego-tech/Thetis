use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub quantity: u64,
    pub bump: u8,
}

/// Binds issuance to the signing wallet that created the mint.
#[account]
#[derive(InitSpace)]
pub struct MintAuthority {
    pub issuer: Pubkey,
}
