//! Shortfalls and restrictions. An inspector with `INSPECT` signs a shortfall reading of a lot,
//! or of one of its batches: the program records an Incident and, when the reading is outside
//! the stated tolerance, moves a `Normal` lot to `ReviewRequired`. It never lowers a restriction
//! and never touches a bond, loan, lock, pool or position. The protocol accreditor sets a lot's
//! restriction to any other value with a reason digest. Neither is ever paused.

use anchor_lang::prelude::*;

use crate::{
    error::ThetisError,
    events::{RestrictionSet, ShortfallAttested},
    instructions::shipment::{add, check_custody_window, require_top_level},
    intent::{
        message::shortfall_message,
        verify::{check_ed25519_instruction, previous_instruction},
    },
    state::*,
    validate::{check_lending_authority, nonzero_digest, valid_code},
};

#[derive(Accounts)]
#[instruction(incident_id: [u8; 16])]
pub struct AttestShortfall<'info> {
    #[account(mut)]
    pub sponsor: Signer<'info>,
    pub protocol: Box<Account<'info, Protocol>>,
    pub inspector_org: Box<Account<'info, Organisation>>,
    pub inspector_authority: Box<Account<'info, Authority>>,
    #[account(mut)]
    pub lot: Box<Account<'info, Lot>>,
    pub batch: Option<Box<Account<'info, ManifestBatch>>>,
    #[account(
        init,
        payer = sponsor,
        space = Incident::DISCRIMINATOR.len() + Incident::INIT_SPACE,
        seeds = [b"incident", protocol.key().as_ref(), incident_id.as_ref()],
        bump,
    )]
    pub incident: Box<Account<'info, Incident>>,
    /// CHECK: The address constraint pins the Instructions sysvar.
    #[account(address = solana_sdk_ids::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetRestriction<'info> {
    pub accreditor: Signer<'info>,
    pub protocol: Box<Account<'info, Protocol>>,
    #[account(mut)]
    pub lot: Box<Account<'info, Lot>>,
}

fn retired(state: LotState) -> bool {
    matches!(state, LotState::Redeemed | LotState::Loaded)
}

/// `shortfall × 10,000 <= expected × tolerance`, both products in `u128` (a `u64` times 10,000
/// cannot overflow it). The caller guarantees `observed_kg < expected_kg`.
fn within_tolerance(expected_kg: u64, observed_kg: u64, tolerance_bps: u16) -> bool {
    u128::from(expected_kg - observed_kg) * 10_000
        <= u128::from(expected_kg) * u128::from(tolerance_bps)
}

#[allow(
    clippy::too_many_arguments,
    reason = "the arguments are the signed shortfall contract"
)]
pub fn attest_shortfall(
    ctx: Context<AttestShortfall>,
    incident_id: [u8; 16],
    observed_kg: u64,
    tolerance_bps: u16,
    method_code: String,
    evidence_digest: [u8; 32],
    observed_at: i64,
    valid_until: i64,
) -> Result<()> {
    let accounts = ctx.accounts;
    let protocol = &accounts.protocol;
    let protocol_key = protocol.key();

    // Step 1: top level (no pause bit: recording a fact is never paused).
    require_top_level()?;

    // Step 2: freshness and the custody signing window.
    let now = Clock::get()?.unix_timestamp;
    check_custody_window(now, valid_until)?;

    // Step 3: the inspector's Authority, the protocol rule (the batch when passed), then the
    // batch's lot.
    let inspector_org = &accounts.inspector_org;
    let inspector_authority = &accounts.inspector_authority;
    let lot = &accounts.lot;
    let batch = accounts.batch.as_deref();
    let inspector_key = inspector_org.key();
    check_lending_authority(
        inspector_authority,
        protocol_key,
        inspector_key,
        Some(Role::Inspector),
        inspector_org,
        scope::INSPECT,
        now,
    )?;
    require!(
        inspector_org.protocol == protocol_key
            && inspector_authority.protocol == protocol_key
            && lot.protocol == protocol_key
            && batch.is_none_or(|batch| batch.protocol == protocol_key),
        ThetisError::WrongOrganisation
    );
    let lot_key = lot.key();
    require!(
        batch.is_none_or(|batch| batch.lot == lot_key),
        ThetisError::WrongOrganisation
    );

    // Step 5: refusals, then every write computed into temporaries.
    require!(!retired(lot.state), ThetisError::LotRetired);
    require!(
        tolerance_bps <= 10_000
            && valid_code(&method_code, MAX_METHOD_CODE)
            && nonzero_digest(&evidence_digest)
            && (0..=now).contains(&observed_at),
        ThetisError::InvalidField
    );
    let expected_kg = batch.map_or(lot.supply_kg, |batch| batch.quantity_kg);
    require!(observed_kg < expected_kg, ThetisError::InvalidField);
    let within = within_tolerance(expected_kg, observed_kg, tolerance_bps);
    let restricts = !within && lot.restriction == Restriction::Normal;
    let (restriction_after, lot_revision) = if restricts {
        (Restriction::ReviewRequired, add(lot.revision, 1)?)
    } else {
        (lot.restriction, lot.revision)
    };

    // Step 6: the inspector signed this exact reading.
    let batch_line = match batch {
        Some(batch) => Some((
            batch
                .index
                .checked_add(1)
                .ok_or(ThetisError::ArithmeticOverflow)?,
            batch.batch_count,
            &batch.load_digest,
        )),
        None => None,
    };
    let text = shortfall_message(
        ctx.program_id,
        &protocol.instance_id,
        &lot.lot_id,
        &incident_id,
        batch_line,
        &inspector_org.display_name,
        &method_code,
        expected_kg,
        observed_kg,
        tolerance_bps,
        &evidence_digest,
        observed_at,
        valid_until,
    );
    let verification = previous_instruction(&accounts.instructions)?;
    check_ed25519_instruction(&verification, &[inspector_authority.wallet], &text)?;

    // Step 7: write and emit.
    let batch_key = batch.map(|batch| batch.key());
    let incident_key = accounts.incident.key();
    accounts.incident.set_inner(Incident {
        protocol: protocol_key,
        incident_id,
        lot: lot_key,
        batch: batch_key,
        inspector: inspector_key,
        method_code,
        expected_kg,
        observed_kg,
        tolerance_bps,
        within_tolerance: within,
        evidence_digest,
        observed_at,
        restriction_after,
        status: IncidentStatus::Open,
        bump: ctx.bumps.incident,
    });
    let lot = &mut accounts.lot;
    lot.restriction = restriction_after;
    lot.revision = lot_revision;
    emit!(ShortfallAttested {
        incident: incident_key,
        lot: lot_key,
        batch: batch_key,
        inspector: inspector_key,
        expected_kg,
        observed_kg,
        tolerance_bps,
        within_tolerance: within,
        restriction: restriction_after,
        lot_revision,
    });
    Ok(())
}

pub fn set_restriction(
    ctx: Context<SetRestriction>,
    restriction: Restriction,
    reason_digest: [u8; 32],
) -> Result<()> {
    let accounts = ctx.accounts;
    let protocol_key = accounts.protocol.key();

    // Step 1: top level. Setting a restriction is never paused.
    require_top_level()?;

    // Step 2: the signer is the protocol accreditor.
    require_keys_eq!(
        accounts.accreditor.key(),
        accounts.protocol.accreditor,
        ThetisError::NotAccreditor
    );

    // Step 3: the protocol rule.
    require_keys_eq!(
        accounts.lot.protocol,
        protocol_key,
        ThetisError::WrongOrganisation
    );

    // Step 5: refusals, then the revision computed into a temporary.
    let lot = &accounts.lot;
    require!(!retired(lot.state), ThetisError::LotRetired);
    require!(
        restriction != lot.restriction && nonzero_digest(&reason_digest),
        ThetisError::InvalidField
    );
    let revision = add(lot.revision, 1)?;

    // Step 6: write and emit.
    let lot_key = lot.key();
    let from = lot.restriction;
    let lot = &mut accounts.lot;
    lot.restriction = restriction;
    lot.revision = revision;
    emit!(RestrictionSet {
        lot: lot_key,
        from,
        to: restriction,
        reason_digest,
        revision,
    });
    Ok(())
}
