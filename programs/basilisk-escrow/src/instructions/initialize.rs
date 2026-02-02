use anchor_lang::prelude::*;
use crate::state::ProgramConfig;

/// Initialize the program configuration.
/// Called once after deployment to set admin and arbitrator.
pub fn handler(ctx: Context<Initialize>, arbitrator: Pubkey) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.arbitrator = arbitrator;
    config.bump = ctx.bumps.config;

    msg!(
        "Program initialized: admin={}, arbitrator={}",
        config.admin,
        config.arbitrator
    );
    Ok(())
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + ProgramConfig::LEN,
        seeds = [b"config"],
        bump,
    )]
    pub config: Account<'info, ProgramConfig>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}
