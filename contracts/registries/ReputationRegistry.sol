// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../interfaces/IReputationRegistry.sol";
import "../interfaces/IIdentityRegistry.sol";

/**
 * @title ReputationRegistry
 * @notice ERC-8004 Reputation Registry — on-chain feedback system linked to
 *         Identity Registry agent IDs. Supports signed feedback values,
 *         per-tag filtering, and agent responses.
 */
contract ReputationRegistry is IReputationRegistry {
    // ========================================================================
    // State
    // ========================================================================

    IIdentityRegistry public immutable identityRegistry;

    /// @notice agentId => client => feedbackIndex => Feedback
    mapping(uint256 => mapping(address => mapping(uint64 => Feedback))) private _feedback;

    /// @notice agentId => client => feedbackIndex => FeedbackResponse
    mapping(uint256 => mapping(address => mapping(uint64 => FeedbackResponse))) private _responses;

    /// @notice agentId => unique client addresses
    mapping(uint256 => address[]) private _clients;

    /// @notice agentId => client => bool (for dedup in _clients array)
    mapping(uint256 => mapping(address => bool)) private _isClient;

    /// @notice agentId => client => next feedback index
    mapping(uint256 => mapping(address => uint64)) private _lastIndex;

    /// @notice agentId => cumulative value (for summary)
    mapping(uint256 => int256) private _cumulativeValue;

    /// @notice agentId => total feedback count
    mapping(uint256 => uint256) private _totalFeedback;

    // ========================================================================
    // Errors
    // ========================================================================

    error AgentNotRegistered();
    error FeedbackNotFound();
    error NotFeedbackGiver();
    error NotAgentOwner();
    error InvalidDecimals();
    error AlreadyRevoked();

    // ========================================================================
    // Constructor
    // ========================================================================

    constructor(address _identityRegistry) {
        identityRegistry = IIdentityRegistry(_identityRegistry);
    }

    // ========================================================================
    // Feedback
    // ========================================================================

    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag,
        string calldata comment
    ) external returns (uint64 index) {
        if (!identityRegistry.isRegistered(agentId)) revert AgentNotRegistered();
        if (valueDecimals > 18) revert InvalidDecimals();

        index = _lastIndex[agentId][msg.sender];
        _lastIndex[agentId][msg.sender] = index + 1;

        _feedback[agentId][msg.sender][index] = Feedback({
            client: msg.sender,
            value: value,
            valueDecimals: valueDecimals,
            timestamp: uint64(block.timestamp),
            tag: tag,
            comment: comment
        });

        // Track unique clients
        if (!_isClient[agentId][msg.sender]) {
            _clients[agentId].push(msg.sender);
            _isClient[agentId][msg.sender] = true;
        }

        _cumulativeValue[agentId] += int256(value);
        _totalFeedback[agentId]++;

        emit FeedbackGiven(agentId, msg.sender, index, value, tag);
    }

    function revokeFeedback(uint256 agentId, uint64 index) external {
        Feedback storage fb = _feedback[agentId][msg.sender][index];
        if (fb.timestamp == 0) revert AlreadyRevoked();
        if (fb.client != msg.sender) revert NotFeedbackGiver();

        // Reverse the cumulative value
        _cumulativeValue[agentId] -= int256(fb.value);
        _totalFeedback[agentId]--;

        // Zero out the feedback (keep slot, mark as revoked via timestamp=0)
        delete _feedback[agentId][msg.sender][index];

        emit FeedbackRevoked(agentId, msg.sender, index);
    }

    function appendResponse(
        uint256 agentId,
        address client,
        uint64 feedbackIndex,
        string calldata comment
    ) external {
        // Only the agent owner can respond
        if (identityRegistry.getAgentIdByOwner(msg.sender) != agentId) revert NotAgentOwner();

        Feedback storage fb = _feedback[agentId][client][feedbackIndex];
        if (fb.timestamp == 0) revert FeedbackNotFound();

        _responses[agentId][client][feedbackIndex] = FeedbackResponse({
            responder: msg.sender,
            timestamp: uint64(block.timestamp),
            comment: comment
        });

        emit ResponseAppended(agentId, client, feedbackIndex);
    }

    // ========================================================================
    // Views
    // ========================================================================

    function getSummary(uint256 agentId) external view returns (ReputationSummary memory) {
        return ReputationSummary({
            totalFeedback: _totalFeedback[agentId],
            cumulativeValue: _cumulativeValue[agentId],
            uniqueClients: _clients[agentId].length
        });
    }

    function readFeedback(
        uint256 agentId,
        address client,
        uint64 index
    ) external view returns (Feedback memory) {
        return _feedback[agentId][client][index];
    }

    function readAllFeedback(
        uint256 agentId,
        address client
    ) external view returns (Feedback[] memory) {
        uint64 count = _lastIndex[agentId][client];
        Feedback[] memory result = new Feedback[](count);
        for (uint64 i = 0; i < count; i++) {
            result[i] = _feedback[agentId][client][i];
        }
        return result;
    }

    function getClients(uint256 agentId) external view returns (address[] memory) {
        return _clients[agentId];
    }

    function getLastIndex(uint256 agentId, address client) external view returns (uint64) {
        return _lastIndex[agentId][client];
    }

    function getResponse(
        uint256 agentId,
        address client,
        uint64 feedbackIndex
    ) external view returns (FeedbackResponse memory) {
        return _responses[agentId][client][feedbackIndex];
    }
}
