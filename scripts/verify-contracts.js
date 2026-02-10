const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const network = hre.network.name;
  const deploymentPath = path.join(__dirname, "..", "deployments", `${network}.json`);

  if (!fs.existsSync(deploymentPath)) {
    console.error(`No deployment found for network: ${network}`);
    console.error(`Run: npx hardhat run scripts/deploy-all.js --network ${network}`);
    process.exit(1);
  }

  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf-8"));
  const { contracts, config } = deployment;

  console.log(`Verifying contracts on ${network}...`);
  console.log();

  // ── 1. IdentityRegistry (no constructor args) ───────────────────────
  try {
    console.log("1/4 Verifying IdentityRegistry...");
    await hre.run("verify:verify", {
      address: contracts.IdentityRegistry,
      constructorArguments: [],
    });
    console.log("     Verified.");
  } catch (e) {
    console.log(`     ${e.message.includes("Already Verified") ? "Already verified." : e.message}`);
  }

  // ── 2. ReputationRegistry ────────────────────────────────────────────
  try {
    console.log("2/4 Verifying ReputationRegistry...");
    await hre.run("verify:verify", {
      address: contracts.ReputationRegistry,
      constructorArguments: [contracts.IdentityRegistry],
    });
    console.log("     Verified.");
  } catch (e) {
    console.log(`     ${e.message.includes("Already Verified") ? "Already verified." : e.message}`);
  }

  // ── 3. ValidationRegistry ────────────────────────────────────────────
  try {
    console.log("3/4 Verifying ValidationRegistry...");
    await hre.run("verify:verify", {
      address: contracts.ValidationRegistry,
      constructorArguments: [contracts.IdentityRegistry],
    });
    console.log("     Verified.");
  } catch (e) {
    console.log(`     ${e.message.includes("Already Verified") ? "Already verified." : e.message}`);
  }

  // ── 4. BasiliskEscrow ───────────────────────────────────────────────
  try {
    console.log("4/4 Verifying BasiliskEscrow...");
    await hre.run("verify:verify", {
      address: contracts.BasiliskEscrow,
      constructorArguments: [
        deployment.deployer,
        config.arbitrator,
        config.treasury,
        config.opsWallet,
        config.feeBps,
        contracts.IdentityRegistry,
      ],
    });
    console.log("     Verified.");
  } catch (e) {
    console.log(`     ${e.message.includes("Already Verified") ? "Already verified." : e.message}`);
  }

  console.log();
  console.log("Verification complete.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
