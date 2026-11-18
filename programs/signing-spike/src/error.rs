use anchor_lang::prelude::*;

#[error_code]
pub enum SigningError {
    #[msg("Both registered programmatic signers must authorize the handover")]
    WrongSigner,
    #[msg("The handover authorization has expired")]
    Expired,
    #[msg("The batch sequence has changed")]
    StaleSequence,
    #[msg("The authorized quantity differs from the batch quantity")]
    QuantityMismatch,
    #[msg("The batch has already been handed over")]
    AlreadyHandedOver,
    #[msg("The batch quantity must be greater than zero")]
    ZeroQuantity,
    #[msg("The sender and receiver must be different parties")]
    SameParty,
}
