// SPDX-License-Identifier: BSL-1.1
pragma solidity 0.8.22;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {OrderTypes} from "./libraries/OrderTypes.sol";
import {IOnRampProvider} from "./interfaces/IOnRampProvider.sol";

/**
 * @title TreasuryPool
 * @notice ElementFlow's in-house liquidity provider, expressed as a settlement adapter.
 *
 * @dev This is the reference {IOnRampProvider} implementation and the default settlement
 *      route. Modelling our own treasury as an adapter — rather than hard-coding it into
 *      the order manager — is what makes a Yellow Card-style partner a drop-in addition
 *      later: a partner adapter satisfies the same interface and is registered the same
 *      way, with no change to the contract that custodies user escrow.
 *
 *      Liquidity is deliberately held here rather than in the order manager so that
 *      house float and user escrow sit in separate contracts with separate authority.
 */
contract TreasuryPool is
    IOnRampProvider,
    Initializable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    /// @notice Held by the order manager. The only role permitted to move funds out
    ///         through the settlement path.
    bytes32 public constant ORDER_MANAGER_ROLE = keccak256("ORDER_MANAGER_ROLE");
    /// @notice Funds and defunds the pool.
    bytes32 public constant TREASURER_ROLE = keccak256("TREASURER_ROLE");

    error ZeroAddress();
    error ZeroAmount();
    error TokenNotSupported(address token);
    error InsufficientPoolLiquidity(address token, uint256 required, uint256 available);

    event TokenSupportUpdated(address indexed token, bool supported);
    event Funded(address indexed token, address indexed from, uint256 amount);
    event Defunded(address indexed token, address indexed to, uint256 amount);
    event OnRampSettled(bytes32 indexed orderId, address indexed token, address indexed beneficiary, uint256 netAmount);
    event OffRampReceived(bytes32 indexed orderId, address indexed token, uint256 amount);
    event OrderRegistered(bytes32 indexed orderId, address indexed token, uint256 amount);
    event OrderRefundNotified(bytes32 indexed orderId, address indexed token, uint256 amount);

    bytes32 private _providerId;
    mapping(address => bool) public isTokenSupported_;
    /// @notice On-ramp float already committed to pending orders, per token.
    /// @dev Subtracted from {availableLiquidity} so concurrent creations and `defund`
    ///      cannot oversubscribe the same pool balance.
    mapping(address => uint256) public reservedLiquidity;

    uint256[46] private __gap;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address admin, address orderManager, bytes32 providerId_) external initializer {
        if (admin == address(0) || orderManager == address(0)) revert ZeroAddress();
        __AccessControl_init();
        __Pausable_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

        _providerId = providerId_;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(UPGRADER_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
        _grantRole(TREASURER_ROLE, admin);
        _grantRole(ORDER_MANAGER_ROLE, orderManager);
    }

    function _authorizeUpgrade(address) internal override onlyRole(UPGRADER_ROLE) {}

    /* ---------------------------------------------------------- IOnRampProvider */

    /// @inheritdoc IOnRampProvider
    function providerId() external view override returns (bytes32) {
        return _providerId;
    }

    /// @inheritdoc IOnRampProvider
    function isTokenSupported(address token) public view override returns (bool) {
        return isTokenSupported_[token];
    }

    /// @inheritdoc IOnRampProvider
    function availableLiquidity(address token) public view override returns (uint256) {
        uint256 balance = IERC20(token).balanceOf(address(this));
        uint256 reserved = reservedLiquidity[token];
        return balance > reserved ? balance - reserved : 0;
    }

    /**
     * @inheritdoc IOnRampProvider
     * @dev Pushes funds to the beneficiary. Reverts rather than returning a failure flag
     *      so that a shortfall unwinds the manager's settlement atomically; the manager
     *      independently verifies the beneficiary's balance delta afterwards.
     */
    function settleOnRamp(OrderTypes.OrderContext calldata ctx, address beneficiary, address feeRecipient)
        external
        override
        onlyRole(ORDER_MANAGER_ROLE)
        whenNotPaused
        nonReentrant
    {
        if (!isTokenSupported_[ctx.token]) revert TokenNotSupported(ctx.token);

        uint256 required = ctx.netAmount + ctx.feeAmount;
        // Release the creation-time reservation, then require the tokens still be on hand.
        // Using raw balance (not availableLiquidity) so the just-released funds are eligible
        // to pay this order without being double-counted against other reservations.
        reservedLiquidity[ctx.token] -= required;
        uint256 balance = IERC20(ctx.token).balanceOf(address(this));
        if (balance < required) revert InsufficientPoolLiquidity(ctx.token, required, balance);

        if (ctx.netAmount > 0) IERC20(ctx.token).safeTransfer(beneficiary, ctx.netAmount);
        if (ctx.feeAmount > 0) IERC20(ctx.token).safeTransfer(feeRecipient, ctx.feeAmount);

        emit OnRampSettled(ctx.orderId, ctx.token, beneficiary, ctx.netAmount);
    }

    /**
     * @inheritdoc IOnRampProvider
     * @dev The manager has already transferred `ctx.netAmount` in. For the in-house pool
     *      the off-ramp proceeds simply become on-ramp float, so there is nothing to do
     *      beyond recording it — a partner adapter would kick off the fiat payout here.
     */
    function settleOffRamp(OrderTypes.OrderContext calldata ctx)
        external
        override
        onlyRole(ORDER_MANAGER_ROLE)
        whenNotPaused
    {
        emit OffRampReceived(ctx.orderId, ctx.token, ctx.netAmount);
    }

    /// @inheritdoc IOnRampProvider
    /// @dev Pre-flights liquidity so an on-ramp order is rejected at creation time rather
    ///      than failing at settlement, when the user is already waiting on a fiat leg.
    function onOrderCreated(OrderTypes.OrderContext calldata ctx)
        external
        override
        onlyRole(ORDER_MANAGER_ROLE)
        whenNotPaused
    {
        if (!isTokenSupported_[ctx.token]) revert TokenNotSupported(ctx.token);

        if (ctx.orderType == OrderTypes.OrderType.OnRamp) {
            uint256 required = ctx.netAmount + ctx.feeAmount;
            uint256 available = availableLiquidity(ctx.token);
            if (available < required) revert InsufficientPoolLiquidity(ctx.token, required, available);
            reservedLiquidity[ctx.token] += required;
        }

        emit OrderRegistered(ctx.orderId, ctx.token, ctx.amount);
    }

    /// @inheritdoc IOnRampProvider
    /// @dev Intentionally does not check pause state: refunds must stay possible even
    ///      while the pool is halted, otherwise pausing would trap user funds upstream.
    function onOrderRefunded(OrderTypes.OrderContext calldata ctx) external override onlyRole(ORDER_MANAGER_ROLE) {
        if (ctx.orderType == OrderTypes.OrderType.OnRamp) {
            reservedLiquidity[ctx.token] -= ctx.netAmount + ctx.feeAmount;
        }
        emit OrderRefundNotified(ctx.orderId, ctx.token, ctx.amount);
    }

    /* --------------------------------------------------------------- treasury */

    function setTokenSupported(address token, bool supported) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (token == address(0)) revert ZeroAddress();
        isTokenSupported_[token] = supported;
        emit TokenSupportUpdated(token, supported);
    }

    /// @notice Add liquidity to the pool.
    function fund(address token, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (!isTokenSupported_[token]) revert TokenNotSupported(token);
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit Funded(token, msg.sender, amount);
    }

    /// @notice Remove liquidity from the pool.
    function defund(address token, address to, uint256 amount) external onlyRole(TREASURER_ROLE) nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        uint256 available = availableLiquidity(token);
        if (available < amount) revert InsufficientPoolLiquidity(token, amount, available);
        IERC20(token).safeTransfer(to, amount);
        emit Defunded(token, to, amount);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(AccessControlUpgradeable)
        returns (bool)
    {
        return interfaceId == type(IOnRampProvider).interfaceId || super.supportsInterface(interfaceId);
    }
}
