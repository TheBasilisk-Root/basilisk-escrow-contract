use anchor_lang::prelude::*;

pub mod state;
pub mod errors;
pub mod instructions;

use instructions::*;

// Program ID — will be replaced with actual deployed keypair address
declare_id!("2pF2rYoQkQK2CzRzQmK9YacHqxeC6R9tPzxfNJAmJTie");

#[program]
pub mod basilisk_escrow {
    use super::*;

    /// Initialize program configuration with admin and arbitrator.
    /// Must be called once after deployment before any jobs can use disputes.
    pub fn initialize(ctx: Context<Initialize>, arbitrator: Pubkey) -> Result<()> {
        instructions::initialize::handler(ctx, arbitrator)
    }

    /// Update program configuration (admin-only).
    pub fn update_config(
        ctx: Context<UpdateConfig>,
        new_arbitrator: Option<Pubkey>,
        new_admin: Option<Pubkey>,
    ) -> Result<()> {
        instructions::update_config::handler(ctx, new_arbitrator, new_admin)
    }

    /// Create a new escrow job with funds locked in PDA.
    pub fn create_job(
        ctx: Context<CreateJob>,
        job_id: String,
        amount: u64,
        description: String,
        deadline_days: u8,
    ) -> Result<()> {
        instructions::create_job::handler(ctx, job_id, amount, description, deadline_days)
    }

    /// Agent accepts an open job.
    pub fn accept_job(ctx: Context<AcceptJob>) -> Result<()> {
        instructions::accept_job::handler(ctx)
    }

    /// Agent submits deliverable for review.
    pub fn submit_deliverable(
        ctx: Context<SubmitDeliverable>,
        deliverable_url: String,
        notes: String,
    ) -> Result<()> {
        instructions::submit_deliverable::handler(ctx, deliverable_url, notes)
    }

    /// Requester approves work and releases payment.
    pub fn approve_and_pay(ctx: Context<ApproveAndPay>, rating: u8) -> Result<()> {
        instructions::approve_and_pay::handler(ctx, rating)
    }

    /// Requester rejects work, opening a dispute.
    pub fn reject_work(ctx: Context<RejectWork>, reason: String) -> Result<()> {
        instructions::reject_work::handler(ctx, reason)
    }

    /// Requester cancels an open job (refunds escrowed tokens).
    pub fn cancel_job(ctx: Context<CancelJob>) -> Result<()> {
        instructions::cancel_job::handler(ctx)
    }

    /// Authorized arbitrator resolves a dispute.
    pub fn resolve_dispute(
        ctx: Context<ResolveDispute>,
        agent_percentage: u8,
    ) -> Result<()> {
        instructions::resolve_dispute::handler(ctx, agent_percentage)
    }
}
