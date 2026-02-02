use anchor_lang::prelude::*;

#[error_code]
pub enum EscrowError {
    // ── Status errors ───────────────────────────────────────────────────
    #[msg("Job is not in Open status")]
    JobNotOpen,

    #[msg("Job has already been taken by another agent")]
    JobAlreadyTaken,

    #[msg("Invalid job status for this operation")]
    InvalidStatus,

    #[msg("Job cannot be cancelled at this stage")]
    CannotCancel,

    #[msg("Job is not in Disputed status")]
    NotDisputed,

    // ── Authorization errors ────────────────────────────────────────────
    #[msg("Unauthorized: signer does not match required authority")]
    Unauthorized,

    #[msg("Unauthorized arbitrator: signer is not the authorized arbitrator")]
    UnauthorizedArbitrator,

    // ── Validation errors ───────────────────────────────────────────────
    #[msg("Invalid percentage: must be 0-100")]
    InvalidPercentage,

    #[msg("Invalid rating: must be 1-5")]
    InvalidRating,

    #[msg("Token account owner does not match expected party")]
    InvalidTokenOwner,

    #[msg("Token account mint does not match job mint")]
    InvalidMint,

    // ── Input length errors ─────────────────────────────────────────────
    #[msg("Job ID exceeds maximum length of 36 characters")]
    JobIdTooLong,

    #[msg("Description exceeds maximum length of 200 characters")]
    DescriptionTooLong,

    #[msg("Deliverable data exceeds maximum length of 500 characters")]
    DeliverableTooLong,

    // ── Arithmetic errors ───────────────────────────────────────────────
    #[msg("Amount must be greater than zero")]
    ZeroAmount,

    #[msg("Arithmetic overflow")]
    Overflow,
}
