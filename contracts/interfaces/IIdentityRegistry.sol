// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IIdentityRegistry
 * @notice ERC-8004 Identity Registry interface for autonomous agent registration.
 *         Each agent identity is represented as an ERC-721 NFT with extensible metadata.
 */
interface IIdentityRegistry {
    // ========================================================================
    // Events
    // ========================================================================

    event AgentRegistered(uint256 indexed agentId, address indexed owner, string uri);
    event AgentURIUpdated(uint256 indexed agentId, string uri);
    event MetadataUpdated(uint256 indexed agentId, string key);
    event AgentWalletSet(uint256 indexed agentId, address indexed wallet);
    event AgentWalletUnset(uint256 indexed agentId, address indexed wallet);

    // ========================================================================
    // Registration
    // ========================================================================

    /// @notice Register a new agent identity. Mints an ERC-721 NFT to msg.sender.
    /// @param uri Token URI (metadata JSON)
    /// @return agentId The newly minted agent token ID
    function register(string calldata uri) external returns (uint256 agentId);

    /// @notice Register with initial metadata key-value pairs.
    function register(
        string calldata uri,
        string[] calldata keys,
        bytes[] calldata values
    ) external returns (uint256 agentId);

    /// @notice Register on behalf of another address (caller pays gas).
    function registerFor(
        address owner,
        string calldata uri
    ) external returns (uint256 agentId);

    // ========================================================================
    // Metadata
    // ========================================================================

    /// @notice Update the token URI for an agent.
    function setAgentURI(uint256 agentId, string calldata uri) external;

    /// @notice Set a metadata key-value pair for an agent.
    function setMetadata(uint256 agentId, string calldata key, bytes calldata value) external;

    /// @notice Get a metadata value for an agent.
    function getMetadata(uint256 agentId, string calldata key) external view returns (bytes memory);

    // ========================================================================
    // Wallet Delegation (EIP-712)
    // ========================================================================

    /// @notice Link a delegated wallet to an agent via EIP-712 signature.
    /// @param agentId The agent token ID
    /// @param wallet The wallet address to delegate
    /// @param deadline Signature expiry timestamp
    /// @param v ECDSA v
    /// @param r ECDSA r
    /// @param s ECDSA s
    function setAgentWallet(
        uint256 agentId,
        address wallet,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    /// @notice Get the delegated wallet for an agent.
    function getAgentWallet(uint256 agentId) external view returns (address);

    /// @notice Remove the delegated wallet for an agent.
    function unsetAgentWallet(uint256 agentId) external;

    // ========================================================================
    // Queries (for escrow integration)
    // ========================================================================

    /// @notice Check if an agent ID is registered (token exists).
    function isRegistered(uint256 agentId) external view returns (bool);

    /// @notice Get the agent ID owned by an address. Returns 0 if unregistered.
    function getAgentIdByOwner(address owner) external view returns (uint256);
}
