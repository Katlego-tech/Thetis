use anchor_lang::prelude::*;

pub mod error;
pub mod events;
pub mod instructions;
pub mod intent;
pub mod state;

use instructions::setup::{self, *};
use state::{Role, SettlementMode};

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
}
