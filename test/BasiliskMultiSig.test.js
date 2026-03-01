const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("BasiliskMultiSig", function () {
  let multisig, token;
  let signers, s1, s2, s3, s4, s5, s6, s7, nonSigner;
  const THRESHOLD = 5n;

  async function deployFixture() {
    const allSigners = await ethers.getSigners();
    [s1, s2, s3, s4, s5, s6, s7, nonSigner] = allSigners;
    signers = [s1, s2, s3, s4, s5, s6, s7];
    const signerAddrs = signers.map((s) => s.address);

    // Deploy multi-sig
    const MultiSig = await ethers.getContractFactory("BasiliskMultiSig");
    multisig = await MultiSig.deploy(signerAddrs, THRESHOLD);
    await multisig.waitForDeployment();

    // Deploy mock ERC-20
    const MockToken = await ethers.getContractFactory("MockERC20");
    token = await MockToken.deploy("Test Token", "TEST", 18);
    await token.waitForDeployment();

    // Mint tokens to multi-sig
    const multisigAddr = await multisig.getAddress();
    await token.mint(multisigAddr, ethers.parseUnits("10000", 18));
  }

  beforeEach(async function () {
    await deployFixture();
  });

  // Helper: get threshold-1 confirmations (s2..s5) — s1 auto-confirms on submit
  async function confirmFromSigners(txId, count = 4) {
    const confirmers = [s2, s3, s4, s5].slice(0, count);
    for (const s of confirmers) {
      await multisig.connect(s).confirmTransaction(txId);
    }
  }

  // Helper: submit + reach threshold for a tx
  async function submitAndConfirm(to, value, data) {
    const tx = await multisig.connect(s1).submitTransaction(to, value, data);
    const receipt = await tx.wait();
    const txId = 0n; // first tx
    await confirmFromSigners(txId);
    return txId;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Constructor & Config
  // ═══════════════════════════════════════════════════════════════════════

  describe("Constructor & Config", function () {
    it("should set threshold correctly", async function () {
      expect(await multisig.threshold()).to.equal(THRESHOLD);
    });

    it("should set all 7 signers", async function () {
      expect(await multisig.getSignerCount()).to.equal(7n);
      const onChainSigners = await multisig.getSigners();
      for (let i = 0; i < 7; i++) {
        expect(onChainSigners[i]).to.equal(signers[i].address);
      }
    });

    it("should mark each signer in isSigner mapping", async function () {
      for (const s of signers) {
        expect(await multisig.isSigner(s.address)).to.be.true;
      }
      expect(await multisig.isSigner(nonSigner.address)).to.be.false;
    });

    it("should start with transactionCount = 0", async function () {
      expect(await multisig.transactionCount()).to.equal(0n);
    });

    it("should revert with duplicate signers", async function () {
      const MultiSig = await ethers.getContractFactory("BasiliskMultiSig");
      const addrs = signers.map((s) => s.address);
      addrs[6] = addrs[0]; // duplicate
      await expect(MultiSig.deploy(addrs, 5)).to.be.revertedWithCustomError(multisig, "DuplicateSigner");
    });

    it("should revert with zero address signer", async function () {
      const MultiSig = await ethers.getContractFactory("BasiliskMultiSig");
      const addrs = signers.map((s) => s.address);
      addrs[3] = ethers.ZeroAddress;
      await expect(MultiSig.deploy(addrs, 5)).to.be.revertedWithCustomError(multisig, "ZeroAddress");
    });

    it("should revert with threshold = 0", async function () {
      const MultiSig = await ethers.getContractFactory("BasiliskMultiSig");
      const addrs = signers.map((s) => s.address);
      await expect(MultiSig.deploy(addrs, 0)).to.be.revertedWithCustomError(multisig, "InvalidThreshold");
    });

    it("should revert with threshold > signer count", async function () {
      const MultiSig = await ethers.getContractFactory("BasiliskMultiSig");
      const addrs = signers.map((s) => s.address);
      await expect(MultiSig.deploy(addrs, 8)).to.be.revertedWithCustomError(multisig, "InvalidThreshold");
    });

    it("should revert with < 3 signers", async function () {
      const MultiSig = await ethers.getContractFactory("BasiliskMultiSig");
      await expect(MultiSig.deploy([s1.address, s2.address], 2)).to.be.revertedWithCustomError(
        multisig,
        "InvalidSignerCount"
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Submit Transaction
  // ═══════════════════════════════════════════════════════════════════════

  describe("Submit Transaction", function () {
    it("should submit and auto-confirm for submitter", async function () {
      await multisig.connect(s1).submitTransaction(s7.address, 0, "0x");
      expect(await multisig.transactionCount()).to.equal(1n);
      expect(await multisig.confirmationCount(0)).to.equal(1n);
      expect(await multisig.hasConfirmed(0, s1.address)).to.be.true;
    });

    it("should assign sequential txIds", async function () {
      await multisig.connect(s1).submitTransaction(s7.address, 0, "0x");
      await multisig.connect(s2).submitTransaction(s7.address, 0, "0x");
      expect(await multisig.transactionCount()).to.equal(2n);
    });

    it("should emit TransactionSubmitted and TransactionConfirmed events", async function () {
      await expect(multisig.connect(s1).submitTransaction(s7.address, 100, "0x"))
        .to.emit(multisig, "TransactionSubmitted")
        .withArgs(0, s1.address, s7.address, 100, "0x")
        .and.to.emit(multisig, "TransactionConfirmed")
        .withArgs(0, s1.address);
    });

    it("should store transaction data correctly", async function () {
      const data = "0xdeadbeef";
      await multisig.connect(s1).submitTransaction(s7.address, 42, data);
      const tx = await multisig.getTransaction(0);
      expect(tx.to).to.equal(s7.address);
      expect(tx.value).to.equal(42n);
      expect(tx.data).to.equal(data);
      expect(tx.executed).to.be.false;
      expect(tx.cancelled).to.be.false;
      expect(tx.numConfirmations).to.equal(1n);
    });

    it("should revert when non-signer submits", async function () {
      await expect(
        multisig.connect(nonSigner).submitTransaction(s7.address, 0, "0x")
      ).to.be.revertedWithCustomError(multisig, "NotSigner");
    });

    it("should revert when target is zero address", async function () {
      await expect(
        multisig.connect(s1).submitTransaction(ethers.ZeroAddress, 0, "0x")
      ).to.be.revertedWithCustomError(multisig, "ZeroAddress");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Confirm Transaction
  // ═══════════════════════════════════════════════════════════════════════

  describe("Confirm Transaction", function () {
    beforeEach(async function () {
      await multisig.connect(s1).submitTransaction(s7.address, 0, "0x");
    });

    it("should allow another signer to confirm", async function () {
      await multisig.connect(s2).confirmTransaction(0);
      expect(await multisig.confirmationCount(0)).to.equal(2n);
      expect(await multisig.hasConfirmed(0, s2.address)).to.be.true;
    });

    it("should increment confirmation count", async function () {
      await multisig.connect(s2).confirmTransaction(0);
      await multisig.connect(s3).confirmTransaction(0);
      expect(await multisig.confirmationCount(0)).to.equal(3n);
    });

    it("should emit TransactionConfirmed event", async function () {
      await expect(multisig.connect(s2).confirmTransaction(0))
        .to.emit(multisig, "TransactionConfirmed")
        .withArgs(0, s2.address);
    });

    it("should revert double confirm", async function () {
      await expect(multisig.connect(s1).confirmTransaction(0)).to.be.revertedWithCustomError(
        multisig,
        "AlreadyConfirmed"
      );
    });

    it("should revert non-signer confirm", async function () {
      await expect(multisig.connect(nonSigner).confirmTransaction(0)).to.be.revertedWithCustomError(
        multisig,
        "NotSigner"
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Revoke Confirmation
  // ═══════════════════════════════════════════════════════════════════════

  describe("Revoke Confirmation", function () {
    beforeEach(async function () {
      await multisig.connect(s1).submitTransaction(s7.address, 0, "0x");
    });

    it("should allow submitter to revoke their confirmation", async function () {
      await multisig.connect(s1).revokeConfirmation(0);
      expect(await multisig.confirmationCount(0)).to.equal(0n);
      expect(await multisig.hasConfirmed(0, s1.address)).to.be.false;
    });

    it("should decrement confirmation count", async function () {
      await multisig.connect(s2).confirmTransaction(0);
      expect(await multisig.confirmationCount(0)).to.equal(2n);
      await multisig.connect(s2).revokeConfirmation(0);
      expect(await multisig.confirmationCount(0)).to.equal(1n);
    });

    it("should emit ConfirmationRevoked event", async function () {
      await expect(multisig.connect(s1).revokeConfirmation(0))
        .to.emit(multisig, "ConfirmationRevoked")
        .withArgs(0, s1.address);
    });

    it("should revert if not confirmed", async function () {
      await expect(multisig.connect(s2).revokeConfirmation(0)).to.be.revertedWithCustomError(
        multisig,
        "NotConfirmed"
      );
    });

    it("should revert for non-signer", async function () {
      await expect(multisig.connect(nonSigner).revokeConfirmation(0)).to.be.revertedWithCustomError(
        multisig,
        "NotSigner"
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Execute Transaction
  // ═══════════════════════════════════════════════════════════════════════

  describe("Execute Transaction", function () {
    it("should execute native ETH transfer", async function () {
      // Fund multisig with ETH
      await s1.sendTransaction({ to: await multisig.getAddress(), value: ethers.parseEther("1.0") });

      const recipient = nonSigner.address;
      const amount = ethers.parseEther("0.5");
      const balBefore = await ethers.provider.getBalance(recipient);

      await multisig.connect(s1).submitTransaction(recipient, amount, "0x");
      await confirmFromSigners(0);
      await multisig.connect(s1).executeTransaction(0);

      const balAfter = await ethers.provider.getBalance(recipient);
      expect(balAfter - balBefore).to.equal(amount);

      const tx = await multisig.getTransaction(0);
      expect(tx.executed).to.be.true;
    });

    it("should execute ERC-20 transfer via calldata", async function () {
      const recipient = nonSigner.address;
      const amount = ethers.parseUnits("100", 18);
      const tokenAddr = await token.getAddress();

      // Encode the transfer calldata
      const iface = new ethers.Interface(["function transfer(address to, uint256 amount) returns (bool)"]);
      const data = iface.encodeFunctionData("transfer", [recipient, amount]);

      await multisig.connect(s1).submitTransaction(tokenAddr, 0, data);
      await confirmFromSigners(0);
      await multisig.connect(s1).executeTransaction(0);

      expect(await token.balanceOf(recipient)).to.equal(amount);
    });

    it("should emit TransactionExecuted event", async function () {
      await s1.sendTransaction({ to: await multisig.getAddress(), value: ethers.parseEther("0.1") });
      await multisig.connect(s1).submitTransaction(nonSigner.address, 1, "0x");
      await confirmFromSigners(0);

      await expect(multisig.connect(s1).executeTransaction(0))
        .to.emit(multisig, "TransactionExecuted")
        .withArgs(0, s1.address);
    });

    it("should revert with insufficient confirmations", async function () {
      await multisig.connect(s1).submitTransaction(nonSigner.address, 0, "0x");
      // Only s1 auto-confirmed (1 of 5 needed)
      await multisig.connect(s2).confirmTransaction(0);
      await multisig.connect(s3).confirmTransaction(0);
      // 3 of 5 — still not enough

      await expect(multisig.connect(s1).executeTransaction(0)).to.be.revertedWithCustomError(
        multisig,
        "InsufficientConfirmations"
      );
    });

    it("should revert double execution", async function () {
      await s1.sendTransaction({ to: await multisig.getAddress(), value: ethers.parseEther("0.1") });
      await multisig.connect(s1).submitTransaction(nonSigner.address, 1, "0x");
      await confirmFromSigners(0);
      await multisig.connect(s1).executeTransaction(0);

      await expect(multisig.connect(s1).executeTransaction(0)).to.be.revertedWithCustomError(
        multisig,
        "TransactionAlreadyExecuted"
      );
    });

    it("should revert for non-signer execution", async function () {
      await multisig.connect(s1).submitTransaction(nonSigner.address, 0, "0x");
      await confirmFromSigners(0);

      await expect(multisig.connect(nonSigner).executeTransaction(0)).to.be.revertedWithCustomError(
        multisig,
        "NotSigner"
      );
    });

    it("should revert on failed call (e.g. insufficient ETH)", async function () {
      // No ETH in multisig, try to send 1 ETH
      await multisig.connect(s1).submitTransaction(nonSigner.address, ethers.parseEther("999"), "0x");
      await confirmFromSigners(0);

      await expect(multisig.connect(s1).executeTransaction(0)).to.be.revertedWithCustomError(
        multisig,
        "ExecutionFailed"
      );
    });

    it("should revert confirm/execute on non-existent tx", async function () {
      await expect(multisig.connect(s1).confirmTransaction(999)).to.be.revertedWithCustomError(
        multisig,
        "TransactionNotFound"
      );
      await expect(multisig.connect(s1).executeTransaction(999)).to.be.revertedWithCustomError(
        multisig,
        "TransactionNotFound"
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Receive
  // ═══════════════════════════════════════════════════════════════════════

  describe("Receive", function () {
    it("should accept native ETH", async function () {
      const multisigAddr = await multisig.getAddress();
      await s1.sendTransaction({ to: multisigAddr, value: ethers.parseEther("1.0") });
      expect(await ethers.provider.getBalance(multisigAddr)).to.equal(ethers.parseEther("1.0"));
    });

    it("should emit NativeReceived event", async function () {
      const multisigAddr = await multisig.getAddress();
      await expect(s1.sendTransaction({ to: multisigAddr, value: ethers.parseEther("0.5") }))
        .to.emit(multisig, "NativeReceived")
        .withArgs(s1.address, ethers.parseEther("0.5"));
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // ERC-20 Flow
  // ═══════════════════════════════════════════════════════════════════════

  describe("ERC-20 Flow", function () {
    it("should hold ERC-20 tokens", async function () {
      const multisigAddr = await multisig.getAddress();
      expect(await token.balanceOf(multisigAddr)).to.equal(ethers.parseUnits("10000", 18));
    });

    it("should complete full ERC-20 submit-confirm-execute transfer", async function () {
      const multisigAddr = await multisig.getAddress();
      const recipient = nonSigner.address;
      const amount = ethers.parseUnits("500", 18);
      const tokenAddr = await token.getAddress();

      const iface = new ethers.Interface(["function transfer(address to, uint256 amount) returns (bool)"]);
      const data = iface.encodeFunctionData("transfer", [recipient, amount]);

      // Submit
      await multisig.connect(s1).submitTransaction(tokenAddr, 0, data);

      // Confirm (s2..s5)
      await confirmFromSigners(0);

      // Execute
      await multisig.connect(s6).executeTransaction(0);

      expect(await token.balanceOf(recipient)).to.equal(amount);
      expect(await token.balanceOf(multisigAddr)).to.equal(ethers.parseUnits("9500", 18));
    });

    it("should encode ERC-20 transfer correctly via helper", async function () {
      const tokenAddr = await token.getAddress();
      const recipient = nonSigner.address;
      const amount = ethers.parseUnits("100", 18);

      const [targetToken, data] = await multisig.encodeERC20Transfer(tokenAddr, recipient, amount);
      expect(targetToken).to.equal(tokenAddr);

      // Verify encoded data matches manual encoding
      const iface = new ethers.Interface(["function transfer(address to, uint256 amount) returns (bool)"]);
      const expected = iface.encodeFunctionData("transfer", [recipient, amount]);
      expect(data).to.equal(expected);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Signer Rotation
  // ═══════════════════════════════════════════════════════════════════════

  describe("Signer Rotation", function () {
    it("should add a signer via self-call", async function () {
      const newSigner = nonSigner.address;
      const msAddr = await multisig.getAddress();

      // Encode addSigner call
      const iface = multisig.interface;
      const data = iface.encodeFunctionData("addSigner", [newSigner]);

      // Submit tx targeting the multisig itself
      await multisig.connect(s1).submitTransaction(msAddr, 0, data);
      await confirmFromSigners(0);
      await multisig.connect(s1).executeTransaction(0);

      expect(await multisig.isSigner(newSigner)).to.be.true;
      expect(await multisig.getSignerCount()).to.equal(8n);
    });

    it("should remove a signer via self-call", async function () {
      const removeAddr = s7.address;
      const msAddr = await multisig.getAddress();

      const data = multisig.interface.encodeFunctionData("removeSigner", [removeAddr]);

      await multisig.connect(s1).submitTransaction(msAddr, 0, data);
      await confirmFromSigners(0);
      await multisig.connect(s1).executeTransaction(0);

      expect(await multisig.isSigner(removeAddr)).to.be.false;
      expect(await multisig.getSignerCount()).to.equal(6n);
    });

    it("should allow added signer to submit and confirm", async function () {
      const newSigner = nonSigner;
      const msAddr = await multisig.getAddress();

      // Add the new signer
      const data = multisig.interface.encodeFunctionData("addSigner", [newSigner.address]);
      await multisig.connect(s1).submitTransaction(msAddr, 0, data);
      await confirmFromSigners(0); // txId 0
      await multisig.connect(s1).executeTransaction(0);

      // New signer submits a tx
      await multisig.connect(newSigner).submitTransaction(s1.address, 0, "0x");
      expect(await multisig.hasConfirmed(1, newSigner.address)).to.be.true;
    });

    it("should prevent removed signer from acting", async function () {
      const msAddr = await multisig.getAddress();

      // Remove s7
      const data = multisig.interface.encodeFunctionData("removeSigner", [s7.address]);
      await multisig.connect(s1).submitTransaction(msAddr, 0, data);
      await confirmFromSigners(0);
      await multisig.connect(s1).executeTransaction(0);

      // s7 tries to submit — should fail
      await expect(
        multisig.connect(s7).submitTransaction(s1.address, 0, "0x")
      ).to.be.revertedWithCustomError(multisig, "NotSigner");
    });

    it("should revert direct addSigner call (not via self)", async function () {
      await expect(multisig.connect(s1).addSigner(nonSigner.address)).to.be.revertedWithCustomError(
        multisig,
        "OnlySelf"
      );
    });

    it("should revert remove signer if it would drop below threshold", async function () {
      const msAddr = await multisig.getAddress();

      // Remove s7 (7 → 6, threshold 5, ok)
      let data = multisig.interface.encodeFunctionData("removeSigner", [s7.address]);
      await multisig.connect(s1).submitTransaction(msAddr, 0, data);
      await confirmFromSigners(0);
      await multisig.connect(s1).executeTransaction(0);

      // Remove s6 (6 → 5, threshold 5, ok — exactly at threshold)
      data = multisig.interface.encodeFunctionData("removeSigner", [s6.address]);
      await multisig.connect(s1).submitTransaction(msAddr, 0, data);
      await confirmFromSigners(1);
      await multisig.connect(s1).executeTransaction(1);

      // Remove s5 (5 → 4, threshold 5, FAIL — would drop below threshold)
      data = multisig.interface.encodeFunctionData("removeSigner", [s5.address]);
      await multisig.connect(s1).submitTransaction(msAddr, 0, data);
      await confirmFromSigners(2);

      await expect(multisig.connect(s1).executeTransaction(2)).to.be.revertedWithCustomError(
        multisig,
        "ExecutionFailed"
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Threshold Change
  // ═══════════════════════════════════════════════════════════════════════

  describe("Threshold Change", function () {
    it("should change threshold via self-call", async function () {
      const msAddr = await multisig.getAddress();
      const data = multisig.interface.encodeFunctionData("changeThreshold", [3]);

      await multisig.connect(s1).submitTransaction(msAddr, 0, data);
      await confirmFromSigners(0);
      await multisig.connect(s1).executeTransaction(0);

      expect(await multisig.threshold()).to.equal(3n);
    });

    it("should emit ThresholdChanged event", async function () {
      const msAddr = await multisig.getAddress();
      const data = multisig.interface.encodeFunctionData("changeThreshold", [4]);

      await multisig.connect(s1).submitTransaction(msAddr, 0, data);
      await confirmFromSigners(0);

      await expect(multisig.connect(s1).executeTransaction(0))
        .to.emit(multisig, "ThresholdChanged")
        .withArgs(5, 4);
    });

    it("should revert threshold = 0 via self-call", async function () {
      const msAddr = await multisig.getAddress();
      const data = multisig.interface.encodeFunctionData("changeThreshold", [0]);

      await multisig.connect(s1).submitTransaction(msAddr, 0, data);
      await confirmFromSigners(0);

      await expect(multisig.connect(s1).executeTransaction(0)).to.be.revertedWithCustomError(
        multisig,
        "ExecutionFailed"
      );
    });

    it("should revert threshold > signerCount via self-call", async function () {
      const msAddr = await multisig.getAddress();
      const data = multisig.interface.encodeFunctionData("changeThreshold", [99]);

      await multisig.connect(s1).submitTransaction(msAddr, 0, data);
      await confirmFromSigners(0);

      await expect(multisig.connect(s1).executeTransaction(0)).to.be.revertedWithCustomError(
        multisig,
        "ExecutionFailed"
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Cancel Transaction
  // ═══════════════════════════════════════════════════════════════════════

  describe("Cancel Transaction", function () {
    it("should cancel a pending tx via self-call", async function () {
      // Submit a regular tx (txId 0)
      await multisig.connect(s1).submitTransaction(nonSigner.address, 0, "0x");

      // Submit a cancel-tx targeting that tx (txId 1)
      const msAddr = await multisig.getAddress();
      const data = multisig.interface.encodeFunctionData("cancelTransaction", [0]);
      await multisig.connect(s1).submitTransaction(msAddr, 0, data);
      await confirmFromSigners(1);
      await multisig.connect(s1).executeTransaction(1);

      const tx = await multisig.getTransaction(0);
      expect(tx.cancelled).to.be.true;
    });

    it("should not allow confirming a cancelled tx", async function () {
      await multisig.connect(s1).submitTransaction(nonSigner.address, 0, "0x");

      const msAddr = await multisig.getAddress();
      const data = multisig.interface.encodeFunctionData("cancelTransaction", [0]);
      await multisig.connect(s1).submitTransaction(msAddr, 0, data);
      await confirmFromSigners(1);
      await multisig.connect(s1).executeTransaction(1);

      await expect(multisig.connect(s2).confirmTransaction(0)).to.be.revertedWithCustomError(
        multisig,
        "TransactionAlreadyCancelled"
      );
    });

    it("should not allow executing a cancelled tx", async function () {
      await multisig.connect(s1).submitTransaction(nonSigner.address, 0, "0x");
      await confirmFromSigners(0);

      const msAddr = await multisig.getAddress();
      const data = multisig.interface.encodeFunctionData("cancelTransaction", [0]);
      await multisig.connect(s1).submitTransaction(msAddr, 0, data);
      await confirmFromSigners(1);
      await multisig.connect(s1).executeTransaction(1);

      await expect(multisig.connect(s1).executeTransaction(0)).to.be.revertedWithCustomError(
        multisig,
        "TransactionAlreadyCancelled"
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // View Functions
  // ═══════════════════════════════════════════════════════════════════════

  describe("View Functions", function () {
    it("getTransaction should return full details", async function () {
      await multisig.connect(s1).submitTransaction(s7.address, 42, "0xabcd");
      const tx = await multisig.getTransaction(0);
      expect(tx.to).to.equal(s7.address);
      expect(tx.value).to.equal(42n);
      expect(tx.data).to.equal("0xabcd");
      expect(tx.executed).to.be.false;
      expect(tx.cancelled).to.be.false;
      expect(tx.numConfirmations).to.equal(1n);
    });

    it("isConfirmed should return true when threshold met", async function () {
      await multisig.connect(s1).submitTransaction(s7.address, 0, "0x");
      expect(await multisig.isConfirmed(0)).to.be.false;
      await confirmFromSigners(0);
      expect(await multisig.isConfirmed(0)).to.be.true;
    });

    it("getConfirmations should return list of confirming signers", async function () {
      await multisig.connect(s1).submitTransaction(s7.address, 0, "0x");
      await multisig.connect(s2).confirmTransaction(0);
      await multisig.connect(s3).confirmTransaction(0);

      const confirmed = await multisig.getConfirmations(0);
      expect(confirmed.length).to.equal(3);
      expect(confirmed).to.include(s1.address);
      expect(confirmed).to.include(s2.address);
      expect(confirmed).to.include(s3.address);
    });

    it("getSigners should return all signers", async function () {
      const result = await multisig.getSigners();
      expect(result.length).to.equal(7);
    });

    it("hasConfirmed should check specific signer", async function () {
      await multisig.connect(s1).submitTransaction(s7.address, 0, "0x");
      expect(await multisig.hasConfirmed(0, s1.address)).to.be.true;
      expect(await multisig.hasConfirmed(0, s2.address)).to.be.false;
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Integration — Escrow + MultiSig as Treasury
  // ═══════════════════════════════════════════════════════════════════════

  describe("Integration — Escrow with MultiSig Treasury", function () {
    let escrow, identity;

    beforeEach(async function () {
      // Deploy Identity Registry
      const IdentityRegistry = await ethers.getContractFactory("IdentityRegistry");
      identity = await IdentityRegistry.deploy();
      await identity.waitForDeployment();

      // Deploy Escrow with multisig as treasury
      const BasiliskEscrow = await ethers.getContractFactory("BasiliskEscrow");
      escrow = await BasiliskEscrow.deploy(
        s1.address, // admin
        s2.address, // arbitrator
        await multisig.getAddress(), // treasury = multisig
        s3.address, // opsWallet
        500, // 5% fee
        await identity.getAddress()
      );
      await escrow.waitForDeployment();

      // Register agents
      await identity.connect(s4)["register(string)"]("ipfs://requester");
      await identity.connect(s5)["register(string)"]("ipfs://agent");

      // Mint tokens to requester and approve
      await token.mint(s4.address, ethers.parseUnits("1000", 18));
      await token.connect(s4).approve(await escrow.getAddress(), ethers.MaxUint256);
    });

    it("should send fees to multisig on job approval", async function () {
      const multisigAddr = await multisig.getAddress();
      const tokenAddr = await token.getAddress();
      const jobId = ethers.keccak256(ethers.toUtf8Bytes("integration-job-001"));
      const amount = ethers.parseUnits("100", 18);

      // Create job
      await escrow.connect(s4).createJob(jobId, tokenAddr, amount, 30, "Integration test");

      // Accept
      await escrow.connect(s5).acceptJob(jobId);

      // Submit deliverable
      await escrow.connect(s5).submitDeliverable(jobId, "Done");

      // Approve — 5% fee, 80% of fee to treasury = 4% = 4 tokens
      const treasuryBefore = await token.balanceOf(multisigAddr);
      await escrow.connect(s4).approveAndPay(jobId, 5);
      const treasuryAfter = await token.balanceOf(multisigAddr);

      // 100 tokens * 5% = 5 token fee, 80% to treasury = 4 tokens
      const expectedTreasuryFee = ethers.parseUnits("4", 18);
      expect(treasuryAfter - treasuryBefore).to.equal(expectedTreasuryFee);
    });

    it("should allow 5-of-7 withdrawal from multisig after fees collected", async function () {
      const multisigAddr = await multisig.getAddress();
      const tokenAddr = await token.getAddress();
      const jobId = ethers.keccak256(ethers.toUtf8Bytes("integration-job-002"));
      const amount = ethers.parseUnits("1000", 18);

      // Run a job to get fees into multisig
      await escrow.connect(s4).createJob(jobId, tokenAddr, amount, 30, "Fee test");
      await escrow.connect(s5).acceptJob(jobId);
      await escrow.connect(s5).submitDeliverable(jobId, "Done");
      await escrow.connect(s4).approveAndPay(jobId, 5);

      // Multisig now has 10000 (minted) + 40 (4% of 1000) tokens
      const msBal = await token.balanceOf(multisigAddr);
      expect(msBal).to.equal(ethers.parseUnits("10040", 18));

      // Withdraw 40 tokens to nonSigner via multisig
      const withdrawAmount = ethers.parseUnits("40", 18);
      const iface = new ethers.Interface(["function transfer(address to, uint256 amount) returns (bool)"]);
      const data = iface.encodeFunctionData("transfer", [nonSigner.address, withdrawAmount]);

      await multisig.connect(s1).submitTransaction(tokenAddr, 0, data);
      await confirmFromSigners(0);
      await multisig.connect(s1).executeTransaction(0);

      expect(await token.balanceOf(nonSigner.address)).to.equal(withdrawAmount);
      expect(await token.balanceOf(multisigAddr)).to.equal(ethers.parseUnits("10000", 18));
    });

    it("should prevent withdrawal with < 5 confirmations", async function () {
      const tokenAddr = await token.getAddress();
      const withdrawAmount = ethers.parseUnits("100", 18);
      const iface = new ethers.Interface(["function transfer(address to, uint256 amount) returns (bool)"]);
      const data = iface.encodeFunctionData("transfer", [nonSigner.address, withdrawAmount]);

      await multisig.connect(s1).submitTransaction(tokenAddr, 0, data);
      // Only 3 confirms (s1 auto + s2 + s3) — need 5
      await multisig.connect(s2).confirmTransaction(0);
      await multisig.connect(s3).confirmTransaction(0);

      await expect(multisig.connect(s1).executeTransaction(0)).to.be.revertedWithCustomError(
        multisig,
        "InsufficientConfirmations"
      );
    });
  });
});
