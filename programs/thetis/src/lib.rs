use anchor_lang::prelude::*;

pub mod error;
pub mod events;
pub mod instructions;
pub mod intent;
mod receipts;
pub mod state;
mod validate;

use instructions::documents::{self, *};
use instructions::issue::{self, *};
use instructions::setup::{self, *};
use instructions::transfer::{self, *};
use state::{DocumentKind, Role, SettlementMode};

declare_id!("jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3");

#[program]
pub mod thetis {
    use super::*;

    pub fn initialize_protocol(
        ctx: Context<InitializeProtocol>,
        instance_id: [u8; 16],
        settlement_mode: SettlementMode,
        admin: Pubkey,
        accreditor: Pubkey,
    ) -> Result<()> {
        setup::initialize_protocol(ctx, instance_id, settlement_mode, admin, accreditor)
    }

    pub fn register_class(
        ctx: Context<RegisterClass>,
        class_code: String,
        version: u32,
        grades: Vec<String>,
        origin_required: bool,
        lot_validity_secs: i64,
        split_inherits_expiry: bool,
    ) -> Result<()> {
        setup::register_class(
            ctx,
            class_code,
            version,
            grades,
            origin_required,
            lot_validity_secs,
            split_inherits_expiry,
        )
    }

    pub fn accredit_organisation(
        ctx: Context<AccreditOrganisation>,
        org_id: [u8; 16],
        role: Role,
        display_name: String,
        admin: Pubkey,
    ) -> Result<()> {
        setup::accredit_organisation(ctx, org_id, role, display_name, admin)
    }

    pub fn declare_relationship(ctx: Context<DeclareRelationship>) -> Result<()> {
        setup::declare_relationship(ctx)
    }

    pub fn delegate_authority(
        ctx: Context<DelegateAuthority>,
        wallet: Pubkey,
        scopes: u16,
        expires_at: i64,
    ) -> Result<()> {
        setup::delegate_authority(ctx, wallet, scopes, expires_at)
    }

    pub fn revoke_authority(ctx: Context<RevokeAuthority>) -> Result<()> {
        setup::revoke_authority(ctx)
    }

    pub fn accredit_custodian_class(
        ctx: Context<AccreditCustodianClass>,
        site_code: String,
        approved_capacity_kg: u64,
    ) -> Result<()> {
        setup::accredit_custodian_class(ctx, site_code, approved_capacity_kg)
    }

    pub fn pause(ctx: Context<SetPause>, flags: u16) -> Result<()> {
        setup::set_pause(ctx, flags, true)
    }

    pub fn unpause(ctx: Context<SetPause>, flags: u16) -> Result<()> {
        setup::set_pause(ctx, flags, false)
    }

    pub fn attest_document(
        ctx: Context<AttestDocument>,
        kind: DocumentKind,
        subject: [u8; 32],
        version: u32,
        sha256: [u8; 32],
        valid_until: i64,
    ) -> Result<()> {
        documents::attest_document(ctx, kind, subject, version, sha256, valid_until)
    }

    pub fn revoke_document(ctx: Context<RevokeDocument>) -> Result<()> {
        documents::revoke_document(ctx)
    }

    pub fn issue_lot(
        ctx: Context<IssueLot>,
        lot_id: String,
        grade: String,
        quantity_kg: u64,
        intake_digest: [u8; 32],
        valid_until: i64,
    ) -> Result<()> {
        issue::issue_lot(ctx, lot_id, grade, quantity_kg, intake_digest, valid_until)
    }

    pub fn transfer(
        ctx: Context<Transfer>,
        quantity_kg: u64,
        expected_revision: u64,
        valid_until: i64,
    ) -> Result<()> {
        transfer::transfer(ctx, quantity_kg, expected_revision, valid_until)
    }
}
