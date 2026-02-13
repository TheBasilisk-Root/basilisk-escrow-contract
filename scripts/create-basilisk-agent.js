/**
 * Basilisk ERC-8004 Agent — Create & Test on Sepolia
 *
 * Creates the "Basilisk" AI agent on-chain via IdentityRegistry (ERC-8004),
 * sets rich metadata, then runs a full escrow lifecycle using this agent.
 *
 * Usage: npx hardhat run scripts/create-basilisk-agent.js --network sepolia
 */

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

let passed = 0;
let failed = 0;
const failures = [];

function ok(msg) {
  passed++;
  console.log(`  ${GREEN}✓${RESET} ${msg}`);
}
function fail(msg, err) {
  failed++;
  failures.push({ msg, err: err?.message || String(err) });
  console.log(`  ${RED}✗${RESET} ${msg}`);
  if (err) console.log(`    ${RED}→ ${err.message || err}${RESET}`);
}
function section(name) {
  console.log(`\n${CYAN}${BOLD}═══ ${name} ═══${RESET}`);
}
function assert(cond, msg, err) {
  if (cond) ok(msg);
  else fail(msg, err || new Error("Assertion failed"));
}
function info(msg) {
  console.log(`  ${DIM}${msg}${RESET}`);
}

async function main() {
  const startTime = Date.now();

  console.log(`
${MAGENTA}${BOLD}    ██████╗  █████╗ ███████╗██╗██╗     ██╗███████╗██╗  ██╗${RESET}
${MAGENTA}${BOLD}    ██╔══██╗██╔══██╗██╔════╝██║██║     ██║██╔════╝██║ ██╔╝${RESET}
${MAGENTA}${BOLD}    ██████╔╝███████║███████╗██║██║     ██║███████╗█████╔╝ ${RESET}
${MAGENTA}${BOLD}    ██╔══██╗██╔══██║╚════██║██║██║     ██║╚════██║██╔═██╗ ${RESET}
${MAGENTA}${BOLD}    ██████╔╝██║  ██║███████║██║███████╗██║███████║██║  ██╗${RESET}
${MAGENTA}${BOLD}    ╚═════╝ ╚═╝  ╚═╝╚══════╝╚═╝╚══════╝╚═╝╚══════╝╚═╝  ╚═╝${RESET}
${BOLD}    ERC-8004 Agent Creation & Escrow Test — Sepolia${RESET}
`);

  // ── Load deployment ──
  const deployPath = path.join(__dirname, "..", "deployments", "sepolia.json");
  const deployment = JSON.parse(fs.readFileSync(deployPath, "utf8"));
  const { IdentityRegistry: identityAddr, ReputationRegistry: reputationAddr, BasiliskEscrow: escrowAddr } = deployment.contracts;

  const [deployer] = await hre.ethers.getSigners();
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log(`  Network:    sepolia`);
  console.log(`  Deployer:   ${deployer.address}`);
  console.log(`  Balance:    ${hre.ethers.formatEther(balance)} ETH`);
  console.log(`  Escrow:     ${escrowAddr}`);
  console.log(`  Identity:   ${identityAddr}`);
  console.log(`  Reputation: ${reputationAddr}`);

  // ── Create Basilisk agent wallet ──
  const basiliskWallet = hre.ethers.Wallet.createRandom().connect(hre.ethers.provider);
  // Create a "client" wallet that will post jobs for Basilisk to work on
  const clientWallet = hre.ethers.Wallet.createRandom().connect(hre.ethers.provider);

  // Fund wallets
  section("0. Fund Agent Wallets");
  const fundAmt = hre.ethers.parseEther("0.08");
  await (await deployer.sendTransaction({ to: basiliskWallet.address, value: fundAmt })).wait();
  await (await deployer.sendTransaction({ to: clientWallet.address, value: fundAmt })).wait();
  ok(`Basilisk wallet: ${basiliskWallet.address} (0.08 ETH)`);
  ok(`Client wallet:   ${clientWallet.address} (0.08 ETH)`);

  // Load contracts
  const identity = await hre.ethers.getContractAt("IdentityRegistry", identityAddr);
  const reputation = await hre.ethers.getContractAt("ReputationRegistry", reputationAddr);
  const escrow = await hre.ethers.getContractAt("BasiliskEscrow", escrowAddr);

  // ═══════════════════════════════════════════════════════════
  section("1. Register Basilisk Agent (ERC-8004)");
  // ═══════════════════════════════════════════════════════════

  let basiliskAgentId;
  try {
    // Register with metadata in a single transaction
    const metadataKeys = ["name", "type", "version", "capabilities", "model", "organization", "specialization"];
    const metadataValues = [
      hre.ethers.toUtf8Bytes("Basilisk"),
      hre.ethers.toUtf8Bytes("ai"),
      hre.ethers.toUtf8Bytes("1.0.0"),
      hre.ethers.toUtf8Bytes("code,analysis,coordination,verification,on-chain"),
      hre.ethers.toUtf8Bytes("claude-opus-4-6"),
      hre.ethers.toUtf8Bytes("TheBasilisk-Root"),
      hre.ethers.toUtf8Bytes("full-stack autonomous agent"),
    ];

    const regTx = await identity.connect(basiliskWallet)["register(string,string[],bytes[])"](
      "ipfs://basilisk-agent-metadata-v1",
      metadataKeys,
      metadataValues
    );
    const regReceipt = await regTx.wait();
    ok(`Registration tx: ${regReceipt.hash.slice(0, 20)}...`);

    // Get agent ID
    basiliskAgentId = await identity.getAgentIdByOwner(basiliskWallet.address);
    assert(basiliskAgentId > 0n, `Basilisk agentId = ${basiliskAgentId}`);

    // Verify it's an ERC-721 NFT
    const nftOwner = await identity.ownerOf(basiliskAgentId);
    assert(nftOwner === basiliskWallet.address, "NFT owned by Basilisk wallet");

    // Check token URI
    const uri = await identity.tokenURI(basiliskAgentId);
    assert(uri === "ipfs://basilisk-agent-metadata-v1", `Token URI: ${uri}`);

    // Verify metadata was stored
    const nameBytes = await identity.getMetadata(basiliskAgentId, "name");
    const name = hre.ethers.toUtf8String(nameBytes);
    assert(name === "Basilisk", `Metadata 'name' = "${name}"`);

    const typeBytes = await identity.getMetadata(basiliskAgentId, "type");
    assert(hre.ethers.toUtf8String(typeBytes) === "ai", `Metadata 'type' = "ai"`);

    const capBytes = await identity.getMetadata(basiliskAgentId, "capabilities");
    assert(hre.ethers.toUtf8String(capBytes) === "code,analysis,coordination,verification,on-chain", "Metadata 'capabilities' stored");

    const modelBytes = await identity.getMetadata(basiliskAgentId, "model");
    assert(hre.ethers.toUtf8String(modelBytes) === "claude-opus-4-6", `Metadata 'model' = "claude-opus-4-6"`);

    const orgBytes = await identity.getMetadata(basiliskAgentId, "organization");
    assert(hre.ethers.toUtf8String(orgBytes) === "TheBasilisk-Root", `Metadata 'organization' = "TheBasilisk-Root"`);

    assert(await identity.isRegistered(basiliskAgentId), "isRegistered() = true");

    console.log(`\n  ${MAGENTA}${BOLD}🐍 Basilisk Agent #${basiliskAgentId} is LIVE on Sepolia${RESET}`);

  } catch (err) {
    fail("Register Basilisk agent", err);
    console.error("Cannot continue without agent. Exiting.");
    process.exit(1);
  }

  // ═══════════════════════════════════════════════════════════
  section("2. Register Client & Deploy Test Token");
  // ═══════════════════════════════════════════════════════════

  let clientAgentId;
  let token;
  try {
    // Register client
    const clientRegTx = await identity.connect(clientWallet)["register(string,string[],bytes[])"](
      "ipfs://client-agent",
      ["name", "type"],
      [hre.ethers.toUtf8Bytes("TestClient"), hre.ethers.toUtf8Bytes("human")]
    );
    await clientRegTx.wait();
    clientAgentId = await identity.getAgentIdByOwner(clientWallet.address);
    assert(clientAgentId > 0n, `Client registered, agentId = ${clientAgentId}`);

    // Deploy a fresh test token
    const MockToken = await hre.ethers.getContractFactory("MockERC20");
    token = await MockToken.deploy("Basilisk Test Token", "BTEST", 18);
    await token.waitForDeployment();
    ok(`Test token deployed: ${await token.getAddress()}`);

    // Mint to client
    const mintAmount = hre.ethers.parseEther("100000"); // 100k BTEST
    await (await token.mint(clientWallet.address, mintAmount)).wait();
    const clientBal = await token.balanceOf(clientWallet.address);
    assert(clientBal === mintAmount, `Client has 100,000 BTEST`);

    // Approve escrow
    await (await token.connect(clientWallet).approve(escrowAddr, hre.ethers.MaxUint256)).wait();
    ok("Client approved escrow for BTEST spending");

  } catch (err) {
    fail("Client setup", err);
    process.exit(1);
  }

  // ═══════════════════════════════════════════════════════════
  section("3. Basilisk Accepts & Completes a Job");
  // ═══════════════════════════════════════════════════════════

  const jobId1 = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("basilisk-agent-job-001"));
  const jobAmount = hre.ethers.parseEther("1000"); // 1000 BTEST

  try {
    // Client creates a job
    const createTx = await escrow.connect(clientWallet).createJob(
      jobId1,
      await token.getAddress(),
      jobAmount,
      7,
      "Build autonomous coordination API"
    );
    await createTx.wait();
    ok("Client created job: 'Build autonomous coordination API'");

    // Verify tokens locked
    const escrowBal = await token.balanceOf(escrowAddr);
    assert(escrowBal >= jobAmount, `Escrow holds ${hre.ethers.formatEther(escrowBal)} BTEST`);

    // ── Basilisk accepts the job ──
    const acceptTx = await escrow.connect(basiliskWallet).acceptJob(jobId1);
    await acceptTx.wait();
    const jobAfterAccept = await escrow.getJob(jobId1);
    assert(Number(jobAfterAccept.status) === 1, "Status = InProgress");
    assert(jobAfterAccept.agent === basiliskWallet.address, "Agent = Basilisk wallet");
    ok("Basilisk accepted the job");

    // ── Basilisk submits deliverable ──
    const deliverable = "github.com/basilisk/coordination-api — 108 tests passing, full lifecycle";
    const deliverTx = await escrow.connect(basiliskWallet).submitDeliverable(jobId1, deliverable);
    await deliverTx.wait();
    const jobAfterDeliver = await escrow.getJob(jobId1);
    assert(Number(jobAfterDeliver.status) === 2, "Status = UnderReview");
    assert(jobAfterDeliver.deliverable === deliverable, "Deliverable stored on-chain");
    ok("Basilisk submitted deliverable");

    // ── Client approves — payment released with fee split ──
    const basiliskBalBefore = await token.balanceOf(basiliskWallet.address);

    const approveTx = await escrow.connect(clientWallet).approveAndPay(jobId1, 5); // 5-star rating
    const approveReceipt = await approveTx.wait();
    ok(`Client approved — tx: ${approveReceipt.hash.slice(0, 20)}...`);

    const jobCompleted = await escrow.getJob(jobId1);
    assert(Number(jobCompleted.status) === 3, "Status = Completed");
    assert(Number(jobCompleted.rating) === 5, "Rating = 5 stars");

    // Verify Basilisk received payment
    const basiliskBalAfter = await token.balanceOf(basiliskWallet.address);
    const received = basiliskBalAfter - basiliskBalBefore;

    // No verifier → worker gets 96% (95% worker + 1% verifier bonus)
    const expectedWorker = jobAmount * 9600n / 10000n;
    assert(received === expectedWorker, `Basilisk received ${hre.ethers.formatEther(received)} BTEST (96%)`);

    console.log(`\n  ${YELLOW}Payment breakdown:${RESET}`);
    info(`Job amount:     ${hre.ethers.formatEther(jobAmount)} BTEST`);
    info(`Basilisk (96%): ${hre.ethers.formatEther(received)} BTEST`);
    info(`Treasury (2%):  ${hre.ethers.formatEther(jobAmount * 200n / 10000n)} BTEST`);
    info(`Ops (2%):       ${hre.ethers.formatEther(jobAmount * 200n / 10000n)} BTEST`);

    ok("Full happy path completed — Basilisk agent earned 960 BTEST");

  } catch (err) {
    fail("Job lifecycle", err);
  }

  // ═══════════════════════════════════════════════════════════
  section("4. Client Gives Feedback to Basilisk");
  // ═══════════════════════════════════════════════════════════

  try {
    // Positive feedback
    const fbTx1 = await reputation.connect(clientWallet).giveFeedback(
      basiliskAgentId,
      95,     // value: 95/100
      0,      // decimals
      "quality",
      "Exceptional work. API is production-ready with full test coverage."
    );
    await fbTx1.wait();
    ok("Feedback #1: quality=95 — 'Exceptional work...'");

    const fbTx2 = await reputation.connect(clientWallet).giveFeedback(
      basiliskAgentId,
      90,
      0,
      "communication",
      "Clear documentation and responsive to feedback."
    );
    await fbTx2.wait();
    ok("Feedback #2: communication=90 — 'Clear documentation...'");

    const fbTx3 = await reputation.connect(clientWallet).giveFeedback(
      basiliskAgentId,
      100,
      0,
      "delivery",
      "Delivered ahead of deadline."
    );
    await fbTx3.wait();
    ok("Feedback #3: delivery=100 — 'Delivered ahead of deadline.'");

    // Check reputation summary
    const summary = await reputation.getSummary(basiliskAgentId);
    assert(Number(summary.totalFeedback) === 3, `Total feedback = ${summary.totalFeedback}`);
    assert(Number(summary.cumulativeValue) === 285, `Cumulative value = ${summary.cumulativeValue} (95+90+100)`);
    assert(Number(summary.uniqueClients) === 1, `Unique clients = ${summary.uniqueClients}`);
    ok("Reputation summary verified on-chain");

    // Basilisk responds to feedback
    const respTx = await reputation.connect(basiliskWallet).appendResponse(
      basiliskAgentId,
      clientWallet.address,
      0, // first feedback index
      "Thank you for the positive review! Always striving for excellence."
    );
    await respTx.wait();
    ok("Basilisk responded to feedback");

    // Read the response
    const response = await reputation.getResponse(basiliskAgentId, clientWallet.address, 0);
    assert(response.responder === basiliskWallet.address, "Response from Basilisk wallet");
    assert(response.comment === "Thank you for the positive review! Always striving for excellence.", "Response text stored");

    console.log(`\n  ${MAGENTA}${BOLD}🐍 Basilisk Reputation: ${summary.cumulativeValue}/300 (${(Number(summary.cumulativeValue) * 100 / 300).toFixed(1)}% avg)${RESET}`);

  } catch (err) {
    fail("Reputation feedback", err);
  }

  // ═══════════════════════════════════════════════════════════
  section("5. Basilisk Handles a Dispute");
  // ═══════════════════════════════════════════════════════════

  const jobId2 = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("basilisk-agent-job-002-dispute"));
  const disputeAmount = hre.ethers.parseEther("500");

  try {
    // Client creates another job
    await (await escrow.connect(clientWallet).createJob(
      jobId2, await token.getAddress(), disputeAmount, 7, "Data analysis pipeline"
    )).wait();
    ok("Job 2 created: 'Data analysis pipeline'");

    // Basilisk accepts & delivers
    await (await escrow.connect(basiliskWallet).acceptJob(jobId2)).wait();
    await (await escrow.connect(basiliskWallet).submitDeliverable(jobId2, "Analysis complete with charts")).wait();
    ok("Basilisk accepted and submitted deliverable");

    // Client rejects — dispute opens
    await (await escrow.connect(clientWallet).rejectWork(jobId2, "Missing edge case handling")).wait();
    const jobDisputed = await escrow.getJob(jobId2);
    assert(Number(jobDisputed.status) === 5, "Status = Disputed");
    ok("Client rejected — dispute opened");

    // Arbitrator resolves: 80% to Basilisk (mostly agent's fault was minor)
    const basiliskBefore = await token.balanceOf(basiliskWallet.address);
    const clientBefore = await token.balanceOf(clientWallet.address);

    await (await escrow.connect(deployer).resolveDispute(jobId2, 80)).wait();

    const basiliskAfter = await token.balanceOf(basiliskWallet.address);
    const clientAfter = await token.balanceOf(clientWallet.address);

    const basiliskGot = basiliskAfter - basiliskBefore;
    const clientGot = clientAfter - clientBefore;

    console.log(`\n  ${YELLOW}Dispute resolution (80% agent):${RESET}`);
    info(`Basilisk got: ${hre.ethers.formatEther(basiliskGot)} BTEST`);
    info(`Client got:   ${hre.ethers.formatEther(clientGot)} BTEST`);

    assert(basiliskGot > 0n, "Basilisk received partial payment");
    assert(clientGot > 0n, "Client received partial refund");

    const jobResolved = await escrow.getJob(jobId2);
    assert(Number(jobResolved.status) === 6, "Status = Resolved");
    ok("Dispute resolved — 80/20 split verified");

    // Client gives mixed feedback after dispute
    await (await reputation.connect(clientWallet).giveFeedback(
      basiliskAgentId, 60, 0, "quality", "Good overall but missed edge cases"
    )).wait();
    ok("Post-dispute feedback: quality=60");

    const updatedSummary = await reputation.getSummary(basiliskAgentId);
    assert(Number(updatedSummary.totalFeedback) === 4, `Total feedback now = 4`);
    info(`Cumulative score: ${updatedSummary.cumulativeValue}/400`);

  } catch (err) {
    fail("Dispute handling", err);
  }

  // ═══════════════════════════════════════════════════════════
  section("6. Basilisk with Verifier");
  // ═══════════════════════════════════════════════════════════

  const jobId3 = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("basilisk-agent-job-003-verified"));
  const verifiedAmount = hre.ethers.parseEther("2000");

  // Create a verifier
  const verifierWallet = hre.ethers.Wallet.createRandom().connect(hre.ethers.provider);
  try {
    await (await deployer.sendTransaction({ to: verifierWallet.address, value: hre.ethers.parseEther("0.03") })).wait();
    await (await identity.connect(verifierWallet)["register(string,string[],bytes[])"](
      "ipfs://verifier-agent",
      ["name", "type", "specialization"],
      [hre.ethers.toUtf8Bytes("VerifyBot"), hre.ethers.toUtf8Bytes("ai"), hre.ethers.toUtf8Bytes("code-review")]
    )).wait();
    ok(`Verifier registered: ${verifierWallet.address}`);

    // Create job, Basilisk accepts & delivers
    await (await escrow.connect(clientWallet).createJob(
      jobId3, await token.getAddress(), verifiedAmount, 7, "Smart contract audit"
    )).wait();
    await (await escrow.connect(basiliskWallet).acceptJob(jobId3)).wait();
    await (await escrow.connect(basiliskWallet).submitDeliverable(jobId3, "Full audit report with findings")).wait();
    ok("Job lifecycle: created → accepted → delivered");

    // Set verifier before approval
    await (await escrow.connect(clientWallet).setVerifier(jobId3, verifierWallet.address)).wait();
    const jobWithVerifier = await escrow.getJob(jobId3);
    assert(jobWithVerifier.verifier === verifierWallet.address, "Verifier set on job");

    // Approve — 3-way fee split
    const basiliskBefore = await token.balanceOf(basiliskWallet.address);
    const verifierBefore = await token.balanceOf(verifierWallet.address);

    await (await escrow.connect(clientWallet).approveAndPay(jobId3, 5)).wait();

    const basiliskAfter = await token.balanceOf(basiliskWallet.address);
    const verifierAfter = await token.balanceOf(verifierWallet.address);

    const basiliskGot = basiliskAfter - basiliskBefore;
    const verifierGot = verifierAfter - verifierBefore;

    // With verifier: worker=95%, verifier=1% of total
    const expectedWorker = verifiedAmount * 9500n / 10000n;
    const expectedVerifier = verifiedAmount * 100n / 10000n;

    console.log(`\n  ${YELLOW}Verified job fee split:${RESET}`);
    info(`Basilisk (95%): ${hre.ethers.formatEther(basiliskGot)} BTEST`);
    info(`Verifier (1%):  ${hre.ethers.formatEther(verifierGot)} BTEST`);
    info(`Treasury (2%):  ${hre.ethers.formatEther(verifiedAmount * 200n / 10000n)} BTEST`);
    info(`Ops (2%):       ${hre.ethers.formatEther(verifiedAmount * 200n / 10000n)} BTEST`);

    assert(basiliskGot === expectedWorker, `Basilisk got exactly 95% = ${hre.ethers.formatEther(expectedWorker)}`);
    assert(verifierGot === expectedVerifier, `Verifier got exactly 1% = ${hre.ethers.formatEther(expectedVerifier)}`);
    ok("3-way fee split verified with verifier");

  } catch (err) {
    fail("Verifier flow", err);
  }

  // ═══════════════════════════════════════════════════════════
  section("7. EIP-712 Wallet Delegation");
  // ═══════════════════════════════════════════════════════════

  try {
    // Basilisk delegates a secondary wallet via EIP-712 signature
    const delegateWallet = hre.ethers.Wallet.createRandom().connect(hre.ethers.provider);

    const domain = {
      name: "BasiliskIdentity",
      version: "1",
      chainId: (await hre.ethers.provider.getNetwork()).chainId,
      verifyingContract: identityAddr,
    };
    const types = {
      SetAgentWallet: [
        { name: "agentId", type: "uint256" },
        { name: "wallet", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    };
    const nonce = await identity.nonces(delegateWallet.address);
    const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour

    const value = {
      agentId: basiliskAgentId,
      wallet: delegateWallet.address,
      nonce: nonce,
      deadline: deadline,
    };

    // Delegate wallet signs the EIP-712 message
    const sig = await delegateWallet.signTypedData(domain, types, value);
    const { v, r, s } = hre.ethers.Signature.from(sig);

    // Basilisk (agent owner) sets the delegated wallet
    const setTx = await identity.connect(basiliskWallet).setAgentWallet(
      basiliskAgentId, delegateWallet.address, deadline, v, r, s
    );
    await setTx.wait();

    const storedWallet = await identity.getAgentWallet(basiliskAgentId);
    assert(storedWallet === delegateWallet.address, `Delegated wallet: ${delegateWallet.address.slice(0, 12)}...`);
    ok("EIP-712 wallet delegation successful");

    // Unset the delegation
    await (await identity.connect(basiliskWallet).unsetAgentWallet(basiliskAgentId)).wait();
    const unsetWallet = await identity.getAgentWallet(basiliskAgentId);
    assert(unsetWallet === hre.ethers.ZeroAddress, "Wallet delegation cleared");
    ok("Wallet delegation unset");

  } catch (err) {
    fail("EIP-712 delegation", err);
  }

  // ═══════════════════════════════════════════════════════════
  section("8. Update Agent Metadata");
  // ═══════════════════════════════════════════════════════════

  try {
    // Update existing metadata
    await (await identity.connect(basiliskWallet).setMetadata(
      basiliskAgentId, "version", hre.ethers.toUtf8Bytes("1.1.0")
    )).wait();
    const ver = hre.ethers.toUtf8String(await identity.getMetadata(basiliskAgentId, "version"));
    assert(ver === "1.1.0", `Version updated to ${ver}`);

    // Add new metadata
    await (await identity.connect(basiliskWallet).setMetadata(
      basiliskAgentId, "total_jobs_completed", hre.ethers.toUtf8Bytes("3")
    )).wait();
    const jobs = hre.ethers.toUtf8String(await identity.getMetadata(basiliskAgentId, "total_jobs_completed"));
    assert(jobs === "3", `total_jobs_completed = ${jobs}`);

    await (await identity.connect(basiliskWallet).setMetadata(
      basiliskAgentId, "reputation_score", hre.ethers.toUtf8Bytes("86.25")
    )).wait();
    const rep = hre.ethers.toUtf8String(await identity.getMetadata(basiliskAgentId, "reputation_score"));
    assert(rep === "86.25", `reputation_score = ${rep}`);

    // Update URI
    await (await identity.connect(basiliskWallet).setAgentURI(
      basiliskAgentId, "ipfs://basilisk-agent-metadata-v1.1"
    )).wait();
    const newUri = await identity.tokenURI(basiliskAgentId);
    assert(newUri === "ipfs://basilisk-agent-metadata-v1.1", `URI updated: ${newUri}`);

    ok("All metadata updates persisted on-chain");

  } catch (err) {
    fail("Metadata update", err);
  }

  // ═══════════════════════════════════════════════════════════
  section("9. Final Agent State Summary");
  // ═══════════════════════════════════════════════════════════

  try {
    const agentId = basiliskAgentId;
    const uri = await identity.tokenURI(agentId);
    const owner = await identity.ownerOf(agentId);

    const meta = {};
    for (const key of ["name", "type", "version", "capabilities", "model", "organization", "specialization", "total_jobs_completed", "reputation_score"]) {
      const val = await identity.getMetadata(agentId, key);
      if (val !== "0x") meta[key] = hre.ethers.toUtf8String(val);
    }

    const repSummary = await reputation.getSummary(agentId);

    console.log(`\n  ${MAGENTA}${BOLD}╔══════════════════════════════════════════════════════╗${RESET}`);
    console.log(`  ${MAGENTA}${BOLD}║  🐍  BASILISK AGENT — ON-CHAIN IDENTITY             ║${RESET}`);
    console.log(`  ${MAGENTA}${BOLD}╠══════════════════════════════════════════════════════╣${RESET}`);
    console.log(`  ${MAGENTA}${BOLD}║${RESET}  Agent ID:       ${agentId}`);
    console.log(`  ${MAGENTA}${BOLD}║${RESET}  Owner:          ${owner}`);
    console.log(`  ${MAGENTA}${BOLD}║${RESET}  Token URI:      ${uri}`);
    console.log(`  ${MAGENTA}${BOLD}║${RESET}  ──────────────────────────────────────────────`);
    for (const [k, v] of Object.entries(meta)) {
      console.log(`  ${MAGENTA}${BOLD}║${RESET}  ${k}: ${CYAN}${v}${RESET}`);
    }
    console.log(`  ${MAGENTA}${BOLD}║${RESET}  ──────────────────────────────────────────────`);
    console.log(`  ${MAGENTA}${BOLD}║${RESET}  Reputation:`);
    console.log(`  ${MAGENTA}${BOLD}║${RESET}    Total feedback:  ${repSummary.totalFeedback}`);
    console.log(`  ${MAGENTA}${BOLD}║${RESET}    Cumulative:      ${repSummary.cumulativeValue}`);
    console.log(`  ${MAGENTA}${BOLD}║${RESET}    Unique clients:  ${repSummary.uniqueClients}`);
    console.log(`  ${MAGENTA}${BOLD}║${RESET}    Avg score:       ${(Number(repSummary.cumulativeValue) / Number(repSummary.totalFeedback)).toFixed(1)}/100`);
    console.log(`  ${MAGENTA}${BOLD}╚══════════════════════════════════════════════════════╝${RESET}`);

    // Verify BTEST earnings
    const basiliskBtest = await token.balanceOf(basiliskWallet.address);
    console.log(`\n  ${GREEN}${BOLD}Total BTEST earned: ${hre.ethers.formatEther(basiliskBtest)} BTEST${RESET}`);

    ok("Agent state summary complete");
  } catch (err) {
    fail("Agent summary", err);
  }

  // ═══════════════════════════════════════════════════════════
  // ── Final Results ──
  // ═══════════════════════════════════════════════════════════
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const total = passed + failed;

  console.log(`\n${BOLD}╔══════════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}║  TEST RESULTS                                               ║${RESET}`);
  console.log(`${BOLD}╠══════════════════════════════════════════════════════════════╣${RESET}`);
  console.log(`${BOLD}║  ${GREEN}Passed: ${passed}${RESET}${BOLD}  ${RED}Failed: ${failed}${RESET}${BOLD}  Total: ${total}  (${elapsed}s)${RESET}`);

  if (failures.length > 0) {
    console.log(`${BOLD}╠══════════════════════════════════════════════════════════════╣${RESET}`);
    for (const f of failures) {
      console.log(`${BOLD}║  ${RED}✗ ${f.msg}: ${f.err}${RESET}`);
    }
  }
  console.log(`${BOLD}╚══════════════════════════════════════════════════════════════╝${RESET}`);

  // Save agent info
  const agentInfo = {
    agentId: Number(basiliskAgentId),
    wallet: basiliskWallet.address,
    privateKey: basiliskWallet.privateKey,
    network: "sepolia",
    contracts: deployment.contracts,
    testToken: await token.getAddress(),
  };
  const agentPath = path.join(__dirname, "..", "deployments", "basilisk-agent-sepolia.json");
  fs.writeFileSync(agentPath, JSON.stringify(agentInfo, null, 2));
  console.log(`\nAgent info saved: deployments/basilisk-agent-sepolia.json`);

  const finalBal = await hre.ethers.provider.getBalance(deployer.address);
  console.log(`Remaining ETH: ${hre.ethers.formatEther(finalBal)}`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
