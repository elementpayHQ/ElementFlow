// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {OrderTypes} from "../libraries/OrderTypes.sol";
import {IOnRampProvider} from "../interfaces/IOnRampProvider.sol";

/**
 * @notice Configurable partner adapter used to exercise the provider abstraction,
 *         including the ways a real third-party integration can misbehave.
 *
 * @dev Stands in for a Yellow Card-style partner: it holds its own liquidity and
 *      settles the crypto leg on instruction from the order manager. The failure
 *      switches let the tests prove that the manager's balance-delta verification
 *      catches an adapter that under-pays, pays the wrong address, or silently no-ops.
 */
contract MockOnRampProvider is IOnRampProvider {
    using SafeERC20 for IERC20;

    bytes32 private immutable _providerId;

    mapping(address => bool) public supportedTokens;

    /// @dev Fraction of `netAmount` actually delivered, in basis points of 10_000.
    ///      10_000 = pay in full, 5_000 = pay half, 0 = pay nothing.
    uint256 public payoutBps = 10_000;
    bool public settleShouldRevert;
    bool public createHookShouldRevert;
    bool public refundHookShouldRevert;
    /// @dev When set, the adapter pays this address instead of the real beneficiary.
    address public misdirectTo;

    uint256 public onOrderCreatedCalls;
    uint256 public onOrderRefundedCalls;
    uint256 public settleOnRampCalls;
    uint256 public settleOffRampCalls;
    bytes32 public lastOrderId;

    constructor(bytes32 providerId_) {
        _providerId = providerId_;
    }

    /* --------------------------------------------------------------- controls */

    function setSupportedToken(address token, bool supported) external {
        supportedTokens[token] = supported;
    }

    function setPayoutBps(uint256 bps) external {
        payoutBps = bps;
    }

    function setSettleShouldRevert(bool value) external {
        settleShouldRevert = value;
    }

    function setCreateHookShouldRevert(bool value) external {
        createHookShouldRevert = value;
    }

    function setRefundHookShouldRevert(bool value) external {
        refundHookShouldRevert = value;
    }

    function setMisdirectTo(address to) external {
        misdirectTo = to;
    }

    /* --------------------------------------------------------- IOnRampProvider */

    function providerId() external view override returns (bytes32) {
        return _providerId;
    }

    function isTokenSupported(address token) external view override returns (bool) {
        return supportedTokens[token];
    }

    function availableLiquidity(address token) external view override returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    function settleOnRamp(OrderTypes.OrderContext calldata ctx, address beneficiary, address feeRecipient)
        external
        override
    {
        require(!settleShouldRevert, "MockOnRampProvider: settle reverted");
        settleOnRampCalls++;
        lastOrderId = ctx.orderId;

        address payTo = misdirectTo == address(0) ? beneficiary : misdirectTo;
        uint256 payAmount = (ctx.netAmount * payoutBps) / 10_000;

        if (payAmount > 0) IERC20(ctx.token).safeTransfer(payTo, payAmount);
        if (ctx.feeAmount > 0) IERC20(ctx.token).safeTransfer(feeRecipient, ctx.feeAmount);
    }

    function settleOffRamp(OrderTypes.OrderContext calldata ctx) external override {
        require(!settleShouldRevert, "MockOnRampProvider: settle reverted");
        settleOffRampCalls++;
        lastOrderId = ctx.orderId;
    }

    function onOrderCreated(OrderTypes.OrderContext calldata ctx) external override {
        require(!createHookShouldRevert, "MockOnRampProvider: create hook reverted");
        onOrderCreatedCalls++;
        lastOrderId = ctx.orderId;
    }

    function onOrderRefunded(OrderTypes.OrderContext calldata ctx) external override {
        require(!refundHookShouldRevert, "MockOnRampProvider: refund hook reverted");
        onOrderRefundedCalls++;
        lastOrderId = ctx.orderId;
    }
}

/// @notice Adapter that reports a `providerId` different from the one it is registered
///         under, used to prove the registry rejects mis-keyed routes.
contract MockMismatchedProvider is MockOnRampProvider {
    constructor() MockOnRampProvider(keccak256("SOME_OTHER_ID")) {}
}
