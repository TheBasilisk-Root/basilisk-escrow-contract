use anchor_lang::prelude::*;

// ============================================================================
// CONSTANTS
// ============================================================================

/// Maximum length for job_id string (UUID format)
pub const MAX_JOB_ID_LEN: usize = 36;

/// Maximum length for job description
pub const MAX_DESCRIPTION_LEN: usize = 200;

/// Maximum length for deliverable data (URL + notes + rejection reason)
pub const MAX_DELIVERABLE_LEN: usize = 500;

// ============================================================================
// PROGRAM CONFIG - Global configuration PDA
// ============================================================================

#[account]
pub struct ProgramConfig {
    /// Admin who can update configuration
    pub admin: Pubkey,
    /// Authorized arbitrator for dispute resolution
    pub arbitrator: Pubkey,
    /// PDA bump seed
    pub bump: u8,
}

impl ProgramConfig {
    /// Discriminator (8) + admin (32) + arbitrator (32) + bump (1) = 73
    pub const LEN: usize = 32 + 32 + 1;
}

// ============================================================================
// JOB - Per-job escrow state PDA
// ============================================================================

#[account]
pub struct Job {
    /// Unique job identifier (max 36 chars, UUID format)
    pub job_id: String,
    /// Requester who posted and funded the job
    pub requester: Pubkey,
    /// Agent assigned to the job (Pubkey::default() if unassigned)
    pub agent: Pubkey,
    /// Escrowed amount in token base units
    pub amount: u64,
    /// Job description (max 200 chars)
    pub description: String,
    /// Current job lifecycle status
    pub status: JobStatus,
    /// Unix timestamp when job was created
    pub created_at: i64,
    /// Unix timestamp deadline for job completion
    pub deadline: i64,
    /// Deliverable data: URL + notes (max 500 chars)
    pub deliverable: String,
    /// Whether the job is/was in dispute
    pub disputed: bool,
    /// Rating given by requester (1-5, 0 = unrated)
    pub rating: u8,
    /// Job PDA bump seed
    pub bump: u8,
    /// Escrow authority PDA bump seed
    pub escrow_authority_bump: u8,
    /// Escrow token account PDA bump seed
    pub escrow_token_bump: u8,
    /// Token mint for this job's escrow
    pub mint: Pubkey,
}

impl Job {
    /// Calculate the exact space needed for Borsh serialization.
    ///
    /// Borsh String layout: 4 bytes (u32 length prefix) + content bytes
    ///
    /// Fields:
    ///   job_id:                4 + MAX_JOB_ID_LEN      = 40
    ///   requester:             32
    ///   agent:                 32
    ///   amount:                8
    ///   description:           4 + MAX_DESCRIPTION_LEN  = 204
    ///   status (enum):         1
    ///   created_at:            8
    ///   deadline:              8
    ///   deliverable:           4 + MAX_DELIVERABLE_LEN  = 504
    ///   disputed:              1
    ///   rating:                1
    ///   bump:                  1
    ///   escrow_authority_bump: 1
    ///   escrow_token_bump:     1
    ///   mint:                  32
    ///   -----------------------------------------
    ///   Total:                 874
    pub const LEN: usize = (4 + MAX_JOB_ID_LEN)
        + 32  // requester
        + 32  // agent
        + 8   // amount
        + (4 + MAX_DESCRIPTION_LEN)
        + 1   // status
        + 8   // created_at
        + 8   // deadline
        + (4 + MAX_DELIVERABLE_LEN)
        + 1   // disputed
        + 1   // rating
        + 1   // bump
        + 1   // escrow_authority_bump
        + 1   // escrow_token_bump
        + 32; // mint
}

// ============================================================================
// JOB STATUS ENUM
// ============================================================================

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum JobStatus {
    /// Job posted, waiting for agent
    Open,
    /// Agent accepted, work in progress
    InProgress,
    /// Deliverable submitted, awaiting review
    UnderReview,
    /// Requester approved, payment released
    Completed,
    /// Requester cancelled before agent accepted
    Cancelled,
    /// Work rejected, under dispute
    Disputed,
    /// Arbitrator resolved the dispute
    Resolved,
}
