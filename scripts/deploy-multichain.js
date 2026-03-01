/**
 * Multi-Chain Deployment — Deploy Basilisk contracts to all configured EVM networks
 *
 * Deploys: IdentityRegistry, ReputationRegistry, ValidationRegistry, BasiliskEscrow
 * Saves per-chain JSON + unified registry.json
 *
 * Usage:
 *   CHAINS=ethereum,base,arbitrum,avalanche npx hardhat run scripts/deploy-multichain.js
 *   CHAINS=sepolia,baseSepolia npx hardhat run scripts/deploy-multichain.js  # testnets
 *   CHAINS=all-mainnets npx hardhat run scripts/deploy-multichain.js
 *   CHAINS=all-testnets npx hardhat run scripts/deploy-multichain.js
 *
 * Options:
 *   SKIP_EXISTING=true  — Skip chains that already have a deployment
 *   DRY_RUN=true        — Only show what would be deployed
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
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

function loadRegistry() {
  if (fs.existsSync(REGISTRY_PATH)) {
    return JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
  }
  return { version: "2.0.0", deployments: {}, lastUpdated: null };
}

function saveRegistry(registry) {
  registry.lastUpdated = new Date().toISOString();
  if (!fs.existsSync(DEPLOYERS_DIR)) fs.mkdirSync(DEPLOYERS_DIR, { recursive: true });
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2));
}

async function main() {
  const chains = resolveChains(process.env.CHAINS);
  const skipExisting = process.env.SKIP_EXISTING === "true";
  const dryRun = process.env.DRY_RUN === "true";

  console.log(`\n${BOLD}╔══════════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}║  Basilisk Multi-Chain Deployment                             ║${RESET}`);
  console.log(`${BOLD}╠══════════════════════════════════════════════════════════════╣${RESET}`);
  console.log(`${BOLD}║  Chains:  ${chains.join(", ")}${RESET}`);
  console.log(`${BOLD}║  Skip:    ${skipExisting ? "yes (existing deployments)" : "no (overwrite)"}${RESET}`);
  console.log(`${BOLD}║  Dry run: ${dryRun ? "YES" : "no"}${RESET}`);
  console.log(`${BOLD}╚══════════════════════════════════════════════════════════════╝${RESET}\n`);

  const registry = loadRegistry();
  const results = [];

  for (let i = 0; i < chains.length; i++) {
    const chain = chains[i];
    const progress = `[${i + 1}/${chains.length}]`;
    const deployPath = path.join(DEPLOYERS_DIR, `${chain}.json`);

    // Check existing
    if (skipExisting && fs.existsSync(deployPath)) {
      console.log(`${YELLOW}${progress} ${chain} — skipped (already deployed)${RESET}`);
      results.push({ chain, status: "SKIPPED" });
      continue;
    }

    if (dryRun) {
      console.log(`${CYAN}${progress} ${chain} — would deploy${RESET}`);
      results.push({ chain, status: "DRY_RUN" });
      continue;
    }

    console.log(`${CYAN}${BOLD}${progress} Deploying to ${chain}...${RESET}`);
    const startTime = Date.now();

    try {
      // Run deploy-chain.js with the target network via hardhat
      const output = execSync(
        `npx hardhat run scripts/deploy-chain.js --network ${chain}`,
        {
          cwd: path.join(__dirname, ".."),
          encoding: "utf8",
          timeout: 600000, // 10 min per chain
          env: { ...process.env },
        }
      );

      // Print output indented
      const lines = output.split("\n").filter((l) => l.trim());
      for (const line of lines) {
        console.log(`    ${DIM}${line}${RESET}`);
      }

      // Load the deployment that was just saved
      if (fs.existsSync(deployPath)) {
        const dep = JSON.parse(fs.readFileSync(deployPath, "utf8"));
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        // Update registry
        registry.deployments[chain] = {
          ...dep,
          deployedAt: dep.deployedAt || new Date().toISOString(),
          deployDuration: `${elapsed}s`,
          verified: false,
        };

        console.log(`  ${GREEN}✓ ${chain} deployed in ${elapsed}s${RESET}`);
        console.log(`    ${DIM}Escrow: ${dep.contracts.BasiliskEscrow}${RESET}\n`);
        results.push({ chain, status: "DEPLOYED", escrow: dep.contracts.BasiliskEscrow });
      }
    } catch (err) {
      const msg = err.stderr || err.message || String(err);
      console.log(`  ${RED}✗ ${chain} FAILED${RESET}`);
      console.log(`    ${RED}${msg.split("\n").slice(0, 5).join("\n    ")}${RESET}\n`);
      results.push({ chain, status: "FAILED", error: msg.split("\n")[0] });
      registry.deployments[chain] = { status: "FAILED", error: msg.split("\n")[0], attemptedAt: new Date().toISOString() };
    }
  }

  // Save registry
  saveRegistry(registry);

  // ── Summary ──
  console.log(`${BOLD}╔══════════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}║  DEPLOYMENT SUMMARY                                         ║${RESET}`);
  console.log(`${BOLD}╠══════════════════════════════════════════════════════════════╣${RESET}`);

  for (const r of results) {
    const icon = r.status === "DEPLOYED" ? `${GREEN}✓${RESET}` :
                 r.status === "SKIPPED" ? `${YELLOW}○${RESET}` :
                 r.status === "DRY_RUN" ? `${CYAN}~${RESET}` : `${RED}✗${RESET}`;
    const extra = r.escrow ? ` → ${r.escrow}` : r.error ? ` → ${r.error}` : "";
    console.log(`${BOLD}║${RESET}  ${icon} ${r.chain}: ${r.status}${DIM}${extra}${RESET}`);
  }

  console.log(`${BOLD}╠══════════════════════════════════════════════════════════════╣${RESET}`);
  console.log(`${BOLD}║${RESET}  Registry: ${DIM}deployments/registry.json${RESET}`);
  console.log(`${BOLD}╚══════════════════════════════════════════════════════════════╝${RESET}`);

  // Generate .env snippet for backend
  const deployed = results.filter((r) => r.status === "DEPLOYED");
  if (deployed.length > 0) {
    console.log(`\n${BOLD}Backend .env snippet:${RESET}`);
    const chainEnvMap = {
      ethereum: "ETHEREUM", base: "BASE", arbitrum: "ARBITRUM",
      avalanche: "AVALANCHE", sepolia: "SEPOLIA",
      baseSepolia: "BASE_SEPOLIA", arbitrumSepolia: "ARBITRUM_SEPOLIA", fuji: "FUJI",
    };
    for (const r of deployed) {
      const prefix = chainEnvMap[r.chain] || r.chain.toUpperCase();
      const dep = registry.deployments[r.chain];
      console.log(`${prefix}_ESCROW_ADDRESS=${dep.contracts.BasiliskEscrow}`);
      console.log(`${prefix}_IDENTITY_ADDRESS=${dep.contracts.IdentityRegistry}`);
      if (dep.contracts.BasiliskMultiSig) {
        console.log(`${prefix}_MULTISIG_ADDRESS=${dep.contracts.BasiliskMultiSig}`);
      }
    }

    console.log(`\n${BOLD}Next step:${RESET} Verify contracts on block explorers:`);
    console.log(`  ${CYAN}CHAINS=${deployed.map((r) => r.chain).join(",")} npx hardhat run scripts/verify-multichain.js${RESET}`);
  }
}

main().catch(console.error);
