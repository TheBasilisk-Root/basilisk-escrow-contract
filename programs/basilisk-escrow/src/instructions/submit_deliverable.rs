use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::EscrowError;

/// Agent submits a deliverable for review.
///
/// SECURITY FIX: Added PDA seed validation AND has_one = agent constraint
/// to ensure only the assigned agent can submit deliverables. The original
/// code only checked job.agent == agent.key() in logic, but had no
/// account-level constraint preventing a different job account from being
/// passed in.
pub fn handler(
    ctx: Context<SubmitDeliverable>,
    deliverable_url: String,
    notes: String,
) -> Result<()> {
    let combined = format!("{} | {}", deliverable_url, notes);
    require!(
        combined.len() <= MAX_DELIVERABLE_LEN,
        EscrowError::DeliverableTooLong
    );

    let job = &mut ctx.accounts.job;
    require!(
        job.status == JobStatus::InProgress,
        EscrowError::InvalidStatus
    );

    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp <= job.deadline,
        EscrowError::DeadlineExpired
    );

    job.deliverable = combined;
    job.status = JobStatus::UnderReview;

    msg!("Deliverable submitted for job {}", job.job_id);
    Ok(())
}

#[derive(Accounts)]
pub struct SubmitDeliverable<'info> {
    /// SECURITY: PDA seeds + has_one = agent ensures:
    /// 1. This is a legitimate job PDA
    /// 2. The signer is the assigned agent for THIS specific job
    #[account(
        mut,
        seeds = [b"job", job.job_id.as_bytes()],
        bump = job.bump,
        has_one = agent @ EscrowError::Unauthorized,
    )]
    pub job: Account<'info, Job>,

    pub agent: Signer<'info>,
}
