// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title BasiliskMultiSig
 * @notice Minimal, non-upgradeable 5-of-7 multi-sig wallet for governing
 *         operational treasury fees from BasiliskEscrow contracts.
 *
 *         Fees are transferred directly to this contract during approveAndPay()
 *         and resolveDispute(). Outgoing transfers require `threshold` out of N
 *         signer confirmations.
 *
 *         Self-governed: add/remove signers and change threshold through the
 *         same multi-sig mechanism (submit tx targeting this contract).
 */
contract BasiliskMultiSig is ReentrancyGuard {
    // ========================================================================
    // Types
    // ========================================================================

    struct Transaction {
        address to;           // slot 0 (20 bytes)
        bool executed;        // slot 0 (+1 byte)
        bool cancelled;       // slot 0 (+1 byte)
        uint256 value;        // slot 1 (native ETH/AVAX)
        uint256 submittedAt;  // slot 2
        bytes data;           // dynamic (encoded calldata)
    }

    // ========================================================================
    // State
    // ========================================================================

    uint256 public threshold;
    uint256 public transactionCount;

    address[] private _signers;
    mapping(address => bool) public isSigner;
    mapping(uint256 => Transaction) public transactions;
    mapping(uint256 => mapping(address => bool)) public confirmations;
    mapping(uint256 => uint256) public confirmationCount;

    // ========================================================================
    // Events
    // ========================================================================

    event TransactionSubmitted(uint256 indexed txId, address indexed submitter, address to, uint256 value, bytes data);
    event TransactionConfirmed(uint256 indexed txId, address indexed signer);
    event ConfirmationRevoked(uint256 indexed txId, address indexed signer);
    event TransactionExecuted(uint256 indexed txId, address indexed executor);
    event TransactionCancelled(uint256 indexed txId);
    event SignerAdded(address indexed signer);
    event SignerRemoved(address indexed signer);
    event ThresholdChanged(uint256 oldThreshold, uint256 newThreshold);
    event NativeReceived(address indexed sender, uint256 amount);

    // ========================================================================
    // Errors
    // ========================================================================

    error NotSigner();
    error InvalidThreshold();
    error InvalidSignerCount();
    error DuplicateSigner();
    error ZeroAddress();
    error TransactionNotFound();
    error TransactionAlreadyExecuted();
    error TransactionAlreadyCancelled();
    error AlreadyConfirmed();
    error NotConfirmed();
    error ExecutionFailed();
    error InsufficientConfirmations();
    error SignerAlreadyExists();
    error SignerNotFound();
    error CannotRemoveLastSigner();
    error OnlySelf();

    // ========================================================================
    // Modifiers
    // ========================================================================

    modifier onlySigner() {
        if (!isSigner[msg.sender]) revert NotSigner();
        _;
    }

    modifier onlySelf() {
        if (msg.sender != address(this)) revert OnlySelf();
        _;
    }

    modifier txExists(uint256 txId) {
        if (txId >= transactionCount) revert TransactionNotFound();
        _;
    }

    modifier notExecuted(uint256 txId) {
        if (transactions[txId].executed) revert TransactionAlreadyExecuted();
        _;
    }

    modifier notCancelled(uint256 txId) {
        if (transactions[txId].cancelled) revert TransactionAlreadyCancelled();
        _;
    }

    // ========================================================================
    // Constructor
    // ========================================================================

    /**
     * @param signers_   Initial signer addresses (3–20, no duplicates, no zero)
     * @param threshold_ Number of confirmations required (1 ≤ threshold ≤ signers.length)
     */
    constructor(address[] memory signers_, uint256 threshold_) {
        if (signers_.length < 3 || signers_.length > 20) revert InvalidSignerCount();
        if (threshold_ == 0 || threshold_ > signers_.length) revert InvalidThreshold();

        for (uint256 i = 0; i < signers_.length; i++) {
            address s = signers_[i];
            if (s == address(0)) revert ZeroAddress();
            if (isSigner[s]) revert DuplicateSigner();

            isSigner[s] = true;
            _signers.push(s);
        }

        threshold = threshold_;
    }

    // ========================================================================
    // Receive
    // ========================================================================

    receive() external payable {
        emit NativeReceived(msg.sender, msg.value);
    }

    // ========================================================================
    // Transaction Lifecycle
    // ========================================================================

    /**
     * @notice Propose a new transaction. Auto-confirms for the submitter.
     * @param to    Target address
     * @param value Native currency amount (wei)
     * @param data  Encoded calldata (use encodeERC20Transfer helper for token transfers)
     * @return txId The transaction ID
     */
    function submitTransaction(
        address to,
        uint256 value,
        bytes calldata data
    ) external onlySigner returns (uint256 txId) {
        if (to == address(0)) revert ZeroAddress();

        txId = transactionCount;
        transactionCount++;

        transactions[txId] = Transaction({
            to: to,
            executed: false,
            cancelled: false,
            value: value,
            submittedAt: block.timestamp,
            data: data
        });

        // Auto-confirm for submitter
        confirmations[txId][msg.sender] = true;
        confirmationCount[txId] = 1;

        emit TransactionSubmitted(txId, msg.sender, to, value, data);
        emit TransactionConfirmed(txId, msg.sender);
    }

    /**
     * @notice Add your confirmation to a pending transaction.
     */
    function confirmTransaction(uint256 txId)
        external
        onlySigner
        txExists(txId)
        notExecuted(txId)
        notCancelled(txId)
    {
        if (confirmations[txId][msg.sender]) revert AlreadyConfirmed();

        confirmations[txId][msg.sender] = true;
        confirmationCount[txId]++;

        emit TransactionConfirmed(txId, msg.sender);
    }

    /**
     * @notice Revoke your confirmation from a pending transaction.
     */
    function revokeConfirmation(uint256 txId)
        external
        onlySigner
        txExists(txId)
        notExecuted(txId)
        notCancelled(txId)
    {
        if (!confirmations[txId][msg.sender]) revert NotConfirmed();

        confirmations[txId][msg.sender] = false;
        confirmationCount[txId]--;

        emit ConfirmationRevoked(txId, msg.sender);
    }

    /**
     * @notice Execute a transaction once threshold confirmations are met.
     */
    function executeTransaction(uint256 txId)
        external
        onlySigner
        txExists(txId)
        notExecuted(txId)
        notCancelled(txId)
        nonReentrant
    {
        if (confirmationCount[txId] < threshold) revert InsufficientConfirmations();

        Transaction storage t = transactions[txId];
        t.executed = true;

        (bool success, ) = t.to.call{value: t.value}(t.data);
        if (!success) revert ExecutionFailed();

        emit TransactionExecuted(txId, msg.sender);
    }

    // ========================================================================
    // Self-Governance (called via multi-sig transaction to this contract)
    // ========================================================================

    /**
     * @notice Add a new signer. Must be called through executeTransaction targeting this contract.
     */
    function addSigner(address signer) external onlySelf {
        if (signer == address(0)) revert ZeroAddress();
        if (isSigner[signer]) revert SignerAlreadyExists();
        if (_signers.length >= 20) revert InvalidSignerCount();

        isSigner[signer] = true;
        _signers.push(signer);

        emit SignerAdded(signer);
    }

    /**
     * @notice Remove a signer. Swap-and-pop to keep array compact.
     *         Cannot remove if it would drop below threshold.
     */
    function removeSigner(address signer) external onlySelf {
        if (!isSigner[signer]) revert SignerNotFound();
        if (_signers.length <= threshold) revert CannotRemoveLastSigner();

        isSigner[signer] = false;

        // Swap-and-pop
        for (uint256 i = 0; i < _signers.length; i++) {
            if (_signers[i] == signer) {
                _signers[i] = _signers[_signers.length - 1];
                _signers.pop();
                break;
            }
        }

        emit SignerRemoved(signer);
    }

    /**
     * @notice Change the confirmation threshold. Must be called through multi-sig.
     */
    function changeThreshold(uint256 newThreshold) external onlySelf {
        if (newThreshold == 0 || newThreshold > _signers.length) revert InvalidThreshold();

        uint256 oldThreshold = threshold;
        threshold = newThreshold;

        emit ThresholdChanged(oldThreshold, newThreshold);
    }

    /**
     * @notice Cancel a pending transaction. Must be called through multi-sig.
     */
    function cancelTransaction(uint256 txId)
        external
        onlySelf
        txExists(txId)
        notExecuted(txId)
        notCancelled(txId)
    {
        transactions[txId].cancelled = true;

        emit TransactionCancelled(txId);
    }

    // ========================================================================
    // Helpers
    // ========================================================================

    /**
     * @notice Encode an ERC-20 transfer call for use as transaction data.
     *         Call off-chain, then pass result as `data` to submitTransaction.
     * @param token  ERC-20 token address
     * @param to     Recipient address
     * @param amount Token amount (in smallest unit)
     * @return targetToken The token contract to call
     * @return data Encoded calldata for IERC20.transfer(to, amount)
     */
    function encodeERC20Transfer(
        address token,
        address to,
        uint256 amount
    ) external pure returns (address targetToken, bytes memory data) {
        targetToken = token;
        data = abi.encodeWithSelector(IERC20.transfer.selector, to, amount);
    }

    // ========================================================================
    // View Functions
    // ========================================================================

    /**
     * @notice Get full transaction details.
     */
    function getTransaction(uint256 txId)
        external
        view
        txExists(txId)
        returns (
            address to,
            uint256 value,
            bytes memory data,
            bool executed,
            bool cancelled,
            uint256 submittedAt,
            uint256 numConfirmations
        )
    {
        Transaction storage t = transactions[txId];
        return (t.to, t.value, t.data, t.executed, t.cancelled, t.submittedAt, confirmationCount[txId]);
    }

    /**
     * @notice Check if a transaction has met the confirmation threshold.
     */
    function isConfirmed(uint256 txId) external view txExists(txId) returns (bool) {
        return confirmationCount[txId] >= threshold;
    }

    /**
     * @notice Get the list of signers who have confirmed a transaction.
     */
    function getConfirmations(uint256 txId) external view txExists(txId) returns (address[] memory) {
        uint256 count = confirmationCount[txId];
        address[] memory confirmed = new address[](count);
        uint256 idx = 0;

        for (uint256 i = 0; i < _signers.length && idx < count; i++) {
            if (confirmations[txId][_signers[i]]) {
                confirmed[idx] = _signers[i];
                idx++;
            }
        }

        return confirmed;
    }

    /**
     * @notice Get the full list of signers.
     */
    function getSigners() external view returns (address[] memory) {
        return _signers;
    }

    /**
     * @notice Get the number of signers.
     */
    function getSignerCount() external view returns (uint256) {
        return _signers.length;
    }

    /**
     * @notice Check if a specific signer has confirmed a transaction.
     */
    function hasConfirmed(uint256 txId, address signer) external view txExists(txId) returns (bool) {
        return confirmations[txId][signer];
    }
}
