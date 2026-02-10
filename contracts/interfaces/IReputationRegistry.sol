// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IReputationRegistry
 * @notice ERC-8004 Reputation Registry interface for on-chain agent feedback.
 *         Feedback is linked to Identity Registry agent IDs.
 */
interface IReputationRegistry {
    // ========================================================================
    // Types
    // ========================================================================

    struct Feedback {
        address client;
        int128 value;
        uint8 valueDecimals;
        uint64 timestamp;
        string tag;
        string comment;
    }

    struct FeedbackResponse {
        address responder;
        uint64 timestamp;
        string comment;
    }

    struct ReputationSummary {
        uint256 totalFeedback;
        int256 cumulativeValue;
        uint256 uniqueClients;
    }

    // ========================================================================
    // Events
    // ========================================================================

    event FeedbackGiven(
        uint256 indexed agentId,
        address indexed client,
        uint64 index,
        int128 value,
        string tag
    );
    event FeedbackRevoked(uint256 indexed agentId, address indexed client, uint64 index);
    event ResponseAppended(uint256 indexed agentId, address indexed client, uint64 feedbackIndex);

    // ========================================================================
    // Functions
    // ========================================================================

    /// @notice Give feedback to a registered agent.
    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag,
        string calldata comment
    ) external returns (uint64 index);

    /// @notice Revoke previously given feedback.
    function revokeFeedback(uint256 agentId, uint64 index) external;

    /// @notice Agent owner appends a response to feedback.
    function appendResponse(
        uint256 agentId,
        address client,
        uint64 feedbackIndex,
        string calldata comment
    ) external;

    /// @notice Get reputation summary for an agent.
    function getSummary(uint256 agentId) external view returns (ReputationSummary memory);

    /// @notice Read a specific feedback entry.
    function readFeedback(
        uint256 agentId,
        address client,
        uint64 index
    ) external view returns (Feedback memory);

    /// @notice Read all feedback from a specific client to an agent.
    function readAllFeedback(
        uint256 agentId,
        address client
    ) external view returns (Feedback[] memory);

    /// @notice Get all unique client addresses who gave feedback.
    function getClients(uint256 agentId) external view returns (address[] memory);

    /// @notice Get the last feedback index for a client-agent pair.
    function getLastIndex(uint256 agentId, address client) external view returns (uint64);
}
