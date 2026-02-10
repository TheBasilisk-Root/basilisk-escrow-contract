// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../interfaces/IValidationRegistry.sol";
import "../interfaces/IIdentityRegistry.sol";

/**
 * @title ValidationRegistry
 * @notice ERC-8004 Validation Registry — on-chain validation request/response
 *         system linked to Identity Registry agent IDs.
 */
contract ValidationRegistry is IValidationRegistry {
    // ========================================================================
    // State
    // ========================================================================

    IIdentityRegistry public immutable identityRegistry;

    /// @notice requestHash => ValidationRecord
    mapping(bytes32 => ValidationRecord) private _validations;

    /// @notice agentId => request hashes
    mapping(uint256 => bytes32[]) private _agentValidations;

    /// @notice validator address => request hashes
    mapping(address => bytes32[]) private _validatorRequests;

    /// @notice Nonce for unique request hash generation
    uint256 private _requestNonce;

    // ========================================================================
    // Errors
    // ========================================================================

    error AgentNotRegistered();
    error NotDesignatedValidator();
    error RequestNotFound();
    error AlreadyCompleted();
    error DeadlineExpired();
    error InvalidScore();
    error InvalidDeadline();
    error ZeroAddress();

    // ========================================================================
    // Constructor
    // ========================================================================

    constructor(address _identityRegistry) {
        identityRegistry = IIdentityRegistry(_identityRegistry);
    }

    // ========================================================================
    // Functions
    // ========================================================================

    function validationRequest(
        uint256 agentId,
        address validator,
        uint64 deadline,
        string calldata context
    ) external returns (bytes32 requestHash) {
        if (!identityRegistry.isRegistered(agentId)) revert AgentNotRegistered();
        if (validator == address(0)) revert ZeroAddress();
        if (deadline <= block.timestamp) revert InvalidDeadline();

        requestHash = keccak256(
            abi.encodePacked(agentId, msg.sender, validator, _requestNonce++, block.timestamp)
        );

        _validations[requestHash] = ValidationRecord({
            agentId: agentId,
            requester: msg.sender,
            validator: validator,
            score: 0,
            requestedAt: uint64(block.timestamp),
            respondedAt: 0,
            deadline: deadline,
            status: ValidationStatus.Pending,
            context: context,
            response: ""
        });

        _agentValidations[agentId].push(requestHash);
        _validatorRequests[validator].push(requestHash);

        emit ValidationRequested(requestHash, agentId, validator, deadline);
    }

    function validationResponse(
        bytes32 requestHash,
        uint8 score,
        string calldata response
    ) external {
        ValidationRecord storage record = _validations[requestHash];
        if (record.requestedAt == 0) revert RequestNotFound();
        if (msg.sender != record.validator) revert NotDesignatedValidator();
        if (record.status != ValidationStatus.Pending) revert AlreadyCompleted();
        if (block.timestamp > record.deadline) revert DeadlineExpired();
        if (score > 100) revert InvalidScore();

        record.score = score;
        record.respondedAt = uint64(block.timestamp);
        record.status = ValidationStatus.Completed;
        record.response = response;

        emit ValidationCompleted(requestHash, record.agentId, score);
    }

    // ========================================================================
    // Views
    // ========================================================================

    function getValidationStatus(bytes32 requestHash) external view returns (ValidationRecord memory) {
        return _validations[requestHash];
    }

    function getSummary(uint256 agentId) external view returns (ValidationSummary memory) {
        bytes32[] storage hashes = _agentValidations[agentId];
        uint256 total = hashes.length;
        uint256 completed = 0;
        uint256 cumScore = 0;

        for (uint256 i = 0; i < total; i++) {
            ValidationRecord storage record = _validations[hashes[i]];
            if (record.status == ValidationStatus.Completed) {
                completed++;
                cumScore += record.score;
            }
        }

        return ValidationSummary({
            totalValidations: total,
            completedValidations: completed,
            cumulativeScore: cumScore
        });
    }

    function getAgentValidations(uint256 agentId) external view returns (bytes32[] memory) {
        return _agentValidations[agentId];
    }

    function getValidatorRequests(address validator) external view returns (bytes32[] memory) {
        return _validatorRequests[validator];
    }
}
