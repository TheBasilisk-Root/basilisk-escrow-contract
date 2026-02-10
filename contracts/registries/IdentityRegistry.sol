// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/interfaces/IERC1271.sol";
import "../interfaces/IIdentityRegistry.sol";

/**
 * @title IdentityRegistry
 * @notice ERC-8004 Identity Registry — each agent is an ERC-721 NFT with
 *         extensible metadata and EIP-712 wallet delegation.
 */
contract IdentityRegistry is IIdentityRegistry, ERC721URIStorage, EIP712 {
    using ECDSA for bytes32;

    // ========================================================================
    // Constants
    // ========================================================================

    bytes32 public constant SET_WALLET_TYPEHASH =
        keccak256("SetAgentWallet(uint256 agentId,address wallet,uint256 nonce,uint256 deadline)");

    // ERC-1271 magic value
    bytes4 private constant _ERC1271_MAGIC = 0x1626ba7e;

    // ========================================================================
    // State
    // ========================================================================

    uint256 private _nextTokenId;

    /// @notice agentId => key => value
    mapping(uint256 => mapping(string => bytes)) private _metadata;

    /// @notice agentId => delegated wallet address
    mapping(uint256 => address) private _agentWallets;

    /// @notice owner address => agentId (reverse lookup for escrow)
    mapping(address => uint256) private _ownerToAgentId;

    /// @notice owner address => nonce (for EIP-712 replay protection)
    mapping(address => uint256) public nonces;

    // ========================================================================
    // Errors
    // ========================================================================

    error NotAgentOwner();
    error AlreadyRegistered();
    error ArrayLengthMismatch();
    error SignatureExpired();
    error InvalidSignature();
    error WalletAlreadyDelegated();
    error NoWalletSet();

    // ========================================================================
    // Constructor
    // ========================================================================

    constructor()
        ERC721("Basilisk Agent Identity", "BAGENT")
        EIP712("BasiliskIdentity", "1")
    {
        _nextTokenId = 1; // 0 = unregistered sentinel
    }

    // ========================================================================
    // Modifiers
    // ========================================================================

    modifier onlyAgentOwner(uint256 agentId) {
        if (ownerOf(agentId) != msg.sender) revert NotAgentOwner();
        _;
    }

    // ========================================================================
    // Registration
    // ========================================================================

    function register(string calldata uri) external returns (uint256 agentId) {
        return _register(msg.sender, uri);
    }

    function register(
        string calldata uri,
        string[] calldata keys,
        bytes[] calldata values
    ) external returns (uint256 agentId) {
        if (keys.length != values.length) revert ArrayLengthMismatch();
        agentId = _register(msg.sender, uri);
        for (uint256 i = 0; i < keys.length; i++) {
            _metadata[agentId][keys[i]] = values[i];
            emit MetadataUpdated(agentId, keys[i]);
        }
    }

    function registerFor(
        address owner,
        string calldata uri
    ) external returns (uint256 agentId) {
        return _register(owner, uri);
    }

    function _register(address owner, string calldata uri) internal returns (uint256 agentId) {
        if (_ownerToAgentId[owner] != 0) revert AlreadyRegistered();

        agentId = _nextTokenId++;
        _mint(owner, agentId);
        _setTokenURI(agentId, uri);
        _ownerToAgentId[owner] = agentId;

        emit AgentRegistered(agentId, owner, uri);
    }

    // ========================================================================
    // Metadata
    // ========================================================================

    function setAgentURI(uint256 agentId, string calldata uri) external onlyAgentOwner(agentId) {
        _setTokenURI(agentId, uri);
        emit AgentURIUpdated(agentId, uri);
    }

    function setMetadata(
        uint256 agentId,
        string calldata key,
        bytes calldata value
    ) external onlyAgentOwner(agentId) {
        _metadata[agentId][key] = value;
        emit MetadataUpdated(agentId, key);
    }

    function getMetadata(uint256 agentId, string calldata key) external view returns (bytes memory) {
        return _metadata[agentId][key];
    }

    // ========================================================================
    // Wallet Delegation (EIP-712)
    // ========================================================================

    function setAgentWallet(
        uint256 agentId,
        address wallet,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external onlyAgentOwner(agentId) {
        if (block.timestamp > deadline) revert SignatureExpired();

        bytes32 structHash = keccak256(
            abi.encode(SET_WALLET_TYPEHASH, agentId, wallet, nonces[wallet]++, deadline)
        );
        bytes32 digest = _hashTypedDataV4(structHash);

        // Try ECDSA first
        address recovered = ECDSA.recover(digest, v, r, s);
        if (recovered != wallet) {
            // Try ERC-1271 (smart contract wallets)
            bytes memory sig = abi.encodePacked(r, s, v);
            if (wallet.code.length == 0) revert InvalidSignature();
            try IERC1271(wallet).isValidSignature(digest, sig) returns (bytes4 magic) {
                if (magic != _ERC1271_MAGIC) revert InvalidSignature();
            } catch {
                revert InvalidSignature();
            }
        }

        _agentWallets[agentId] = wallet;
        emit AgentWalletSet(agentId, wallet);
    }

    function getAgentWallet(uint256 agentId) external view returns (address) {
        return _agentWallets[agentId];
    }

    function unsetAgentWallet(uint256 agentId) external onlyAgentOwner(agentId) {
        address wallet = _agentWallets[agentId];
        if (wallet == address(0)) revert NoWalletSet();
        delete _agentWallets[agentId];
        emit AgentWalletUnset(agentId, wallet);
    }

    // ========================================================================
    // Queries
    // ========================================================================

    function isRegistered(uint256 agentId) external view returns (bool) {
        if (agentId == 0 || agentId >= _nextTokenId) return false;
        // Check token still exists (not burned)
        try this.ownerOf(agentId) returns (address) {
            return true;
        } catch {
            return false;
        }
    }

    function getAgentIdByOwner(address owner) external view returns (uint256) {
        return _ownerToAgentId[owner];
    }

    function nextTokenId() external view returns (uint256) {
        return _nextTokenId;
    }

    // ========================================================================
    // Overrides (keep _ownerToAgentId in sync on transfer)
    // ========================================================================

    function _update(
        address to,
        uint256 tokenId,
        address auth
    ) internal override returns (address from) {
        from = super._update(to, tokenId, auth);
        // Update reverse mapping on transfer
        if (from != address(0)) {
            delete _ownerToAgentId[from];
        }
        if (to != address(0)) {
            _ownerToAgentId[to] = tokenId;
        }
    }

    // ========================================================================
    // EIP-712 domain (expose for frontend)
    // ========================================================================

    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}
