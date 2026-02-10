const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("ReputationRegistry", function () {
  let identity, reputation;
  let owner, alice, bob, carol;
  let agentId;

  beforeEach(async function () {
    [owner, alice, bob, carol] = await ethers.getSigners();

    const IdentityRegistry = await ethers.getContractFactory("IdentityRegistry");
    identity = await IdentityRegistry.deploy();
    await identity.waitForDeployment();

    const ReputationRegistry = await ethers.getContractFactory("ReputationRegistry");
    reputation = await ReputationRegistry.deploy(await identity.getAddress());
    await reputation.waitForDeployment();

    // Register alice as agent (agentId=1)
    await identity.connect(alice)["register(string)"]("ipfs://alice");
    agentId = 1n;
  });

  // ── Give Feedback ─────────────────────────────────────────────────

  describe("giveFeedback", function () {
    it("should give positive feedback", async function () {
      const tx = await reputation.connect(bob).giveFeedback(agentId, 100, 0, "quality", "Great work");
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        (l) => l.fragment && l.fragment.name === "FeedbackGiven"
      );
      expect(event.args.agentId).to.equal(agentId);
      expect(event.args.client).to.equal(bob.address);
      expect(event.args.index).to.equal(0n);
      expect(event.args.value).to.equal(100n);
    });

    it("should give negative feedback", async function () {
      await reputation.connect(bob).giveFeedback(agentId, -50, 0, "quality", "Poor work");
      const fb = await reputation.readFeedback(agentId, bob.address, 0);
      expect(fb.value).to.equal(-50n);
    });

    it("should increment index for multiple feedback from same client", async function () {
      await reputation.connect(bob).giveFeedback(agentId, 100, 0, "q1", "Good");
      await reputation.connect(bob).giveFeedback(agentId, 80, 0, "q2", "OK");
      expect(await reputation.getLastIndex(agentId, bob.address)).to.equal(2n);
    });

    it("should track unique clients", async function () {
      await reputation.connect(bob).giveFeedback(agentId, 100, 0, "tag", "c1");
      await reputation.connect(carol).giveFeedback(agentId, 90, 0, "tag", "c2");
      await reputation.connect(bob).giveFeedback(agentId, 80, 0, "tag", "c3");

      const clients = await reputation.getClients(agentId);
      expect(clients.length).to.equal(2);
      expect(clients).to.include(bob.address);
      expect(clients).to.include(carol.address);
    });

    it("should revert for unregistered agent", async function () {
      await expect(
        reputation.connect(bob).giveFeedback(999n, 100, 0, "tag", "comment")
      ).to.be.revertedWithCustomError(reputation, "AgentNotRegistered");
    });

    it("should revert for invalid decimals (>18)", async function () {
      await expect(
        reputation.connect(bob).giveFeedback(agentId, 100, 19, "tag", "comment")
      ).to.be.revertedWithCustomError(reputation, "InvalidDecimals");
    });

    it("should support decimal values", async function () {
      // 4.5 with 1 decimal = value=45, decimals=1
      await reputation.connect(bob).giveFeedback(agentId, 45, 1, "rating", "4.5 stars");
      const fb = await reputation.readFeedback(agentId, bob.address, 0);
      expect(fb.value).to.equal(45n);
      expect(fb.valueDecimals).to.equal(1n);
    });

    it("should store tag and comment", async function () {
      await reputation.connect(bob).giveFeedback(agentId, 100, 0, "speed", "Very fast");
      const fb = await reputation.readFeedback(agentId, bob.address, 0);
      expect(fb.tag).to.equal("speed");
      expect(fb.comment).to.equal("Very fast");
    });
  });

  // ── Revoke Feedback ───────────────────────────────────────────────

  describe("revokeFeedback", function () {
    beforeEach(async function () {
      await reputation.connect(bob).giveFeedback(agentId, 100, 0, "tag", "Good");
    });

    it("should revoke feedback and update cumulative value", async function () {
      const summaryBefore = await reputation.getSummary(agentId);
      expect(summaryBefore.cumulativeValue).to.equal(100n);

      await reputation.connect(bob).revokeFeedback(agentId, 0);

      const summaryAfter = await reputation.getSummary(agentId);
      expect(summaryAfter.cumulativeValue).to.equal(0n);
      expect(summaryAfter.totalFeedback).to.equal(0n);
    });

    it("should revert when revoking non-existent feedback", async function () {
      // Non-existent feedback has timestamp=0, same as revoked
      await expect(
        reputation.connect(carol).revokeFeedback(agentId, 0)
      ).to.be.revertedWithCustomError(reputation, "AlreadyRevoked");
    });

    it("should revert when revoking already revoked feedback", async function () {
      await reputation.connect(bob).revokeFeedback(agentId, 0);
      await expect(
        reputation.connect(bob).revokeFeedback(agentId, 0)
      ).to.be.revertedWithCustomError(reputation, "AlreadyRevoked");
    });
  });

  // ── Responses ─────────────────────────────────────────────────────

  describe("appendResponse", function () {
    beforeEach(async function () {
      await reputation.connect(bob).giveFeedback(agentId, 100, 0, "tag", "Good");
    });

    it("should allow agent owner to respond", async function () {
      await reputation.connect(alice).appendResponse(agentId, bob.address, 0, "Thanks!");
      const resp = await reputation.getResponse(agentId, bob.address, 0);
      expect(resp.comment).to.equal("Thanks!");
      expect(resp.responder).to.equal(alice.address);
    });

    it("should revert response from non-agent-owner", async function () {
      await expect(
        reputation.connect(bob).appendResponse(agentId, bob.address, 0, "Not my agent")
      ).to.be.revertedWithCustomError(reputation, "NotAgentOwner");
    });

    it("should revert response to non-existent feedback", async function () {
      await expect(
        reputation.connect(alice).appendResponse(agentId, carol.address, 0, "No feedback here")
      ).to.be.revertedWithCustomError(reputation, "FeedbackNotFound");
    });
  });

  // ── Summary & Views ──────────────────────────────────────────────

  describe("getSummary", function () {
    it("should return correct summary after multiple feedback", async function () {
      await reputation.connect(bob).giveFeedback(agentId, 100, 0, "q", "c1");
      await reputation.connect(carol).giveFeedback(agentId, -30, 0, "q", "c2");
      await reputation.connect(bob).giveFeedback(agentId, 50, 0, "q", "c3");

      const summary = await reputation.getSummary(agentId);
      expect(summary.totalFeedback).to.equal(3n);
      expect(summary.cumulativeValue).to.equal(120n); // 100 + (-30) + 50
      expect(summary.uniqueClients).to.equal(2n);
    });

    it("should return empty summary for agent with no feedback", async function () {
      const summary = await reputation.getSummary(agentId);
      expect(summary.totalFeedback).to.equal(0n);
      expect(summary.cumulativeValue).to.equal(0n);
      expect(summary.uniqueClients).to.equal(0n);
    });
  });

  describe("readAllFeedback", function () {
    it("should return all feedback from a client", async function () {
      await reputation.connect(bob).giveFeedback(agentId, 100, 0, "q", "c1");
      await reputation.connect(bob).giveFeedback(agentId, 80, 0, "q", "c2");

      const all = await reputation.readAllFeedback(agentId, bob.address);
      expect(all.length).to.equal(2);
      expect(all[0].value).to.equal(100n);
      expect(all[1].value).to.equal(80n);
    });
  });
});
