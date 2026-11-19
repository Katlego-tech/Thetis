use anchor_lang::prelude::*;

#[error_code]
pub enum IntentError {
    #[msg("Handover must be a top-level instruction")]
    NotTopLevel,
    #[msg("The handover authorization has expired")]
    Expired,
    #[msg("The handover authorization exceeds the custody time window")]
    WindowTooLong,
    #[msg("The batch sequence has changed")]
    StaleSequence,
    #[msg("The authorized quantity differs from the batch quantity")]
    QuantityMismatch,
    #[msg("The batch has already been handed over")]
    AlreadyHandedOver,
    #[msg("An Ed25519 verification instruction must immediately precede handover")]
    MissingVerification,
    #[msg("The Ed25519 verification instruction data is malformed")]
    MalformedVerification,
    #[msg("Exactly two signatures must be verified")]
    WrongSignatureCount,
    #[msg("Ed25519 offsets must reference data in the verification instruction itself")]
    CrossInstructionReference,
    #[msg("The signatures must match the registered sender and receiver in that order")]
    WrongSigner,
    #[msg("Both signatures must cover the exact handover text")]
    MessageMismatch,
    #[msg("The display name must be 1 to 48 printable ASCII bytes with single internal spaces")]
    InvalidDisplayName,
    #[msg("The lot id must be 1 to 16 uppercase ASCII letters, digits, or hyphens")]
    InvalidLotId,
    #[msg("The sender and receiver must be different parties")]
    SameParty,
    #[msg("The batch quantity must be greater than zero")]
    ZeroQuantity,
}
