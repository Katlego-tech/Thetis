//! Custody handover: the current holder of a batch and the next holder sign one text, and the
//! program moves the batch to the next holder. The stage is derived from the batch's stage and
//! the recipient: a departure goes only to the batch's carrier and rechecks the departure
//! document; an arrival goes only to the destination custodian and turns that batch's share of
//! the reservation into occupancy; the lot returns to `Stored` at the destination when its last
//! batch arrives.

use anchor_lang::prelude::*;

use crate::{
    error::ThetisError,
    events::CustodyHandedOver,
    instructions::shipment::{
        add, check_custody_window, check_departure_document, require_top_level, sub,
    },
    intent::{
        message::custody_handover_message,
        verify::{check_ed25519_instruction, previous_instruction},
    },
    state::*,
    validate::check_lending_authority,
};

#[derive(Accounts)]
#[instruction(manifest_digest: [u8; 32], expected_sequence: u64)]
pub struct Handover<'info> {
    #[account(mut)]
    pub sponsor: Signer<'info>,
    pub protocol: Box<Account<'info, Protocol>>,
    #[account(mut)]
    pub shipment: Box<Account<'info, Shipment>>,
    #[account(mut)]
    pub batch: Box<Account<'info, ManifestBatch>>,
    #[account(mut)]
    pub lot: Box<Account<'info, Lot>>,
    pub from_org: Box<Account<'info, Organisation>>,
    pub from_authority: Box<Account<'info, Authority>>,
    pub to_org: Box<Account<'info, Organisation>>,
    pub to_authority: Box<Account<'info, Authority>>,
    #[account(mut)]
    pub source_class: Box<Account<'info, CustodianClass>>,
    #[account(mut)]
    pub destination_class: Box<Account<'info, CustodianClass>>,
    pub departure_document: Option<Box<Account<'info, DocumentAttestation>>>,
    // The sequence the handover consumes is the seed, so a used sequence fails here.
    #[account(
        init,
        payer = sponsor,
        space = HandoverRecord::DISCRIMINATOR.len() + HandoverRecord::INIT_SPACE,
        seeds = [b"handover", batch.key().as_ref(), &expected_sequence.to_le_bytes()],
        bump,
    )]
    pub handover: Box<Account<'info, HandoverRecord>>,
    /// CHECK: The address constraint pins the Instructions sysvar.
    #[account(address = solana_sdk_ids::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handover(
    ctx: Context<Handover>,
    manifest_digest: [u8; 32],
    expected_sequence: u64,
    valid_until: i64,
) -> Result<()> {
    let accounts = ctx.accounts;
    let protocol = &accounts.protocol;
    let protocol_key = protocol.key();

    // Step 1: top level, then the pause bit.
    require_top_level()?;
    require!(
        protocol.pause_flags & pause::HANDOVER == 0,
        ThetisError::Paused
    );

    // Step 2: freshness and the custody signing window.
    let now = Clock::get()?.unix_timestamp;
    check_custody_window(now, valid_until)?;

    // Step 3: both Authorities (the sender must hold the batch), the protocol rule, then the
    // bindings.
    let shipment = &accounts.shipment;
    let batch = &accounts.batch;
    let lot = &accounts.lot;
    let from_org = &accounts.from_org;
    let from_authority = &accounts.from_authority;
    let to_org = &accounts.to_org;
    let to_authority = &accounts.to_authority;
    let source_class = &accounts.source_class;
    let destination_class = &accounts.destination_class;
    check_lending_authority(
        from_authority,
        protocol_key,
        batch.holder,
        None,
        from_org,
        scope::CARRY,
        now,
    )?;
    let to_key = to_org.key();
    check_lending_authority(
        to_authority,
        protocol_key,
        to_key,
        None,
        to_org,
        scope::CARRY,
        now,
    )?;
    require!(
        shipment.protocol == protocol_key
            && batch.protocol == protocol_key
            && lot.protocol == protocol_key
            && source_class.protocol == protocol_key
            && destination_class.protocol == protocol_key,
        ThetisError::WrongOrganisation
    );
    let shipment_key = shipment.key();
    let lot_key = lot.key();
    let destination_key = destination_class.key();
    require!(
        batch.shipment == shipment_key
            && shipment.lot == lot_key
            && shipment.source == source_class.key()
            && shipment.destination == destination_key,
        ThetisError::WrongOrganisation
    );

    // Step 4: the batch's handover counter (a past sequence already failed at init).
    require_eq!(
        batch.sequence,
        expected_sequence,
        ThetisError::StaleRevision
    );

    // Step 5: refusals, then every write computed into temporaries.
    require!(
        matches!(
            shipment.status,
            ShipmentStatus::Prepared | ShipmentStatus::InTransit
        ),
        ThetisError::ShipmentNotOpen
    );
    require!(
        batch.stage != BatchStage::Arrived,
        ThetisError::StageOutOfOrder
    );
    require!(
        shipment.registered_count >= shipment.batch_count,
        ThetisError::ShipmentIncomplete
    );
    require!(
        lot.restriction != Restriction::Frozen,
        ThetisError::Restricted
    );
    let from_key = from_org.key();
    require!(to_key != from_key, ThetisError::InvalidField);
    let stage = match batch.stage {
        BatchStage::AtSource if to_org.role == Role::Transporter && to_key == batch.carrier => {
            HandoverStage::Departure
        }
        BatchStage::InTransit if to_key == shipment.destination_custodian => HandoverStage::Arrival,
        BatchStage::InTransit if to_org.role == Role::Transporter => HandoverStage::Transfer,
        _ => return err!(ThetisError::RecipientNotApproved),
    };
    require!(
        manifest_digest == batch.manifest_digest,
        ThetisError::ManifestMismatch
    );
    if stage == HandoverStage::Departure {
        let document = accounts
            .departure_document
            .as_ref()
            .filter(|document| document.key() == shipment.departure_document)
            .ok_or(ThetisError::DepartureDocumentInvalid)?;
        check_departure_document(document, protocol_key, lot_key, now)?;
    }
    let q = batch.quantity_kg;
    let sequence = add(batch.sequence, 1)?;
    let shipment_revision = add(shipment.revision, 1)?;
    let mut source_occupied = source_class.occupied_kg;
    let mut destination_reserved = destination_class.reserved_inbound_kg;
    let mut destination_occupied = destination_class.occupied_kg;
    let mut departed_count = shipment.departed_count;
    let mut departed_kg = shipment.departed_kg;
    let mut arrived_count = shipment.arrived_count;
    let mut arrived_kg = shipment.arrived_kg;
    let mut shipment_status = shipment.status;
    let mut lot_state = lot.state;
    let mut lot_custodian_class = lot.custodian_class;
    let mut lot_revision = lot.revision;
    match stage {
        HandoverStage::Departure => {
            source_occupied = sub(source_occupied, q)?;
            departed_count = departed_count
                .checked_add(1)
                .ok_or(ThetisError::ArithmeticOverflow)?;
            departed_kg = add(departed_kg, q)?;
            if shipment_status == ShipmentStatus::Prepared {
                lot_revision = add(lot_revision, 1)?;
                shipment_status = ShipmentStatus::InTransit;
                lot_state = LotState::InTransit;
            }
        }
        HandoverStage::Transfer => {}
        HandoverStage::Arrival => {
            destination_reserved = sub(destination_reserved, q)?;
            destination_occupied = add(destination_occupied, q)?;
            arrived_count = arrived_count
                .checked_add(1)
                .ok_or(ThetisError::ArithmeticOverflow)?;
            arrived_kg = add(arrived_kg, q)?;
            if arrived_count == shipment.batch_count {
                lot_revision = add(lot_revision, 1)?;
                shipment_status = ShipmentStatus::Arrived;
                lot_state = LotState::Stored;
                lot_custodian_class = destination_key;
            }
        }
    }

    // Step 6: the holder and the next holder signed this exact handover, holder first.
    let text = custody_handover_message(
        ctx.program_id,
        &protocol.instance_id,
        &lot.lot_id,
        &shipment.shipment_id,
        batch
            .index
            .checked_add(1)
            .ok_or(ThetisError::ArithmeticOverflow)?,
        batch.batch_count,
        q,
        &from_org.display_name,
        &to_org.display_name,
        stage,
        &batch.manifest_digest,
        expected_sequence,
        valid_until,
    );
    let verification = previous_instruction(&accounts.instructions)?;
    check_ed25519_instruction(
        &verification,
        &[from_authority.wallet, to_authority.wallet],
        &text,
    )?;

    // Step 7: write and emit.
    let batch_key = batch.key();
    let from_wallet = from_authority.wallet;
    let to_wallet = to_authority.wallet;
    let record = &mut accounts.handover;
    let record_key = record.key();
    record.set_inner(HandoverRecord {
        protocol: protocol_key,
        batch: batch_key,
        shipment: shipment_key,
        sequence: expected_sequence,
        from: from_key,
        to: to_key,
        from_wallet,
        to_wallet,
        stage,
        quantity_kg: q,
        manifest_digest,
        at: now,
        bump: ctx.bumps.handover,
    });
    let batch = &mut accounts.batch;
    batch.holder = to_key;
    batch.sequence = sequence;
    match stage {
        HandoverStage::Departure => {
            batch.stage = BatchStage::InTransit;
            batch.departed_at = Some(now);
        }
        HandoverStage::Transfer => {}
        HandoverStage::Arrival => {
            batch.stage = BatchStage::Arrived;
            batch.arrived_at = Some(now);
        }
    }
    accounts.source_class.occupied_kg = source_occupied;
    let destination_class = &mut accounts.destination_class;
    destination_class.reserved_inbound_kg = destination_reserved;
    destination_class.occupied_kg = destination_occupied;
    let shipment = &mut accounts.shipment;
    shipment.departed_count = departed_count;
    shipment.departed_kg = departed_kg;
    shipment.arrived_count = arrived_count;
    shipment.arrived_kg = arrived_kg;
    shipment.status = shipment_status;
    shipment.revision = shipment_revision;
    let lot = &mut accounts.lot;
    lot.state = lot_state;
    lot.custodian_class = lot_custodian_class;
    lot.revision = lot_revision;
    emit!(CustodyHandedOver {
        handover: record_key,
        batch: batch_key,
        shipment: shipment_key,
        lot: lot_key,
        sequence: expected_sequence,
        from: from_key,
        to: to_key,
        stage,
        quantity_kg: q,
        shipment_status,
        lot_state,
        shipment_revision,
        lot_revision,
    });
    Ok(())
}
