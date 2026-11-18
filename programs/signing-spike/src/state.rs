use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Party {
    pub wallet: Pubkey,
    pub ps_signer: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Batch {
    pub id: [u8; 16],
    pub sender: Pubkey,
    pub receiver: Pubkey,
    pub quantity_kg: u64,
    pub sequence: u64,
    pub handed_over: bool,
    pub bump: u8,
}
