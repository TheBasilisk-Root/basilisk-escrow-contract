use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::state::*;
use crate::errors::EscrowError;

/// Arbitrator resolves a disputed job by splitting escrowed funds.
///
/// ╔══════════════════════════════════════════════════════════════════════╗
/// ║  CRITICAL SECURITY FIX #1: ARBITRATOR AUTHORIZATION                ║
/// ║                                                                     ║
/// ║  BEFORE: Any signer could call resolve_dispute and steal funds.    ║
/// ║  The "arbitrator" account had NO authorization check — just a      ║
/// ║  `/// CHECK:` comment saying "would check in production".          ║
/// ║                                                                     ║
/// ║  AFTER: Arbitrator is validated against ProgramConfig.arbitrator.   ║
/// ║  The config PDA stores the authorized arbitrator pubkey, set by    ║
/// ║  the admin during initialize. Only that exact pubkey can resolve   ║
/// ║  disputes. Config can be updated via update_config (admin-only).   ║
/// ╚══════════════════════════════════════════════════════════════════════╝
///
/// Additional security fixes:
/// - Job PDA seed validation
/// - Status check uses JobStatus::Disputed (not just bool flag)
/// - Escrow token validated by PDA seeds
/// - Agent + requester token accounts validated for owner AND mint
/// - Overflow-safe arithmetic for percentage calculation
pub fn handler(
    ctx: Context<ResolveDispute>,
    agent_percentage: u8,
) -> Result<()> {
    let job = &mut ctx.accounts.job;

    require!(
        job.status == JobStatus::Disputed,
        EscrowError::NotDisputed
    );
    require!(agent_percentage <= 100, EscrowError::InvalidPercentage);

    // ── Overflow-safe split calculation ─────────────────────────────────
    let agent_amount = (job.amount as u128)
        .checked_mul(agent_percentage as u128)
        .ok_or(EscrowError::Overflow)?
        .checked_div(100)
        .ok_or(EscrowError::Overflow)? as u64;
    let requester_amount = job
        .amount
        .checked_sub(agent_amount)
        .ok_or(EscrowError::Overflow)?;

    let job_id_bytes = job.job_id.as_bytes();
    let seeds: &[&[u8]] = &[
        b"escrow",
        job_id_bytes,
        &[job.escrow_authority_bump],
    ];
    let signer_seeds = &[seeds];

    // ── Pay agent their portion ─────────────────────────────────────────
    if agent_amount > 0 {
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
        token::transfer(cpi_ctx, agent_amount)?;
    }

    // ── Refund requester their portion ──────────────────────────────────
    if requester_amount > 0 {
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
        token::transfer(cpi_ctx, requester_amount)?;
    }

    job.status = JobStatus::Resolved;
    job.disputed = false;

    msg!(
        "Dispute resolved for job {}: {}% ({}) to agent, {}% ({}) to requester",
        job.job_id,
        agent_percentage,
        agent_amount,
        100 - agent_percentage,
        requester_amount
    );
    Ok(())
}

#[derive(Accounts)]
pub struct ResolveDispute<'info> {
    /// SECURITY: PDA seeds ensure legitimate job account
    #[account(
        mut,
        seeds = [b"job", job.job_id.as_bytes()],
        bump = job.bump,
    )]
    pub job: Account<'info, Job>,

    /// SECURITY: ProgramConfig PDA stores the authorized arbitrator.
    /// This is the core fix for the arbitrator authorization vulnerability.
    #[account(
        seeds = [b"config"],
        bump = config.bump,
    )]
    pub config: Account<'info, ProgramConfig>,

    /// CHECK: PDA authority for escrow. Validated by seeds.
    #[account(
        seeds = [b"escrow", job.job_id.as_bytes()],
        bump = job.escrow_authority_bump,
    )]
    pub escrow_authority: UncheckedAccount<'info>,

    /// SECURITY FIX: Arbitrator MUST match the authorized arbitrator
    /// stored in ProgramConfig. Without this constraint, ANYONE could
    /// call resolve_dispute and direct funds to arbitrary accounts.
    #[account(
        constraint = arbitrator.key() == config.arbitrator @ EscrowError::UnauthorizedArbitrator,
    )]
    pub arbitrator: Signer<'info>,

    /// SECURITY: Escrow token validated by PDA seeds + mint check
    #[account(
        mut,
        seeds = [b"escrow_token", job.job_id.as_bytes()],
        bump = job.escrow_token_bump,
        constraint = escrow_token.mint == job.mint @ EscrowError::InvalidMint,
    )]
    pub escrow_token: Account<'info, TokenAccount>,

    /// SECURITY: Agent token owner + mint validated against job record
    #[account(
        mut,
        constraint = agent_token.owner == job.agent @ EscrowError::InvalidTokenOwner,
        constraint = agent_token.mint == job.mint @ EscrowError::InvalidMint,
    )]
    pub agent_token: Account<'info, TokenAccount>,

    /// SECURITY: Requester token owner + mint validated against job record
    #[account(
        mut,
        constraint = requester_token.owner == job.requester @ EscrowError::InvalidTokenOwner,
        constraint = requester_token.mint == job.mint @ EscrowError::InvalidMint,
    )]
    pub requester_token: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}
