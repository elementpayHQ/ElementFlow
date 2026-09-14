// SPDX-License-Identifier: BSL-1.1
pragma solidity 0.8.22;

import {OrderTypes} from "../libraries/OrderTypes.sol";

/**
 * @title IOnRampProvider
 * @notice Settlement adapter interface. One implementation per liquidity/settlement route
 *         (in-house treasury liquidity, a Yellow Card-style partner, an OTC desk, ...).
 *
 * @dev Trust model — read this before writing an adapter.
 *
 *      The order manager NEVER trusts an adapter's return value as proof of payment.
 *      For on-ramp settlement the manager measures the beneficiary's token balance
 *      before and after {settleOnRamp} and reverts unless the observed delta covers
 *      `netAmount`. An adapter that lies, silently no-ops, or pays the wrong address
 *      therefore cannot mark an order settled. Adapters are permissioned (registered by
 *      governance) but this balance-delta check means a compromised adapter still cannot
 *      forge a settlement — it can only fail closed.
 *
 *      Consequently adapters are expected to PUSH funds, not to be pulled from: the
 *      manager holds no allowance on the adapter and makes no assumptions about where
 *      the adapter sources liquidity.
 */
interface IOnRampProvider {
    /// @notice Stable identifier for this route, e.g. keccak256("ELEMENTFLOW_TREASURY").
    /// @dev Must be immutable for the lifetime of the adapter; the registry keys on it.
    function providerId() external view returns (bytes32);

    /// @notice Whether this adapter can settle the given token.
    function isTokenSupported(address token) external view returns (bool);

    /// @notice Liquidity currently available to settle `token`, in base units.
    /// @dev Advisory only — used for observability and pre-flight checks. Settlement
    ///      correctness never depends on this value being accurate.
    function availableLiquidity(address token) external view returns (uint256);

    /**
     * @notice Settle an on-ramp order by delivering tokens to the beneficiary.
     * @dev MUST transfer at least `ctx.netAmount` of `ctx.token` to `beneficiary`, and
     *      `ctx.feeAmount` to `feeRecipient`. MUST revert on failure rather than
     *      returning false, so the whole settlement transaction unwinds atomically.
     *      Only callable by the registered order manager.
     */
    function settleOnRamp(
        OrderTypes.OrderContext calldata ctx,
        address beneficiary,
        address feeRecipient
    ) external;

    /**
     * @notice Settle an off-ramp order: the manager has already escrowed the user's tokens.
     * @dev The manager transfers `ctx.netAmount` to this adapter immediately BEFORE this
     *      call, so the adapter is funded on entry and is responsible for the fiat leg.
     *      MUST revert if it cannot accept the funds.
     */
    function settleOffRamp(OrderTypes.OrderContext calldata ctx) external;

    /**
     * @notice Lifecycle notification: an order routed to this adapter was created.
     * @dev Advisory hook for reservation/accounting. MUST NOT revert for reasons the
     *      manager cannot act on — a revert here blocks order creation entirely.
     */
    function onOrderCreated(OrderTypes.OrderContext calldata ctx) external;

    /**
     * @notice Lifecycle notification: an order routed to this adapter was refunded.
     * @dev Called after the manager has already released its own accounting. Reverting
     *      here blocks refunds, so implementations should keep this minimal.
     */
    function onOrderRefunded(OrderTypes.OrderContext calldata ctx) external;
}
