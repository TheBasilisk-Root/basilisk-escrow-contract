use anchor_lang::prelude::*;
use crate::state::ProgramConfig;
use crate::errors::EscrowError;

/// Update program configuration (admin-only).
/// Allows changing the arbitrator or transferring admin rights.
pub fn handler(
    ctx: Context<UpdateConfig>,
    new_arbitrator: Option<Pubkey>,
    new_admin: Option<Pubkey>,
) -> Result<()> {
    let config = &mut ctx.accounts.config;

    if let Some(arbitrator) = new_arbitrator {
        msg!("Arbitrator updated: {} -> {}", config.arbitrator, arbitrator);
        config.arbitrator = arbitrator;
    }

    if let Some(admin) = new_admin {
        msg!("Admin transferred: {} -> {}", config.admin, admin);
        config.admin = admin;
    }

    Ok(())
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
        has_one = admin @ EscrowError::Unauthorized,
    )]
    pub config: Account<'info, ProgramConfig>,

    pub admin: Signer<'info>,
}
