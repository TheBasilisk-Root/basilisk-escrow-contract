use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("BASKescrowProgram11111111111111111111111111");

#[program]
pub mod basilisk_escrow {
    use super::*;

    /// Create a new escrow job
    pub fn create_job(
        ctx: Context<CreateJob>,
        job_id: String,
        amount: u64,
        description: String,
        deadline_days: u8,
    ) -> Result<()> {
        let job = &mut ctx.accounts.job;
        let clock = Clock::get()?;

        job.job_id = job_id;
        job.requester = ctx.accounts.requester.key();
        job.agent = Pubkey::default(); // Not assigned yet
        job.amount = amount;
        job.description = description;
        job.status = JobStatus::Open;
        job.created_at = clock.unix_timestamp;
        job.deadline = clock.unix_timestamp + (deadline_days as i64 * 86400);
        job.deliverable = String::new();
        job.disputed = false;

        // Transfer tokens to escrow
        let cpi_accounts = Transfer {
            from: ctx.accounts.requester_token.to_account_info(),
            to: ctx.accounts.escrow_token.to_account_info(),
            authority: ctx.accounts.requester.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        token::transfer(cpi_ctx, amount)?;

        msg!("Job created: {} - {} $BASILISK escrowed", job.job_id, amount);
        Ok(())
    }

    /// Agent accepts job
    pub fn accept_job(ctx: Context<AcceptJob>) -> Result<()> {
        let job = &mut ctx.accounts.job;

        require!(job.status == JobStatus::Open, EscrowError::JobNotOpen);
        require!(job.agent == Pubkey::default(), EscrowError::JobAlreadyTaken);

        job.agent = ctx.accounts.agent.key();
        job.status = JobStatus::InProgress;

        msg!("Job {} accepted by agent {}", job.job_id, job.agent);
        Ok(())
    }

    /// Agent submits deliverable
    pub fn submit_deliverable(
        ctx: Context<SubmitDeliverable>,
        deliverable_url: String,
        notes: String,
    ) -> Result<()> {
        let job = &mut ctx.accounts.job;

        require!(job.status == JobStatus::InProgress, EscrowError::InvalidStatus);
        require!(job.agent == ctx.accounts.agent.key(), EscrowError::Unauthorized);

        job.deliverable = format!("{} | {}", deliverable_url, notes);
        job.status = JobStatus::UnderReview;

        msg!("Deliverable submitted for job {}", job.job_id);
        Ok(())
    }

    /// Requester approves work and releases payment
    pub fn approve_and_pay(ctx: Context<ApproveAndPay>, rating: u8) -> Result<()> {
        let job = &mut ctx.accounts.job;
        
        require!(job.status == JobStatus::UnderReview, EscrowError::InvalidStatus);
        require!(job.requester == ctx.accounts.requester.key(), EscrowError::Unauthorized);
        require!(rating >= 1 && rating <= 5, EscrowError::InvalidRating);

        // Transfer from escrow to agent
        let seeds = &[
            b"escrow",
            job.job_id.as_bytes(),
            &[ctx.bumps.escrow_authority],
        ];
        let signer = &[&seeds[..]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.escrow_token.to_account_info(),
            to: ctx.accounts.agent_token.to_account_info(),
            authority: ctx.accounts.escrow_authority.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer);
        token::transfer(cpi_ctx, job.amount)?;

        job.status = JobStatus::Completed;
        job.rating = rating;

        msg!("Job {} approved - {} $BASILISK paid to agent", job.job_id, job.amount);
        Ok(())
    }

    /// Requester rejects work
    pub fn reject_work(ctx: Context<RejectWork>, reason: String) -> Result<()> {
        let job = &mut ctx.accounts.job;

        require!(job.status == JobStatus::UnderReview, EscrowError::InvalidStatus);
        require!(job.requester == ctx.accounts.requester.key(), EscrowError::Unauthorized);

        job.status = JobStatus::Disputed;
        job.disputed = true;
        job.deliverable = format!("{} | REJECTED: {}", job.deliverable, reason);

        msg!("Job {} rejected - dispute opened", job.job_id);
        Ok(())
    }

    /// Cancel job before agent accepts (refund requester)
    pub fn cancel_job(ctx: Context<CancelJob>) -> Result<()> {
        let job = &mut ctx.accounts.job;

        require!(job.status == JobStatus::Open, EscrowError::CannotCancel);
        require!(job.requester == ctx.accounts.requester.key(), EscrowError::Unauthorized);

        // Refund to requester
        let seeds = &[
            b"escrow",
            job.job_id.as_bytes(),
            &[ctx.bumps.escrow_authority],
        ];
        let signer = &[&seeds[..]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.escrow_token.to_account_info(),
            to: ctx.accounts.requester_token.to_account_info(),
            authority: ctx.accounts.escrow_authority.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer);
        token::transfer(cpi_ctx, job.amount)?;

        job.status = JobStatus::Cancelled;

        msg!("Job {} cancelled - funds returned to requester", job.job_id);
        Ok(())
    }

    /// Arbitrator resolves dispute
    pub fn resolve_dispute(
        ctx: Context<ResolveDispute>,
        agent_percentage: u8, // 0-100
    ) -> Result<()> {
        let job = &mut ctx.accounts.job;

        require!(job.disputed, EscrowError::NotDisputed);
        require!(agent_percentage <= 100, EscrowError::InvalidPercentage);

        let agent_amount = (job.amount as u128 * agent_percentage as u128 / 100) as u64;
        let requester_amount = job.amount - agent_amount;

        let seeds = &[
            b"escrow",
            job.job_id.as_bytes(),
            &[ctx.bumps.escrow_authority],
        ];
        let signer = &[&seeds[..]];

        // Pay agent their portion
        if agent_amount > 0 {
            let cpi_accounts = Transfer {
                from: ctx.accounts.escrow_token.to_account_info(),
                to: ctx.accounts.agent_token.to_account_info(),
                authority: ctx.accounts.escrow_authority.to_account_info(),
            };
            let cpi_program = ctx.accounts.token_program.to_account_info();
            let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer);
            token::transfer(cpi_ctx, agent_amount)?;
        }

        // Refund requester their portion
        if requester_amount > 0 {
            let cpi_accounts = Transfer {
                from: ctx.accounts.escrow_token.to_account_info(),
                to: ctx.accounts.requester_token.to_account_info(),
                authority: ctx.accounts.escrow_authority.to_account_info(),
            };
            let cpi_program = ctx.accounts.token_program.to_account_info();
            let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer);
            token::transfer(cpi_ctx, requester_amount)?;
        }

        job.status = JobStatus::Resolved;
        job.disputed = false;

        msg!("Dispute resolved: {}% to agent, {}% to requester", agent_percentage, 100 - agent_percentage);
        Ok(())
    }
}

// Accounts

#[derive(Accounts)]
#[instruction(job_id: String)]
pub struct CreateJob<'info> {
    #[account(
        init,
        payer = requester,
        space = 8 + Job::LEN,
        seeds = [b"job", job_id.as_bytes()],
        bump
    )]
    pub job: Account<'info, Job>,

    /// CHECK: PDA authority for escrow
    #[account(
        seeds = [b"escrow", job_id.as_bytes()],
        bump
    )]
    pub escrow_authority: AccountInfo<'info>,

    #[account(mut)]
    pub requester: Signer<'info>,

    #[account(mut)]
    pub requester_token: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = requester,
        token::mint = requester_token.mint,
        token::authority = escrow_authority,
        seeds = [b"escrow_token", job_id.as_bytes()],
        bump
    )]
    pub escrow_token: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct AcceptJob<'info> {
    #[account(mut)]
    pub job: Account<'info, Job>,

    pub agent: Signer<'info>,
}

#[derive(Accounts)]
pub struct SubmitDeliverable<'info> {
    #[account(mut)]
    pub job: Account<'info, Job>,

    pub agent: Signer<'info>,
}

#[derive(Accounts)]
pub struct ApproveAndPay<'info> {
    #[account(mut)]
    pub job: Account<'info, Job>,

    /// CHECK: PDA authority
    #[account(
        seeds = [b"escrow", job.job_id.as_bytes()],
        bump
    )]
    pub escrow_authority: AccountInfo<'info>,

    pub requester: Signer<'info>,

    #[account(mut)]
    pub escrow_token: Account<'info, TokenAccount>,

    #[account(mut)]
    pub agent_token: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RejectWork<'info> {
    #[account(mut)]
    pub job: Account<'info, Job>,

    pub requester: Signer<'info>,
}

#[derive(Accounts)]
pub struct CancelJob<'info> {
    #[account(mut)]
    pub job: Account<'info, Job>,

    /// CHECK: PDA authority
    #[account(
        seeds = [b"escrow", job.job_id.as_bytes()],
        bump
    )]
    pub escrow_authority: AccountInfo<'info>,

    pub requester: Signer<'info>,

    #[account(mut)]
    pub escrow_token: Account<'info, TokenAccount>,

    #[account(mut)]
    pub requester_token: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ResolveDispute<'info> {
    #[account(mut)]
    pub job: Account<'info, Job>,

    /// CHECK: PDA authority
    #[account(
        seeds = [b"escrow", job.job_id.as_bytes()],
        bump
    )]
    pub escrow_authority: AccountInfo<'info>,

    /// CHECK: Authorized arbitrator (would check against list in production)
    pub arbitrator: Signer<'info>,

    #[account(mut)]
    pub escrow_token: Account<'info, TokenAccount>,

    #[account(mut)]
    pub agent_token: Account<'info, TokenAccount>,

    #[account(mut)]
    pub requester_token: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

// Data structures

#[account]
pub struct Job {
    pub job_id: String,          // 32 bytes
    pub requester: Pubkey,       // 32 bytes
    pub agent: Pubkey,           // 32 bytes
    pub amount: u64,             // 8 bytes
    pub description: String,     // 200 bytes max
    pub status: JobStatus,       // 1 byte
    pub created_at: i64,         // 8 bytes
    pub deadline: i64,           // 8 bytes
    pub deliverable: String,     // 300 bytes max
    pub disputed: bool,          // 1 byte
    pub rating: u8,              // 1 byte
}

impl Job {
    pub const LEN: usize = 32 + 32 + 32 + 8 + 200 + 1 + 8 + 8 + 300 + 1 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum JobStatus {
    Open,
    InProgress,
    UnderReview,
    Completed,
    Cancelled,
    Disputed,
    Resolved,
}

// Errors

#[error_code]
pub enum EscrowError {
    #[msg("Job is not open")]
    JobNotOpen,
    #[msg("Job already taken by another agent")]
    JobAlreadyTaken,
    #[msg("Invalid job status for this operation")]
    InvalidStatus,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Cannot cancel job at this stage")]
    CannotCancel,
    #[msg("Job is not disputed")]
    NotDisputed,
    #[msg("Invalid percentage (must be 0-100)")]
    InvalidPercentage,
    #[msg("Invalid rating (must be 1-5)")]
    InvalidRating,
}
