use anchor_lang::{
    prelude::*,
    solana_program::instruction::{get_stack_height, TRANSACTION_LEVEL_STACK_HEIGHT},
};
use solana_sdk_ids::sysvar;

pub mod error;
pub mod message;
mod state;
pub mod verify;

use error::IntentError;
use message::{handover_message, valid_display_name, valid_lot_id};
pub use state::{Batch, Party};
use verify::{check_ed25519_instruction, previous_instruction};

declare_id!("3LfZrLC2R3AdjAQgdoEjdC3YZpbHLaJGy446H74cPEyH");

const PARTY_SEED: &[u8] = b"party";
const BATCH_SEED: &[u8] = b"batch";
pub const CUSTODY_WINDOW_SECS: i64 = 600;
pub const MONEY_WINDOW_SECS: i64 = 300;

#[program]
pub mod intent_spike {
    use super::*;

    pub fn register_party(
        ctx: Context<RegisterParty>,
        wallet: Pubkey,
        display_name: String,
    ) -> Result<()> {
        require!(
            valid_display_name(&display_name),
            IntentError::InvalidDisplayName
        );
        ctx.accounts.party.set_inner(Party {
            wallet,
            display_name,
            bump: ctx.bumps.party,
        });
        Ok(())
    }

    pub fn open_batch(
        ctx: Context<OpenBatch>,
        id: [u8; 16],
        sender_wallet: Pubkey,
        receiver_wallet: Pubkey,
        quantity_kg: u64,
        lot_id: String,
    ) -> Result<()> {
        require!(valid_lot_id(&lot_id), IntentError::InvalidLotId);
        require_keys_neq!(sender_wallet, receiver_wallet, IntentError::SameParty);
        require_gt!(quantity_kg, 0, IntentError::ZeroQuantity);
        ctx.accounts.batch.set_inner(Batch {
            id,
            lot_id,
            sender: ctx.accounts.sender.key(),
            receiver: ctx.accounts.receiver.key(),
            quantity_kg,
            sequence: 0,
            handed_over: false,
            bump: ctx.bumps.batch,
        });
        Ok(())
    }

    #[allow(unused_variables, reason = "id is used by the batch PDA constraint")]
    pub fn handover(
        ctx: Context<Handover>,
        id: [u8; 16],
        quantity_kg: u64,
        valid_until: i64,
        expected_sequence: u64,
    ) -> Result<()> {
        require_eq!(
            get_stack_height(),
            TRANSACTION_LEVEL_STACK_HEIGHT,
            IntentError::NotTopLevel
        );
        let now = Clock::get()?.unix_timestamp;
        require!(now <= valid_until, IntentError::Expired);
        // Saturation keeps windows larger than i64::MAX outside the allowed range.
        require!(
            valid_until.saturating_sub(now) <= CUSTODY_WINDOW_SECS,
            IntentError::WindowTooLong
        );

        let batch = &mut ctx.accounts.batch;
        require_eq!(
            expected_sequence,
            batch.sequence,
            IntentError::StaleSequence
        );
        require_eq!(
            quantity_kg,
            batch.quantity_kg,
            IntentError::QuantityMismatch
        );
        require!(!batch.handed_over, IntentError::AlreadyHandedOver);

        let verification = previous_instruction(&ctx.accounts.instructions)?;
        let sender = &ctx.accounts.sender;
        let receiver = &ctx.accounts.receiver;
        let message = handover_message(
            ctx.program_id,
            &batch.lot_id,
            &batch.id,
            batch.quantity_kg,
            &sender.display_name,
            &receiver.display_name,
            batch.sequence,
            valid_until,
        );
        check_ed25519_instruction(&verification, &[sender.wallet, receiver.wallet], &message)?;

        // Only the open batch (sequence 0) can reach this transition.
        batch.sequence += 1;
        batch.handed_over = true;
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(wallet: Pubkey)]
pub struct RegisterParty<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = Party::DISCRIMINATOR.len() + Party::INIT_SPACE,
        seeds = [PARTY_SEED, wallet.as_ref()],
        bump,
    )]
    pub party: Account<'info, Party>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(id: [u8; 16], sender_wallet: Pubkey, receiver_wallet: Pubkey)]
pub struct OpenBatch<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = Batch::DISCRIMINATOR.len() + Batch::INIT_SPACE,
        seeds = [BATCH_SEED, id.as_ref()],
        bump,
    )]
    pub batch: Account<'info, Batch>,
    #[account(seeds = [PARTY_SEED, sender_wallet.as_ref()], bump = sender.bump)]
    pub sender: Account<'info, Party>,
    #[account(seeds = [PARTY_SEED, receiver_wallet.as_ref()], bump = receiver.bump)]
    pub receiver: Account<'info, Party>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(id: [u8; 16])]
pub struct Handover<'info> {
    #[account(
        mut,
        seeds = [BATCH_SEED, id.as_ref()],
        bump = batch.bump,
        has_one = sender,
        has_one = receiver,
    )]
    pub batch: Account<'info, Batch>,
    pub sender: Account<'info, Party>,
    pub receiver: Account<'info, Party>,
    /// CHECK: The address constraint selects the runtime's instructions sysvar.
    #[account(address = sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
}
