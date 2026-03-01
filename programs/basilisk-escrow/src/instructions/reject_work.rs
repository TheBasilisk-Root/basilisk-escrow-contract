use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::EscrowError;

/// Requester rejects submitted work, sending it back for revision.
///
/// The agent can resubmit an improved deliverable. If the requester
/// wants to escalate to arbitration, they should use `open_dispute`.
///
/// SECURITY FIX: Added PDA seed validation and has_one = requester
/// to prevent unauthorized rejection.
pub fn handler(ctx: Context<RejectWork>, reason: String) -> Result<()> {
    let job = &mut ctx.accounts.job;

    require!(
        job.status == JobStatus::UnderReview,
        EscrowError::InvalidStatus
    );

    // Move back to InProgress so agent can resubmit
    job.status = JobStatus::InProgress;

    msg!("Job {} work rejected, returned for revision: {}", job.job_id, reason);
    Ok(())
}

#[derive(Accounts)]
pub struct RejectWork<'info> {
    /// SECURITY: PDA seeds + has_one = requester
    #[account(
        mut,
        seeds = [b"job", job.job_id.as_bytes()],
        bump = job.bump,
        has_one = requester @ EscrowError::Unauthorized,
    )]
    pub job: Account<'info, Job>,

    pub requester: Signer<'info>,
}
