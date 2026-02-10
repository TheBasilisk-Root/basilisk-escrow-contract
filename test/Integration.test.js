const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("Integration: Full Lifecycle", function () {
  let identity, reputation, validation, escrow, token;
  let admin, arbitrator, treasury, ops, poster, worker, validator_, client;

  beforeEach(async function () {
    [admin, arbitrator, treasury, ops, poster, worker, validator_, client] = await ethers.getSigners();

    // Deploy all contracts
    const IdentityRegistry = await ethers.getContractFactory("IdentityRegistry");
    identity = await IdentityRegistry.deploy();
    await identity.waitForDeployment();

    const ReputationRegistry = await ethers.getContractFactory("ReputationRegistry");
    reputation = await ReputationRegistry.deploy(await identity.getAddress());
    await reputation.waitForDeployment();

    const ValidationRegistry = await ethers.getContractFactory("ValidationRegistry");
    validation = await ValidationRegistry.deploy(await identity.getAddress());
    await validation.waitForDeployment();

    const BasiliskEscrow = await ethers.getContractFactory("BasiliskEscrow");
    escrow = await BasiliskEscrow.deploy(
      admin.address,
      arbitrator.address,
      treasury.address,
      ops.address,
      500, // 5%
      await identity.getAddress()
    );
    await escrow.waitForDeployment();

    // Deploy mock token
    const MockToken = await ethers.getContractFactory("MockERC20");
    token = await MockToken.deploy("USDC", "USDC", 6);
    await token.waitForDeployment();

    // Mint and approve
    await token.mint(poster.address, 1_000_000n * 10n ** 6n);
    await token.connect(poster).approve(await escrow.getAddress(), ethers.MaxUint256);
  });

  it("should complete full lifecycle: register → job → feedback → validation", async function () {
    // 1. Register agents
    await identity.connect(poster)["register(string)"]("ipfs://poster");
    await identity.connect(worker)["register(string)"]("ipfs://worker");

    const posterAgentId = await identity.getAgentIdByOwner(poster.address);
    const workerAgentId = await identity.getAgentIdByOwner(worker.address);
    expect(posterAgentId).to.equal(1n);
    expect(workerAgentId).to.equal(2n);

    // 2. Create job
    const jobId = ethers.keccak256(ethers.toUtf8Bytes("integration-job-1"));
    const amount = 1000n * 10n ** 6n; // 1000 USDC
    await escrow.connect(poster).createJob(jobId, await token.getAddress(), amount, 30, "Build API");

    // 3. Accept job
    await escrow.connect(worker).acceptJob(jobId);

    // 4. Submit deliverable
    await escrow.connect(worker).submitDeliverable(jobId, "API completed");

    // 5. Approve and pay
    const workerBefore = await token.balanceOf(worker.address);
    await escrow.connect(poster).approveAndPay(jobId, 5);
    const workerAfter = await token.balanceOf(worker.address);

    // No verifier → 96% to worker
    const expectedWorker = (amount * 96n) / 100n;
    expect(workerAfter - workerBefore).to.equal(expectedWorker);

    // 6. Give feedback on worker
    await reputation.connect(poster).giveFeedback(workerAgentId, 100, 0, "quality", "Excellent");
    const repSummary = await reputation.getSummary(workerAgentId);
    expect(repSummary.totalFeedback).to.equal(1n);
    expect(repSummary.cumulativeValue).to.equal(100n);

    // 7. Worker responds to feedback
    await reputation.connect(worker).appendResponse(workerAgentId, poster.address, 0, "Thank you!");

    // 8. Submit validation request
    const deadline = BigInt(await time.latest()) + 86400n;
    const valTx = await validation.connect(poster).validationRequest(
      workerAgentId, validator_.address, deadline, "Verify API quality"
    );
    const valReceipt = await valTx.wait();
    const valEvent = valReceipt.logs.find(
      (l) => l.fragment?.name === "ValidationRequested"
    );
    const requestHash = valEvent.args.requestHash;

    // 9. Validator responds
    await validation.connect(validator_).validationResponse(requestHash, 92, "High quality API");

    const valSummary = await validation.getSummary(workerAgentId);
    expect(valSummary.completedValidations).to.equal(1n);
    expect(valSummary.cumulativeScore).to.equal(92n);
  });

  it("should handle dispute resolution across all contracts", async function () {
    // Register
    await identity.connect(poster)["register(string)"]("ipfs://poster");
    await identity.connect(worker)["register(string)"]("ipfs://worker");

    // Job lifecycle through to dispute
    const jobId = ethers.keccak256(ethers.toUtf8Bytes("dispute-job-1"));
    const amount = 500n * 10n ** 6n;
    await escrow.connect(poster).createJob(jobId, await token.getAddress(), amount, 30, "Design task");
    await escrow.connect(worker).acceptJob(jobId);
    await escrow.connect(worker).submitDeliverable(jobId, "Design done");
    await escrow.connect(poster).rejectWork(jobId, "Not what I asked for");

    // Resolve: 60% to agent
    const workerBefore = await token.balanceOf(worker.address);
    const posterBefore = await token.balanceOf(poster.address);
    await escrow.connect(arbitrator).resolveDispute(jobId, 60);
    const workerAfter = await token.balanceOf(worker.address);
    const posterAfter = await token.balanceOf(poster.address);

    // Fee: 500 * 500/10000 = 25 USDC
    // Remaining: 475
    // Worker: 475 * 60/100 = 285
    // Poster: 475 - 285 = 190
    expect(workerAfter - workerBefore).to.equal(285n * 10n ** 6n);
    expect(posterAfter - posterBefore).to.equal(190n * 10n ** 6n);

    // Give negative feedback
    const workerAgentId = await identity.getAgentIdByOwner(worker.address);
    await reputation.connect(poster).giveFeedback(workerAgentId, -30, 0, "quality", "Did not follow spec");
    const summary = await reputation.getSummary(workerAgentId);
    expect(summary.cumulativeValue).to.equal(-30n);
  });

  it("should deploy all 4 contracts linked together", async function () {
    // Verify contracts reference each other correctly
    expect(await reputation.identityRegistry()).to.equal(await identity.getAddress());
    expect(await validation.identityRegistry()).to.equal(await identity.getAddress());
    expect(await escrow.identityRegistry()).to.equal(await identity.getAddress());
  });

  it("should handle job with verifier fee split", async function () {
    await identity.connect(poster)["register(string)"]("ipfs://poster");
    await identity.connect(worker)["register(string)"]("ipfs://worker");

    const jobId = ethers.keccak256(ethers.toUtf8Bytes("verified-job-1"));
    const amount = 200n * 10n ** 6n; // 200 USDC
    await escrow.connect(poster).createJob(jobId, await token.getAddress(), amount, 30, "Verified task");
    await escrow.connect(worker).acceptJob(jobId);
    await escrow.connect(worker).submitDeliverable(jobId, "Done");
    await escrow.connect(poster).setVerifier(jobId, validator_.address);

    const treasuryBefore = await token.balanceOf(treasury.address);
    const opsBefore = await token.balanceOf(ops.address);
    const validatorBefore = await token.balanceOf(validator_.address);
    const workerBefore = await token.balanceOf(worker.address);

    await escrow.connect(poster).approveAndPay(jobId, 4);

    // Fee: 200 * 500/10000 = 10 USDC
    // Treasury: 10 * 40/100 = 4
    // Ops: 10 * 40/100 = 4
    // Verifier: 10 - 4 - 4 = 2
    // Worker: 200 - 10 = 190
    expect(await token.balanceOf(treasury.address) - treasuryBefore).to.equal(4n * 10n ** 6n);
    expect(await token.balanceOf(ops.address) - opsBefore).to.equal(4n * 10n ** 6n);
    expect(await token.balanceOf(validator_.address) - validatorBefore).to.equal(2n * 10n ** 6n);
    expect(await token.balanceOf(worker.address) - workerBefore).to.equal(190n * 10n ** 6n);
  });

  it("should block unregistered users when registration is required", async function () {
    const jobId = ethers.keccak256(ethers.toUtf8Bytes("blocked-job"));
    await expect(
      escrow.connect(poster).createJob(jobId, await token.getAddress(), 100n * 10n ** 6n, 30, "Test")
    ).to.be.revertedWithCustomError(escrow, "AgentNotRegistered");
  });

  it("should allow unregistered users after disabling registration", async function () {
    await escrow.connect(admin).setIdentityRegistry(ethers.ZeroAddress, false);

    const jobId = ethers.keccak256(ethers.toUtf8Bytes("open-job"));
    await escrow.connect(poster).createJob(jobId, await token.getAddress(), 100n * 10n ** 6n, 30, "Open job");
    const status = await escrow.getJobStatus(jobId);
    expect(status.exists).to.be.true;
  });

  it("should handle multiple jobs concurrently", async function () {
    await identity.connect(poster)["register(string)"]("ipfs://poster");
    await identity.connect(worker)["register(string)"]("ipfs://worker");

    const jobIds = [];
    for (let i = 0; i < 3; i++) {
      const jobId = ethers.keccak256(ethers.toUtf8Bytes(`multi-job-${i}`));
      jobIds.push(jobId);
      await escrow.connect(poster).createJob(jobId, await token.getAddress(), 100n * 10n ** 6n, 30, `Job ${i}`);
    }

    // Accept all
    for (const jobId of jobIds) {
      await escrow.connect(worker).acceptJob(jobId);
    }

    // Submit and approve first two, cancel third (expire it first)
    await escrow.connect(worker).submitDeliverable(jobIds[0], "Del 0");
    await escrow.connect(worker).submitDeliverable(jobIds[1], "Del 1");

    await escrow.connect(poster).approveAndPay(jobIds[0], 5);
    await escrow.connect(poster).approveAndPay(jobIds[1], 4);

    // Cancel third after deadline
    await time.increase(31 * 86400);
    await escrow.connect(poster).cancelJob(jobIds[2]);

    const s0 = await escrow.getJobStatus(jobIds[0]);
    const s1 = await escrow.getJobStatus(jobIds[1]);
    const s2 = await escrow.getJobStatus(jobIds[2]);

    expect(s0.status).to.equal(3n); // Completed
    expect(s1.status).to.equal(3n); // Completed
    expect(s2.status).to.equal(4n); // Cancelled
  });
});
