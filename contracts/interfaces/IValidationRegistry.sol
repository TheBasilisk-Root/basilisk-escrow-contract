// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IValidationRegistry
 * @notice ERC-8004 Validation Registry interface for on-chain agent validation.
 *         Validators submit requests and responses linked to Identity Registry agent IDs.
 */
interface IValidationRegistry {
    // ========================================================================
    // Types
    // ========================================================================

    enum ValidationStatus {
        Pending,    // 0 — Request submitted, awaiting response
        Completed,  // 1 — Validator responded
        Expired     // 2 — No response within deadline
    }

    struct ValidationRecord {
        uint256 agentId;
        address requester;
        address validator;
        uint8 score;          // 0-100
        uint64 requestedAt;
        uint64 respondedAt;
        uint64 deadline;
        ValidationStatus status;
        string context;
        string response;
    }

    struct ValidationSummary {
        uint256 totalValidations;
        uint256 completedValidations;
        uint256 cumulativeScore;
    }

    // ========================================================================
    // Events
    // ========================================================================

    event ValidationRequested(
        bytes32 indexed requestHash,
        uint256 indexed agentId,
        address indexed validator,
        uint64 deadline
    );
    event ValidationCompleted(
        bytes32 indexed requestHash,
        uint256 indexed agentId,
        uint8 score
    );

    // ========================================================================
    // Functions
    // ========================================================================

    /// @notice Submit a validation request for an agent.
    function validationRequest(
        uint256 agentId,
        address validator,
        uint64 deadline,
        string calldata context
    ) external returns (bytes32 requestHash);

    /// @notice Validator submits a response (score 0-100).
    function validationResponse(
        bytes32 requestHash,
        uint8 score,
        string calldata response
    ) external;

    /// @notice Get validation record by request hash.
    function getValidationStatus(bytes32 requestHash) external view returns (ValidationRecord memory);

    /// @notice Get validation summary for an agent.
    function getSummary(uint256 agentId) external view returns (ValidationSummary memory);

    /// @notice Get all validation request hashes for an agent.
    function getAgentValidations(uint256 agentId) external view returns (bytes32[] memory);

    /// @notice Get all validation request hashes assigned to a validator.
    function getValidatorRequests(address validator) external view returns (bytes32[] memory);
}
