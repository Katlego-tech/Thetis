//! Shipments: the owner prepares a shipment of a whole lot to another accredited site, reserving
//! the destination's capacity and committing the batch manifest as one Merkle root; any payer
//! then registers each batch with its proof; the owner may cancel before any batch departs.

use anchor_lang::{
    prelude::*,
    solana_program::instruction::{get_stack_height, TRANSACTION_LEVEL_STACK_HEIGHT},
};

use crate::{
    error::ThetisError,
    events::{BatchRegistered, ShipmentCancelled, ShipmentPrepared},
    intent::{
        message::{cancel_shipment_message, prepare_shipment_message},
        verify::{check_ed25519_instruction, previous_instruction},
    },
    manifest::{batch_leaf, verify_batch, DEPTH},
    state::*,
    validate::{check_lending_authority, nonzero_digest, CUSTODY_WINDOW_SECS},
};

#[derive(Accounts)]
#[instruction(shipment_id: [u8; 16])]
pub struct PrepareShipment<'info> {
    #[account(mut)]
    pub sponsor: Signer<'info>,
    pub protocol: Box<Account<'info, Protocol>>,
    pub owner_org: Box<Account<'info, Organisation>>,
    pub owner_authority: Box<Account<'info, Authority>>,
    #[account(mut)]
    pub lot: Box<Account<'info, Lot>>,
    #[account(mut)]
    pub position: Box<Account<'info, Position>>,
    pub source_class: Box<Account<'info, CustodianClass>>,
    // Allow the handler to refuse a destination equal to the source with InvalidField.
    #[account(mut, dup)]
    pub destination_class: Box<Account<'info, CustodianClass>>,
    pub destination_org: Box<Account<'info, Organisation>>,
    pub departure_document: Box<Account<'info, DocumentAttestation>>,
    pub departure_issuer: Box<Account<'info, Organisation>>,
    #[account(
        init,
        payer = sponsor,
        space = Shipment::DISCRIMINATOR.len() + Shipment::INIT_SPACE,
        seeds = [b"shipment", protocol.key().as_ref(), shipment_id.as_ref()],
        bump,
    )]
    pub shipment: Box<Account<'info, Shipment>>,
    /// CHECK: The address constraint pins the Instructions sysvar.
    #[account(address = solana_sdk_ids::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(index: u8, quantity_kg: u64, carrier: Pubkey, load_digest: [u8; 32])]
pub struct RegisterBatch<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub protocol: Box<Account<'info, Protocol>>,
    #[account(mut)]
    pub shipment: Box<Account<'info, Shipment>>,
    // The load identity is the seed: one trip's consignment is registered once per protocol.
    #[account(
        init,
        payer = payer,
        space = ManifestBatch::DISCRIMINATOR.len() + ManifestBatch::INIT_SPACE,
        seeds = [b"batch", protocol.key().as_ref(), load_digest.as_ref()],
        bump,
    )]
    pub batch: Box<Account<'info, ManifestBatch>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelShipment<'info> {
    #[account(mut)]
    pub sponsor: Signer<'info>,
    pub protocol: Box<Account<'info, Protocol>>,
    pub owner_org: Box<Account<'info, Organisation>>,
    pub owner_authority: Box<Account<'info, Authority>>,
    #[account(mut)]
    pub lot: Box<Account<'info, Lot>>,
    #[account(mut)]
    pub shipment: Box<Account<'info, Shipment>>,
    #[account(mut)]
    pub destination_class: Box<Account<'info, CustodianClass>>,
    pub destination_org: Box<Account<'info, Organisation>>,
    /// CHECK: The address constraint pins the Instructions sysvar.
    #[account(address = solana_sdk_ids::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
}

fn require_top_level() -> Result<()> {
    require_eq!(
        get_stack_height(),
        TRANSACTION_LEVEL_STACK_HEIGHT,
        ThetisError::NotTopLevel
    );
    Ok(())
}

/// The custody signing window: not expired, and at most 600 s ahead.
fn check_custody_window(now: i64, valid_until: i64) -> Result<()> {
    require!(now <= valid_until, ThetisError::Expired);
    let window = valid_until
        .checked_sub(now)
        .ok_or(ThetisError::WindowTooLong)?;
    require!(window <= CUSTODY_WINDOW_SECS, ThetisError::WindowTooLong);
    Ok(())
}

fn add(a: u64, b: u64) -> Result<u64> {
    a.checked_add(b)
        .ok_or_else(|| error!(ThetisError::ArithmeticOverflow))
}

fn sub(a: u64, b: u64) -> Result<u64> {
    a.checked_sub(b)
        .ok_or_else(|| error!(ThetisError::ArithmeticOverflow))
}

/// A departure document is usable for `lot` when it belongs to the protocol, is of kind
/// `Departure`, names the lot's address as its subject, has a non-zero hash, and is neither
/// revoked nor expired. Shipments check it at prepare, and each batch's departure rechecks it.
pub fn check_departure_document(
    doc: &DocumentAttestation,
    protocol: Pubkey,
    lot: Pubkey,
    now: i64,
) -> Result<()> {
    require!(
        doc.protocol == protocol
            && doc.kind == DocumentKind::Departure
            && doc.subject == lot.to_bytes()
            && nonzero_digest(&doc.sha256)
            && doc.revoked_at.is_none()
            && doc.valid_until > now,
        ThetisError::DepartureDocumentInvalid
    );
    Ok(())
}

pub fn prepare_shipment(
    ctx: Context<PrepareShipment>,
    shipment_id: [u8; 16],
    batch_count: u8,
    manifest_root: [u8; 32],
    expected_revision: u64,
    valid_until: i64,
) -> Result<()> {
    let accounts = ctx.accounts;
    let protocol = &accounts.protocol;
    let protocol_key = protocol.key();

    // Step 1: top level, then the pause bit.
    require_top_level()?;
    require!(protocol.pause_flags & pause::SHIP == 0, ThetisError::Paused);

    // Step 2: freshness and the custody signing window.
    let now = Clock::get()?.unix_timestamp;
    check_custody_window(now, valid_until)?;

    // Step 3: the owner's Authority, the protocol rule, then the bindings.
    let owner_org = &accounts.owner_org;
    let owner_authority = &accounts.owner_authority;
    let lot = &accounts.lot;
    let position = &accounts.position;
    let source_class = &accounts.source_class;
    let destination_class = &accounts.destination_class;
    let destination_org = &accounts.destination_org;
    check_lending_authority(
        owner_authority,
        protocol_key,
        position.owner,
        None,
        owner_org,
        scope::SHIP,
        now,
    )?;
    require!(
        lot.protocol == protocol_key
            && position.protocol == protocol_key
            && source_class.protocol == protocol_key
            && destination_class.protocol == protocol_key
            && destination_org.protocol == protocol_key,
        ThetisError::WrongOrganisation
    );
    let lot_key = lot.key();
    let destination_key = destination_class.key();
    require!(
        position.lot == lot_key
            && lot.custodian_class == source_class.key()
            && destination_class.custodian == destination_org.key(),
        ThetisError::WrongOrganisation
    );

    // Step 4: the lot's revision.
    require_eq!(lot.revision, expected_revision, ThetisError::StaleRevision);

    // Step 5: refusals. Everything is computed into temporaries; nothing is written yet.
    require!(lot.state == LotState::Stored, ThetisError::LotNotStored);
    require!(
        lot.restriction == Restriction::Normal,
        ThetisError::Restricted
    );
    require!(
        position.quantity_kg == lot.supply_kg,
        ThetisError::NotSoleHolder
    );
    require!(
        destination_key != source_class.key(),
        ThetisError::InvalidField
    );
    require!(
        destination_class.class_policy == lot.class_policy,
        ThetisError::DestinationNotEligible
    );
    require!(
        !destination_org.related.contains(&owner_org.key())
            && !owner_org.related.contains(&destination_org.key()),
        ThetisError::RelatedCustodian
    );
    require!(
        (1..=MAX_BATCHES).contains(&batch_count) && nonzero_digest(&manifest_root),
        ThetisError::InvalidField
    );
    let document = &accounts.departure_document;
    let issuer = &accounts.departure_issuer;
    check_departure_document(document, protocol_key, lot_key, now)?;
    require!(
        issuer.key() == document.issuer
            && issuer.protocol == protocol_key
            && (issuer.role == Role::DocumentIssuer || issuer.key() == source_class.custodian),
        ThetisError::DepartureDocumentInvalid
    );
    let committed_kg = lot.supply_kg;
    let booked = add(
        add(
            destination_class.occupied_kg,
            destination_class.reserved_inbound_kg,
        )?,
        committed_kg,
    )?;
    require!(
        booked <= destination_class.approved_capacity_kg,
        ThetisError::OverCapacity
    );
    let lot_revision = add(lot.revision, 1)?;
    let position_revision = add(position.revision, 1)?;
    let reserved_inbound_kg = add(destination_class.reserved_inbound_kg, committed_kg)?;

    // Step 6: the owner signed this exact shipment.
    let text = prepare_shipment_message(
        ctx.program_id,
        &protocol.instance_id,
        &lot.lot_id,
        &shipment_id,
        committed_kg,
        &owner_org.display_name,
        &destination_org.display_name,
        &destination_class.site_code,
        batch_count,
        &manifest_root,
        (&document.sha256, document.version),
        expected_revision,
        valid_until,
    );
    let verification = previous_instruction(&accounts.instructions)?;
    check_ed25519_instruction(&verification, &[owner_authority.wallet], &text)?;

    // Step 7: write and emit.
    let owner_key = owner_org.key();
    let position_key = position.key();
    let source_key = source_class.key();
    let source_custodian = source_class.custodian;
    let destination_custodian = destination_class.custodian;
    let locked_kg = position.locked_kg;
    let document_key = document.key();
    let shipment = &mut accounts.shipment;
    let shipment_key = shipment.key();
    shipment.set_inner(Shipment {
        protocol: protocol_key,
        shipment_id,
        lot: lot_key,
        position: position_key,
        owner: owner_key,
        source: source_key,
        source_custodian,
        destination: destination_key,
        destination_custodian,
        committed_kg,
        locked_kg,
        batch_count,
        manifest_root,
        departure_document: document_key,
        registered_count: 0,
        registered_kg: 0,
        departed_count: 0,
        departed_kg: 0,
        arrived_count: 0,
        arrived_kg: 0,
        status: ShipmentStatus::Prepared,
        prepared_at: now,
        revision: 0,
        bump: ctx.bumps.shipment,
    });
    accounts.destination_class.reserved_inbound_kg = reserved_inbound_kg;
    let lot = &mut accounts.lot;
    lot.state = LotState::Prepared;
    lot.revision = lot_revision;
    accounts.position.revision = position_revision;
    emit!(ShipmentPrepared {
        shipment: shipment_key,
        lot: lot_key,
        owner: owner_key,
        source: source_key,
        destination: destination_key,
        committed_kg,
        locked_kg,
        batch_count,
        manifest_root,
        departure_document: document_key,
        lot_revision,
        position_revision,
    });
    Ok(())
}

pub fn register_batch(
    ctx: Context<RegisterBatch>,
    index: u8,
    quantity_kg: u64,
    carrier: Pubkey,
    load_digest: [u8; 32],
    manifest_digest: [u8; 32],
    proof: [[u8; 32]; DEPTH],
) -> Result<()> {
    let accounts = ctx.accounts;
    let protocol_key = accounts.protocol.key();

    // Step 1: top level; registration is never paused. Step 2: Anchor checked the payer.
    require_top_level()?;

    // Step 3: the protocol rule.
    let shipment = &accounts.shipment;
    require!(
        shipment.protocol == protocol_key,
        ThetisError::WrongOrganisation
    );

    // Step 5: refusals. The owner authorised the leaf through the signed root.
    require!(
        shipment.status == ShipmentStatus::Prepared,
        ThetisError::ShipmentNotOpen
    );
    require!(index < shipment.batch_count, ThetisError::InvalidField);
    require!(quantity_kg > 0, ThetisError::ZeroQuantity);
    require!(
        carrier != Pubkey::default()
            && nonzero_digest(&load_digest)
            && nonzero_digest(&manifest_digest),
        ThetisError::InvalidField
    );
    let leaf = batch_leaf(index, quantity_kg, &carrier, &load_digest, &manifest_digest);
    require!(
        verify_batch(&shipment.manifest_root, index, leaf, &proof),
        ThetisError::ManifestMismatch
    );
    let registered_kg = add(shipment.registered_kg, quantity_kg)?;
    let registered_count = shipment
        .registered_count
        .checked_add(1)
        .ok_or(ThetisError::ArithmeticOverflow)?;
    require!(
        registered_kg <= shipment.committed_kg
            && (registered_count != shipment.batch_count || registered_kg == shipment.committed_kg),
        ThetisError::BatchSumMismatch
    );

    // Step 6: write and emit.
    let shipment_key = shipment.key();
    let lot_key = shipment.lot;
    let batch_count = shipment.batch_count;
    let holder = shipment.source_custodian;
    let batch = &mut accounts.batch;
    let batch_key = batch.key();
    batch.set_inner(ManifestBatch {
        protocol: protocol_key,
        shipment: shipment_key,
        lot: lot_key,
        index,
        batch_count,
        quantity_kg,
        carrier,
        load_digest,
        manifest_digest,
        holder,
        stage: BatchStage::AtSource,
        sequence: 0,
        observation_count: 0,
        departed_at: None,
        arrived_at: None,
        bump: ctx.bumps.batch,
    });
    let shipment = &mut accounts.shipment;
    shipment.registered_count = registered_count;
    shipment.registered_kg = registered_kg;
    emit!(BatchRegistered {
        batch: batch_key,
        shipment: shipment_key,
        index,
        quantity_kg,
        carrier,
        load_digest,
        manifest_digest,
        registered_count,
    });
    Ok(())
}

pub fn cancel_shipment(
    ctx: Context<CancelShipment>,
    expected_revision: u64,
    valid_until: i64,
) -> Result<()> {
    let accounts = ctx.accounts;
    let protocol = &accounts.protocol;
    let protocol_key = protocol.key();

    // Step 1: top level; cancellation reduces risk and is never paused.
    require_top_level()?;

    // Step 2: freshness and the custody signing window.
    let now = Clock::get()?.unix_timestamp;
    check_custody_window(now, valid_until)?;

    // Step 3: the owner's Authority, the protocol rule, then the bindings.
    let owner_org = &accounts.owner_org;
    let owner_authority = &accounts.owner_authority;
    let lot = &accounts.lot;
    let shipment = &accounts.shipment;
    let destination_class = &accounts.destination_class;
    let destination_org = &accounts.destination_org;
    check_lending_authority(
        owner_authority,
        protocol_key,
        shipment.owner,
        None,
        owner_org,
        scope::SHIP,
        now,
    )?;
    require!(
        lot.protocol == protocol_key
            && shipment.protocol == protocol_key
            && destination_class.protocol == protocol_key
            && destination_org.protocol == protocol_key,
        ThetisError::WrongOrganisation
    );
    let lot_key = lot.key();
    require!(
        shipment.lot == lot_key
            && shipment.destination == destination_class.key()
            && destination_class.custodian == destination_org.key(),
        ThetisError::WrongOrganisation
    );

    // Step 4: the shipment's revision.
    require_eq!(
        shipment.revision,
        expected_revision,
        ThetisError::StaleRevision
    );

    // Step 5: refusals, then the writes computed into temporaries.
    require!(
        shipment.status != ShipmentStatus::InTransit,
        ThetisError::ShipmentDeparted
    );
    require!(
        shipment.status == ShipmentStatus::Prepared,
        ThetisError::ShipmentNotOpen
    );
    let released_kg = shipment.committed_kg;
    let reserved_inbound_kg = sub(destination_class.reserved_inbound_kg, released_kg)?;
    let lot_revision = add(lot.revision, 1)?;
    let revision = add(shipment.revision, 1)?;

    // Step 6: the owner signed this exact cancellation.
    let text = cancel_shipment_message(
        ctx.program_id,
        &protocol.instance_id,
        &lot.lot_id,
        &shipment.shipment_id,
        &owner_org.display_name,
        &destination_org.display_name,
        &destination_class.site_code,
        expected_revision,
        valid_until,
    );
    let verification = previous_instruction(&accounts.instructions)?;
    check_ed25519_instruction(&verification, &[owner_authority.wallet], &text)?;

    // Step 7: write and emit. Registered batches stay as tombstones.
    let shipment_key = shipment.key();
    accounts.destination_class.reserved_inbound_kg = reserved_inbound_kg;
    let lot = &mut accounts.lot;
    lot.state = LotState::Stored;
    lot.revision = lot_revision;
    let shipment = &mut accounts.shipment;
    shipment.status = ShipmentStatus::Cancelled;
    shipment.revision = revision;
    emit!(ShipmentCancelled {
        shipment: shipment_key,
        lot: lot_key,
        released_kg,
        lot_revision,
        revision,
    });
    Ok(())
}
