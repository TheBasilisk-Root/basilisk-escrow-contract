// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./interfaces/IIdentityRegistry.sol";

/**
 * @title BasiliskEscrow
 * @notice Trustless escrow for agent-to-agent job coordination on EVM chains.
 *         Mirrors the Solana/Anchor escrow program with identical lifecycle and
 *         fee split. Integrates with ERC-8004 Identity Registry for agent gating.
 *
 *         Lifecycle: Open → InProgress → UnderReview → Completed/Disputed → Resolved
 *
 *         Fee model (5% default, configurable):
 *           95% → Worker
 *           2%  → Treasury (buyback & burn)
 *           2%  → Operational costs
 *           1%  → Verifier (or returned to worker as bonus if no verifier)
 */
contract BasiliskEscrow is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    // ========================================================================
    // Types
    // ========================================================================

    enum JobStatus {
        Open,        // 0 — Job posted, waiting for agent
        InProgress,  // 1 — Agent accepted, work in progress
        UnderReview, // 2 — Deliverable submitted, awaiting review
        Completed,   // 3 — Approved, payment released
        Cancelled,   // 4 — Requester cancelled or expired
        Disputed,    // 5 — Rejected, under dispute
        Resolved     // 6 — Arbitrator resolved dispute
    }

    struct Job {
        // slot 0: address(20) + uint8(1) + uint8(1) + bool(1) = 23 bytes
        address requester;
        uint8 rating;
        JobStatus status;
        bool disputed;
        // slot 1
        address agent;
        // slot 2
        address token;
        // slot 3
        address verifier;
        // slot 4
        uint256 amount;
        // slot 5
        uint256 deadline;
        // slot 6
        uint256 createdAt;
        // slot 7
        uint256 requesterAgentId;
        // slot 8
        uint256 agentAgentId;
        // dynamic
        string description;
        string deliverable;
    }

    // ========================================================================
    // Constants
    // ========================================================================

    uint16 public constant MAX_FEE_BPS = 1000; // 10% absolute max
    uint8 public constant TREASURY_SHARE_PCT = 40;
    uint8 public constant OPS_SHARE_PCT = 40;
    uint8 public constant VERIFIER_SHARE_PCT = 20;

    // ========================================================================
    // Config State
    // ========================================================================

    address public arbitrator;
    address public treasury;
    address public opsWallet;
    uint16 public feeBps; // basis points (500 = 5%)

    IIdentityRegistry public identityRegistry;
    bool public requireRegistration;

    // ========================================================================
    // Job State
    // ========================================================================

    mapping(bytes32 => Job) public jobs;
    mapping(bytes32 => bool) public jobExists;

    // ========================================================================
    // Events
    // ========================================================================

    event JobCreated(
        bytes32 indexed jobId,
        address indexed requester,
        address token,
        uint256 amount,
        uint256 deadline,
        uint256 requesterAgentId
    );
    event JobAccepted(bytes32 indexed jobId, address indexed agent, uint256 agentAgentId);
    event DeliverableSubmitted(bytes32 indexed jobId, address indexed agent, string deliverable);
    event JobApproved(
        bytes32 indexed jobId,
        address indexed agent,
        uint256 workerAmount,
        uint256 treasuryAmount,
        uint256 opsAmount,
        uint256 verifierAmount,
        uint8 rating
    );
    event JobRejected(bytes32 indexed jobId, string reason);
    event JobCancelled(bytes32 indexed jobId, uint256 refundAmount);
    event DisputeResolved(
        bytes32 indexed jobId,
        uint256 agentAmount,
        uint256 requesterAmount,
        uint256 treasuryAmount,
        uint256 opsAmount,
        uint8 agentPercentage
    );
    event VerifierSet(bytes32 indexed jobId, address indexed verifier);
    event ConfigUpdated(address arbitrator, address treasury, address opsWallet, uint16 feeBps);
    event IdentityRegistryUpdated(address identityRegistry, bool requireRegistration);

    // ========================================================================
    // Errors
    // ========================================================================

    error Unauthorized();
    error JobNotFound();
    error JobIdAlreadyExists();
    error InvalidStatus(JobStatus expected, JobStatus actual);
    error InvalidAmount();
    error InvalidPercentage();
    error InvalidRating();
    error InvalidFeeBps();
    error DeadlineExpired();
    error CannotCancel();
    error DescriptionTooLong();
    error DeliverableTooLong();
    error AgentNotRegistered();
    error ZeroAddress();

    // ========================================================================
    // Modifiers
    // ========================================================================

    modifier onlyArbitrator() {
        if (msg.sender != arbitrator) revert Unauthorized();
        _;
    }

    modifier onlyRequester(bytes32 jobId) {
        if (msg.sender != jobs[jobId].requester) revert Unauthorized();
        _;
    }

    modifier onlyAgent(bytes32 jobId) {
        if (msg.sender != jobs[jobId].agent) revert Unauthorized();
        _;
    }

    modifier jobMustExist(bytes32 jobId) {
        if (!jobExists[jobId]) revert JobNotFound();
        _;
    }

    // ========================================================================
    // Constructor
    // ========================================================================

    /// @param _admin         Contract owner (can update config)
    /// @param _arbitrator    Dispute resolver
    /// @param _treasury      Treasury wallet (buyback & burn)
    /// @param _opsWallet     Operational costs wallet
    /// @param _feeBps        Fee in basis points (e.g. 500 = 5%)
    /// @param _identityReg   ERC-8004 Identity Registry address (address(0) to disable)
    constructor(
        address _admin,
        address _arbitrator,
        address _treasury,
        address _opsWallet,
        uint16 _feeBps,
        address _identityReg
    ) Ownable(_admin) {
        if (_arbitrator == address(0)) revert ZeroAddress();
        if (_treasury == address(0)) revert ZeroAddress();
        if (_opsWallet == address(0)) revert ZeroAddress();
        if (_feeBps > MAX_FEE_BPS) revert InvalidFeeBps();

        arbitrator = _arbitrator;
        treasury = _treasury;
        opsWallet = _opsWallet;
        feeBps = _feeBps;

        if (_identityReg != address(0)) {
            identityRegistry = IIdentityRegistry(_identityReg);
            requireRegistration = true;
        }
    }

    // ========================================================================
    // Admin
    // ========================================================================

    function updateConfig(
        address _arbitrator,
        address _treasury,
        address _opsWallet,
        uint16 _feeBps
    ) external onlyOwner {
        if (_arbitrator == address(0)) revert ZeroAddress();
        if (_treasury == address(0)) revert ZeroAddress();
        if (_opsWallet == address(0)) revert ZeroAddress();
        if (_feeBps > MAX_FEE_BPS) revert InvalidFeeBps();

        arbitrator = _arbitrator;
        treasury = _treasury;
        opsWallet = _opsWallet;
        feeBps = _feeBps;

        emit ConfigUpdated(_arbitrator, _treasury, _opsWallet, _feeBps);
    }

    function setIdentityRegistry(address _identityReg, bool _require) external onlyOwner {
        if (_identityReg != address(0)) {
            identityRegistry = IIdentityRegistry(_identityReg);
        }
        requireRegistration = _require;
        emit IdentityRegistryUpdated(_identityReg, _require);
    }

    // ========================================================================
    // ERC-8004 Integration
    // ========================================================================

    function _validateRegistered(address account) internal view returns (uint256 agentId) {
        if (!requireRegistration) return 0;
        agentId = identityRegistry.getAgentIdByOwner(account);
        if (agentId == 0) revert AgentNotRegistered();
    }

    // ========================================================================
    // Job Lifecycle
    // ========================================================================

    function createJob(
        bytes32 jobId,
        address token,
        uint256 amount,
        uint8 deadlineDays,
        string calldata description
    ) external nonReentrant {
        if (jobExists[jobId]) revert JobIdAlreadyExists();
        if (amount == 0) revert InvalidAmount();
        if (deadlineDays == 0) revert InvalidAmount();
        if (bytes(description).length > 200) revert DescriptionTooLong();

        uint256 requesterAgentId = _validateRegistered(msg.sender);
        uint256 deadline = block.timestamp + (uint256(deadlineDays) * 1 days);

        jobs[jobId] = Job({
            requester: msg.sender,
            rating: 0,
            status: JobStatus.Open,
            disputed: false,
            agent: address(0),
            token: token,
            verifier: address(0),
            amount: amount,
            deadline: deadline,
            createdAt: block.timestamp,
            requesterAgentId: requesterAgentId,
            agentAgentId: 0,
            description: description,
            deliverable: ""
        });
        jobExists[jobId] = true;

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        emit JobCreated(jobId, msg.sender, token, amount, deadline, requesterAgentId);
    }

    function acceptJob(bytes32 jobId) external jobMustExist(jobId) {
        Job storage job = jobs[jobId];
        if (job.status != JobStatus.Open) revert InvalidStatus(JobStatus.Open, job.status);

        uint256 agentAgentId = _validateRegistered(msg.sender);

        job.agent = msg.sender;
        job.agentAgentId = agentAgentId;
        job.status = JobStatus.InProgress;

        emit JobAccepted(jobId, msg.sender, agentAgentId);
    }

    function submitDeliverable(
        bytes32 jobId,
        string calldata deliverable
    ) external jobMustExist(jobId) onlyAgent(jobId) {
        Job storage job = jobs[jobId];
        if (job.status != JobStatus.InProgress) revert InvalidStatus(JobStatus.InProgress, job.status);
        if (block.timestamp > job.deadline) revert DeadlineExpired();
        if (bytes(deliverable).length > 500) revert DeliverableTooLong();

        job.deliverable = deliverable;
        job.status = JobStatus.UnderReview;

        emit DeliverableSubmitted(jobId, msg.sender, deliverable);
    }

    /// @notice Requester sets a verifier before approving (optional).
    function setVerifier(bytes32 jobId, address _verifier) external jobMustExist(jobId) onlyRequester(jobId) {
        Job storage job = jobs[jobId];
        // Can set verifier while InProgress or UnderReview
        if (job.status != JobStatus.InProgress && job.status != JobStatus.UnderReview) {
            revert InvalidStatus(JobStatus.InProgress, job.status);
        }
        job.verifier = _verifier;
        emit VerifierSet(jobId, _verifier);
    }

    /// @notice Requester approves work and releases payment with fee split.
    function approveAndPay(
        bytes32 jobId,
        uint8 rating
    ) external nonReentrant jobMustExist(jobId) onlyRequester(jobId) {
        Job storage job = jobs[jobId];
        if (job.status != JobStatus.UnderReview) revert InvalidStatus(JobStatus.UnderReview, job.status);
        if (rating < 1 || rating > 5) revert InvalidRating();

        job.status = JobStatus.Completed;
        job.rating = rating;

        // Cache storage reads to avoid stack-too-deep
        address agent = job.agent;
        address tokenAddr = job.token;
        address jobVerifier = job.verifier;
        uint256 amount = job.amount;

        _distributeFees(jobId, agent, tokenAddr, jobVerifier, amount, rating);
    }

    function _distributeFees(
        bytes32 jobId,
        address agent,
        address tokenAddr,
        address jobVerifier,
        uint256 amount,
        uint8 rating
    ) private {
        IERC20 token = IERC20(tokenAddr);

        // Calculate fee split (mirrors Solana exactly)
        uint256 totalFee = (amount * feeBps) / 10000;
        uint256 treasuryShare = (totalFee * TREASURY_SHARE_PCT) / 100;
        uint256 opsShare = (totalFee * OPS_SHARE_PCT) / 100;
        uint256 verifierShare = totalFee - treasuryShare - opsShare; // remainder avoids rounding dust

        uint256 workerAmount;
        if (jobVerifier != address(0)) {
            workerAmount = amount - totalFee;
            token.safeTransfer(jobVerifier, verifierShare);
        } else {
            // No verifier: bonus goes to worker (96% total)
            workerAmount = amount - totalFee + verifierShare;
            verifierShare = 0;
        }

        token.safeTransfer(treasury, treasuryShare);
        token.safeTransfer(opsWallet, opsShare);
        token.safeTransfer(agent, workerAmount);

        emit JobApproved(jobId, agent, workerAmount, treasuryShare, opsShare, verifierShare, rating);
    }

    function rejectWork(
        bytes32 jobId,
        string calldata reason
    ) external jobMustExist(jobId) onlyRequester(jobId) {
        Job storage job = jobs[jobId];
        if (job.status != JobStatus.UnderReview) revert InvalidStatus(JobStatus.UnderReview, job.status);

        job.status = JobStatus.Disputed;
        job.disputed = true;

        emit JobRejected(jobId, reason);
    }

    function cancelJob(bytes32 jobId) external nonReentrant jobMustExist(jobId) onlyRequester(jobId) {
        Job storage job = jobs[jobId];

        bool isOpen = job.status == JobStatus.Open;
        bool isExpired = job.status == JobStatus.InProgress && block.timestamp > job.deadline;

        if (!isOpen && !isExpired) revert CannotCancel();

        job.status = JobStatus.Cancelled;

        IERC20(job.token).safeTransfer(job.requester, job.amount);

        emit JobCancelled(jobId, job.amount);
    }

    /// @notice Arbitrator resolves a dispute by splitting funds. Fee is still taken.
    /// @param agentPercentage 0-100, percentage of post-fee amount going to agent
    function resolveDispute(
        bytes32 jobId,
        uint8 agentPercentage
    ) external nonReentrant jobMustExist(jobId) onlyArbitrator {
        Job storage job = jobs[jobId];
        if (job.status != JobStatus.Disputed) revert InvalidStatus(JobStatus.Disputed, job.status);
        if (agentPercentage > 100) revert InvalidPercentage();

        job.status = JobStatus.Resolved;
        job.disputed = false;

        // Cache storage reads
        address agent = job.agent;
        address requester = job.requester;
        address tokenAddr = job.token;
        uint256 amount = job.amount;

        _distributeDispute(jobId, agent, requester, tokenAddr, amount, agentPercentage);
    }

    function _distributeDispute(
        bytes32 jobId,
        address agent,
        address requester,
        address tokenAddr,
        uint256 amount,
        uint8 agentPercentage
    ) private {
        IERC20 token = IERC20(tokenAddr);

        // Fee still taken on disputes (treasury 50%, ops 50%, no verifier share)
        uint256 totalFee = (amount * feeBps) / 10000;
        uint256 treasuryShare = totalFee / 2;
        uint256 opsShare = totalFee - treasuryShare; // remainder avoids rounding dust

        uint256 remaining = amount - totalFee;
        uint256 agentAmount = (remaining * agentPercentage) / 100;
        uint256 requesterAmount = remaining - agentAmount;

        token.safeTransfer(treasury, treasuryShare);
        token.safeTransfer(opsWallet, opsShare);

        if (agentAmount > 0) {
            token.safeTransfer(agent, agentAmount);
        }
        if (requesterAmount > 0) {
            token.safeTransfer(requester, requesterAmount);
        }

        emit DisputeResolved(jobId, agentAmount, requesterAmount, treasuryShare, opsShare, agentPercentage);
    }

    // ========================================================================
    // Views
    // ========================================================================

    function getJob(bytes32 jobId) external view returns (
        address requester,
        address agent,
        address token,
        address verifier,
        uint256 amount,
        uint256 deadline,
        uint256 createdAt,
        JobStatus status,
        uint8 rating,
        bool disputed,
        uint256 requesterAgentId,
        uint256 agentAgentId,
        string memory description,
        string memory deliverable
    ) {
        Job storage job = jobs[jobId];
        return (
            job.requester,
            job.agent,
            job.token,
            job.verifier,
            job.amount,
            job.deadline,
            job.createdAt,
            job.status,
            job.rating,
            job.disputed,
            job.requesterAgentId,
            job.agentAgentId,
            job.description,
            job.deliverable
        );
    }

    function getJobStatus(bytes32 jobId) external view returns (bool exists, JobStatus status) {
        return (jobExists[jobId], jobs[jobId].status);
    }

    /// @notice Calculate the fee breakdown for a given amount.
    function calculateFees(uint256 amount, bool hasVerifier) external view returns (
        uint256 totalFee,
        uint256 workerAmount,
        uint256 treasuryAmount,
        uint256 opsAmount,
        uint256 verifierAmount
    ) {
        totalFee = (amount * feeBps) / 10000;
        treasuryAmount = (totalFee * TREASURY_SHARE_PCT) / 100;
        opsAmount = (totalFee * OPS_SHARE_PCT) / 100;
        verifierAmount = totalFee - treasuryAmount - opsAmount;

        if (hasVerifier) {
            workerAmount = amount - totalFee;
        } else {
            workerAmount = amount - totalFee + verifierAmount;
            verifierAmount = 0;
        }
    }
}
