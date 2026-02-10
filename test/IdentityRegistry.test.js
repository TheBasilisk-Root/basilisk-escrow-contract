const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("IdentityRegistry", function () {
  let identity;
  let owner, alice, bob, carol;

  beforeEach(async function () {
    [owner, alice, bob, carol] = await ethers.getSigners();
    const IdentityRegistry = await ethers.getContractFactory("IdentityRegistry");
    identity = await IdentityRegistry.deploy();
    await identity.waitForDeployment();
  });

  // ── Registration ──────────────────────────────────────────────────

  describe("Registration", function () {
    it("should register a new agent and return agentId=1", async function () {
      const tx = await identity.connect(alice)["register(string)"]("ipfs://agent1");
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        (l) => l.fragment && l.fragment.name === "AgentRegistered"
      );
      expect(event.args.agentId).to.equal(1n);
      expect(event.args.owner).to.equal(alice.address);
    });

    it("should mint an ERC-721 token to the registrant", async function () {
      await identity.connect(alice)["register(string)"]("ipfs://agent1");
      expect(await identity.ownerOf(1)).to.equal(alice.address);
      expect(await identity.balanceOf(alice.address)).to.equal(1n);
    });

    it("should set the token URI", async function () {
      await identity.connect(alice)["register(string)"]("ipfs://agent1");
      expect(await identity.tokenURI(1)).to.equal("ipfs://agent1");
    });

    it("should increment nextTokenId", async function () {
      await identity.connect(alice)["register(string)"]("ipfs://a1");
      await identity.connect(bob)["register(string)"]("ipfs://a2");
      expect(await identity.nextTokenId()).to.equal(3n);
    });

    it("should revert if already registered", async function () {
      await identity.connect(alice)["register(string)"]("ipfs://a1");
      await expect(
        identity.connect(alice)["register(string)"]("ipfs://a2")
      ).to.be.revertedWithCustomError(identity, "AlreadyRegistered");
    });

    it("should register with initial metadata", async function () {
      await identity
        .connect(alice)
        ["register(string,string[],bytes[])"](
          "ipfs://a1",
          ["type", "version"],
          [ethers.toUtf8Bytes("ai"), ethers.toUtf8Bytes("1.0")]
        );
      const typeVal = await identity.getMetadata(1, "type");
      expect(ethers.toUtf8String(typeVal)).to.equal("ai");
    });

    it("should revert register with mismatched key/value arrays", async function () {
      await expect(
        identity
          .connect(alice)
          ["register(string,string[],bytes[])"](
            "ipfs://a1",
            ["type"],
            [ethers.toUtf8Bytes("ai"), ethers.toUtf8Bytes("extra")]
          )
      ).to.be.revertedWithCustomError(identity, "ArrayLengthMismatch");
    });

    it("should registerFor another address", async function () {
      await identity.connect(owner).registerFor(bob.address, "ipfs://bob");
      expect(await identity.ownerOf(1)).to.equal(bob.address);
      expect(await identity.getAgentIdByOwner(bob.address)).to.equal(1n);
    });
  });

  // ── Metadata ──────────────────────────────────────────────────────

  describe("Metadata", function () {
    beforeEach(async function () {
      await identity.connect(alice)["register(string)"]("ipfs://a1");
    });

    it("should update agent URI", async function () {
      await identity.connect(alice).setAgentURI(1, "ipfs://updated");
      expect(await identity.tokenURI(1)).to.equal("ipfs://updated");
    });

    it("should revert setAgentURI from non-owner", async function () {
      await expect(
        identity.connect(bob).setAgentURI(1, "ipfs://hacked")
      ).to.be.revertedWithCustomError(identity, "NotAgentOwner");
    });

    it("should set and get metadata", async function () {
      await identity.connect(alice).setMetadata(1, "capabilities", ethers.toUtf8Bytes("code,analysis"));
      const val = await identity.getMetadata(1, "capabilities");
      expect(ethers.toUtf8String(val)).to.equal("code,analysis");
    });

    it("should overwrite existing metadata key", async function () {
      await identity.connect(alice).setMetadata(1, "k", ethers.toUtf8Bytes("v1"));
      await identity.connect(alice).setMetadata(1, "k", ethers.toUtf8Bytes("v2"));
      const val = await identity.getMetadata(1, "k");
      expect(ethers.toUtf8String(val)).to.equal("v2");
    });

    it("should return empty bytes for unknown key", async function () {
      const val = await identity.getMetadata(1, "nonexistent");
      expect(val).to.equal("0x");
    });
  });

  // ── Queries ───────────────────────────────────────────────────────

  describe("Queries", function () {
    it("should return isRegistered=true for valid agent", async function () {
      await identity.connect(alice)["register(string)"]("ipfs://a1");
      expect(await identity.isRegistered(1)).to.be.true;
    });

    it("should return isRegistered=false for agentId=0", async function () {
      expect(await identity.isRegistered(0)).to.be.false;
    });

    it("should return isRegistered=false for non-existent agentId", async function () {
      expect(await identity.isRegistered(999)).to.be.false;
    });

    it("should return getAgentIdByOwner=0 for unregistered address", async function () {
      expect(await identity.getAgentIdByOwner(bob.address)).to.equal(0n);
    });

    it("should return correct agentId for registered owner", async function () {
      await identity.connect(alice)["register(string)"]("ipfs://a1");
      expect(await identity.getAgentIdByOwner(alice.address)).to.equal(1n);
    });
  });

  // ── EIP-712 Wallet Delegation ────────────────────────────────────

  describe("Wallet Delegation (EIP-712)", function () {
    beforeEach(async function () {
      await identity.connect(alice)["register(string)"]("ipfs://a1");
    });

    it("should set agent wallet with valid EIP-712 signature", async function () {
      const agentId = 1n;
      const deadline = BigInt(await time.latest()) + 3600n;
      const nonce = await identity.nonces(bob.address);

      const domain = {
        name: "BasiliskIdentity",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await identity.getAddress(),
      };
      const types = {
        SetAgentWallet: [
          { name: "agentId", type: "uint256" },
          { name: "wallet", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      };
      const value = { agentId, wallet: bob.address, nonce, deadline };

      const sig = await bob.signTypedData(domain, types, value);
      const { v, r, s } = ethers.Signature.from(sig);

      await identity.connect(alice).setAgentWallet(agentId, bob.address, deadline, v, r, s);
      expect(await identity.getAgentWallet(1)).to.equal(bob.address);
    });

    it("should revert with expired deadline", async function () {
      const deadline = BigInt(await time.latest()) - 3600n;
      // Dummy sig values — deadline check comes first
      await expect(
        identity.connect(alice).setAgentWallet(1, bob.address, deadline, 27, ethers.ZeroHash, ethers.ZeroHash)
      ).to.be.revertedWithCustomError(identity, "SignatureExpired");
    });

    it("should revert from non-owner", async function () {
      const deadline = BigInt(await time.latest()) + 3600n;
      await expect(
        identity.connect(bob).setAgentWallet(1, bob.address, deadline, 27, ethers.ZeroHash, ethers.ZeroHash)
      ).to.be.revertedWithCustomError(identity, "NotAgentOwner");
    });

    it("should unset agent wallet", async function () {
      // First set a wallet
      const agentId = 1n;
      const deadline = BigInt(await time.latest()) + 3600n;
      const nonce = await identity.nonces(bob.address);

      const domain = {
        name: "BasiliskIdentity",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await identity.getAddress(),
      };
      const types = {
        SetAgentWallet: [
          { name: "agentId", type: "uint256" },
          { name: "wallet", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      };
      const value = { agentId, wallet: bob.address, nonce, deadline };
      const sig = await bob.signTypedData(domain, types, value);
      const { v, r, s } = ethers.Signature.from(sig);

      await identity.connect(alice).setAgentWallet(agentId, bob.address, deadline, v, r, s);
      expect(await identity.getAgentWallet(1)).to.equal(bob.address);

      await identity.connect(alice).unsetAgentWallet(1);
      expect(await identity.getAgentWallet(1)).to.equal(ethers.ZeroAddress);
    });

    it("should revert unsetAgentWallet when no wallet set", async function () {
      await expect(
        identity.connect(alice).unsetAgentWallet(1)
      ).to.be.revertedWithCustomError(identity, "NoWalletSet");
    });
  });

  // ── Transfer tracking ────────────────────────────────────────────

  describe("Transfer tracking", function () {
    it("should update ownerToAgentId on transfer", async function () {
      await identity.connect(alice)["register(string)"]("ipfs://a1");
      expect(await identity.getAgentIdByOwner(alice.address)).to.equal(1n);

      await identity.connect(alice).transferFrom(alice.address, bob.address, 1);
      expect(await identity.getAgentIdByOwner(alice.address)).to.equal(0n);
      expect(await identity.getAgentIdByOwner(bob.address)).to.equal(1n);
    });
  });
});
