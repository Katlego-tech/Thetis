use anchor_lang::prelude::*;

pub const MAX_CLASS_CODE: usize = 8;
pub const MAX_GRADES: usize = 8;
pub const MAX_GRADE: usize = 8;
pub const MAX_DISPLAY_NAME: usize = 48;
pub const MAX_RELATED: usize = 8;
pub const MAX_SITE_CODE: usize = 16;
pub const MAX_LOT_ID: usize = 16;

#[account]
#[derive(InitSpace)]
pub struct Protocol {
    pub instance_id: [u8; 16],
    pub settlement_mode: SettlementMode,
    pub admin: Pubkey,
    pub accreditor: Pubkey,
    pub pause_flags: u16,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct ClassPolicy {
    pub protocol: Pubkey,
    #[max_len(MAX_CLASS_CODE)]
    pub class_code: String,
    pub version: u32,
    pub unit: QuantityUnit,
    #[max_len(MAX_GRADES, MAX_GRADE)]
    pub grades: Vec<String>,
    pub origin_required: bool,
    pub lot_validity_secs: i64,
    pub split_inherits_expiry: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Organisation {
    pub protocol: Pubkey,
    pub org_id: [u8; 16],
    pub role: Role,
    #[max_len(MAX_DISPLAY_NAME)]
    pub display_name: String,
    pub admin: Pubkey,
    #[max_len(MAX_RELATED)]
    pub related: Vec<Pubkey>,
    pub bump: u8,
}

/// Marker for a display name taken in one protocol; its address carries the meaning.
#[account]
#[derive(InitSpace)]
pub struct OrganisationName {}

#[account]
#[derive(InitSpace)]
pub struct Authority {
    pub protocol: Pubkey,
    pub organisation: Pubkey,
    pub wallet: Pubkey,
    pub scopes: u16,
    pub expires_at: i64,
    pub revoked_at: Option<i64>,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct CustodianClass {
    pub protocol: Pubkey,
    pub custodian: Pubkey,
    pub class_policy: Pubkey,
    #[max_len(MAX_SITE_CODE)]
    pub site_code: String,
    pub approved_capacity_kg: u64,
    pub occupied_kg: u64,
    pub reserved_inbound_kg: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct DocumentAttestation {
    pub protocol: Pubkey,
    pub kind: DocumentKind,
    pub subject: [u8; 32],
    pub version: u32,
    pub issuer: Pubkey,
    pub sha256: [u8; 32],
    pub valid_until: i64,
    pub revoked_at: Option<i64>,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct IntakeIdentity {
    pub protocol: Pubkey,
    pub custodian: Pubkey,
    pub intake_digest: [u8; 32],
    pub lot: Pubkey,
    pub retired: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Lot {
    pub protocol: Pubkey,
    #[max_len(MAX_LOT_ID)]
    pub lot_id: String,
    pub class_policy: Pubkey,
    pub class_version: u32,
    #[max_len(MAX_GRADE)]
    pub grade: String,
    pub custodian_class: Pubkey,
    pub intake: Pubkey,
    pub parent: Option<Pubkey>,
    pub root: Pubkey,
    pub mint: Pubkey,
    pub supply_kg: u64,
    pub state: LotState,
    pub restriction: Restriction,
    pub expires_at: i64,
    pub revision: u64,
    pub live_children: u32,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub protocol: Pubkey,
    pub lot: Pubkey,
    pub owner: Pubkey,
    pub quantity_kg: u64,
    pub locked_kg: u64,
    pub reserved_kg: u64,
    pub revision: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Facility {
    pub protocol: Pubkey,
    pub lender: Pubkey,
    pub borrower: Pubkey,
    pub facility_id: [u8; 16],
    pub currency: [u8; 3],
    pub currency_decimals: u8,
    pub terms_version: u32,
    pub rate_bps: u16,
    pub max_ltv_bps: u16,
    pub terms_digest: [u8; 32],
    pub loan_count: u32,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Valuation {
    pub protocol: Pubkey,
    pub facility: Pubkey,
    pub class_policy: Pubkey,
    #[max_len(MAX_GRADE)]
    pub grade: String,
    pub custodian_class: Pubkey,
    pub value_per_kg: u64,
    pub haircut_bps: u16,
    pub valid_until: i64,
    pub source_digest: [u8; 32],
    pub version: u32,
    pub set_at: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Loan {
    pub protocol: Pubkey,
    pub facility: Pubkey,
    pub borrower: Pubkey,
    pub lot: Pubkey,
    pub position: Pubkey,
    pub index: u32,
    pub status: LoanStatus,
    pub rate_bps: u16,
    pub terms_version: u32,
    pub principal: u64,
    pub booked_interest: u64,
    pub accrual_remainder: u64,
    pub accrued_at: i64,
    pub open_exceptions: u16,
    pub revision: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct LockAllocation {
    pub protocol: Pubkey,
    pub loan: Pubkey,
    pub position: Pubkey,
    pub quantity_kg: u64,
    pub control: LockControl,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct PaymentAttestation {
    pub protocol: Pubkey,
    pub lender: Pubkey,
    pub loan: Pubkey,
    pub payment_id: [u8; 32],
    pub purpose: PaymentPurpose,
    pub subject: Pubkey,
    pub amount: u64,
    pub currency: [u8; 3],
    pub evidence_digest: [u8; 32],
    pub observed_at: i64,
    pub status: PaymentStatus,
    pub applied: u64,
    pub surplus: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct ReleaseIntent {
    pub protocol: Pubkey,
    pub loan: Pubkey,
    pub lot: Pubkey,
    pub position: Pubkey,
    pub seller: Pubkey,
    pub buyer: Pubkey,
    pub nonce: u64,
    pub quantity_kg: u64,
    pub price: u64,
    pub top_up: u64,
    pub currency: [u8; 3],
    pub expires_at: i64,
    pub position_revision: u64,
    pub status: IntentStatus,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct SimulationPool {
    pub protocol: Pubkey,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub currency: [u8; 3],
    pub currency_decimals: u8,
    pub cash_minor: u64,
    pub total_shares: u64,
    pub lent_minor: u64,
    pub income_minor: u64,
    pub revision: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct PoolShare {
    pub pool: Pubkey,
    pub organisation: Pubkey,
    pub shares: u64,
    pub lent_minor: u64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, Debug, PartialEq, Eq)]
pub enum SettlementMode {
    FiatAttestationTest,
    DevnetTokenSimulation,
}

#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, Debug, PartialEq, Eq)]
pub enum QuantityUnit {
    Kilogram,
}

#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Exporter,
    Buyer,
    Custodian,
    Transporter,
    Terminal,
    Lender,
    Inspector,
    DocumentIssuer,
}

#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, Debug, PartialEq, Eq)]
pub enum DocumentKind {
    Origin,
}

#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, Debug, PartialEq, Eq)]
pub enum LotState {
    Stored,
    Redeemed,
}

#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Restriction {
    Normal,
}

#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, Debug, PartialEq, Eq)]
pub enum LoanStatus {
    Active,
    Recovery,
    ExternalHandoff,
    Closed,
}

#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, Debug, PartialEq, Eq)]
pub enum LockControl {
    Pledged,
    Recovery,
}

#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, Debug, PartialEq, Eq)]
pub enum PaymentPurpose {
    Repayment,
    Release,
    Correction,
}

#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, Debug, PartialEq, Eq)]
pub enum PaymentStatus {
    Unconsumed,
    Consumed,
    Voided,
}

#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntentStatus {
    Open,
    Executed,
}

pub mod scope {
    pub const ISSUE: u16 = 1 << 0;
    pub const TRANSFER: u16 = 1 << 1;
    pub const SPLIT: u16 = 1 << 2;
    pub const REDEEM: u16 = 1 << 3;
    pub const ATTEST_ORIGIN: u16 = 1 << 4;
    pub const PLEDGE: u16 = 1 << 5;
    pub const BUY: u16 = 1 << 6;
    pub const LEND: u16 = 1 << 7;
    pub const POOL: u16 = 1 << 8;
}

pub mod pause {
    pub const ISSUE: u16 = 1 << 0;
    pub const TRANSFER: u16 = 1 << 1;
    pub const SPLIT: u16 = 1 << 2;
    pub const REDEEM: u16 = 1 << 3;
    pub const PLEDGE: u16 = 1 << 4;
    pub const ADVANCE: u16 = 1 << 5;
    pub const RELEASE: u16 = 1 << 6;
    pub const LIQUIDATE: u16 = 1 << 7;
    pub const POOL: u16 = 1 << 8;
    pub const ALL: u16 =
        ISSUE | TRANSFER | SPLIT | REDEEM | PLEDGE | ADVANCE | RELEASE | LIQUIDATE | POOL;
}
