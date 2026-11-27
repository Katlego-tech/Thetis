use anchor_lang::prelude::*;

pub mod error;
pub mod events;
pub mod instructions;
pub mod intent;
pub mod lending_math;
pub mod manifest;
mod receipts;
pub mod state;
pub mod validate;

use instructions::advance::{self, *};
use instructions::documents::{self, *};
use instructions::facility::{self, *};
use instructions::issue::{self, *};
use instructions::payment::{self, *};
use instructions::pledge::{self, *};
use instructions::recovery::{self, *};
use instructions::redeem::{self, *};
use instructions::release::{self, *};
use instructions::setup::{self, *};
use instructions::shipment::{self, *};
use instructions::simulation::{self, *};
use instructions::split::{self, *};
use instructions::transfer::{self, *};
use instructions::valuation::{self, *};
use state::{DocumentKind, PaymentPurpose, Role, SettlementMode};

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

    pub fn split(
        ctx: Context<Split>,
        child_lot_id: String,
        quantity_kg: u64,
        expected_revision: u64,
        valid_until: i64,
    ) -> Result<()> {
        split::split(
            ctx,
            child_lot_id,
            quantity_kg,
            expected_revision,
            valid_until,
        )
    }

    pub fn redeem(
        ctx: Context<Redeem>,
        quantity_kg: u64,
        collection_ticket: [u8; 32],
        expected_revision: u64,
        valid_until: i64,
    ) -> Result<()> {
        redeem::redeem(
            ctx,
            quantity_kg,
            collection_ticket,
            expected_revision,
            valid_until,
        )
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "the arguments are the facility terms"
    )]
    pub fn open_facility(
        ctx: Context<OpenFacility>,
        facility_id: [u8; 16],
        currency: [u8; 3],
        currency_decimals: u8,
        terms_version: u32,
        rate_bps: u16,
        max_ltv_bps: u16,
        terms_digest: [u8; 32],
    ) -> Result<()> {
        facility::open_facility(
            ctx,
            facility_id,
            currency,
            currency_decimals,
            terms_version,
            rate_bps,
            max_ltv_bps,
            terms_digest,
        )
    }

    pub fn set_valuation(
        ctx: Context<SetValuation>,
        grade: String,
        value_per_kg: u64,
        haircut_bps: u16,
        valid_until: i64,
        source_digest: [u8; 32],
    ) -> Result<()> {
        valuation::set_valuation(
            ctx,
            grade,
            value_per_kg,
            haircut_bps,
            valid_until,
            source_digest,
        )
    }

    pub fn pledge(
        ctx: Context<Pledge>,
        loan_index: u32,
        quantity_kg: u64,
        expected_revision: u64,
        valid_until: i64,
    ) -> Result<()> {
        pledge::pledge(ctx, loan_index, quantity_kg, expected_revision, valid_until)
    }

    pub fn record_advance(
        ctx: Context<RecordAdvance>,
        amount: u64,
        currency: [u8; 3],
        expected_revision: u64,
        valid_until: i64,
    ) -> Result<()> {
        advance::record_advance(ctx, amount, currency, expected_revision, valid_until)
    }

    pub fn confirm_payment(
        ctx: Context<ConfirmPayment>,
        payment_id: [u8; 32],
        purpose: PaymentPurpose,
        amount: u64,
        currency: [u8; 3],
        evidence_digest: [u8; 32],
        observed_at: i64,
    ) -> Result<()> {
        payment::confirm_payment(
            ctx,
            payment_id,
            purpose,
            amount,
            currency,
            evidence_digest,
            observed_at,
        )
    }

    pub fn repay(ctx: Context<Repay>, amount: u64) -> Result<()> {
        payment::repay(ctx, amount)
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "the arguments are the signed intent's terms"
    )]
    pub fn create_release_intent(
        ctx: Context<CreateReleaseIntent>,
        nonce: u64,
        quantity_kg: u64,
        price: u64,
        top_up: u64,
        expires_at: i64,
        expected_revision: u64,
        valid_until: i64,
    ) -> Result<()> {
        release::create_release_intent(
            ctx,
            nonce,
            quantity_kg,
            price,
            top_up,
            expires_at,
            expected_revision,
            valid_until,
        )
    }

    pub fn sell_pledged(
        ctx: Context<SellPledged>,
        expected_revision: u64,
        valid_until: i64,
    ) -> Result<()> {
        release::sell_pledged(ctx, expected_revision, valid_until)
    }

    pub fn liquidate(ctx: Context<Liquidate>, expected_revision: u64) -> Result<()> {
        recovery::liquidate(ctx, expected_revision)
    }

    pub fn close_loan(ctx: Context<CloseLoan>, expected_revision: u64) -> Result<()> {
        recovery::close_loan(ctx, expected_revision)
    }

    pub fn open_pool(ctx: Context<OpenPool>, currency: [u8; 3]) -> Result<()> {
        simulation::open_pool(ctx, currency)
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        simulation::deposit(ctx, amount)
    }

    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        simulation::withdraw(ctx, amount)
    }

    pub fn borrow(
        ctx: Context<Borrow>,
        amount: u64,
        expected_revision: u64,
        valid_until: i64,
    ) -> Result<()> {
        simulation::borrow(ctx, amount, expected_revision, valid_until)
    }

    pub fn prepare_shipment(
        ctx: Context<PrepareShipment>,
        shipment_id: [u8; 16],
        batch_count: u8,
        manifest_root: [u8; 32],
        expected_revision: u64,
        valid_until: i64,
    ) -> Result<()> {
        shipment::prepare_shipment(
            ctx,
            shipment_id,
            batch_count,
            manifest_root,
            expected_revision,
            valid_until,
        )
    }

    pub fn register_batch(
        ctx: Context<RegisterBatch>,
        index: u8,
        quantity_kg: u64,
        carrier: Pubkey,
        load_digest: [u8; 32],
        manifest_digest: [u8; 32],
        proof: [[u8; 32]; 4],
    ) -> Result<()> {
        shipment::register_batch(
            ctx,
            index,
            quantity_kg,
            carrier,
            load_digest,
            manifest_digest,
            proof,
        )
    }

    pub fn cancel_shipment(
        ctx: Context<CancelShipment>,
        expected_revision: u64,
        valid_until: i64,
    ) -> Result<()> {
        shipment::cancel_shipment(ctx, expected_revision, valid_until)
    }
}
