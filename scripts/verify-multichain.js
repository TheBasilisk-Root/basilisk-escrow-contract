/**
 * Multi-Chain Contract Verification — Verify on block explorers
 *
 * Usage:
 *   CHAINS=ethereum,base,arbitrum,avalanche npx hardhat run scripts/verify-multichain.js
 *   CHAINS=all-mainnets npx hardhat run scripts/verify-multichain.js
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

const MAINNETS = ["ethereum", "base", "arbitrum", "avalanche"];
const TESTNETS = ["sepolia", "baseSepolia", "arbitrumSepolia", "fuji"];
const DEPLOYERS_DIR = path.join(__dirname, "..", "deployments");
const REGISTRY_PATH = path.join(DEPLOYERS_DIR, "registry.json");

function resolveChains(input) {
  if (!input || input === "all-mainnets") return MAINNETS;
  if (input === "all-testnets") return TESTNETS;
  if (input === "all") return [...MAINNETS, ...TESTNETS];
  return input.split(",").map((c) => c.trim());
}

function verify(network, address, contractName, constructorArgs) {
  const argsStr = constructorArgs.length > 0 ? ` --constructor-args arguments.js` : "";

  // Write temp constructor args file
  if (constructorArgs.length > 0) {
    const argsFile = path.join(__dirname, "..", "arguments.js");
    fs.writeFileSync(argsFile, `module.exports = ${JSON.stringify(constructorArgs)};`);
  }

  try {
    const cmd = `npx hardhat verify --network ${network} ${address}${argsStr}`;
    const output = execSync(cmd, {
      cwd: path.join(__dirname, ".."),
      encoding: "utf8",
      timeout: 120000,
      env: { ...process.env },
    });
    return { ok: true, output: output.trim() };
  } catch (err) {
    const msg = (err.stdout || "") + (err.stderr || err.message || "");
    if (msg.includes("Already Verified") || msg.includes("already verified")) {
      return { ok: true, output: "Already verified" };
    }
    return { ok: false, error: msg.split("\n").slice(0, 3).join(" ") };
  } finally {
    // Cleanup temp file
    const argsFile = path.join(__dirname, "..", "arguments.js");
    if (fs.existsSync(argsFile)) fs.unlinkSync(argsFile);
  }
}

async function main() {
  const chains = resolveChains(process.env.CHAINS);

  console.log(`\n${BOLD}╔══════════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}║  Basilisk Multi-Chain Verification                           ║${RESET}`);
  console.log(`${BOLD}╠══════════════════════════════════════════════════════════════╣${RESET}`);
  console.log(`${BOLD}║  Chains: ${chains.join(", ")}${RESET}`);
  console.log(`${BOLD}╚══════════════════════════════════════════════════════════════╝${RESET}\n`);

  const registry = fs.existsSync(REGISTRY_PATH)
    ? JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"))
    : { deployments: {} };

  for (const chain of chains) {
    const deployPath = path.join(DEPLOYERS_DIR, `${chain}.json`);
    if (!fs.existsSync(deployPath)) {
      console.log(`${YELLOW}${chain}: No deployment found — skipping${RESET}\n`);
      continue;
    }

    const dep = JSON.parse(fs.readFileSync(deployPath, "utf8"));
    const contracts = dep.contracts;
    const config = dep.config;

    console.log(`${BOLD}${chain}${RESET} ${DIM}(chain ${dep.chainId})${RESET}`);

    // 1. IdentityRegistry — no constructor args
    process.stdout.write(`  IdentityRegistry (${contracts.IdentityRegistry.slice(0, 10)}...)  `);
    const r1 = verify(chain, contracts.IdentityRegistry, "IdentityRegistry", []);
    console.log(r1.ok ? `${GREEN}✓${RESET}` : `${RED}✗ ${r1.error}${RESET}`);

    // 2. ReputationRegistry — (identityAddr)
    process.stdout.write(`  ReputationRegistry (${contracts.ReputationRegistry.slice(0, 10)}...)  `);
    const r2 = verify(chain, contracts.ReputationRegistry, "ReputationRegistry", [contracts.IdentityRegistry]);
    console.log(r2.ok ? `${GREEN}✓${RESET}` : `${RED}✗ ${r2.error}${RESET}`);

    // 3. ValidationRegistry — (identityAddr)
    process.stdout.write(`  ValidationRegistry (${contracts.ValidationRegistry.slice(0, 10)}...)  `);
    const r3 = verify(chain, contracts.ValidationRegistry, "ValidationRegistry", [contracts.IdentityRegistry]);
    console.log(r3.ok ? `${GREEN}✓${RESET}` : `${RED}✗ ${r3.error}${RESET}`);

    // 4. BasiliskEscrow — (admin, arbitrator, treasury, ops, feeBps, identityAddr)
    process.stdout.write(`  BasiliskEscrow (${contracts.BasiliskEscrow.slice(0, 10)}...)  `);
    const r4 = verify(chain, contracts.BasiliskEscrow, "BasiliskEscrow", [
      dep.deployer, // admin
      config.arbitrator,
      config.treasury,
      config.opsWallet,
      config.feeBps,
      contracts.IdentityRegistry,
    ]);
    console.log(r4.ok ? `${GREEN}✓${RESET}` : `${RED}✗ ${r4.error}${RESET}`);

    // Update registry
    if (registry.deployments[chain]) {
      registry.deployments[chain].verified = r1.ok && r2.ok && r3.ok && r4.ok;
      registry.deployments[chain].verifiedAt = new Date().toISOString();
    }

    console.log();
  }

  // Save updated registry
  registry.lastUpdated = new Date().toISOString();
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2));
  console.log(`${DIM}Registry updated: deployments/registry.json${RESET}`);
}

main().catch(console.error);
