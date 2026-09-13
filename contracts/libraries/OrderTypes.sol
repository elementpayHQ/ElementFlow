// SPDX-License-Identifier: BSL-1.1
pragma solidity 0.8.22;

/**
 * @title OrderTypes
 * @notice Shared value types for the ElementFlow on-ramp / off-ramp system.
 * @dev Kept in a library so that the order manager, the provider registry and every
 *      provider adapter agree on a single canonical set of types without creating
 *      an inheritance dependency between them.
 */
library OrderTypes {
    /// @notice Direction of the ramp.
    /// @dev OnRamp  = fiat -> crypto (user receives tokens from ElementFlow liquidity).
    ///      OffRamp = crypto -> fiat (user escrows tokens, receives fiat off-chain).
    ///      Values are pinned to the legacy `IOrderManagement.OrderType` ordering so
    ///      existing backend callers keep working without an enum remap.
    enum OrderType {
        OnRamp,
        OffRamp
    }

    /// @notice Lifecycle of an order.
    /// @dev `None` is the implicit zero value, which lets us distinguish "never existed"
    ///      from a real state without a separate existence flag. Terminal states are
    ///      `Settled` and `Refunded`; there is no path out of either.
    enum OrderStatus {
        None,
        Pending,
        Settled,
        Refunded
    }

    /**
     * @notice Canonical order record.
     * @dev Field ordering is chosen for storage packing:
     *      slot 0: requester(20) + orderType(1) + status(1) + feeBps(2) + createdAt(8) = 32 bytes
     *      slot 1: token(20) + expiresAt(8)                                            = 28 bytes
     *      slot 2: amount
     *      slot 3: providerId
     *      slot 4+: messageHash (dynamic)
     */
    struct Order {
        address requester; //  Beneficiary / owner of the order.
        OrderType orderType;
        OrderStatus status;
        uint16 feeBps; //      Fee snapshot taken at creation time.
        uint64 createdAt;
        address token; //      ERC20 settled in.
        uint64 expiresAt; //   After this timestamp the order may be refunded permissionlessly.
        uint256 amount; //     Gross amount in token base units.
        bytes32 providerId; // Settlement route; bytes32(0) == internal liquidity.
        string messageHash; // Opaque off-chain metadata reference (kept for backend compatibility).
    }

    /**
     * @notice Read-only view of an order handed to provider adapters.
     * @dev Adapters receive a memory copy so they can never mutate manager state, and the
     *      struct is versioned by shape: adding a field is a breaking change for adapters,
     *      which is exactly the signal we want when settlement semantics change.
     */
    struct OrderContext {
        bytes32 orderId;
        address requester;
        address token;
        uint256 amount; //     Gross amount.
        uint256 netAmount; //  Amount owed to the beneficiary after fees.
        uint256 feeAmount; //  Amount owed to the fee recipient.
        OrderType orderType;
        bytes32 providerId;
        string messageHash;
    }
}
