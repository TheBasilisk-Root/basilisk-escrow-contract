const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network = hre.network.name;

  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  Basilisk EVM Contract Deployment                           ║");
  console.log("╠══════════════════════════════════════════════════════════════╣");
  console.log(`║  Network:    ${network}`);
  console.log(`║  Deployer:   ${deployer.address}`);
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log();

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log(`Deployer balance: ${hre.ethers.formatEther(balance)} ETH`);
  console.log();

  // Config — use env vars or deployer as fallback for local testing
  const arbitrator = process.env.ARBITRATOR_ADDRESS || deployer.address;
  const treasury = process.env.TREASURY_ADDRESS || deployer.address;
  const opsWallet = process.env.OPS_WALLET_ADDRESS || deployer.address;
  const feeBps = 500; // 5%

  // ── 1. Deploy Identity Registry ──────────────────────────────────────
  console.log("1/4 Deploying IdentityRegistry...");
  const IdentityRegistry = await hre.ethers.getContractFactory("IdentityRegistry");
  const identity = await IdentityRegistry.deploy();
  await identity.waitForDeployment();
  const identityAddr = await identity.getAddress();
  console.log(`     IdentityRegistry: ${identityAddr}`);

  // ── 2. Deploy Reputation Registry ────────────────────────────────────
  console.log("2/4 Deploying ReputationRegistry...");
  const ReputationRegistry = await hre.ethers.getContractFactory("ReputationRegistry");
  const reputation = await ReputationRegistry.deploy(identityAddr);
  await reputation.waitForDeployment();
  const reputationAddr = await reputation.getAddress();
  console.log(`     ReputationRegistry: ${reputationAddr}`);

  // ── 3. Deploy Validation Registry ────────────────────────────────────
  console.log("3/4 Deploying ValidationRegistry...");
  const ValidationRegistry = await hre.ethers.getContractFactory("ValidationRegistry");
  const validation = await ValidationRegistry.deploy(identityAddr);
  await validation.waitForDeployment();
  const validationAddr = await validation.getAddress();
  console.log(`     ValidationRegistry: ${validationAddr}`);

  // ── 4. Deploy BasiliskEscrow ─────────────────────────────────────────
  console.log("4/4 Deploying BasiliskEscrow...");
  const BasiliskEscrow = await hre.ethers.getContractFactory("BasiliskEscrow");
  const escrow = await BasiliskEscrow.deploy(
    deployer.address, // admin
    arbitrator,
    treasury,
    opsWallet,
    feeBps,
    identityAddr
  );
  await escrow.waitForDeployment();
  const escrowAddr = await escrow.getAddress();
  console.log(`     BasiliskEscrow: ${escrowAddr}`);

  // ── Save deployment addresses ────────────────────────────────────────
  const deployment = {
    network,
    chainId: Number((await hre.ethers.provider.getNetwork()).chainId),
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    contracts: {
      IdentityRegistry: identityAddr,
      ReputationRegistry: reputationAddr,
      ValidationRegistry: validationAddr,
      BasiliskEscrow: escrowAddr,
    },
    config: {
      arbitrator,
      treasury,
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
  console.log(`║  IdentityRegistry:   ${identityAddr}`);
  console.log(`║  ReputationRegistry: ${reputationAddr}`);
  console.log(`║  ValidationRegistry: ${validationAddr}`);
  console.log(`║  BasiliskEscrow:     ${escrowAddr}`);
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
