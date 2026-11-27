//! Custody observation: an observer with `OBSERVE` signs that one batch was seen at a checkpoint
//! or crossing a border. The record is the `ObservationRecorded` event plus the batch's
//! `observation_count`; the holder, stage, sequence, lot and shipment never change. A `Border`
//! observation is recorded only by a Transporter or a Terminal; a `Checkpoint` by a Custodian,
//! Transporter, Terminal or Inspector. Observations are never paused.

use anchor_lang::prelude::*;

use crate::{
    error::ThetisError,
    events::ObservationRecorded,
    instructions::shipment::{check_custody_window, require_top_level},
    intent::{
        message::observation_message,
        verify::{check_ed25519_instruction, previous_instruction},
    },
    state::*,
    validate::{check_lending_authority, valid_code},
};

/// `location_code` is `[A-Z0-9-]`, 1 to 16 bytes.
const MAX_LOCATION_CODE: usize = 16;

#[derive(Accounts)]
pub struct RecordObservation<'info> {
    #[account(mut)]
    pub sponsor: Signer<'info>,
    pub protocol: Box<Account<'info, Protocol>>,
    pub observer_org: Box<Account<'info, Organisation>>,
    pub observer_authority: Box<Account<'info, Authority>>,
    pub holder_org: Box<Account<'info, Organisation>>,
    pub shipment: Box<Account<'info, Shipment>>,
    #[account(mut)]
    pub batch: Box<Account<'info, ManifestBatch>>,
    pub lot: Box<Account<'info, Lot>>,
    /// CHECK: The address constraint pins the Instructions sysvar.
    #[account(address = solana_sdk_ids::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
}

/// Whether an organisation of `role` may record an observation of `kind`.
fn may_observe(kind: ObservationKind, role: Role) -> bool {
    match kind {
        ObservationKind::Border => matches!(role, Role::Transporter | Role::Terminal),
        ObservationKind::Checkpoint => matches!(
            role,
            Role::Custodian | Role::Transporter | Role::Terminal | Role::Inspector
        ),
    }
}

pub fn record_observation(
    ctx: Context<RecordObservation>,
    kind: ObservationKind,
    location_code: String,
    evidence_digest: [u8; 32],
    observed_at: i64,
    expected_observation: u32,
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

    // Step 3: the observer's Authority, then (before the protocol rule) the role by kind, the
    // protocol rule, then the bindings.
    let observer_org = &accounts.observer_org;
    let observer_authority = &accounts.observer_authority;
    let holder_org = &accounts.holder_org;
    let shipment = &accounts.shipment;
    let batch = &accounts.batch;
    let lot = &accounts.lot;
    let observer_key = observer_org.key();
    check_lending_authority(
        observer_authority,
        protocol_key,
        observer_key,
        None,
        observer_org,
        scope::OBSERVE,
        now,
    )?;
    require!(may_observe(kind, observer_org.role), ThetisError::WrongRole);
    require!(
        observer_org.protocol == protocol_key
            && observer_authority.protocol == protocol_key
            && holder_org.protocol == protocol_key
            && shipment.protocol == protocol_key
            && batch.protocol == protocol_key
            && lot.protocol == protocol_key,
        ThetisError::WrongOrganisation
    );
    let shipment_key = shipment.key();
    let lot_key = lot.key();
    let holder_key = holder_org.key();
    require!(
        batch.shipment == shipment_key && shipment.lot == lot_key && holder_key == batch.holder,
        ThetisError::WrongOrganisation
    );

    // Step 4: the batch's observation counter.
    require_eq!(
        batch.observation_count,
        expected_observation,
        ThetisError::StaleRevision
    );

    // Step 5: refusals, then the write computed into a temporary.
    require!(
        shipment.status != ShipmentStatus::Cancelled,
        ThetisError::ShipmentNotOpen
    );
    require!(
        valid_code(&location_code, MAX_LOCATION_CODE)
            && evidence_digest != [0; 32]
            && (0..=now).contains(&observed_at),
        ThetisError::InvalidField
    );
    let observation_count = batch
        .observation_count
        .checked_add(1)
        .ok_or(ThetisError::ArithmeticOverflow)?;

    // Step 6: the observer signed this exact observation.
    let text = observation_message(
        ctx.program_id,
        &protocol.instance_id,
        &lot.lot_id,
        &shipment.shipment_id,
        batch
            .index
            .checked_add(1)
            .ok_or(ThetisError::ArithmeticOverflow)?,
        batch.batch_count,
        &holder_org.display_name,
        &observer_org.display_name,
        kind,
        &location_code,
        &evidence_digest,
        observed_at,
        expected_observation,
        valid_until,
    );
    let verification = previous_instruction(&accounts.instructions)?;
    check_ed25519_instruction(&verification, &[observer_authority.wallet], &text)?;

    // Step 7: write and emit.
    let batch = &mut accounts.batch;
    let batch_key = batch.key();
    batch.observation_count = observation_count;
    emit!(ObservationRecorded {
        batch: batch_key,
        shipment: shipment_key,
        lot: lot_key,
        observer: observer_key,
        holder: holder_key,
        kind,
        location_code,
        evidence_digest,
        observed_at,
        index: expected_observation,
    });
    Ok(())
}
