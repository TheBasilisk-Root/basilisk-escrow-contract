// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title BasiliskEscrow
 * @notice Trustless escrow for agent-to-agent job coordination on EVM chains.
 *         Mirrors the Solana/Anchor escrow program with identical lifecycle:
 *         Open → InProgress → UnderReview → Completed/Disputed → Resolved
 *
 * @dev Supports any ERC-20 token. Each job locks funds in the contract until
 *      the requester approves delivery or an arbitrator resolves a dispute.
 *
 *      Designed for deployment on Base and other EVM-compatible chains.
 */
contract BasiliskEscrow is ReentrancyGuard {
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
        address requester;
        address agent;
        address token;
        uint256 amount;
        uint256 deadline;
        uint256 createdAt;
        JobStatus status;
        uint8 rating;
        bool disputed;
        string description;
        string deliverable;
    }

    // ========================================================================
    // State
    // ========================================================================

    address public admin;
    address public arbitrator;

    /// @notice jobId => Job struct
    mapping(bytes32 => Job) public jobs;

    /// @notice Track whether a jobId has been used
    mapping(bytes32 => bool) public jobExists;

    // ========================================================================
    // Events
    // ========================================================================

    event JobCreated(bytes32 indexed jobId, address indexed requester, address token, uint256 amount, uint256 deadline);
    event JobAccepted(bytes32 indexed jobId, address indexed agent);
    event DeliverableSubmitted(bytes32 indexed jobId, address indexed agent, string deliverable);
    event JobApproved(bytes32 indexed jobId, address indexed agent, uint256 amount, uint8 rating);
    event JobRejected(bytes32 indexed jobId, string reason);
    event JobCancelled(bytes32 indexed jobId, uint256 refundAmount);
    event DisputeResolved(bytes32 indexed jobId, uint256 agentAmount, uint256 requesterAmount, uint8 agentPercentage);
    event ConfigUpdated(address admin, address arbitrator);

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
    error DeadlineExpired();
    error CannotCancel();
    error DescriptionTooLong();
    error DeliverableTooLong();

    // ========================================================================
    // Modifiers
    // ========================================================================

    modifier onlyAdmin() {
        if (msg.sender != admin) revert Unauthorized();
        _;
    }

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

    constructor(address _admin, address _arbitrator) {
        admin = _admin;
        arbitrator = _arbitrator;
    }

    // ========================================================================
    // Admin
    // ========================================================================

    /// @notice Update admin and/or arbitrator addresses.
    function updateConfig(address _admin, address _arbitrator) external onlyAdmin {
        admin = _admin;
        arbitrator = _arbitrator;
        emit ConfigUpdated(_admin, _arbitrator);
    }

    // ========================================================================
    // Job Lifecycle
    // ========================================================================

    /// @notice Create a job and escrow ERC-20 tokens.
    /// @param jobId        Unique job identifier (keccak256 of off-chain UUID)
    /// @param token        ERC-20 token address for payment
    /// @param amount       Amount to escrow (in token base units)
    /// @param deadlineDays Number of days until deadline (min 1, max 255)
    /// @param description  Short description (max 200 chars)
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

        uint256 deadline = block.timestamp + (uint256(deadlineDays) * 1 days);

        jobs[jobId] = Job({
            requester: msg.sender,
            agent: address(0),
            token: token,
            amount: amount,
            deadline: deadline,
            createdAt: block.timestamp,
            status: JobStatus.Open,
            rating: 0,
            disputed: false,
            description: description,
            deliverable: ""
        });
        jobExists[jobId] = true;

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        emit JobCreated(jobId, msg.sender, token, amount, deadline);
    }

    /// @notice Agent accepts an open job.
    function acceptJob(bytes32 jobId) external jobMustExist(jobId) {
        Job storage job = jobs[jobId];
        if (job.status != JobStatus.Open) revert InvalidStatus(JobStatus.Open, job.status);

        job.agent = msg.sender;
        job.status = JobStatus.InProgress;

        emit JobAccepted(jobId, msg.sender);
    }

    /// @notice Agent submits deliverable for review. Must be before deadline.
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

    /// @notice Requester approves work and releases payment to agent.
    function approveAndPay(
        bytes32 jobId,
        uint8 rating
    ) external nonReentrant jobMustExist(jobId) onlyRequester(jobId) {
        Job storage job = jobs[jobId];
        if (job.status != JobStatus.UnderReview) revert InvalidStatus(JobStatus.UnderReview, job.status);
        if (rating < 1 || rating > 5) revert InvalidRating();

        job.status = JobStatus.Completed;
        job.rating = rating;

        IERC20(job.token).safeTransfer(job.agent, job.amount);

        emit JobApproved(jobId, job.agent, job.amount, rating);
    }

    /// @notice Requester rejects work and opens a dispute.
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

    /// @notice Cancel an open job OR an expired in-progress job. Refunds requester.
    function cancelJob(bytes32 jobId) external nonReentrant jobMustExist(jobId) onlyRequester(jobId) {
        Job storage job = jobs[jobId];

        bool isOpen = job.status == JobStatus.Open;
        bool isExpired = job.status == JobStatus.InProgress && block.timestamp > job.deadline;

        if (!isOpen && !isExpired) revert CannotCancel();

        job.status = JobStatus.Cancelled;

        IERC20(job.token).safeTransfer(job.requester, job.amount);

        emit JobCancelled(jobId, job.amount);
    }

    /// @notice Arbitrator resolves a dispute by splitting funds.
    /// @param agentPercentage 0-100, percentage of escrowed funds going to agent
    function resolveDispute(
        bytes32 jobId,
        uint8 agentPercentage
    ) external nonReentrant jobMustExist(jobId) onlyArbitrator {
        Job storage job = jobs[jobId];
        if (job.status != JobStatus.Disputed) revert InvalidStatus(JobStatus.Disputed, job.status);
        if (agentPercentage > 100) revert InvalidPercentage();

        uint256 agentAmount = (job.amount * agentPercentage) / 100;
        uint256 requesterAmount = job.amount - agentAmount;

        job.status = JobStatus.Resolved;
        job.disputed = false;

        if (agentAmount > 0) {
            IERC20(job.token).safeTransfer(job.agent, agentAmount);
        }
        if (requesterAmount > 0) {
            IERC20(job.token).safeTransfer(job.requester, requesterAmount);
        }

        emit DisputeResolved(jobId, agentAmount, requesterAmount, agentPercentage);
    }

    // ========================================================================
    // Views
    // ========================================================================

    /// @notice Get full job details.
    function getJob(bytes32 jobId) external view returns (
        address requester,
        address agent,
        address token,
        uint256 amount,
        uint256 deadline,
        uint256 createdAt,
        JobStatus status,
        uint8 rating,
        bool disputed,
        string memory description,
        string memory deliverable
    ) {
        Job storage job = jobs[jobId];
        return (
            job.requester,
            job.agent,
            job.token,
            job.amount,
            job.deadline,
            job.createdAt,
            job.status,
            job.rating,
            job.disputed,
            job.description,
            job.deliverable
        );
    }

    /// @notice Check if a job exists and return its status.
    function getJobStatus(bytes32 jobId) external view returns (bool exists, JobStatus status) {
        return (jobExists[jobId], jobs[jobId].status);
    }
}
