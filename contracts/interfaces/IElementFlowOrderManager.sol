// SPDX-License-Identifier: BSL-1.1
pragma solidity 0.8.22;

import {OrderTypes} from "../libraries/OrderTypes.sol";

/**
 * @title IElementFlowOrderManager
 * @notice External surface of the ElementFlow order manager.
 */
interface IElementFlowOrderManager {
    /* ------------------------------------------------------------------ errors */

    error ZeroAddress();
    error ZeroAmount();
    error InvalidOrderType();
    error EmptyMessageHash();
    error TokenNotAllowed(address token);
    error OrderAlreadyExists(bytes32 orderId);
    error OrderNotFound(bytes32 orderId);
    error OrderNotPending(bytes32 orderId, OrderTypes.OrderStatus status);
    error OrderNotExpired(bytes32 orderId, uint64 expiresAt);
    error NotOrderCreator(address caller, address requester);
    error InsufficientLiquidity(address token, uint256 required, uint256 available);
    error ProviderSettlementShortfall(uint256 expected, uint256 received);
    error FeeTooHigh(uint16 feeBps, uint16 maxFeeBps);
    error InvalidExpiry(uint64 provided);
    error UnexpectedBalanceDelta(uint256 expected, uint256 received);
    error LegacyOrderNotPending(bytes32 orderId);
    error ProviderRegistryNotSet();
    error ArrayLengthMismatch();

    /* ------------------------------------------------------------------ events */

    /// @dev `rate` is retained at the end of the signature for backend log-parsing
    ///      compatibility with the v1 `OrderCreated` event.
    event OrderCreated(
        bytes32 indexed orderId,
        address indexed token,
        address indexed requester,
        uint256 amount,
        string messageHash,
        uint256 rate,
        OrderTypes.OrderType orderType
    );
    event OrderSettled(
        bytes32 indexed orderId,
        address indexed token,
        address indexed requester,
        uint256 netAmount,
        uint256 feeAmount,
        bytes32 providerId
    );
    event OrderRefunded(bytes32 indexed orderId, address indexed token, address indexed requester, uint256 amount);

    event TreasuryUpdated(address indexed previousTreasury, address indexed newTreasury);
    event FeeRecipientUpdated(address indexed previousRecipient, address indexed newRecipient);
    event FeeBpsUpdated(uint16 previousFeeBps, uint16 newFeeBps);
    event ProviderRegistryUpdated(address indexed previousRegistry, address indexed newRegistry);
    event DefaultProviderUpdated(bytes32 indexed previousProviderId, bytes32 indexed newProviderId);
    event OrderTtlUpdated(uint64 previousTtl, uint64 newTtl);
    event TokenAllowanceUpdated(address indexed token, bool allowed);
    event LiquidityDeposited(address indexed token, address indexed from, uint256 amount);
    event LiquidityWithdrawn(address indexed token, address indexed to, uint256 amount);
    event StuckTokensRescued(address indexed token, address indexed to, uint256 amount);

    /* --------------------------------------------------------------- lifecycle */

    function createOrder(
        address requester,
        uint256 amount,
        address token,
        OrderTypes.OrderType orderType,
        string calldata messageHash
    ) external returns (bytes32 orderId);

    function createOrderWithProvider(
        address requester,
        uint256 amount,
        address token,
        OrderTypes.OrderType orderType,
        string calldata messageHash,
        bytes32 providerId,
        bytes32 intentKey
    ) external returns (bytes32 orderId);

    /// @notice OffRamp-friendly create: pull from `payer`, refund to `refundAddress`.
    /// @dev `refundAddress == address(0)` defaults to `payer` (same as createOrder).
    function createOrderWithRefund(
        address payer,
        address refundAddress,
        uint256 amount,
        address token,
        OrderTypes.OrderType orderType,
        string calldata messageHash
    ) external returns (bytes32 orderId);

    function createOrderWithProviderAndRefund(
        address payer,
        address refundAddress,
        uint256 amount,
        address token,
        OrderTypes.OrderType orderType,
        string calldata messageHash,
        bytes32 providerId,
        bytes32 intentKey
    ) external returns (bytes32 orderId);

    function settleOrder(bytes32 orderId) external;

    function refundOrder(bytes32 orderId) external;

    function refundExpiredOrder(bytes32 orderId) external;

    /* ------------------------------------------------------------------- views */

    /// @notice Full v2 order record.
    function getOrderRecord(bytes32 orderId) external view returns (OrderTypes.Order memory);

    /// @notice Create-time refund destination for OffRamp (payer when unset / zero).
    function getRefundAddress(bytes32 orderId) external view returns (address);

    /**
     * @notice v1-compatible order view.
     * @dev Returns the flat 8-tuple that the existing backend decodes positionally, with
     *      the status re-encoded into v1 numbering (0=Pending, 1=Settled, 2=Refunded).
     */
    function getOrder(bytes32 orderId)
        external
        view
        returns (
            bytes32 id,
            address requester,
            address provider,
            address token,
            uint256 amount,
            uint8 status,
            OrderTypes.OrderType orderType,
            string memory messageHash
        );

    function computeOrderId(
        address requester,
        uint256 amount,
        address token,
        OrderTypes.OrderType orderType,
        bytes32 intentKey
    ) external view returns (bytes32);

    function availableLiquidity(address token) external view returns (uint256);

    function reservedLiquidity(address token) external view returns (uint256);
}
