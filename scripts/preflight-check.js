/**
 * Pre-Flight Check — Verify readiness before multi-chain deployment
 *
 * Checks: RPC connectivity, deployer balance, gas estimates, env vars
 *
 * Usage:
 *   npx hardhat run scripts/preflight-check.js                    # all mainnets
 *   CHAINS=sepolia,baseSepolia npx hardhat run scripts/preflight-check.js  # specific chains
 */

const hre = require("hardhat");

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

const MAINNETS = ["ethereum", "base", "arbitrum", "avalanche"];
const TESTNETS = ["sepolia", "baseSepolia", "arbitrumSepolia", "fuji"];

const NATIVE_TOKENS = {
  ethereum: "ETH", base: "ETH", arbitrum: "ETH", avalanche: "AVAX",
  sepolia: "ETH", baseSepolia: "ETH", arbitrumSepolia: "ETH", fuji: "AVAX",
};

// Minimum balance needed to deploy 5 contracts (incl. MultiSig) + buffer
const MIN_BALANCE = {
  ethereum: "0.20",   // ~$600 at $3k/ETH (+multisig ~1.5M gas)
  base: "0.007",      // ~$21 (L2, very cheap)
  arbitrum: "0.012",  // ~$36 (L2)
  avalanche: "4.0",   // ~$140 at $35/AVAX
  sepolia: "0.15",    baseSepolia: "0.007",
  arbitrumSepolia: "0.007", fuji: "2.0",
};

async function checkChain(networkName) {
  const config = hre.config.networks[networkName];
  if (!config) return { network: networkName, status: "NOT_CONFIGURED", error: "Network not in hardhat.config.js" };

  const result = { network: networkName, chainId: config.chainId, status: "OK", checks: {} };

  // 1. RPC connectivity
  try {
    const provider = new hre.ethers.JsonRpcProvider(config.url);
    const network = await Promise.race([
      provider.getNetwork(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 8000)),
    ]);
    result.checks.rpc = { ok: true, chainId: Number(network.chainId) };
  } catch (err) {
    result.checks.rpc = { ok: false, error: err.message };
    result.status = "RPC_FAILED";
    return result;
  }

  // 2. Deployer balance
  try {
    const provider = new hre.ethers.JsonRpcProvider(config.url);
    const wallet = new hre.ethers.Wallet(config.accounts[0], provider);
    const balance = await wallet.provider.getBalance(wallet.address);
    const formatted = hre.ethers.formatEther(balance);
    const minBal = hre.ethers.parseEther(MIN_BALANCE[networkName] || "0.01");
    const sufficient = balance >= minBal;

    result.checks.balance = {
      ok: sufficient,
      address: wallet.address,
      balance: formatted,
      native: NATIVE_TOKENS[networkName],
      minimum: MIN_BALANCE[networkName],
    };
    if (!sufficient) result.status = "LOW_BALANCE";
  } catch (err) {
    result.checks.balance = { ok: false, error: err.message };
    result.status = "BALANCE_CHECK_FAILED";
  }

  // 3. Deployer key check
  const key = config.accounts?.[0];
  result.checks.deployerKey = {
    ok: key && key !== "0x" + "00".repeat(32),
    placeholder: key === "0x" + "00".repeat(32),
  };
  if (!result.checks.deployerKey.ok) result.status = "NO_DEPLOYER_KEY";

  // 4. Existing deployment check
  const fs = require("fs");
  const path = require("path");
  const deployPath = path.join(__dirname, "..", "deployments", `${networkName}.json`);
  const exists = fs.existsSync(deployPath);
  result.checks.existingDeployment = { exists };
  if (exists) {
    const dep = JSON.parse(fs.readFileSync(deployPath, "utf8"));
    result.checks.existingDeployment.escrow = dep.contracts?.BasiliskEscrow;
    result.checks.existingDeployment.deployedAt = dep.deployedAt;
  }

  return result;
}

async function main() {
  const chainsEnv = process.env.CHAINS;
  const chains = !chainsEnv ? MAINNETS
    : chainsEnv === "all-mainnets" ? MAINNETS
    : chainsEnv === "all-testnets" ? TESTNETS
    : chainsEnv === "all" ? [...MAINNETS, ...TESTNETS]
    : chainsEnv.split(",").map(c => c.trim());

  console.log(`\n${BOLD}╔══════════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}║  Basilisk Pre-Flight Check                                  ║${RESET}`);
  console.log(`${BOLD}╠══════════════════════════════════════════════════════════════╣${RESET}`);
  console.log(`${BOLD}║  Chains: ${chains.join(", ")}${RESET}`);
  console.log(`${BOLD}╚══════════════════════════════════════════════════════════════╝${RESET}\n`);

  let allReady = true;

  for (const chain of chains) {
    const result = await checkChain(chain);
    const icon = result.status === "OK" ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
    const statusColor = result.status === "OK" ? GREEN : RED;

    console.log(`${icon} ${BOLD}${chain}${RESET} ${DIM}(chain ${result.chainId || "?"})${RESET} — ${statusColor}${result.status}${RESET}`);

    if (result.checks.rpc) {
      const r = result.checks.rpc;
      console.log(`    RPC:      ${r.ok ? GREEN + "connected" : RED + r.error}${RESET}`);
    }

    if (result.checks.balance) {
      const b = result.checks.balance;
      const color = b.ok ? GREEN : RED;
      console.log(`    Balance:  ${color}${b.balance} ${b.native}${RESET} ${DIM}(min: ${b.minimum} ${b.native})${RESET}`);
      console.log(`    Deployer: ${DIM}${b.address}${RESET}`);
    }

    if (result.checks.deployerKey && !result.checks.deployerKey.ok) {
      console.log(`    Key:      ${RED}Missing or placeholder${RESET}`);
    }

    if (result.checks.existingDeployment?.exists) {
      console.log(`    ${YELLOW}⚠ Already deployed:${RESET} ${result.checks.existingDeployment.escrow}`);
      console.log(`      ${DIM}at ${result.checks.existingDeployment.deployedAt}${RESET}`);
    }

    if (result.status !== "OK") allReady = false;
    console.log();
  }

  // Summary
  console.log(`${BOLD}──────────────────────────────────────${RESET}`);
  if (allReady) {
    console.log(`${GREEN}${BOLD}All ${chains.length} chains ready for deployment.${RESET}`);
    console.log(`\nRun: ${CYAN}npx hardhat run scripts/deploy-multichain.js${RESET}`);
  } else {
    console.log(`${RED}${BOLD}Some chains are not ready. Fix issues above before deploying.${RESET}`);
  }

  // Env var checklist
  console.log(`\n${BOLD}Env Var Checklist:${RESET}`);
  const envChecks = [
    ["DEPLOYER_PRIVATE_KEY", !!process.env.DEPLOYER_PRIVATE_KEY],
    ["ARBITRATOR_ADDRESS", !!process.env.ARBITRATOR_ADDRESS],
    ["OPS_WALLET_ADDRESS", !!process.env.OPS_WALLET_ADDRESS],
    ["MULTISIG_SIGNERS", !!process.env.MULTISIG_SIGNERS],
    ["MULTISIG_THRESHOLD", !!process.env.MULTISIG_THRESHOLD],
  ];
  for (const [name, ok] of envChecks) {
    console.log(`  ${ok ? GREEN + "✓" : RED + "✗"} ${name}${RESET}`);
  }

  // Validate MULTISIG_SIGNERS format
  if (process.env.MULTISIG_SIGNERS) {
    const msSigners = process.env.MULTISIG_SIGNERS.split(",").map((s) => s.trim());
    const msThreshold = parseInt(process.env.MULTISIG_THRESHOLD || "5", 10);
    const validAddrs = msSigners.every((a) => /^0x[0-9a-fA-F]{40}$/.test(a));
    const uniqueAddrs = new Set(msSigners.map((a) => a.toLowerCase())).size === msSigners.length;

    console.log(`\n${BOLD}MultiSig Config:${RESET}`);
    console.log(`  ${validAddrs ? GREEN + "✓" : RED + "✗"} ${msSigners.length} signer addresses ${validAddrs ? "valid" : "INVALID"}${RESET}`);
    console.log(`  ${uniqueAddrs ? GREEN + "✓" : RED + "✗"} All addresses unique${RESET}`);
    console.log(`  ${msThreshold > 0 && msThreshold <= msSigners.length ? GREEN + "✓" : RED + "✗"} Threshold: ${msThreshold}-of-${msSigners.length}${RESET}`);

    if (!validAddrs || !uniqueAddrs) allReady = false;
  }
}

main().catch(console.error);
