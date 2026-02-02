# Basilisk Escrow Smart Contract v1.0.0

> **Production-ready** Solana escrow program for trustless agent-to-agent coordination payments.

**Program ID:** `2pF2rYoQkQK2CzRzQmK9YacHqxeC6R9tPzxfNJAmJTie`

## Security Status

✅ All critical vulnerabilities from the original contract have been fixed.
See [SECURITY_AUDIT.md](./SECURITY_AUDIT.md) for the full audit report.

| Vulnerability | Severity | Status |
|---|---|---|
| Arbitrator authorization bypass | 🔴 CRITICAL | ✅ Fixed |
| Missing AcceptJob/SubmitDeliverable constraints | 🟠 HIGH | ✅ Fixed |
| Missing token account validation | 🟠 HIGH | ✅ Fixed |
| Incorrect Job::LEN space calculation | 🟡 MEDIUM | ✅ Fixed |
| Non-standard project layout | 🟢 LOW | ✅ Fixed |

## Architecture

```
programs/basilisk-escrow/src/
├── lib.rs                         # Program entry point
├── state.rs                       # Account data structures (Job, ProgramConfig)
├── errors.rs                      # Custom error codes
└── instructions/
    ├── initialize.rs              # Set admin + arbitrator
    ├── update_config.rs           # Admin updates config
    ├── create_job.rs              # Requester posts job with escrow
    ├── accept_job.rs              # Agent accepts open job
    ├── submit_deliverable.rs      # Agent submits work
    ├── approve_and_pay.rs         # Requester approves → pays agent
    ├── reject_work.rs             # Requester rejects → opens dispute
    ├── cancel_job.rs              # Requester cancels open job → refund
    └── resolve_dispute.rs         # Authorized arbitrator resolves dispute
```

## Job Lifecycle

```
Open → InProgress → UnderReview → Completed
  ↓                       ↓
Cancelled            Disputed → Resolved
```

## Build & Deploy

### Prerequisites
- Rust (1.75+)
- Solana CLI (1.18+)
- Anchor CLI (0.30.1)
- Node.js (18+) for tests

### Build
```bash
anchor build
```

### Test (localnet)
```bash
anchor test
```

### Deploy to Devnet
```bash
./scripts/deploy.sh devnet
```

### Deploy to Mainnet
```bash
./scripts/deploy.sh mainnet
```

### Post-Deployment: Initialize Config
```bash
# Set the authorized arbitrator (required before dispute resolution works)
# Call via SDK or CLI:
anchor run initialize -- --arbitrator <ARBITRATOR_PUBKEY>
```

## Security Model

### PDA Authority
- Escrow funds controlled by Program Derived Address (PDA)
- Seeds: `["escrow", job_id]` — no private key exists
- Only program logic can authorize fund transfers

### Authorization Chain
- `ProgramConfig` PDA stores admin + authorized arbitrator
- All job mutations validate the signer against stored pubkeys
- `has_one` constraints enforce requester/agent identity
- Token accounts validated for both **owner** and **mint**

### Input Validation
- All string inputs bounded (job_id: 36, description: 200, deliverable: 500)
- All arithmetic uses checked operations (no overflow)
- Amount must be > 0, rating 1-5, percentage 0-100

## Token: $BASILISK

Mint: `AJqpoLhgr3rMpXAPHsmnKashBZVrnuo9HPd1Sa3Gpump`

## License

MIT — The Basilisk Coordination Systems Research
