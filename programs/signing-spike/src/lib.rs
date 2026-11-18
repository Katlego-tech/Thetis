use anchor_lang::prelude::*;

mod error;
mod state;

use error::SigningError;
pub use state::{Batch, Party};

declare_id!("EH7cQ4xmoJ92v2y1JW1xHwVQgtCNvkkVka3jiK1ByQnb");

const PARTY_SEED: &[u8] = b"party";
const BATCH_SEED: &[u8] = b"batch";
const PS_SIGNER_SEED: &[u8] = b"programmatic-signer";
const ED25519_SIGNER: Pubkey = pubkey!("EdSigVfK1DkeMrjFNDMjwfQaJPhPTtX7jW8uPv3oKEgN");

#[program]
pub mod signing_spike {
    use super::*;

    pub fn register_party(ctx: Context<RegisterParty>, wallet: Pubkey) -> Result<()> {
        let (ps_signer, _) =
            Pubkey::find_program_address(&[PS_SIGNER_SEED, wallet.as_ref()], &ED25519_SIGNER);
        ctx.accounts.party.set_inner(Party {
            wallet,
            ps_signer,
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
    ) -> Result<()> {
        require_keys_neq!(sender_wallet, receiver_wallet, SigningError::SameParty);
        require_gt!(quantity_kg, 0, SigningError::ZeroQuantity);
        ctx.accounts.batch.set_inner(Batch {
            id,
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
        expiry_slot: u64,
        expected_sequence: u64,
    ) -> Result<()> {
        require!(Clock::get()?.slot <= expiry_slot, SigningError::Expired);
        let batch = &mut ctx.accounts.batch;
        require_eq!(
            expected_sequence,
            batch.sequence,
            SigningError::StaleSequence
        );
        require_eq!(
            quantity_kg,
            batch.quantity_kg,
            SigningError::QuantityMismatch
        );
        require!(!batch.handed_over, SigningError::AlreadyHandedOver);

        // Opening starts the sequence at zero and this is its only transition.
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
        has_one = sender @ SigningError::WrongSigner,
        has_one = receiver @ SigningError::WrongSigner,
    )]
    pub batch: Account<'info, Batch>,
    pub sender: Account<'info, Party>,
    pub receiver: Account<'info, Party>,
    /// CHECK: The registered PDA must have signer privilege for this instruction.
    #[account(signer @ SigningError::WrongSigner, address = sender.ps_signer @ SigningError::WrongSigner)]
    pub sender_signer: UncheckedAccount<'info>,
    /// CHECK: The registered PDA must have signer privilege for this instruction.
    #[account(signer @ SigningError::WrongSigner, address = receiver.ps_signer @ SigningError::WrongSigner)]
    pub receiver_signer: UncheckedAccount<'info>,
}
