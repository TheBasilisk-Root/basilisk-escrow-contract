use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::EscrowError;

/// Requester rejects submitted work, opening a dispute.
///
/// SECURITY FIX: Added PDA seed validation and has_one = requester
/// to prevent unauthorized rejection.
pub fn handler(ctx: Context<RejectWork>, reason: String) -> Result<()> {
    let job = &mut ctx.accounts.job;

    require!(
        job.status == JobStatus::UnderReview,
        EscrowError::InvalidStatus
    );

    let new_deliverable = format!("{} | REJECTED: {}", job.deliverable, reason);
    require!(
        new_deliverable.len() <= MAX_DELIVERABLE_LEN,
        EscrowError::DeliverableTooLong
    );

    job.status = JobStatus::Disputed;
    job.disputed = true;
    job.deliverable = new_deliverable;

    msg!("Job {} rejected - dispute opened", job.job_id);
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
