use anchor_lang::prelude::*;

#[error_code]
pub enum ThetisError {
    #[msg("Instruction must be invoked at the top level")]
    NotTopLevel,
    #[msg("This action is paused")]
    Paused,
    #[msg("The signed intent has expired")]
    Expired,
    #[msg("The signed intent exceeds the allowed validity window")]
    WindowTooLong,
    #[msg("The authority has been revoked")]
    AuthorityRevoked,
    #[msg("The authority has expired")]
    AuthorityExpired,
    #[msg("The organisation does not match")]
    WrongOrganisation,
    #[msg("The authority lacks the required scope")]
    ScopeMissing,
    #[msg("The expected revision does not match")]
    StaleRevision,
    #[msg("The preceding Ed25519 verification instruction is missing")]
    MissingVerification,
    #[msg("The Ed25519 verification instruction is malformed")]
    MalformedVerification,
    #[msg("The number of signatures does not match")]
    WrongSignatureCount,
    #[msg("Ed25519 offsets must reference the verification instruction itself")]
    CrossInstructionReference,
    #[msg("The signer does not match the expected authority wallet")]
    WrongSigner,
    #[msg("The verified message does not match the on-chain intent")]
    MessageMismatch,
    #[msg("A field violates its allowed values or bounds")]
    InvalidField,
    #[msg("Quantity must be greater than zero")]
    ZeroQuantity,
    #[msg("Arithmetic overflow or underflow")]
    ArithmeticOverflow,
    #[msg("The protocol admin must sign")]
    NotAdmin,
    #[msg("The protocol accreditor must sign")]
    NotAccreditor,
    #[msg("The signer is not authorized to administer this organisation's authority")]
    NotOrganisationAdmin,
    #[msg("The requested scopes are not allowed for this role")]
    ScopeNotAllowed,
    #[msg("The organisation does not have the required role")]
    WrongRole,
    #[msg("Only the issuing organisation may revoke the document")]
    NotIssuer,
    #[msg("The document has been revoked")]
    DocumentRevoked,
    #[msg("The custodian and owner are related")]
    RelatedCustodian,
    #[msg("The origin attestation is invalid")]
    OriginInvalid,
    #[msg("Quantity exceeds approved capacity")]
    OverCapacity,
    #[msg("The lot is not stored")]
    LotNotStored,
    #[msg("The lot is restricted")]
    Restricted,
    #[msg("The recipient is not an approved holder")]
    RecipientNotApproved,
    #[msg("Quantity exceeds the available position balance")]
    InsufficientAvailable,
    #[msg("The class policy requires reassay before splitting")]
    SplitNeedsReassay,
    #[msg("The split would empty the parent lot")]
    SplitWouldEmptyParent,
    #[msg("The vault balance differs from the position quantity")]
    BalanceMismatch,
    #[msg("The root lot does not match")]
    RootMismatch,
}
