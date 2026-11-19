use anchor_lang::prelude::*;

use crate::message::{MAX_DISPLAY_NAME_BYTES, MAX_LOT_ID_BYTES};

#[account]
#[derive(InitSpace)]
pub struct Party {
    pub wallet: Pubkey,
    #[max_len(MAX_DISPLAY_NAME_BYTES)]
    pub display_name: String,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Batch {
    pub id: [u8; 16],
    #[max_len(MAX_LOT_ID_BYTES)]
    pub lot_id: String,
    pub sender: Pubkey,
    pub receiver: Pubkey,
    pub quantity_kg: u64,
    pub sequence: u64,
    pub handed_over: bool,
    pub bump: u8,
}
