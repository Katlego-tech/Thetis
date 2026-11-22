use anchor_lang::prelude::*;

use crate::state::{DocumentKind, Role};

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
