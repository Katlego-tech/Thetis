use anchor_lang::prelude::*;

use crate::state::{DocumentKind, PaymentPurpose, Role};

#[event]
pub struct ProtocolInitialized {
    pub protocol: Pubkey,
}

#[event]
pub struct ClassRegistered {
    pub class_policy: Pubkey,
    pub version: u32,
}

#[event]
pub struct OrganisationAccredited {
    pub organisation: Pubkey,
    pub role: Role,
}

#[event]
pub struct RelationshipDeclared {
    pub a: Pubkey,
    pub b: Pubkey,
}

#[event]
pub struct AuthorityDelegated {
    pub authority: Pubkey,
    pub organisation: Pubkey,
    pub scopes: u16,
    pub expires_at: i64,
}

#[event]
pub struct AuthorityRevoked {
    pub authority: Pubkey,
    pub at: i64,
}

#[event]
pub struct CustodianClassAccredited {
    pub custodian_class: Pubkey,
    pub approved_capacity_kg: u64,
}

#[event]
pub struct PauseChanged {
    pub flags: u16,
}

#[event]
pub struct DocumentAttested {
    pub document: Pubkey,
    pub kind: DocumentKind,
    pub subject: [u8; 32],
    pub version: u32,
}

#[event]
pub struct DocumentRevoked {
    pub document: Pubkey,
    pub at: i64,
}

#[event]
pub struct LotIssued {
    pub lot: Pubkey,
    pub owner: Pubkey,
    pub quantity_kg: u64,
    pub intake: Pubkey,
    pub revision: u64,
}

#[event]
pub struct UnitsTransferred {
    pub lot: Pubkey,
    pub from: Pubkey,
    pub to: Pubkey,
    pub quantity_kg: u64,
    pub revision: u64,
}

#[event]
pub struct LotSplit {
    pub parent: Pubkey,
    pub child: Pubkey,
    pub owner: Pubkey,
    pub quantity_kg: u64,
    pub parent_revision: u64,
}

#[event]
pub struct UnitsRedeemed {
    pub lot: Pubkey,
    pub owner: Pubkey,
    pub quantity_kg: u64,
    pub collection_ticket: [u8; 32],
    pub revision: u64,
    pub lot_redeemed: bool,
}

#[event]
pub struct FacilityOpened {
    pub facility: Pubkey,
    pub lender: Pubkey,
    pub borrower: Pubkey,
    pub currency: [u8; 3],
    pub currency_decimals: u8,
    pub terms_version: u32,
    pub rate_bps: u16,
    pub max_ltv_bps: u16,
}

#[event]
pub struct ValuationSet {
    pub valuation: Pubkey,
    pub facility: Pubkey,
    pub version: u32,
    pub value_per_kg: u64,
    pub haircut_bps: u16,
    pub valid_until: i64,
    pub source_digest: [u8; 32],
    pub set_at: i64,
}

#[event]
pub struct Pledged {
    pub loan: Pubkey,
    pub lock: Pubkey,
    pub position: Pubkey,
    pub lot: Pubkey,
    pub quantity_kg: u64,
    pub position_revision: u64,
    pub revision: u64,
}

#[event]
pub struct AdvanceRecorded {
    pub loan: Pubkey,
    pub amount: u64,
    pub principal: u64,
    pub booked_interest: u64,
    pub revision: u64,
}

#[event]
pub struct PaymentConfirmed {
    pub payment: Pubkey,
    pub loan: Pubkey,
    pub purpose: PaymentPurpose,
    pub subject: Pubkey,
    pub amount: u64,
    pub currency: [u8; 3],
}

#[event]
pub struct PaymentCorrected {
    pub payment: Pubkey,
    pub target: Pubkey,
    pub loan: Pubkey,
    pub voided: bool,
    pub open_exceptions: u16,
    pub loan_revision: u64,
}

#[event]
pub struct Repaid {
    pub loan: Pubkey,
    pub payment: Option<Pubkey>,
    pub pool: Option<Pubkey>,
    pub pool_revision: Option<u64>,
    pub applied: u64,
    pub from_interest: u64,
    pub from_principal: u64,
    pub surplus: u64,
    pub principal: u64,
    pub booked_interest: u64,
    pub revision: u64,
}

#[event]
pub struct ReleaseIntentCreated {
    pub intent: Pubkey,
    pub loan: Pubkey,
    pub seller: Pubkey,
    pub buyer: Pubkey,
    pub quantity_kg: u64,
    pub price: u64,
    pub top_up: u64,
    pub expires_at: i64,
}

#[event]
pub struct PledgedSold {
    pub intent: Pubkey,
    pub loan: Pubkey,
    pub payment: Pubkey,
    pub lot: Pubkey,
    pub seller_position: Pubkey,
    pub buyer_position: Pubkey,
    pub quantity_kg: u64,
    pub applied: u64,
    pub surplus: u64,
    pub principal: u64,
    pub booked_interest: u64,
    pub lot_revision: u64,
    pub revision: u64,
}

#[event]
pub struct Liquidated {
    pub loan: Pubkey,
    pub lock: Pubkey,
    pub debt: u64,
    pub limit: u64,
    pub revision: u64,
}

#[event]
pub struct LoanClosed {
    pub loan: Pubkey,
    pub position: Pubkey,
    pub released_kg: u64,
    pub revision: u64,
}

#[event]
pub struct PoolOpened {
    pub pool: Pubkey,
    pub mint: Pubkey,
    pub currency: [u8; 3],
    pub currency_decimals: u8,
}

#[event]
pub struct Deposited {
    pub pool: Pubkey,
    pub organisation: Pubkey,
    pub wallet: Pubkey,
    pub amount: u64,
    pub shares: u64,
    pub pool_revision: u64,
}

#[event]
pub struct Withdrawn {
    pub pool: Pubkey,
    pub organisation: Pubkey,
    pub wallet: Pubkey,
    pub amount: u64,
    pub shares: u64,
    pub pool_revision: u64,
}

#[event]
pub struct Borrowed {
    pub loan: Pubkey,
    pub pool: Pubkey,
    pub amount: u64,
    pub principal: u64,
    pub booked_interest: u64,
    pub revision: u64,
    pub pool_revision: u64,
}

#[event]
pub struct ShipmentPrepared {
    pub shipment: Pubkey,
    pub lot: Pubkey,
    pub owner: Pubkey,
    pub source: Pubkey,
    pub destination: Pubkey,
    pub committed_kg: u64,
    pub locked_kg: u64,
    pub batch_count: u8,
    pub manifest_root: [u8; 32],
    pub departure_document: Pubkey,
    pub lot_revision: u64,
    pub position_revision: u64,
}

#[event]
pub struct BatchRegistered {
    pub batch: Pubkey,
    pub shipment: Pubkey,
    pub index: u8,
    pub quantity_kg: u64,
    pub carrier: Pubkey,
    pub load_digest: [u8; 32],
    pub manifest_digest: [u8; 32],
    pub registered_count: u8,
}

#[event]
pub struct ShipmentCancelled {
    pub shipment: Pubkey,
    pub lot: Pubkey,
    pub released_kg: u64,
    pub lot_revision: u64,
    pub revision: u64,
}
