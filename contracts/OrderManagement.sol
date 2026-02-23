// SPDX-License-Identifier: BSL 1.1
pragma solidity 0.8.22;

import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "./interfaces/IOrderManagement.sol";
import "./interfaces/ISettingsManager.sol";

/**
 * @title OrderManagement
 * @notice ElementFlow production on/off-ramp order manager.
 *
 * Security model:
 *  - Owner (multisig + timelock): upgrades, token whitelist, role rotation, pause, unreserved withdrawal.
 *  - OrderSigner (hot backend key): signs EIP-712 intents that lock all order economics.
 *  - Aggregator (execution bot): drives the state machine only; cannot alter order params.
 *  - User: creates OffRamp orders with a backend-signed intent; funds pulled at creation.
 *
 * Fee model:
 *  escrowedAmount = principal + protocolFee + partnerFee
 *  All fee wallets are snapshotted per-order at intent-signing time and are immutable after creation.
 *
 * Solvency:
 *  reserved[token] tracks all tokens committed to pending orders.
 *  Owner may only withdraw balanceOf(this) - reserved[token].
 */
contract OrderManagement is
    IOrderManagement,
    Initializable,
    PausableUpgradeable,
    OwnableUpgradeable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable
{
    using SafeERC20 for IERC20;
    using ECDSA for bytes32;

    // ─────────────────────────────────────────────────────────────
    // Constants
    // ─────────────────────────────────────────────────────────────

    uint256 internal constant MAX_BPS = 100_000;

    bytes32 internal constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    bytes32 internal constant ORDER_INTENT_TYPEHASH = keccak256(
        "OrderIntent("
        "address requester,"
        "address token,"
        "uint8 orderType,"
        "uint256 principalAmount,"
        "uint256 protocolFeeBps,"
        "uint256 partnerFeeBps,"
        "address providerWallet,"
        "address partnerFeeWallet,"
        "address protocolFeeWallet,"
        "bytes32 providerId,"
        "uint256 nonce,"
        "uint256 deadline"
        ")"
    );

    // ─────────────────────────────────────────────────────────────
    // Storage
    // ─────────────────────────────────────────────────────────────

    /// @notice EIP-712 domain separator (set once at initialise, rebuilt on chain fork if needed).
    bytes32 private _domainSeparator;

    /// @notice Backend key that authorises order intent economics.
    address internal _orderSigner;

    /// @notice Execution bot that drives order lifecycle.
    address internal _aggregatorAddress;

    /// @notice Default treasury — used as protocolFeeWallet fallback in admin flows only.
    address public treasury;

    /// @notice Token whitelist oracle.
    address public settingsManager;

    /// @notice Per-requester monotonic nonce for replay protection.
    mapping(address => uint256) public userNonce;

    /// @notice Primary order store.
    mapping(bytes32 => Order) private _orders;

    /// @notice Tokens reserved for pending orders (OnRamp inventory + OffRamp escrow).
    mapping(address => uint256) public reserved;

    /// @dev Storage gap for future upgrades — preserves storage layout.
    uint256[44] private __gap;

    // ─────────────────────────────────────────────────────────────
    // Constructor / Initializer
    // ─────────────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialises the proxy. Must be called exactly once.
     * @param aggregator_      Aggregator execution address.
     * @param orderSigner_     EIP-712 signing key address.
     * @param treasury_        Default protocol treasury.
     * @param settingsManager_ Token whitelist contract.
     * @param owner_           Initial owner (should be a multisig).
     */
    function initialize(
        address aggregator_,
        address orderSigner_,
        address treasury_,
        address settingsManager_,
        address owner_
    ) external initializer {
        if (aggregator_      == address(0)) revert ZeroAddress();
        if (orderSigner_     == address(0)) revert ZeroAddress();
        if (treasury_        == address(0)) revert ZeroAddress();
        if (settingsManager_ == address(0)) revert ZeroAddress();
        if (owner_           == address(0)) revert ZeroAddress();

        __Pausable_init_unchained();
        __Ownable_init_unchained(owner_);
        __UUPSUpgradeable_init_unchained();
        __ReentrancyGuard_init_unchained();

        _aggregatorAddress = aggregator_;
        _orderSigner       = orderSigner_;
        treasury           = treasury_;
        settingsManager    = settingsManager_;

        _domainSeparator = _buildDomainSeparator();
    }

    // ─────────────────────────────────────────────────────────────
    // Access Modifiers
    // ─────────────────────────────────────────────────────────────

    modifier onlyAggregator() {
        require(msg.sender == _aggregatorAddress, "Caller is not the aggregator");
        _;
    }

    // ─────────────────────────────────────────────────────────────
    // OffRamp Order Creation (called by user)
    // ─────────────────────────────────────────────────────────────

    /**
     * @inheritdoc IOrderManagement
     */
    function createOffRampOrder(OrderIntent calldata intent, bytes calldata sig)
        external
        override
        whenNotPaused
        nonReentrant
        returns (bytes32 orderId)
    {
        if (intent.orderType != OrderType.OffRamp) revert InvalidOrderType();

        orderId = _verifyIntent(intent, sig);
        _validateIntentFields(intent);

        (uint256 protocolFee, uint256 partnerFee, uint256 escrowedAmount) =
            _computeFees(intent.principalAmount, intent.protocolFeeBps, intent.partnerFeeBps);

        // Pull tokens from user; reject fee-on-transfer tokens.
        uint256 preBal  = IERC20(intent.token).balanceOf(address(this));
        IERC20(intent.token).safeTransferFrom(intent.requester, address(this), escrowedAmount);
        uint256 postBal = IERC20(intent.token).balanceOf(address(this));
        if (postBal - preBal != escrowedAmount) {
            revert FeeOnTransferTokenRejected(intent.token, escrowedAmount, postBal - preBal);
        }

        reserved[intent.token] += escrowedAmount;

        _storeOrder(orderId, intent, protocolFee, partnerFee, escrowedAmount);

        emit OrderCreated(
            orderId,
            intent.token,
            intent.requester,
            OrderType.OffRamp,
            escrowedAmount,
            intent.principalAmount,
            protocolFee,
            partnerFee,
            intent.providerId,
            intent.deadline
        );
    }

    // ─────────────────────────────────────────────────────────────
    // OnRamp Order Creation (called by aggregator)
    // ─────────────────────────────────────────────────────────────

    /**
     * @inheritdoc IOrderManagement
     */
    function createOnRampOrder(OrderIntent calldata intent, bytes calldata sig)
        external
        override
        whenNotPaused
        onlyAggregator
        nonReentrant
        returns (bytes32 orderId)
    {
        if (intent.orderType != OrderType.OnRamp) revert InvalidOrderType();

        orderId = _verifyIntent(intent, sig);
        _validateIntentFields(intent);

        (uint256 protocolFee, uint256 partnerFee, uint256 escrowedAmount) =
            _computeFees(intent.principalAmount, intent.protocolFeeBps, intent.partnerFeeBps);

        uint256 avail = IERC20(intent.token).balanceOf(address(this)) - reserved[intent.token];
        if (avail < escrowedAmount) {
            revert InsufficientInventory(intent.token, escrowedAmount, avail);
        }
        reserved[intent.token] += escrowedAmount;

        _storeOrder(orderId, intent, protocolFee, partnerFee, escrowedAmount);

        emit OrderCreated(
            orderId,
            intent.token,
            intent.requester,
            OrderType.OnRamp,
            escrowedAmount,
            intent.principalAmount,
            protocolFee,
            partnerFee,
            intent.providerId,
            intent.deadline
        );
    }

    // ─────────────────────────────────────────────────────────────
    // Settlement
    // ─────────────────────────────────────────────────────────────

    /**
     * @inheritdoc IOrderManagement
     */
    function settleOrder(bytes32 orderId)
        external
        override
        onlyAggregator
        whenNotPaused
        nonReentrant
    {
        Order storage order = _orders[orderId];
        _requirePending(orderId, order);
        if (block.timestamp > order.deadline) revert OrderNotPending(orderId, order.status);

        // CEI: mutate state before all external calls.
        order.status = OrderStatus.Completed;
        reserved[order.token] -= order.escrowedAmount;

        IERC20 token = IERC20(order.token);

        token.safeTransfer(order.providerWallet, order.principal);
        token.safeTransfer(order.protocolFeeWallet, order.protocolFee);
        if (order.partnerFee > 0) {
            token.safeTransfer(order.partnerFeeWallet, order.partnerFee);
        }

        emit OrderSettled(
            orderId,
            order.providerWallet,
            order.protocolFeeWallet,
            order.partnerFeeWallet,
            order.principal,
            order.protocolFee,
            order.partnerFee
        );
    }

    // ─────────────────────────────────────────────────────────────
    // Refund (aggregator-initiated, OffRamp only)
    // ─────────────────────────────────────────────────────────────

    /**
     * @inheritdoc IOrderManagement
     */
    function refundOrder(bytes32 orderId)
        external
        override
        onlyAggregator
        whenNotPaused
        nonReentrant
    {
        Order storage order = _orders[orderId];
        _requirePending(orderId, order);
        if (order.orderType != OrderType.OffRamp) revert OrderNotOffRamp(orderId);

        // CEI: state before external call.
        order.status = OrderStatus.Cancelled;
        reserved[order.token] -= order.escrowedAmount;

        IERC20(order.token).safeTransfer(order.requester, order.escrowedAmount);

        emit OrderRefunded(orderId, order.requester, order.escrowedAmount);
    }

    // ─────────────────────────────────────────────────────────────
    // OnRamp Cancel (aggregator-initiated, no token movement)
    // ─────────────────────────────────────────────────────────────

    /**
     * @inheritdoc IOrderManagement
     */
    function cancelOnRampOrder(bytes32 orderId)
        external
        override
        onlyAggregator
        whenNotPaused
        nonReentrant
    {
        Order storage order = _orders[orderId];
        _requirePending(orderId, order);
        if (order.orderType != OrderType.OnRamp) revert OrderNotOnRamp(orderId);

        // CEI: state before any side-effects.
        order.status = OrderStatus.Cancelled;
        reserved[order.token] -= order.escrowedAmount;

        emit OnRampOrderCancelled(orderId);
    }

    // ─────────────────────────────────────────────────────────────
    // Trustless Expiry (callable by anyone after deadline)
    // ─────────────────────────────────────────────────────────────

    /**
     * @inheritdoc IOrderManagement
     */
    function expireOrder(bytes32 orderId)
        external
        override
        nonReentrant
    {
        Order storage order = _orders[orderId];
        _requirePending(orderId, order);
        if (block.timestamp <= order.deadline) {
            revert OrderNotExpired(orderId, order.deadline, block.timestamp);
        }

        order.status = OrderStatus.Cancelled;
        reserved[order.token] -= order.escrowedAmount;

        if (order.orderType == OrderType.OffRamp) {
            IERC20(order.token).safeTransfer(order.requester, order.escrowedAmount);
            emit OrderExpired(orderId, order.requester, order.escrowedAmount);
        } else {
            // OnRamp — inventory simply released; no tokens to transfer back.
            emit OnRampOrderCancelled(orderId);
        }
    }

    // ─────────────────────────────────────────────────────────────
    // View Functions
    // ─────────────────────────────────────────────────────────────

    /// @inheritdoc IOrderManagement
    function getOrder(bytes32 orderId) external view override returns (Order memory) {
        if (_orders[orderId].requester == address(0)) revert OrderNotFound(orderId);
        return _orders[orderId];
    }

    /// @inheritdoc IOrderManagement
    function availableBalance(address token) external view override returns (uint256) {
        uint256 bal = IERC20(token).balanceOf(address(this));
        uint256 res = reserved[token];
        return bal > res ? bal - res : 0;
    }

    /// @notice Returns the current domain separator (EIP-712).
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparator;
    }

    /// @notice Returns the current order signer address.
    function orderSigner() external view returns (address) {
        return _orderSigner;
    }

    /// @notice Returns the current aggregator address.
    function aggregatorAddress() external view returns (address) {
        return _aggregatorAddress;
    }

    /// @notice Returns the contract version.
    function getVersion() external pure returns (string memory) {
        return "2.0.0";
    }

    // ─────────────────────────────────────────────────────────────
    // Admin — Safe Withdrawal
    // ─────────────────────────────────────────────────────────────

    /**
     * @notice Withdraw tokens not committed to any pending order.
     *         Cannot drain escrow or OnRamp inventory backing live orders.
     * @param token  ERC-20 token to withdraw.
     * @param to     Destination address.
     * @param amount Amount to withdraw.
     */
    function withdrawUnreserved(address token, address to, uint256 amount)
        external
        onlyOwner
        nonReentrant
    {
        if (to == address(0)) revert ZeroAddress();
        uint256 bal  = IERC20(token).balanceOf(address(this));
        uint256 res  = reserved[token];
        uint256 avail = bal > res ? bal - res : 0;
        if (amount > avail) revert WithdrawalExceedsUnreserved(amount, avail);

        IERC20(token).safeTransfer(to, amount);
        emit UnreservedWithdrawn(token, to, amount);
    }

    // ─────────────────────────────────────────────────────────────
    // Admin — Role Management
    // ─────────────────────────────────────────────────────────────

    /// @notice Updates the aggregator address. Only owner.
    function updateAggregatorAddress(address aggregator_) external onlyOwner {
        if (aggregator_ == address(0)) revert ZeroAddress();
        emit AggregatorUpdated(_aggregatorAddress, aggregator_);
        _aggregatorAddress = aggregator_;
    }

    /// @notice Updates the order signer address. Only owner.
    function updateOrderSigner(address signer_) external onlyOwner {
        if (signer_ == address(0)) revert ZeroAddress();
        emit OrderSignerUpdated(_orderSigner, signer_);
        _orderSigner = signer_;
    }

    /// @notice Updates the default treasury address. Only owner.
    /// @dev Does NOT affect already-created orders; per-order protocolFeeWallet is immutable.
    function updateTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, treasury_);
        treasury = treasury_;
    }

    /// @notice Updates the settings manager (token whitelist) address. Only owner.
    function updateSettingsManager(address settingsManager_) external onlyOwner {
        if (settingsManager_ == address(0)) revert ZeroAddress();
        settingsManager = settingsManager_;
    }

    /// @notice Pauses the contract. Only owner.
    function pause() external onlyOwner { _pause(); }

    /// @notice Unpauses the contract. Only owner.
    function unpause() external onlyOwner { _unpause(); }

    // ─────────────────────────────────────────────────────────────
    // Internal Helpers
    // ─────────────────────────────────────────────────────────────

    /**
     * @dev Verifies the EIP-712 signature, increments the requester's nonce, and returns
     *      the EIP-712 typed data hash (used directly as the orderId to avoid recomputation).
     */
    function _verifyIntent(OrderIntent calldata intent, bytes calldata sig)
        internal
        returns (bytes32 digest)
    {
        if (block.timestamp > intent.deadline) {
            revert ExpiredIntent(intent.deadline, block.timestamp);
        }
        uint256 expected = userNonce[intent.requester];
        if (intent.nonce != expected) {
            revert InvalidNonce(expected, intent.nonce);
        }

        bytes32 structHash = keccak256(abi.encode(
            ORDER_INTENT_TYPEHASH,
            intent.requester,
            intent.token,
            uint8(intent.orderType),
            intent.principalAmount,
            intent.protocolFeeBps,
            intent.partnerFeeBps,
            intent.providerWallet,
            intent.partnerFeeWallet,
            intent.protocolFeeWallet,
            intent.providerId,
            intent.nonce,
            intent.deadline
        ));

        digest = MessageHashUtils.toTypedDataHash(_domainSeparator, structHash);
        address recovered = ECDSA.recover(digest, sig);
        if (recovered != _orderSigner) revert InvalidSignature();

        // Increment nonce after successful verification.
        userNonce[intent.requester] = expected + 1;
    }

    /**
     * @dev Validates intent fields that are not covered by signature verification.
     */
    function _validateIntentFields(OrderIntent calldata intent) internal view {
        if (intent.requester        == address(0)) revert ZeroAddress();
        if (intent.token            == address(0)) revert ZeroAddress();
        if (intent.providerWallet   == address(0)) revert ZeroAddress();
        if (intent.protocolFeeWallet == address(0)) revert ZeroAddress();
        if (intent.principalAmount  == 0)          revert ZeroAmount();

        if (!ISettingsManager(settingsManager).isTokenSupported(intent.token)) {
            revert TokenNotSupported(intent.token);
        }
    }

    /**
     * @dev Computes fee amounts from principal and basis points.
     *      Reverts if total fees exceed principal (sanity guard against misconfigured intents).
     */
    function _computeFees(
        uint256 principal,
        uint256 protocolFeeBps,
        uint256 partnerFeeBps
    ) internal pure returns (
        uint256 protocolFee,
        uint256 partnerFee,
        uint256 escrowedAmount
    ) {
        protocolFee = (principal * protocolFeeBps) / MAX_BPS;
        partnerFee  = (principal * partnerFeeBps)  / MAX_BPS;
        uint256 totalFees = protocolFee + partnerFee;
        if (totalFees > principal) revert FeesExceedPrincipal(totalFees, principal);
        escrowedAmount = principal + totalFees;
    }

    /**
     * @dev Builds and stores the Order struct from a verified intent.
     */
    function _storeOrder(
        bytes32 orderId,
        OrderIntent calldata intent,
        uint256 protocolFee,
        uint256 partnerFee,
        uint256 escrowedAmount
    ) internal {
        _orders[orderId] = Order({
            requester:         intent.requester,
            token:             intent.token,
            orderType:         intent.orderType,
            status:            OrderStatus.Pending,
            providerWallet:    intent.providerWallet,
            protocolFeeWallet: intent.protocolFeeWallet,
            partnerFeeWallet:  intent.partnerFeeWallet,
            principal:         intent.principalAmount,
            protocolFee:       protocolFee,
            partnerFee:        partnerFee,
            escrowedAmount:    escrowedAmount,
            deadline:          intent.deadline,
            providerId:        intent.providerId
        });
    }

    /**
     * @dev Reverts if the order does not exist or is not Pending.
     */
    function _requirePending(bytes32 orderId, Order storage order) internal view {
        if (order.requester == address(0)) revert OrderNotFound(orderId);
        if (order.status != OrderStatus.Pending) revert OrderNotPending(orderId, order.status);
    }

    /**
     * @dev Builds the EIP-712 domain separator.
     */
    function _buildDomainSeparator() internal view returns (bytes32) {
        return keccak256(abi.encode(
            DOMAIN_TYPEHASH,
            keccak256(bytes("ElementFlow")),
            keccak256(bytes("2")),
            block.chainid,
            address(this)
        ));
    }

    // ─────────────────────────────────────────────────────────────
    // UUPS
    // ─────────────────────────────────────────────────────────────

    /// @dev Only owner can authorise implementation upgrades.
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
