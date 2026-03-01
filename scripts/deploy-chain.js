/**
 * Per-Chain Deployment — Deploy all 5 Basilisk contracts to a single EVM network.
 *
 * Deploys in order:
 *   1/5 BasiliskMultiSig    (signers, threshold)
 *   2/5 IdentityRegistry    ()
 *   3/5 ReputationRegistry  (identityAddr)
 *   4/5 ValidationRegistry  (identityAddr)
 *   5/5 BasiliskEscrow      (admin, arbitrator, treasury=MULTISIG, opsWallet, feeBps, identityAddr)
 *
 * Usage:
 *   npx hardhat run scripts/deploy-chain.js --network base
 *   npx hardhat run scripts/deploy-chain.js --network sepolia
 *
 * Required env:
 *   MULTISIG_SIGNERS     — 7 comma-separated addresses
 *   MULTISIG_THRESHOLD   — defaults to 5
 *   ARBITRATOR_ADDRESS   — dispute resolver
 *   OPS_WALLET_ADDRESS   — operations wallet
 */

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network = hre.network.name;

  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  Basilisk Per-Chain Deployment (with MultiSig)              ║");
  console.log("╠══════════════════════════════════════════════════════════════╣");
  console.log(`║  Network:    ${network}`);
  console.log(`║  Deployer:   ${deployer.address}`);
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log();

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log(`Deployer balance: ${hre.ethers.formatEther(balance)} ETH`);
  console.log();

  // ── Parse config ───────────────────────────────────────────────────────

  const signersRaw = process.env.MULTISIG_SIGNERS;
  if (!signersRaw) {
    console.error("ERROR: MULTISIG_SIGNERS env var required (7 comma-separated addresses)");
    process.exit(1);
  }
  const multisigSigners = signersRaw.split(",").map((s) => s.trim());
  const multisigThreshold = parseInt(process.env.MULTISIG_THRESHOLD || "5", 10);

  if (multisigSigners.length < 3 || multisigSigners.length > 20) {
    console.error(`ERROR: Need 3–20 signers, got ${multisigSigners.length}`);
    process.exit(1);
  }
  for (const addr of multisigSigners) {
    if (!hre.ethers.isAddress(addr)) {
      console.error(`ERROR: Invalid signer address: ${addr}`);
      process.exit(1);
    }
  }
  if (multisigThreshold < 1 || multisigThreshold > multisigSigners.length) {
    console.error(`ERROR: Threshold ${multisigThreshold} invalid for ${multisigSigners.length} signers`);
    process.exit(1);
  }

  const arbitrator = process.env.ARBITRATOR_ADDRESS || deployer.address;
  const opsWallet = process.env.OPS_WALLET_ADDRESS || deployer.address;
  const feeBps = 500; // 5%

  console.log(`MultiSig: ${multisigSigners.length} signers, threshold ${multisigThreshold}`);
  console.log(`Arbitrator: ${arbitrator}`);
  console.log(`Ops Wallet: ${opsWallet}`);
  console.log();

  // ── 1. Deploy BasiliskMultiSig ─────────────────────────────────────────
  console.log("1/5 Deploying BasiliskMultiSig...");
  const MultiSig = await hre.ethers.getContractFactory("BasiliskMultiSig");
  const multisig = await MultiSig.deploy(multisigSigners, multisigThreshold);
  await multisig.waitForDeployment();
  const multisigAddr = await multisig.getAddress();
  console.log(`     BasiliskMultiSig: ${multisigAddr}`);
  await sleep(5000); // Wait for nonce propagation on L2

  // ── 2. Deploy Identity Registry ────────────────────────────────────────
  console.log("2/5 Deploying IdentityRegistry...");
  const IdentityRegistry = await hre.ethers.getContractFactory("IdentityRegistry");
  const identity = await IdentityRegistry.deploy();
  await identity.waitForDeployment();
  const identityAddr = await identity.getAddress();
  console.log(`     IdentityRegistry: ${identityAddr}`);
  await sleep(5000);

  // ── 3. Deploy Reputation Registry ──────────────────────────────────────
  console.log("3/5 Deploying ReputationRegistry...");
  const ReputationRegistry = await hre.ethers.getContractFactory("ReputationRegistry");
  const reputation = await ReputationRegistry.deploy(identityAddr);
  await reputation.waitForDeployment();
  const reputationAddr = await reputation.getAddress();
  console.log(`     ReputationRegistry: ${reputationAddr}`);
  await sleep(5000);

  // ── 4. Deploy Validation Registry ──────────────────────────────────────
  console.log("4/5 Deploying ValidationRegistry...");
  const ValidationRegistry = await hre.ethers.getContractFactory("ValidationRegistry");
  const validation = await ValidationRegistry.deploy(identityAddr);
  await validation.waitForDeployment();
  const validationAddr = await validation.getAddress();
  console.log(`     ValidationRegistry: ${validationAddr}`);
  await sleep(5000);

  // ── 5. Deploy BasiliskEscrow (treasury = multisig) ─────────────────────
  console.log("5/5 Deploying BasiliskEscrow...");
  const BasiliskEscrow = await hre.ethers.getContractFactory("BasiliskEscrow");
  const escrow = await BasiliskEscrow.deploy(
    deployer.address, // admin
    arbitrator,
    multisigAddr, // treasury = multisig
    opsWallet,
    feeBps,
    identityAddr
  );
  await escrow.waitForDeployment();
  const escrowAddr = await escrow.getAddress();
  console.log(`     BasiliskEscrow: ${escrowAddr}`);

  // ── Save deployment addresses ──────────────────────────────────────────
  const deployment = {
    network,
    chainId: Number((await hre.ethers.provider.getNetwork()).chainId),
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    contracts: {
      BasiliskMultiSig: multisigAddr,
      IdentityRegistry: identityAddr,
      ReputationRegistry: reputationAddr,
      ValidationRegistry: validationAddr,
      BasiliskEscrow: escrowAddr,
    },
    config: {
      multisigSigners,
      multisigThreshold,
      treasury: multisigAddr,
      arbitrator,
      opsWallet,
      feeBps,
    },
  };

  const deploymentsDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }
  const outPath = path.join(deploymentsDir, `${network}.json`);
  fs.writeFileSync(outPath, JSON.stringify(deployment, null, 2));

  console.log();
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  DEPLOYMENT SUCCESSFUL                                      ║");
  console.log("╠══════════════════════════════════════════════════════════════╣");
  console.log(`║  BasiliskMultiSig:   ${multisigAddr}`);
  console.log(`║  IdentityRegistry:   ${identityAddr}`);
  console.log(`║  ReputationRegistry: ${reputationAddr}`);
  console.log(`║  ValidationRegistry: ${validationAddr}`);
  console.log(`║  BasiliskEscrow:     ${escrowAddr}`);
  console.log("╠══════════════════════════════════════════════════════════════╣");
  console.log(`║  Treasury (MultiSig): ${multisigAddr}`);
  console.log(`║  Threshold: ${multisigThreshold}-of-${multisigSigners.length}`);
  console.log("╠══════════════════════════════════════════════════════════════╣");
  console.log(`║  Addresses saved to: deployments/${network}.json`);
  console.log("╚══════════════════════════════════════════════════════════════╝");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
