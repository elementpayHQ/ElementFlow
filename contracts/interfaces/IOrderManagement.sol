// SPDX-License-Identifier: BSL 1.1
pragma solidity 0.8.22;

/**
 * @title IOrderManagement
 * @notice Interface for the ElementFlow on/off-ramp order management protocol.
 *
 * Design principles:
 *  - OrderSigner (backend key) authorises all order economics via EIP-712 signed intents.
 *  - Aggregator (execution bot) only drives the state machine; it cannot alter params.
 *  - reserved[token] accounting prevents inventory over-commitment on OnRamp orders.
 *  - All fee wallets are snapshotted per-order at creation and are immune to admin rotation.
 */
interface IOrderManagement {

    // ─────────────────────────────────────────────────────────────
    // Enums & Structs
    // ─────────────────────────────────────────────────────────────

    enum OrderType   { OnRamp, OffRamp }
    enum OrderStatus { Pending, Completed, Cancelled }

    /**
     * @notice EIP-712 signed intent that authorises order creation.
     *
     * @param requester         User address (OffRamp) or beneficiary (OnRamp).
     * @param token             ERC-20 token to be used.
     * @param orderType         OnRamp or OffRamp.
     * @param principalAmount   Net token amount the provider / user receives (excluding fees).
     * @param protocolFeeBps    Protocol fee in basis points (denominator 100_000).
     * @param partnerFeeBps     Partner / integrator fee in basis points.
     * @param providerWallet    Principal destination — LP wallet for OffRamp, user for OnRamp.
     * @param partnerFeeWallet  Integrator fee recipient (address(0) to skip partner fee).
     * @param protocolFeeWallet Protocol treasury snapshot (immune to updateTreasury mid-flight).
     * @param providerId        Opaque off-chain provider reference.
     * @param nonce             Per-requester monotonic nonce (prevents replay).
     * @param deadline          Unix timestamp after which the intent is invalid.
     */
    struct OrderIntent {
        address requester;
        address token;
        OrderType orderType;
        uint256 principalAmount;
        uint256 protocolFeeBps;
        uint256 partnerFeeBps;
        address providerWallet;
        address partnerFeeWallet;
        address protocolFeeWallet;
        bytes32 providerId;
        uint256 nonce;
        uint256 deadline;
    }

    /**
     * @notice On-chain order record — stored after intent verification.
     *
     * @param requester         Original order creator (user for OffRamp, aggregator for OnRamp).
     * @param token             ERC-20 token.
     * @param orderType         OnRamp or OffRamp.
     * @param status            Lifecycle state.
     * @param providerWallet    Principal destination locked at creation.
     * @param protocolFeeWallet Protocol fee destination locked at creation.
     * @param partnerFeeWallet  Partner fee destination locked at creation.
     * @param principal         Token units going to providerWallet.
     * @param protocolFee       Token units going to protocolFeeWallet.
     * @param partnerFee        Token units going to partnerFeeWallet (0 if none).
     * @param escrowedAmount    principal + protocolFee + partnerFee (exact pulled amount).
     * @param deadline          Expiry timestamp for trustless user refund.
     * @param providerId        Opaque off-chain reference.
     */
    struct Order {
        address requester;
        address token;
        OrderType orderType;
        OrderStatus status;
        address providerWallet;
        address protocolFeeWallet;
        address partnerFeeWallet;
        uint256 principal;
        uint256 protocolFee;
        uint256 partnerFee;
        uint256 escrowedAmount;
        uint256 deadline;
        bytes32 providerId;
    }

    // ─────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────

    /**
     * @notice Emitted when a new order is created and funds are committed.
     * @param orderId        Unique order identifier (derived from EIP-712 intent hash).
     * @param token          ERC-20 token address.
     * @param requester      Address that created the order.
     * @param orderType      OnRamp or OffRamp.
     * @param escrowedAmount Total tokens pulled from requester / reserved from inventory.
     * @param principal      Net amount destined for providerWallet.
     * @param protocolFee    Amount destined for protocolFeeWallet.
     * @param partnerFee     Amount destined for partnerFeeWallet (0 if none).
     * @param providerId     Opaque off-chain provider reference.
     * @param deadline       Order expiry timestamp.
     */
    event OrderCreated(
        bytes32 indexed orderId,
        address indexed token,
        address indexed requester,
        OrderType orderType,
        uint256 escrowedAmount,
        uint256 principal,
        uint256 protocolFee,
        uint256 partnerFee,
        bytes32 providerId,
        uint256 deadline
    );

    /**
     * @notice Emitted when an order is successfully settled.
     * @param orderId           Settled order.
     * @param providerWallet    Received principal.
     * @param protocolFeeWallet Received protocol fee.
     * @param partnerFeeWallet  Received partner fee (address(0) if skipped).
     * @param principal         Principal token amount transferred.
     * @param protocolFee       Protocol fee transferred.
     * @param partnerFee        Partner fee transferred (0 if none).
     */
    event OrderSettled(
        bytes32 indexed orderId,
        address providerWallet,
        address protocolFeeWallet,
        address partnerFeeWallet,
        uint256 principal,
        uint256 protocolFee,
        uint256 partnerFee
    );

    /**
     * @notice Emitted when an OffRamp order is refunded by the aggregator.
     * @param orderId        Refunded order.
     * @param requester      Address that received the refund.
     * @param escrowedAmount Full amount returned (principal + all fees).
     */
    event OrderRefunded(
        bytes32 indexed orderId,
        address requester,
        uint256 escrowedAmount
    );

    /**
     * @notice Emitted when an order expires and a trustless refund is triggered.
     * @param orderId        Expired order.
     * @param requester      Address that received the refund.
     * @param escrowedAmount Full amount returned.
     */
    event OrderExpired(
        bytes32 indexed orderId,
        address requester,
        uint256 escrowedAmount
    );

    /**
     * @notice Emitted when an OnRamp order is cancelled before settlement (no tokens moved).
     * @param orderId Cancelled order.
     */
    event OnRampOrderCancelled(bytes32 indexed orderId);

    /**
     * @notice Emitted when unreserved tokens are withdrawn by the owner.
     */
    event UnreservedWithdrawn(address indexed token, address indexed to, uint256 amount);

    /**
     * @notice Emitted when the aggregator address is rotated.
     */
    event AggregatorUpdated(address indexed previous, address indexed next);

    /**
     * @notice Emitted when the order signer address is rotated.
     */
    event OrderSignerUpdated(address indexed previous, address indexed next);

    /**
     * @notice Emitted when the default treasury is updated.
     */
    event TreasuryUpdated(address indexed previous, address indexed next);

    // ─────────────────────────────────────────────────────────────
    // Errors
    // ─────────────────────────────────────────────────────────────

    error ZeroAddress();
    error InvalidOrderType();
    error ZeroAmount();
    error TokenNotSupported(address token);
    error InvalidSignature();
    error ExpiredIntent(uint256 deadline, uint256 current);
    error InvalidNonce(uint256 expected, uint256 provided);
    error OrderNotFound(bytes32 orderId);
    error OrderNotPending(bytes32 orderId, OrderStatus status);
    error OrderNotOffRamp(bytes32 orderId);
    error OrderNotOnRamp(bytes32 orderId);
    error OrderNotExpired(bytes32 orderId, uint256 deadline, uint256 current);
    error InsufficientInventory(address token, uint256 required, uint256 available);
    error FeeOnTransferTokenRejected(address token, uint256 expected, uint256 actual);
    error WithdrawalExceedsUnreserved(uint256 requested, uint256 available);
    error FeesExceedPrincipal(uint256 totalFees, uint256 principal);

    // ─────────────────────────────────────────────────────────────
    // Core Order Lifecycle
    // ─────────────────────────────────────────────────────────────

    /**
     * @notice Creates an OffRamp order. Called by the user with a backend-signed intent.
     *         Pulls (principal + protocolFee + partnerFee) from the user into escrow.
     * @param intent Signed order parameters.
     * @param sig    EIP-712 signature from the orderSigner.
     * @return orderId Unique identifier for the created order.
     */
    function createOffRampOrder(OrderIntent calldata intent, bytes calldata sig)
        external
        returns (bytes32 orderId);

    /**
     * @notice Creates an OnRamp order. Called by the aggregator with a backend-signed intent.
     *         Reserves (principal + protocolFee + partnerFee) from contract inventory.
     * @param intent Signed order parameters.
     * @param sig    EIP-712 signature from the orderSigner.
     * @return orderId Unique identifier for the created order.
     */
    function createOnRampOrder(OrderIntent calldata intent, bytes calldata sig)
        external
        returns (bytes32 orderId);

    /**
     * @notice Settles a pending order. Called by the aggregator once the off-chain leg completes.
     *         Distributes principal → providerWallet, protocolFee → protocolFeeWallet,
     *         partnerFee → partnerFeeWallet.
     * @param orderId Order to settle.
     */
    function settleOrder(bytes32 orderId) external;

    /**
     * @notice Refunds a pending OffRamp order. Called by the aggregator when the fiat leg fails.
     *         Returns the full escrowedAmount to the requester.
     * @param orderId Order to refund.
     */
    function refundOrder(bytes32 orderId) external;

    /**
     * @notice Cancels a pending OnRamp order (fiat never arrived). Called by the aggregator.
     *         Releases the inventory reservation — no tokens are transferred.
     * @param orderId Order to cancel.
     */
    function cancelOnRampOrder(bytes32 orderId) external;

    /**
     * @notice Trustless expiry — anyone can call after the order deadline passes.
     *         Returns the full escrowedAmount (OffRamp) or releases reservation (OnRamp).
     * @param orderId Order to expire.
     */
    function expireOrder(bytes32 orderId) external;

    // ─────────────────────────────────────────────────────────────
    // View Functions
    // ─────────────────────────────────────────────────────────────

    /**
     * @notice Returns full order details.
     */
    function getOrder(bytes32 orderId) external view returns (Order memory);

    /**
     * @notice Returns the current nonce for a user (next expected nonce).
     */
    function userNonce(address user) external view returns (uint256);

    /**
     * @notice Returns the amount of token currently reserved for pending orders.
     */
    function reserved(address token) external view returns (uint256);

    /**
     * @notice Returns the amount available for new OnRamp orders or owner withdrawal.
     */
    function availableBalance(address token) external view returns (uint256);
}
