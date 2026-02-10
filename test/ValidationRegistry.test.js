const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("ValidationRegistry", function () {
  let identity, validation;
  let owner, alice, bob, validator;
  let agentId;

  beforeEach(async function () {
    [owner, alice, bob, validator] = await ethers.getSigners();

    const IdentityRegistry = await ethers.getContractFactory("IdentityRegistry");
    identity = await IdentityRegistry.deploy();
    await identity.waitForDeployment();

    const ValidationRegistry = await ethers.getContractFactory("ValidationRegistry");
    validation = await ValidationRegistry.deploy(await identity.getAddress());
    await validation.waitForDeployment();

    // Register alice as agent
    await identity.connect(alice)["register(string)"]("ipfs://alice");
    agentId = 1n;
  });

  // ── Validation Request ────────────────────────────────────────────

  describe("validationRequest", function () {
    it("should create a validation request", async function () {
      const deadline = BigInt(await time.latest()) + 86400n;
      const tx = await validation.connect(bob).validationRequest(
        agentId, validator.address, deadline, "Test validation"
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        (l) => l.fragment && l.fragment.name === "ValidationRequested"
      );
      expect(event.args.agentId).to.equal(agentId);
      expect(event.args.validator).to.equal(validator.address);
    });

    it("should store validation record correctly", async function () {
      const deadline = BigInt(await time.latest()) + 86400n;
      const tx = await validation.connect(bob).validationRequest(
        agentId, validator.address, deadline, "Context data"
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        (l) => l.fragment && l.fragment.name === "ValidationRequested"
      );
      const requestHash = event.args.requestHash;

      const record = await validation.getValidationStatus(requestHash);
      expect(record.agentId).to.equal(agentId);
      expect(record.requester).to.equal(bob.address);
      expect(record.validator).to.equal(validator.address);
      expect(record.status).to.equal(0n); // Pending
      expect(record.context).to.equal("Context data");
    });

    it("should revert for unregistered agent", async function () {
      const deadline = BigInt(await time.latest()) + 86400n;
      await expect(
        validation.connect(bob).validationRequest(999n, validator.address, deadline, "ctx")
      ).to.be.revertedWithCustomError(validation, "AgentNotRegistered");
    });

    it("should revert for zero address validator", async function () {
      const deadline = BigInt(await time.latest()) + 86400n;
      await expect(
        validation.connect(bob).validationRequest(agentId, ethers.ZeroAddress, deadline, "ctx")
      ).to.be.revertedWithCustomError(validation, "ZeroAddress");
    });

    it("should revert for past deadline", async function () {
      const deadline = BigInt(await time.latest()) - 1n;
      await expect(
        validation.connect(bob).validationRequest(agentId, validator.address, deadline, "ctx")
      ).to.be.revertedWithCustomError(validation, "InvalidDeadline");
    });

    it("should track agent validations", async function () {
      const deadline = BigInt(await time.latest()) + 86400n;
      await validation.connect(bob).validationRequest(agentId, validator.address, deadline, "c1");
      await validation.connect(bob).validationRequest(agentId, validator.address, deadline, "c2");

      const hashes = await validation.getAgentValidations(agentId);
      expect(hashes.length).to.equal(2);
    });

    it("should track validator requests", async function () {
      const deadline = BigInt(await time.latest()) + 86400n;
      await validation.connect(bob).validationRequest(agentId, validator.address, deadline, "c1");

      const requests = await validation.getValidatorRequests(validator.address);
      expect(requests.length).to.equal(1);
    });
  });

  // ── Validation Response ───────────────────────────────────────────

  describe("validationResponse", function () {
    let requestHash;

    beforeEach(async function () {
      const deadline = BigInt(await time.latest()) + 86400n;
      const tx = await validation.connect(bob).validationRequest(
        agentId, validator.address, deadline, "Validate this"
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        (l) => l.fragment && l.fragment.name === "ValidationRequested"
      );
      requestHash = event.args.requestHash;
    });

    it("should submit a validation response", async function () {
      await validation.connect(validator).validationResponse(requestHash, 85, "Good agent");
      const record = await validation.getValidationStatus(requestHash);
      expect(record.score).to.equal(85n);
      expect(record.status).to.equal(1n); // Completed
      expect(record.response).to.equal("Good agent");
    });

    it("should revert from non-designated validator", async function () {
      await expect(
        validation.connect(bob).validationResponse(requestHash, 85, "response")
      ).to.be.revertedWithCustomError(validation, "NotDesignatedValidator");
    });

    it("should revert for invalid score (>100)", async function () {
      await expect(
        validation.connect(validator).validationResponse(requestHash, 101, "response")
      ).to.be.revertedWithCustomError(validation, "InvalidScore");
    });

    it("should revert for already completed validation", async function () {
      await validation.connect(validator).validationResponse(requestHash, 85, "done");
      await expect(
        validation.connect(validator).validationResponse(requestHash, 90, "again")
      ).to.be.revertedWithCustomError(validation, "AlreadyCompleted");
    });

    it("should revert for non-existent request", async function () {
      await expect(
        validation.connect(validator).validationResponse(ethers.ZeroHash, 85, "response")
      ).to.be.revertedWithCustomError(validation, "RequestNotFound");
    });
  });

  // ── Summary ───────────────────────────────────────────────────────

  describe("getSummary", function () {
    it("should return correct summary after completions", async function () {
      const deadline = BigInt(await time.latest()) + 86400n;

      const tx1 = await validation.connect(bob).validationRequest(agentId, validator.address, deadline, "c1");
      const r1 = await tx1.wait();
      const h1 = r1.logs.find((l) => l.fragment?.name === "ValidationRequested").args.requestHash;

      const tx2 = await validation.connect(bob).validationRequest(agentId, validator.address, deadline, "c2");
      const r2 = await tx2.wait();
      const h2 = r2.logs.find((l) => l.fragment?.name === "ValidationRequested").args.requestHash;

      await validation.connect(validator).validationResponse(h1, 80, "ok");
      // h2 left pending

      const summary = await validation.getSummary(agentId);
      expect(summary.totalValidations).to.equal(2n);
      expect(summary.completedValidations).to.equal(1n);
      expect(summary.cumulativeScore).to.equal(80n);
    });

    it("should return empty summary for agent with no validations", async function () {
      const summary = await validation.getSummary(agentId);
      expect(summary.totalValidations).to.equal(0n);
      expect(summary.completedValidations).to.equal(0n);
    });
  });
});
