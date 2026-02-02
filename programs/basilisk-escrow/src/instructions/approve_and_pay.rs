use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::state::*;
use crate::errors::EscrowError;

/// Requester approves work and releases escrowed payment to agent.
///
/// SECURITY FIXES:
/// - PDA seed validation on job account
/// - has_one = requester ensures only the job poster can approve
/// - Escrow token validated by PDA seeds (cannot substitute fake account)
/// - Agent token owner validated against job.agent
/// - Mint consistency validated across all token accounts
pub fn handler(ctx: Context<ApproveAndPay>, rating: u8) -> Result<()> {
    let job = &mut ctx.accounts.job;

    require!(
        job.status == JobStatus::UnderReview,
        EscrowError::InvalidStatus
    );
    require!(rating >= 1 && rating <= 5, EscrowError::InvalidRating);

    // ── Transfer from escrow to agent ───────────────────────────────────
    let job_id_bytes = job.job_id.as_bytes();
    let seeds: &[&[u8]] = &[
        b"escrow",
        job_id_bytes,
        &[job.escrow_authority_bump],
    ];
    let signer_seeds = &[seeds];

    let cpi_accounts = Transfer {
        from: ctx.accounts.escrow_token.to_account_info(),
        to: ctx.accounts.agent_token.to_account_info(),
        authority: ctx.accounts.escrow_authority.to_account_info(),
    };
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        cpi_accounts,
        signer_seeds,
    );
    token::transfer(cpi_ctx, job.amount)?;

    job.status = JobStatus::Completed;
    job.rating = rating;

    msg!(
        "Job {} approved - {} tokens paid to agent (rating: {})",
        job.job_id,
        job.amount,
        rating
    );
    Ok(())
}

#[derive(Accounts)]
pub struct ApproveAndPay<'info> {
    /// SECURITY: PDA seeds + has_one = requester
    #[account(
        mut,
        seeds = [b"job", job.job_id.as_bytes()],
        bump = job.bump,
        has_one = requester @ EscrowError::Unauthorized,
    )]
    pub job: Account<'info, Job>,

    /// CHECK: PDA authority for escrow. Validated by seeds constraint.
    #[account(
        seeds = [b"escrow", job.job_id.as_bytes()],
        bump = job.escrow_authority_bump,
    )]
    pub escrow_authority: UncheckedAccount<'info>,

    pub requester: Signer<'info>,

    /// SECURITY: Escrow token validated by PDA seeds — cannot be substituted
    #[account(
        mut,
        seeds = [b"escrow_token", job.job_id.as_bytes()],
        bump = job.escrow_token_bump,
        constraint = escrow_token.mint == job.mint @ EscrowError::InvalidMint,
    )]
    pub escrow_token: Account<'info, TokenAccount>,

    /// SECURITY: Validates owner is the assigned agent AND mint matches
    #[account(
        mut,
        constraint = agent_token.owner == job.agent @ EscrowError::InvalidTokenOwner,
        constraint = agent_token.mint == job.mint @ EscrowError::InvalidMint,
    )]
    pub agent_token: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}
