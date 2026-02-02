use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use crate::state::*;
use crate::errors::EscrowError;

/// Create a new escrow job.
///
/// Requester posts a job with funds locked in a PDA-controlled escrow account.
/// The escrow token account is initialized as a PDA so only the program can
/// authorize transfers out of it.
pub fn handler(
    ctx: Context<CreateJob>,
    job_id: String,
    amount: u64,
    description: String,
    deadline_days: u8,
) -> Result<()> {
    // ── Input validation ────────────────────────────────────────────────
    require!(job_id.len() <= MAX_JOB_ID_LEN, EscrowError::JobIdTooLong);
    require!(
        description.len() <= MAX_DESCRIPTION_LEN,
        EscrowError::DescriptionTooLong
    );
    require!(amount > 0, EscrowError::ZeroAmount);

    // ── Initialize job state ────────────────────────────────────────────
    let job = &mut ctx.accounts.job;
    let clock = Clock::get()?;

    job.job_id = job_id;
    job.requester = ctx.accounts.requester.key();
    job.agent = Pubkey::default(); // Not assigned yet
    job.amount = amount;
    job.description = description;
    job.status = JobStatus::Open;
    job.created_at = clock.unix_timestamp;
    job.deadline = clock
        .unix_timestamp
        .checked_add((deadline_days as i64).checked_mul(86400).ok_or(EscrowError::Overflow)?)
        .ok_or(EscrowError::Overflow)?;
    job.deliverable = String::new();
    job.disputed = false;
    job.rating = 0;
    job.bump = ctx.bumps.job;
    job.escrow_authority_bump = ctx.bumps.escrow_authority;
    job.escrow_token_bump = ctx.bumps.escrow_token;
    job.mint = ctx.accounts.mint.key();

    // ── Transfer tokens to escrow ───────────────────────────────────────
    let cpi_accounts = Transfer {
        from: ctx.accounts.requester_token.to_account_info(),
        to: ctx.accounts.escrow_token.to_account_info(),
        authority: ctx.accounts.requester.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        cpi_accounts,
    );
    token::transfer(cpi_ctx, amount)?;

    msg!(
        "Job created: {} - {} tokens escrowed (mint: {})",
        job.job_id,
        amount,
        job.mint
    );
    Ok(())
}

#[derive(Accounts)]
#[instruction(job_id: String)]
pub struct CreateJob<'info> {
    // ── Job PDA ─────────────────────────────────────────────────────────
    #[account(
        init,
        payer = requester,
        space = 8 + Job::LEN,
        seeds = [b"job", job_id.as_bytes()],
        bump,
    )]
    pub job: Account<'info, Job>,

    // ── Escrow authority PDA (signs token transfers) ────────────────────
    /// CHECK: PDA authority for escrow token account. Validated by seeds.
    #[account(
        seeds = [b"escrow", job_id.as_bytes()],
        bump,
    )]
    pub escrow_authority: UncheckedAccount<'info>,

    // ── Escrow token account PDA ────────────────────────────────────────
    #[account(
        init,
        payer = requester,
        token::mint = mint,
        token::authority = escrow_authority,
        seeds = [b"escrow_token", job_id.as_bytes()],
        bump,
    )]
    pub escrow_token: Account<'info, TokenAccount>,

    // ── Requester (signer + payer) ──────────────────────────────────────
    #[account(mut)]
    pub requester: Signer<'info>,

    // ── Requester's token account ───────────────────────────────────────
    /// SECURITY: Validate owner matches signer and mint matches job mint
    #[account(
        mut,
        constraint = requester_token.owner == requester.key() @ EscrowError::InvalidTokenOwner,
        constraint = requester_token.mint == mint.key() @ EscrowError::InvalidMint,
    )]
    pub requester_token: Account<'info, TokenAccount>,

    // ── Token mint ──────────────────────────────────────────────────────
    pub mint: Account<'info, Mint>,

    // ── Programs ────────────────────────────────────────────────────────
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}
