const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("BasiliskEscrow", function () {
  let escrow, token, identity;
  let admin, arbitrator, treasury, ops, requester, agent, verifier, other;
  const FEE_BPS = 500n; // 5%
  const JOB_AMOUNT = ethers.parseUnits("100", 18); // 100 tokens
  const JOB_ID = ethers.keccak256(ethers.toUtf8Bytes("job-001"));

  async function deployContracts() {
    [admin, arbitrator, treasury, ops, requester, agent, verifier, other] = await ethers.getSigners();

    // Deploy mock ERC-20
    const MockToken = await ethers.getContractFactory("MockERC20");
    token = await MockToken.deploy("Test Token", "TEST", 18);
    await token.waitForDeployment();

    // Deploy Identity Registry
    const IdentityRegistry = await ethers.getContractFactory("IdentityRegistry");
    identity = await IdentityRegistry.deploy();
    await identity.waitForDeployment();

    // Deploy Escrow
    const BasiliskEscrow = await ethers.getContractFactory("BasiliskEscrow");
    escrow = await BasiliskEscrow.deploy(
      admin.address,
      arbitrator.address,
      treasury.address,
      ops.address,
      FEE_BPS,
      await identity.getAddress()
    );
    await escrow.waitForDeployment();

    // Mint tokens to requester and approve escrow
    await token.mint(requester.address, ethers.parseUnits("10000", 18));
    await token.connect(requester).approve(await escrow.getAddress(), ethers.MaxUint256);

    // Register agents in identity registry
    await identity.connect(requester)["register(string)"]("ipfs://requester");
    await identity.connect(agent)["register(string)"]("ipfs://agent");
  }

  beforeEach(async function () {
    await deployContracts();
  });

  // Helper: create a standard job
  async function createStandardJob(jobId = JOB_ID) {
    await escrow.connect(requester).createJob(jobId, await token.getAddress(), JOB_AMOUNT, 30, "Test job");
    return jobId;
  }

  // Helper: advance job to UnderReview
  async function advanceToUnderReview(jobId = JOB_ID) {
    await createStandardJob(jobId);
    await escrow.connect(agent).acceptJob(jobId);
    await escrow.connect(agent).submitDeliverable(jobId, "Delivered");
    return jobId;
  }

  // ── Constructor & Config ──────────────────────────────────────────

  describe("Constructor & Config", function () {
    it("should set initial config correctly", async function () {
      expect(await escrow.owner()).to.equal(admin.address);
      expect(await escrow.arbitrator()).to.equal(arbitrator.address);
      expect(await escrow.treasury()).to.equal(treasury.address);
      expect(await escrow.opsWallet()).to.equal(ops.address);
      expect(await escrow.feeBps()).to.equal(FEE_BPS);
      expect(await escrow.requireRegistration()).to.be.true;
    });

    it("should revert constructor with zero address arbitrator", async function () {
      const BasiliskEscrow = await ethers.getContractFactory("BasiliskEscrow");
      await expect(
        BasiliskEscrow.deploy(admin.address, ethers.ZeroAddress, treasury.address, ops.address, 500, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(escrow, "ZeroAddress");
    });

    it("should revert constructor with fee > MAX_FEE_BPS", async function () {
      const BasiliskEscrow = await ethers.getContractFactory("BasiliskEscrow");
      await expect(
        BasiliskEscrow.deploy(admin.address, arbitrator.address, treasury.address, ops.address, 1001, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(escrow, "InvalidFeeBps");
    });

    it("should update config", async function () {
      await escrow.connect(admin).updateConfig(other.address, other.address, other.address, 300);
      expect(await escrow.arbitrator()).to.equal(other.address);
      expect(await escrow.feeBps()).to.equal(300n);
    });

    it("should revert updateConfig from non-owner", async function () {
      await expect(
        escrow.connect(other).updateConfig(other.address, other.address, other.address, 300)
      ).to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount");
    });

    it("should set identity registry", async function () {
      await escrow.connect(admin).setIdentityRegistry(ethers.ZeroAddress, false);
      expect(await escrow.requireRegistration()).to.be.false;
    });
  });

  // ── Job Creation ──────────────────────────────────────────────────

  describe("createJob", function () {
    it("should create a job and escrow tokens", async function () {
      const balBefore = await token.balanceOf(requester.address);
      await createStandardJob();
      const balAfter = await token.balanceOf(requester.address);
      expect(balBefore - balAfter).to.equal(JOB_AMOUNT);
    });

    it("should store job details correctly", async function () {
      await createStandardJob();
      const job = await escrow.getJob(JOB_ID);
      expect(job.requester).to.equal(requester.address);
      expect(job.amount).to.equal(JOB_AMOUNT);
      expect(job.status).to.equal(0n); // Open
      expect(job.description).to.equal("Test job");
      expect(job.requesterAgentId).to.equal(1n);
    });

    it("should emit JobCreated event", async function () {
      await expect(
        escrow.connect(requester).createJob(JOB_ID, await token.getAddress(), JOB_AMOUNT, 30, "Test")
      ).to.emit(escrow, "JobCreated");
    });

    it("should revert for duplicate jobId", async function () {
      await createStandardJob();
      await expect(createStandardJob()).to.be.revertedWithCustomError(escrow, "JobIdAlreadyExists");
    });

    it("should revert for zero amount", async function () {
      await expect(
        escrow.connect(requester).createJob(JOB_ID, await token.getAddress(), 0, 30, "Test")
      ).to.be.revertedWithCustomError(escrow, "InvalidAmount");
    });

    it("should revert for zero deadline", async function () {
      await expect(
        escrow.connect(requester).createJob(JOB_ID, await token.getAddress(), JOB_AMOUNT, 0, "Test")
      ).to.be.revertedWithCustomError(escrow, "InvalidAmount");
    });

    it("should revert for description too long", async function () {
      const longDesc = "x".repeat(201);
      await expect(
        escrow.connect(requester).createJob(JOB_ID, await token.getAddress(), JOB_AMOUNT, 30, longDesc)
      ).to.be.revertedWithCustomError(escrow, "DescriptionTooLong");
    });

    it("should revert for unregistered requester when registration required", async function () {
      await expect(
        escrow.connect(other).createJob(JOB_ID, await token.getAddress(), JOB_AMOUNT, 30, "Test")
      ).to.be.revertedWithCustomError(escrow, "AgentNotRegistered");
    });

    it("should allow unregistered requester when registration disabled", async function () {
      await escrow.connect(admin).setIdentityRegistry(ethers.ZeroAddress, false);
      await token.mint(other.address, JOB_AMOUNT);
      await token.connect(other).approve(await escrow.getAddress(), ethers.MaxUint256);
      await escrow.connect(other).createJob(JOB_ID, await token.getAddress(), JOB_AMOUNT, 30, "Test");
      const status = await escrow.getJobStatus(JOB_ID);
      expect(status.exists).to.be.true;
    });
  });

  // ── Accept Job ────────────────────────────────────────────────────

  describe("acceptJob", function () {
    beforeEach(async function () {
      await createStandardJob();
    });

    it("should accept a job", async function () {
      await escrow.connect(agent).acceptJob(JOB_ID);
      const job = await escrow.getJob(JOB_ID);
      expect(job.agent).to.equal(agent.address);
      expect(job.status).to.equal(1n); // InProgress
      expect(job.agentAgentId).to.equal(2n);
    });

    it("should revert if not Open", async function () {
      await escrow.connect(agent).acceptJob(JOB_ID);
      await expect(
        escrow.connect(agent).acceptJob(JOB_ID)
      ).to.be.revertedWithCustomError(escrow, "InvalidStatus");
    });

    it("should revert for unregistered agent", async function () {
      await expect(
        escrow.connect(other).acceptJob(JOB_ID)
      ).to.be.revertedWithCustomError(escrow, "AgentNotRegistered");
    });
  });

  // ── Submit Deliverable ────────────────────────────────────────────

  describe("submitDeliverable", function () {
    beforeEach(async function () {
      await createStandardJob();
      await escrow.connect(agent).acceptJob(JOB_ID);
    });

    it("should submit deliverable", async function () {
      await escrow.connect(agent).submitDeliverable(JOB_ID, "Delivered");
      const job = await escrow.getJob(JOB_ID);
      expect(job.status).to.equal(2n); // UnderReview
      expect(job.deliverable).to.equal("Delivered");
    });

    it("should revert from non-agent", async function () {
      await expect(
        escrow.connect(requester).submitDeliverable(JOB_ID, "Delivered")
      ).to.be.revertedWithCustomError(escrow, "Unauthorized");
    });

    it("should revert if not InProgress", async function () {
      await escrow.connect(agent).submitDeliverable(JOB_ID, "Delivered");
      await expect(
        escrow.connect(agent).submitDeliverable(JOB_ID, "Again")
      ).to.be.revertedWithCustomError(escrow, "InvalidStatus");
    });

    it("should revert if past deadline", async function () {
      await time.increase(31 * 86400); // 31 days
      await expect(
        escrow.connect(agent).submitDeliverable(JOB_ID, "Late")
      ).to.be.revertedWithCustomError(escrow, "DeadlineExpired");
    });

    it("should revert for deliverable too long", async function () {
      const longDel = "x".repeat(501);
      await expect(
        escrow.connect(agent).submitDeliverable(JOB_ID, longDel)
      ).to.be.revertedWithCustomError(escrow, "DeliverableTooLong");
    });
  });

  // ── Set Verifier ──────────────────────────────────────────────────

  describe("setVerifier", function () {
    it("should set verifier while InProgress", async function () {
      await createStandardJob();
      await escrow.connect(agent).acceptJob(JOB_ID);
      await escrow.connect(requester).setVerifier(JOB_ID, verifier.address);
      const job = await escrow.getJob(JOB_ID);
      expect(job.verifier).to.equal(verifier.address);
    });

    it("should set verifier while UnderReview", async function () {
      await advanceToUnderReview();
      await escrow.connect(requester).setVerifier(JOB_ID, verifier.address);
      const job = await escrow.getJob(JOB_ID);
      expect(job.verifier).to.equal(verifier.address);
    });

    it("should revert from non-requester", async function () {
      await createStandardJob();
      await escrow.connect(agent).acceptJob(JOB_ID);
      await expect(
        escrow.connect(agent).setVerifier(JOB_ID, verifier.address)
      ).to.be.revertedWithCustomError(escrow, "Unauthorized");
    });
  });

  // ── Approve & Pay (Fee Split) ─────────────────────────────────────

  describe("approveAndPay", function () {
    describe("with verifier", function () {
      beforeEach(async function () {
        await advanceToUnderReview();
        await escrow.connect(requester).setVerifier(JOB_ID, verifier.address);
      });

      it("should split fees correctly: 95% worker, 2% treasury, 2% ops, 1% verifier", async function () {
        const treasuryBefore = await token.balanceOf(treasury.address);
        const opsBefore = await token.balanceOf(ops.address);
        const agentBefore = await token.balanceOf(agent.address);
        const verifierBefore = await token.balanceOf(verifier.address);

        await escrow.connect(requester).approveAndPay(JOB_ID, 5);

        const treasuryAfter = await token.balanceOf(treasury.address);
        const opsAfter = await token.balanceOf(ops.address);
        const agentAfter = await token.balanceOf(agent.address);
        const verifierAfter = await token.balanceOf(verifier.address);

        // 100 tokens @ 5% = 5 tokens total fee
        // Treasury: 5 * 40% = 2
        // Ops: 5 * 40% = 2
        // Verifier: 5 - 2 - 2 = 1
        // Worker: 100 - 5 = 95
        const expectedTreasury = ethers.parseUnits("2", 18);
        const expectedOps = ethers.parseUnits("2", 18);
        const expectedVerifier = ethers.parseUnits("1", 18);
        const expectedWorker = ethers.parseUnits("95", 18);

        expect(treasuryAfter - treasuryBefore).to.equal(expectedTreasury);
        expect(opsAfter - opsBefore).to.equal(expectedOps);
        expect(verifierAfter - verifierBefore).to.equal(expectedVerifier);
        expect(agentAfter - agentBefore).to.equal(expectedWorker);
      });

      it("should set status to Completed with rating", async function () {
        await escrow.connect(requester).approveAndPay(JOB_ID, 4);
        const job = await escrow.getJob(JOB_ID);
        expect(job.status).to.equal(3n); // Completed
        expect(job.rating).to.equal(4n);
      });
    });

    describe("without verifier (bonus to worker)", function () {
      beforeEach(async function () {
        await advanceToUnderReview();
        // No setVerifier call
      });

      it("should give worker 96% (verifier share as bonus)", async function () {
        const agentBefore = await token.balanceOf(agent.address);
        const treasuryBefore = await token.balanceOf(treasury.address);
        const opsBefore = await token.balanceOf(ops.address);

        await escrow.connect(requester).approveAndPay(JOB_ID, 5);

        const agentAfter = await token.balanceOf(agent.address);
        const treasuryAfter = await token.balanceOf(treasury.address);
        const opsAfter = await token.balanceOf(ops.address);

        // Worker: 100 - 5 + 1 = 96
        // Treasury: 2, Ops: 2
        expect(agentAfter - agentBefore).to.equal(ethers.parseUnits("96", 18));
        expect(treasuryAfter - treasuryBefore).to.equal(ethers.parseUnits("2", 18));
        expect(opsAfter - opsBefore).to.equal(ethers.parseUnits("2", 18));
      });
    });

    it("should revert for invalid rating (0)", async function () {
      await advanceToUnderReview();
      await expect(
        escrow.connect(requester).approveAndPay(JOB_ID, 0)
      ).to.be.revertedWithCustomError(escrow, "InvalidRating");
    });

    it("should revert for invalid rating (6)", async function () {
      await advanceToUnderReview();
      await expect(
        escrow.connect(requester).approveAndPay(JOB_ID, 6)
      ).to.be.revertedWithCustomError(escrow, "InvalidRating");
    });

    it("should revert from non-requester", async function () {
      await advanceToUnderReview();
      await expect(
        escrow.connect(agent).approveAndPay(JOB_ID, 5)
      ).to.be.revertedWithCustomError(escrow, "Unauthorized");
    });

    it("should handle small amounts with rounding", async function () {
      // 7 tokens @ 500bps = 0.35 fee → 0 due to integer division
      // Actually: 7e18 * 500 / 10000 = 3.5e17
      // Treasury: 3.5e17 * 40 / 100 = 1.4e17
      // Ops: 3.5e17 * 40 / 100 = 1.4e17
      // Verifier: 3.5e17 - 1.4e17 - 1.4e17 = 0.7e17
      const smallAmount = ethers.parseUnits("7", 18);
      const jobId = ethers.keccak256(ethers.toUtf8Bytes("job-small"));
      await escrow.connect(requester).createJob(jobId, await token.getAddress(), smallAmount, 30, "Small");
      await escrow.connect(agent).acceptJob(jobId);
      await escrow.connect(agent).submitDeliverable(jobId, "Done");
      await escrow.connect(requester).setVerifier(jobId, verifier.address);

      const agentBefore = await token.balanceOf(agent.address);
      await escrow.connect(requester).approveAndPay(jobId, 3);
      const agentAfter = await token.balanceOf(agent.address);

      // Total tokens should sum to exactly smallAmount
      const treasuryBal = await token.balanceOf(treasury.address);
      const opsBal = await token.balanceOf(ops.address);
      const verifierBal = await token.balanceOf(verifier.address);
      const workerGot = agentAfter - agentBefore;

      // Verify no tokens are lost
      expect(workerGot + treasuryBal + opsBal + verifierBal).to.equal(smallAmount);
    });
  });

  // ── Reject Work ───────────────────────────────────────────────────

  describe("rejectWork", function () {
    it("should transition to Disputed", async function () {
      await advanceToUnderReview();
      await escrow.connect(requester).rejectWork(JOB_ID, "Not satisfied");
      const job = await escrow.getJob(JOB_ID);
      expect(job.status).to.equal(5n); // Disputed
      expect(job.disputed).to.be.true;
    });

    it("should revert from non-requester", async function () {
      await advanceToUnderReview();
      await expect(
        escrow.connect(agent).rejectWork(JOB_ID, "reason")
      ).to.be.revertedWithCustomError(escrow, "Unauthorized");
    });
  });

  // ── Cancel Job ────────────────────────────────────────────────────

  describe("cancelJob", function () {
    it("should cancel an Open job and refund", async function () {
      await createStandardJob();
      const balBefore = await token.balanceOf(requester.address);
      await escrow.connect(requester).cancelJob(JOB_ID);
      const balAfter = await token.balanceOf(requester.address);
      expect(balAfter - balBefore).to.equal(JOB_AMOUNT);
    });

    it("should cancel an expired InProgress job", async function () {
      await createStandardJob();
      await escrow.connect(agent).acceptJob(JOB_ID);
      await time.increase(31 * 86400); // past 30-day deadline
      await escrow.connect(requester).cancelJob(JOB_ID);
      const job = await escrow.getJob(JOB_ID);
      expect(job.status).to.equal(4n); // Cancelled
    });

    it("should revert cancel on non-expired InProgress job", async function () {
      await createStandardJob();
      await escrow.connect(agent).acceptJob(JOB_ID);
      await expect(
        escrow.connect(requester).cancelJob(JOB_ID)
      ).to.be.revertedWithCustomError(escrow, "CannotCancel");
    });

    it("should revert cancel from non-requester", async function () {
      await createStandardJob();
      await expect(
        escrow.connect(agent).cancelJob(JOB_ID)
      ).to.be.revertedWithCustomError(escrow, "Unauthorized");
    });
  });

  // ── Resolve Dispute ───────────────────────────────────────────────

  describe("resolveDispute", function () {
    beforeEach(async function () {
      await advanceToUnderReview();
      await escrow.connect(requester).rejectWork(JOB_ID, "Bad work");
    });

    it("should resolve dispute with fee split (50/50 treasury/ops)", async function () {
      const treasuryBefore = await token.balanceOf(treasury.address);
      const opsBefore = await token.balanceOf(ops.address);
      const agentBefore = await token.balanceOf(agent.address);
      const requesterBefore = await token.balanceOf(requester.address);

      // 70% to agent
      await escrow.connect(arbitrator).resolveDispute(JOB_ID, 70);

      const treasuryAfter = await token.balanceOf(treasury.address);
      const opsAfter = await token.balanceOf(ops.address);
      const agentAfter = await token.balanceOf(agent.address);
      const requesterAfter = await token.balanceOf(requester.address);

      // Fee: 100 * 500 / 10000 = 5 tokens
      // Treasury: 5/2 = 2 (integer division)
      // Ops: 5 - 2 = 3 (remainder)
      // Remaining: 100 - 5 = 95
      // Agent: 95 * 70 / 100 = 66.5 = 66 (integer division)
      // Requester: 95 - 66 = 29
      const expectedTreasury = ethers.parseUnits("2.5", 18);
      const expectedOps = ethers.parseUnits("2.5", 18);
      const expectedAgent = ethers.parseUnits("66.5", 18);
      const expectedRequester = ethers.parseUnits("28.5", 18);

      expect(treasuryAfter - treasuryBefore).to.equal(expectedTreasury);
      expect(opsAfter - opsBefore).to.equal(expectedOps);
      expect(agentAfter - agentBefore).to.equal(expectedAgent);
      expect(requesterAfter - requesterBefore).to.equal(expectedRequester);
    });

    it("should resolve with 100% to agent", async function () {
      const agentBefore = await token.balanceOf(agent.address);
      await escrow.connect(arbitrator).resolveDispute(JOB_ID, 100);
      const agentAfter = await token.balanceOf(agent.address);
      // 100 - 5 fee = 95 all to agent
      expect(agentAfter - agentBefore).to.equal(ethers.parseUnits("95", 18));
    });

    it("should resolve with 0% to agent (all to requester)", async function () {
      const requesterBefore = await token.balanceOf(requester.address);
      await escrow.connect(arbitrator).resolveDispute(JOB_ID, 0);
      const requesterAfter = await token.balanceOf(requester.address);
      expect(requesterAfter - requesterBefore).to.equal(ethers.parseUnits("95", 18));
    });

    it("should revert from non-arbitrator", async function () {
      await expect(
        escrow.connect(admin).resolveDispute(JOB_ID, 50)
      ).to.be.revertedWithCustomError(escrow, "Unauthorized");
    });

    it("should revert for invalid percentage (>100)", async function () {
      await expect(
        escrow.connect(arbitrator).resolveDispute(JOB_ID, 101)
      ).to.be.revertedWithCustomError(escrow, "InvalidPercentage");
    });

    it("should revert for non-disputed job", async function () {
      const jobId2 = ethers.keccak256(ethers.toUtf8Bytes("job-002"));
      await advanceToUnderReview(jobId2);
      await expect(
        escrow.connect(arbitrator).resolveDispute(jobId2, 50)
      ).to.be.revertedWithCustomError(escrow, "InvalidStatus");
    });
  });

  // ── calculateFees view ────────────────────────────────────────────

  describe("calculateFees", function () {
    it("should calculate fees with verifier", async function () {
      const result = await escrow.calculateFees(JOB_AMOUNT, true);
      expect(result.totalFee).to.equal(ethers.parseUnits("5", 18));
      expect(result.workerAmount).to.equal(ethers.parseUnits("95", 18));
      expect(result.treasuryAmount).to.equal(ethers.parseUnits("2", 18));
      expect(result.opsAmount).to.equal(ethers.parseUnits("2", 18));
      expect(result.verifierAmount).to.equal(ethers.parseUnits("1", 18));
    });

    it("should calculate fees without verifier (bonus to worker)", async function () {
      const result = await escrow.calculateFees(JOB_AMOUNT, false);
      expect(result.totalFee).to.equal(ethers.parseUnits("5", 18));
      expect(result.workerAmount).to.equal(ethers.parseUnits("96", 18));
      expect(result.treasuryAmount).to.equal(ethers.parseUnits("2", 18));
      expect(result.opsAmount).to.equal(ethers.parseUnits("2", 18));
      expect(result.verifierAmount).to.equal(0n);
    });
  });

  // ── getJob & getJobStatus ─────────────────────────────────────────

  describe("Views", function () {
    it("getJobStatus should return exists=false for unknown job", async function () {
      const result = await escrow.getJobStatus(ethers.ZeroHash);
      expect(result.exists).to.be.false;
    });

    it("getJobStatus should return correct status", async function () {
      await createStandardJob();
      const result = await escrow.getJobStatus(JOB_ID);
      expect(result.exists).to.be.true;
      expect(result.status).to.equal(0n); // Open
    });
  });
});
