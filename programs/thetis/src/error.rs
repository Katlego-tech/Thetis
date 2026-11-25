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
    #[msg("This action is not available in the instance's settlement mode")]
    WrongSettlementMode,
    #[msg("The currency does not match the facility or pool")]
    CurrencyMismatch,
    #[msg("The valuation has expired")]
    ValuationStale,
    #[msg("The valuation does not match the facility, class, grade and site")]
    ValuationMismatch,
    #[msg("The debt would exceed the loan limit")]
    OverLimit,
    #[msg("The position owner is not the facility's borrower")]
    BorrowerNotEligible,
    #[msg("The lot has expired")]
    LotExpired,
    #[msg("The loan is not active")]
    LoanNotActive,
    #[msg("Quantity exceeds the locked quantity")]
    InsufficientLocked,
    #[msg("The position has reserved units")]
    PositionCommitted,
    #[msg("The payment attestation is not bound to this action")]
    PaymentNotBound,
    #[msg("The payment attestation has already been consumed or voided")]
    PaymentConsumed,
    #[msg("A payment attestation is required")]
    PaymentMissing,
    #[msg("The release intent has expired")]
    IntentExpired,
    #[msg("The release intent is not open")]
    IntentNotOpen,
    #[msg("The remaining debt would exceed the limit on the remaining collateral")]
    ResidualOverLimit,
    #[msg("The loan has an open payment exception")]
    LoanUnderException,
    #[msg("The loan is within its limit")]
    LoanHealthy,
    #[msg("The loan still has debt outstanding")]
    DebtOutstanding,
    #[msg("The loan cannot close while a payment exception is open")]
    LiveObligation,
    #[msg("The pool does not hold enough free cash")]
    InsufficientLiquidity,
    #[msg("Amount exceeds the depositor's shares")]
    InsufficientShares,
    #[msg("The token mint or account does not match the pool")]
    MintMismatch,
}
