use anchor_lang::prelude::*;

#[error_code]
pub enum ReceiptError {
    #[msg("Receipt mints require zero decimals")]
    InvalidDecimals,
    #[msg("Issue quantity must be positive")]
    ZeroQuantity,
    #[msg("The signer must own the source position")]
    WrongOwner,
    #[msg("The source position has insufficient units")]
    InsufficientQuantity,
    #[msg("The source and destination positions must differ")]
    SamePosition,
    #[msg("The destination quantity exceeds u64")]
    QuantityOverflow,
    #[msg("The vault token balance must equal the position quantity")]
    VaultBalanceMismatch,
}
