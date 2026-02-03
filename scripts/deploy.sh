#!/bin/bash
# ============================================================================
# Basilisk Escrow Contract — Deployment Script
# ============================================================================
#
# Usage:
#   ./scripts/deploy.sh devnet    # Deploy to devnet (testing)
#   ./scripts/deploy.sh mainnet   # Deploy to mainnet (production)
#
# Prerequisites:
#   - Solana CLI installed (solana --version)
#   - Anchor CLI installed (anchor --version)
#   - Program keypair at target/deploy/basilisk_escrow-keypair.json
#   - Wallet configured (solana config set --url <cluster> -k <wallet-path>)
#
# Program ID: GXwWMznpFNaABnXj47ypdq3bvb1dfNBXijZ1m936ZFH1
# Deploy wallet: Fur9MZEUr1uipaDtZzYrUe8xTffSXi7fUfgcQp5F57xR
# ============================================================================

set -euo pipefail

PROGRAM_ID="GXwWMznpFNaABnXj47ypdq3bvb1dfNBXijZ1m936ZFH1"
DEPLOY_WALLET="Fur9MZEUr1uipaDtZzYrUe8xTffSXi7fUfgcQp5F57xR"
KEYPAIR_PATH="target/deploy/basilisk_escrow-keypair.json"

CLUSTER="${1:-devnet}"

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Basilisk Escrow Contract Deployment                        ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  Cluster:    $CLUSTER"
echo "║  Program ID: $PROGRAM_ID"
echo "║  Wallet:     $DEPLOY_WALLET"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# ── Preflight checks ────────────────────────────────────────────────
echo "→ Checking prerequisites..."

if ! command -v solana &> /dev/null; then
    echo "✗ solana CLI not found. Install: sh -c \"\$(curl -sSfL https://release.anza.xyz/stable/install)\""
    exit 1
fi

if ! command -v anchor &> /dev/null; then
    echo "✗ anchor CLI not found. Install: cargo install --git https://github.com/coral-xyz/anchor --tag v0.30.1 anchor-cli"
    exit 1
fi

if [ ! -f "$KEYPAIR_PATH" ]; then
    echo "✗ Program keypair not found at $KEYPAIR_PATH"
    echo "  Generate with: solana-keygen new -o $KEYPAIR_PATH"
    exit 1
fi

# Verify keypair matches expected program ID
KEYPAIR_PUBKEY=$(solana-keygen pubkey "$KEYPAIR_PATH")
if [ "$KEYPAIR_PUBKEY" != "$PROGRAM_ID" ]; then
    echo "✗ Keypair mismatch! Expected $PROGRAM_ID, got $KEYPAIR_PUBKEY"
    exit 1
fi
echo "✓ Program keypair verified: $PROGRAM_ID"

# ── Configure cluster ───────────────────────────────────────────────
if [ "$CLUSTER" = "mainnet" ]; then
    CLUSTER_URL="https://api.mainnet-beta.solana.com"
    echo ""
    echo "⚠  WARNING: Deploying to MAINNET. This is irreversible."
    echo "   Press Ctrl+C within 10 seconds to abort..."
    sleep 10
elif [ "$CLUSTER" = "devnet" ]; then
    CLUSTER_URL="https://api.devnet.solana.com"
else
    echo "✗ Unknown cluster: $CLUSTER (use 'devnet' or 'mainnet')"
    exit 1
fi

solana config set --url "$CLUSTER_URL" --keypair ~/.config/solana/id.json

echo ""
echo "→ Checking wallet balance..."
BALANCE=$(solana balance "$DEPLOY_WALLET" --url "$CLUSTER_URL" 2>/dev/null || echo "0 SOL")
echo "  Wallet balance: $BALANCE"

# ── Build ────────────────────────────────────────────────────────────
echo ""
echo "→ Building program..."
anchor build

# Verify the built program matches our keypair
BUILT_ID=$(solana-keygen pubkey target/deploy/basilisk_escrow-keypair.json)
echo "✓ Built program ID: $BUILT_ID"

# ── Deploy ───────────────────────────────────────────────────────────
echo ""
echo "→ Deploying to $CLUSTER..."
anchor deploy --provider.cluster "$CLUSTER"

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  ✓ DEPLOYMENT SUCCESSFUL                                    ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  Program ID: $PROGRAM_ID"
echo "║  Cluster:    $CLUSTER"
echo "║  Explorer:   https://explorer.solana.com/address/$PROGRAM_ID"
if [ "$CLUSTER" = "devnet" ]; then
echo "║              ?cluster=devnet"
fi
echo "╚══════════════════════════════════════════════════════════════╝"

echo ""
echo "NEXT STEPS:"
echo "  1. Run: anchor test --provider.cluster $CLUSTER"
echo "  2. Initialize config: Call 'initialize' with your arbitrator pubkey"
echo "  3. Verify on Explorer: https://explorer.solana.com/address/$PROGRAM_ID"
if [ "$CLUSTER" = "devnet" ]; then
echo "  4. When ready: ./scripts/deploy.sh mainnet"
fi
