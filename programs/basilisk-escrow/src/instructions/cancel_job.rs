use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::state::*;
use crate::errors::EscrowError;

/// Requester cancels a job before any agent accepts.
/// Escrowed funds are returned to requester.
///
/// SECURITY FIXES:
/// - PDA seed validation on job account
/// - has_one = requester
/// - Escrow token validated by PDA seeds
/// - Requester token owner + mint validated
pub fn handler(ctx: Context<CancelJob>) -> Result<()> {
    let job = &mut ctx.accounts.job;

    require!(job.status == JobStatus::Open, EscrowError::CannotCancel);

    // ── Refund to requester ─────────────────────────────────────────────
    let job_id_bytes = job.job_id.as_bytes();
    let seeds: &[&[u8]] = &[
        b"escrow",
        job_id_bytes,
        &[job.escrow_authority_bump],
    ];
    let signer_seeds = &[seeds];

    let cpi_accounts = Transfer {
        from: ctx.accounts.escrow_token.to_account_info(),
        to: ctx.accounts.requester_token.to_account_info(),
        authority: ctx.accounts.escrow_authority.to_account_info(),
    };
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        cpi_accounts,
        signer_seeds,
    );
    token::transfer(cpi_ctx, job.amount)?;

    job.status = JobStatus::Cancelled;

    msg!(
        "Job {} cancelled - {} tokens returned to requester",
        job.job_id,
        job.amount
    );
    Ok(())
}

#[derive(Accounts)]
pub struct CancelJob<'info> {
    /// SECURITY: PDA seeds + has_one = requester
    #[account(
        mut,
        seeds = [b"job", job.job_id.as_bytes()],
        bump = job.bump,
        has_one = requester @ EscrowError::Unauthorized,
    )]
    pub job: Account<'info, Job>,

    /// CHECK: PDA authority. Validated by seeds.
    #[account(
        seeds = [b"escrow", job.job_id.as_bytes()],
        bump = job.escrow_authority_bump,
    )]
    pub escrow_authority: UncheckedAccount<'info>,

    pub requester: Signer<'info>,

    /// SECURITY: Escrow token validated by PDA seeds
    #[account(
        mut,
        seeds = [b"escrow_token", job.job_id.as_bytes()],
        bump = job.escrow_token_bump,
        constraint = escrow_token.mint == job.mint @ EscrowError::InvalidMint,
    )]
    pub escrow_token: Account<'info, TokenAccount>,

    /// SECURITY: Requester token owner + mint validated
    #[account(
        mut,
        constraint = requester_token.owner == requester.key() @ EscrowError::InvalidTokenOwner,
        constraint = requester_token.mint == job.mint @ EscrowError::InvalidMint,
    )]
    pub requester_token: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}
