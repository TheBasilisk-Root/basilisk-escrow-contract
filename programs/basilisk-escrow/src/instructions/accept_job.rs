use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::EscrowError;

/// Agent accepts an open job.
///
/// SECURITY FIX: Added PDA seed validation on job account to prevent
/// passing arbitrary accounts. Status and assignment checks enforce
/// that only open, unassigned jobs can be accepted.
pub fn handler(ctx: Context<AcceptJob>) -> Result<()> {
    let job = &mut ctx.accounts.job;

    require!(job.status == JobStatus::Open, EscrowError::JobNotOpen);
    require!(
        job.agent == Pubkey::default(),
        EscrowError::JobAlreadyTaken
    );

    job.agent = ctx.accounts.agent.key();
    job.status = JobStatus::InProgress;

    msg!(
        "Job {} accepted by agent {}",
        job.job_id,
        job.agent
    );
    Ok(())
}

#[derive(Accounts)]
pub struct AcceptJob<'info> {
    /// SECURITY: PDA seed constraint ensures this is a legitimate job account
    /// created by this program, not an arbitrary account.
    #[account(
        mut,
        seeds = [b"job", job.job_id.as_bytes()],
        bump = job.bump,
    )]
    pub job: Account<'info, Job>,

    pub agent: Signer<'info>,
}
