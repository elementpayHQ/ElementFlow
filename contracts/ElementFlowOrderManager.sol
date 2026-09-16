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
import {IElementFlowOrderManager} from "./interfaces/IElementFlowOrderManager.sol";
import {IOnRampProvider} from "./interfaces/IOnRampProvider.sol";
import {IProviderRegistry} from "./interfaces/IProviderRegistry.sol";

/**
 * @title ElementFlowOrderManager
 * @notice Escrow and settlement engine for ElementFlow on-ramp (fiat -> crypto) and
 *         off-ramp (crypto -> fiat) orders.
 *
 * @dev ## Upgrade path
 *
 *      This contract is a storage-compatible successor to the v1 `OrderManagement`
 *      implementation that is already live behind UUPS proxies on Base / Base Sepolia.
 *      The first three storage slots are reproduced byte-for-byte and MUST NOT be
 *      reordered, retyped or removed:
 *
 *          slot 0  address                        _aggregatorAddress
 *          slot 1  address                        treasury
 *          slot 2  mapping(bytes32 => LegacyOrder) legacyOrders
 *
 *      All v1 parent contracts (Ownable/Pausable/UUPS) used OpenZeppelin v5 namespaced
 *      (ERC-7201) storage, so swapping `OwnableUpgradeable` for `AccessControlUpgradeable`
 *      does not disturb the layout above. This lets us fix the v1 vulnerabilities by
 *      upgrading the existing proxies in place rather than migrating users to a new
 *      address — which matters because two of those vulnerabilities are live.
 *
 *      ## Accounting invariant
 *
 *      For every allowlisted token the contract maintains:
 *
 *          balanceOf(this) >= escrowedBalance[token] + reservedLiquidity[token]
 *
 *      `escrowedBalance` is user money held against pending off-ramp orders.
 *      `reservedLiquidity` is house float committed to pending on-ramp orders.
 *      Only the surplus above both is withdrawable or rescuable. v1 conflated all three,
 *      which allowed on-ramp settlement to pay out of off-ramp user escrow.
 */
contract ElementFlowOrderManager is
    IElementFlowOrderManager,
    Initializable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    /* ------------------------------------------------------------------ roles */

    /// @notice Authorises implementation upgrades. Held by governance (multisig/timelock).
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    /// @notice Emergency stop. Intentionally cheap to hold — a hot key is acceptable here
    ///         because pausing is a fail-safe action; unpausing is admin-only.
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    /// @notice Backend settlement authority: settles and refunds orders.
    bytes32 public constant AGGREGATOR_ROLE = keccak256("AGGREGATOR_ROLE");
    /// @notice May create orders on behalf of a user (relayed/meta-transaction flow).
    bytes32 public constant ORDER_CREATOR_ROLE = keccak256("ORDER_CREATOR_ROLE");
    /// @notice Manages on-ramp float: deposits, withdrawals, surplus rescue.
    bytes32 public constant TREASURER_ROLE = keccak256("TREASURER_ROLE");

    /* -------------------------------------------------------------- constants */

    /// @dev Basis-point denominator. Retained from v1 (100_000, not 10_000) so that any
    ///      fee figure carried over from off-chain config keeps its meaning.
    uint256 public constant MAX_BPS = 100_000;
    /// @notice Hard ceiling on the protocol fee: 5% of MAX_BPS. Governance cannot exceed
    ///         this even by mistake, which bounds the worst case of a compromised admin.
    uint16 public constant MAX_FEE_BPS = 5_000;
    /// @dev Bounds on the order time-to-live, guarding against both a zero TTL
    ///      (instantly refundable orders) and an effectively infinite one.
    uint64 public constant MIN_ORDER_TTL = 15 minutes;
    uint64 public constant MAX_ORDER_TTL = 30 days;

    /* --------------------------------------------------- v1 storage (slots 0-2) */

    /// @dev v1 lifecycle enum. Preserved only so `LegacyOrder` keeps its exact layout.
    enum LegacyOrderStatus {
        Pending,
        Completed,
        Cancelled
    }

    /// @dev v1 order record. Field order/types are frozen — see the upgrade note above.
    struct LegacyOrder {
        bytes32 orderId;
        address requester;
        address provider;
        address token;
        uint256 amount;
        LegacyOrderStatus status;
        OrderTypes.OrderType orderType;
        string messageHash;
    }

    /**
     * @dev v1 inherited `OwnableUpgradeable`, which claimed the ERC-7201 namespace
     *      `openzeppelin.storage.Ownable`. v2 replaces Ownable with AccessControl, but the
     *      namespace declaration has to stay: dropping it would leave those slots
     *      unaccounted for, so a future version could unknowingly reuse them and collide
     *      with the still-populated v1 owner value. Authorisation is decided entirely by
     *      AccessControl — this struct is inert.
     * @custom:storage-location erc7201:openzeppelin.storage.Ownable
     */
    struct DeprecatedOwnableStorage {
        address _owner;
    }

    /// @custom:oz-renamed-from _aggregatorAddress
    address private _legacyAggregatorAddress; // slot 0 — unused in v2, kept for layout.
    /// @notice Destination for settled off-ramp principal.
    address public treasury; // slot 1
    /// @custom:oz-renamed-from orders
    mapping(bytes32 => LegacyOrder) public legacyOrders; // slot 2

    /* ------------------------------------------------------- v2 storage (new) */

    /// @notice Canonical order records created by v2.
    mapping(bytes32 => OrderTypes.Order) private _orders;
    /// @notice User funds held against pending off-ramp orders. Never spendable as float.
    mapping(address => uint256) public escrowedBalance;
    /// @notice House float committed to pending internally-settled on-ramp orders.
    mapping(address => uint256) public reservedLiquidity;
    /// @notice Token allowlist. Enforced on creation only, so an in-flight order can
    ///         always be settled or refunded even after its token is delisted.
    mapping(address => bool) public isTokenAllowed;

    /// @notice Recipient of protocol fees. Separated from `treasury` so fee revenue and
    ///         settlement float can live in different custody arrangements.
    address public feeRecipient;
    /// @notice Current protocol fee. Snapshotted onto each order at creation time so a
    ///         later fee change cannot retroactively alter a pending order's economics.
    uint16 public feeBps;
    /// @notice Seconds after creation at which an order becomes permissionlessly refundable.
    uint64 public orderTtl;

    /// @notice Registry resolving `providerId` -> settlement adapter.
    IProviderRegistry public providerRegistry;
    /// @notice Route applied when a caller does not name one. bytes32(0) == internal liquidity.
    bytes32 public defaultProviderId;

    /// @notice Optional OffRamp refund destination per order. Zero means pay `order.requester`.
    /// @dev Parallel mapping (not a field on OrderTypes.Order) so existing packed order
    ///      storage stays upgrade-compatible. Set only at create when payer ≠ refundAddress.
    mapping(bytes32 => address) private _refundAddress;

    /// @dev Reserved for future variables. Shrink this — never move it — when adding state.
    uint256[37] private __gap;

    /* --------------------------------------------------------------- modifiers */

    /// @dev Rejects an order id that was never created, distinguishing it from a
    ///      created-then-terminal order (which fails the `Pending` check instead).
    modifier orderExists(bytes32 orderId) {
        if (_orders[orderId].status == OrderTypes.OrderStatus.None) revert OrderNotFound(orderId);
        _;
    }

    /* ----------------------------------------------------------- construction */

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialise a brand-new proxy.
     * @dev Uses `reinitializer(2)` rather than `initializer` so that a fresh deployment
     *      lands on the same initialization version as an upgraded v1 proxy. That makes
     *      {initializeV2} unreachable here, closing the window where someone could
     *      re-run migration logic against a fresh proxy.
     */
    /// @custom:oz-upgrades-validate-as-initializer
    function initialize(
        address admin,
        address aggregator,
        address treasury_,
        address feeRecipient_,
        uint16 feeBps_,
        uint64 orderTtl_
    ) external reinitializer(2) {
        __AccessControl_init();
        __Pausable_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

        _bootstrapRoles(admin, aggregator);
        _setTreasury(treasury_);
        _setFeeRecipient(feeRecipient_);
        _setFeeBps(feeBps_);
        _setOrderTtl(orderTtl_);
    }

    /**
     * @notice Migrate a live v1 proxy onto this implementation.
     * @param legacyEscrowTokens Tokens with v1 off-ramp escrow still held by the proxy.
     * @param legacyEscrowAmounts Matching escrowed amounts.
     * @dev The escrow seed is essential. v1 kept no escrow accounting, so on entry the
     *      proxy's entire balance would otherwise look like unencumbered on-ramp float
     *      and could be paid out from under off-ramp users with pending orders. Compute
     *      these amounts by summing v1 orders that are still `Pending` and `OffRamp`.
     */
    /// @custom:oz-upgrades-validate-as-initializer
    function initializeV2(
        address admin,
        address aggregator,
        address feeRecipient_,
        uint16 feeBps_,
        uint64 orderTtl_,
        address[] calldata legacyEscrowTokens,
        uint256[] calldata legacyEscrowAmounts
    ) external reinitializer(2) {
        // OZ 5.x `__Pausable_init` is a no-op against namespaced Pausable storage, so any
        // emergency halt already set on the live v1 proxy is preserved across migration.
        __AccessControl_init();
        __Pausable_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

        _bootstrapRoles(admin, aggregator);
        // `treasury` is inherited from v1 storage; validate rather than overwrite it.
        if (treasury == address(0)) revert ZeroAddress();
        _setFeeRecipient(feeRecipient_);
        _setFeeBps(feeBps_);
        _setOrderTtl(orderTtl_);

        uint256 len = legacyEscrowTokens.length;
        if (len != legacyEscrowAmounts.length) revert ArrayLengthMismatch();
        for (uint256 i; i < len; ++i) {
            address token = legacyEscrowTokens[i];
            if (token == address(0)) revert ZeroAddress();
            escrowedBalance[token] = legacyEscrowAmounts[i];
        }
    }

    function _bootstrapRoles(address admin, address aggregator) private {
        if (admin == address(0) || aggregator == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(UPGRADER_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
        _grantRole(TREASURER_ROLE, admin);
        _grantRole(AGGREGATOR_ROLE, aggregator);
        _grantRole(ORDER_CREATOR_ROLE, aggregator);
        // Mirrors the v1 field purely so legacy tooling reading `aggregatorAddress()`
        // keeps resolving; v2 authorisation is decided solely by AGGREGATOR_ROLE.
        _legacyAggregatorAddress = aggregator;
    }

    function _authorizeUpgrade(address) internal override onlyRole(UPGRADER_ROLE) {}

    /* -------------------------------------------------------- order creation */

    /// @inheritdoc IElementFlowOrderManager
    /// @dev Passes creator (`requester`) + `refundAddress`. Pull/allowance always from
    ///      requester. Refund pays `refundAddress` when non-zero; otherwise requester.
    ///      (`refundAddress == requester` is treated the same as unset.)
    function createOrder(
        address requester,
        address refundAddress,
        uint256 amount,
        address token,
        OrderTypes.OrderType orderType,
        string calldata messageHash
    ) external override returns (bytes32) {
        return
            _createOrder(
                requester,
                refundAddress,
                amount,
                token,
                orderType,
                messageHash,
                defaultProviderId,
                keccak256(bytes(messageHash))
            );
    }

    /// @inheritdoc IElementFlowOrderManager
    function createOrderWithProvider(
        address requester,
        address refundAddress,
        uint256 amount,
        address token,
        OrderTypes.OrderType orderType,
        string calldata messageHash,
        bytes32 providerId,
        bytes32 intentKey
    ) external override returns (bytes32) {
        return
            _createOrder(
                requester,
                refundAddress,
                amount,
                token,
                orderType,
                messageHash,
                providerId,
                intentKey
            );
    }

    function _createOrder(
        address payer,
        address refundAddress,
        uint256 amount,
        address token,
        OrderTypes.OrderType orderType,
        string calldata messageHash,
        bytes32 providerId,
        bytes32 intentKey
    ) private whenNotPaused nonReentrant returns (bytes32 orderId) {
        if (payer == address(0) || token == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (bytes(messageHash).length == 0) revert EmptyMessageHash();
        if (uint8(orderType) > uint8(OrderTypes.OrderType.OffRamp)) revert InvalidOrderType();
        if (!isTokenAllowed[token]) revert TokenNotAllowed(token);

        // Either the user acts for themselves, or a trusted relayer acts for them.
        // v1 let anybody create an order for any address, which allowed an attacker to
        // burn a victim's ERC20 allowance and to grief order-id derivation.
        if (msg.sender != payer && !hasRole(ORDER_CREATOR_ROLE, msg.sender)) {
            revert NotOrderCreator(msg.sender, payer);
        }

        orderId = computeOrderId(payer, amount, token, orderType, intentKey);
        if (_orders[orderId].status != OrderTypes.OrderStatus.None) revert OrderAlreadyExists(orderId);

        uint16 snapshotFeeBps = feeBps;

        // --- effects -------------------------------------------------------
        _orders[orderId] = OrderTypes.Order({
            requester: payer,
            orderType: orderType,
            status: OrderTypes.OrderStatus.Pending,
            feeBps: snapshotFeeBps,
            createdAt: uint64(block.timestamp),
            token: token,
            expiresAt: uint64(block.timestamp) + orderTtl,
            amount: amount,
            providerId: providerId,
            messageHash: messageHash
        });

        // address(0) => payer. Only store when distinct — sparse + getRefundAddress default.
        {
            address refundTo = refundAddress == address(0) ? payer : refundAddress;
            if (refundTo != payer) {
                _refundAddress[orderId] = refundTo;
            }
        }

        if (orderType == OrderTypes.OrderType.OffRamp) {
            escrowedBalance[token] += amount;
        } else if (providerId == bytes32(0)) {
            // Internally-settled on-ramp: commit house float now so that concurrent
            // orders cannot each pass a balance check and collectively oversubscribe it.
            uint256 free = availableLiquidity(token);
            if (free < amount) revert InsufficientLiquidity(token, amount, free);
            reservedLiquidity[token] += amount;
        }

        // --- interactions ---------------------------------------------------
        if (orderType == OrderTypes.OrderType.OffRamp) {
            _pullExact(token, payer, amount);
        }

        if (providerId != bytes32(0)) {
            uint256 feeAmount = (amount * snapshotFeeBps) / MAX_BPS;
            IOnRampProvider(_resolveProvider(providerId)).onOrderCreated(
                _buildContext(orderId, _orders[orderId], amount, feeAmount)
            );
        }

        emit OrderCreated(orderId, token, payer, amount, messageHash, 0, orderType);
    }

    /* ------------------------------------------------------------ settlement */

    /// @inheritdoc IElementFlowOrderManager
    function settleOrder(bytes32 orderId)
        external
        override
        onlyRole(AGGREGATOR_ROLE)
        whenNotPaused
        nonReentrant
        orderExists(orderId)
    {
        OrderTypes.Order storage order = _orders[orderId];
        if (order.status != OrderTypes.OrderStatus.Pending) revert OrderNotPending(orderId, order.status);

        // --- effects (before any external call) -----------------------------
        order.status = OrderTypes.OrderStatus.Settled;

        address token = order.token;
        address requester = order.requester;
        uint256 amount = order.amount;
        bytes32 providerId = order.providerId;
        uint256 feeAmount = (amount * order.feeBps) / MAX_BPS;
        uint256 netAmount = amount - feeAmount;

        OrderTypes.OrderContext memory ctx = _buildContext(orderId, order, amount, feeAmount);

        if (order.orderType == OrderTypes.OrderType.OffRamp) {
            escrowedBalance[token] -= amount;
            _settleOffRamp(ctx, token, netAmount, feeAmount, providerId);
        } else {
            if (providerId == bytes32(0)) {
                reservedLiquidity[token] -= amount;
                _payout(token, requester, netAmount);
                _payout(token, feeRecipient, feeAmount);
            } else {
                _settleOnRampViaProvider(ctx, token, requester, netAmount, providerId);
            }
        }

        emit OrderSettled(orderId, token, requester, netAmount, feeAmount, providerId);
    }

    function _settleOffRamp(
        OrderTypes.OrderContext memory ctx,
        address token,
        uint256 netAmount,
        uint256 feeAmount,
        bytes32 providerId
    ) private {
        if (providerId == bytes32(0)) {
            _payout(token, treasury, netAmount);
        } else {
            // Fund the adapter first so it is solvent when it runs the fiat leg.
            address adapter = _resolveProvider(providerId);
            _payout(token, adapter, netAmount);
            IOnRampProvider(adapter).settleOffRamp(ctx);
        }
        _payout(token, feeRecipient, feeAmount);
    }

    /**
     * @dev Provider-routed on-ramp settlement.
     *      The adapter's return value is not trusted: we measure the beneficiary's
     *      balance across the call and require the observed delta to cover `netAmount`.
     *      A buggy or malicious adapter can therefore only fail closed — it can never
     *      cause an order to be marked settled without the user actually being paid.
     */
    function _settleOnRampViaProvider(
        OrderTypes.OrderContext memory ctx,
        address token,
        address requester,
        uint256 netAmount,
        bytes32 providerId
    ) private {
        address adapter = _resolveProvider(providerId);
        uint256 balanceBefore = IERC20(token).balanceOf(requester);

        IOnRampProvider(adapter).settleOnRamp(ctx, requester, feeRecipient);

        uint256 delivered = IERC20(token).balanceOf(requester) - balanceBefore;
        if (delivered < netAmount) revert ProviderSettlementShortfall(netAmount, delivered);
    }

    /* --------------------------------------------------------------- refunds */

    /// @inheritdoc IElementFlowOrderManager
    function refundOrder(bytes32 orderId)
        external
        override
        onlyRole(AGGREGATOR_ROLE)
        whenNotPaused
        nonReentrant
        orderExists(orderId)
    {
        _refund(orderId);
    }

    /**
     * @inheritdoc IElementFlowOrderManager
     * @dev Permissionless once the order's TTL has elapsed. This is the system's
     *      liveness guarantee: if the aggregator stalls or censors, an off-ramp user can
     *      always recover their own escrow without needing anyone's cooperation.
     */
    function refundExpiredOrder(bytes32 orderId) external override whenNotPaused nonReentrant orderExists(orderId) {
        uint64 expiresAt = _orders[orderId].expiresAt;
        if (block.timestamp < expiresAt) revert OrderNotExpired(orderId, expiresAt);
        _refund(orderId);
    }

    function _refund(bytes32 orderId) private {
        OrderTypes.Order storage order = _orders[orderId];
        if (order.status != OrderTypes.OrderStatus.Pending) revert OrderNotPending(orderId, order.status);

        // --- effects ---------------------------------------------------------
        order.status = OrderTypes.OrderStatus.Refunded;

        address token = order.token;
        address requester = order.requester;
        // Immutable create-time beneficiary. OrderRefunded.requester emits this payout address.
        address payout = _refundPayout(orderId, requester);
        uint256 amount = order.amount;
        bytes32 providerId = order.providerId;
        uint256 feeAmount = (amount * order.feeBps) / MAX_BPS;

        OrderTypes.OrderContext memory ctx = _buildContext(orderId, order, amount, feeAmount);

        if (order.orderType == OrderTypes.OrderType.OffRamp) {
            escrowedBalance[token] -= amount;
        } else if (providerId == bytes32(0)) {
            // On-ramp: nothing was ever escrowed on-chain (the user pays fiat), so a
            // refund simply releases the committed float. v1 had no path here at all,
            // which left failed on-ramp orders Pending forever and their float stranded.
            reservedLiquidity[token] -= amount;
        }

        // --- interactions ------------------------------------------------------
        if (order.orderType == OrderTypes.OrderType.OffRamp) {
            _payout(token, payout, amount);
        }

        if (providerId != bytes32(0)) {
            // Refunds must still reach a disabled adapter so operators can cut a bad
            // route without locking already-pending user escrow / reserved float.
            IOnRampProvider(_resolveProviderForRefund(providerId)).onOrderRefunded(ctx);
        }

        emit OrderRefunded(orderId, token, payout, amount);
    }

    /* ------------------------------------------------- legacy (v1) order drain */

    /**
     * @notice Settle an order created by the v1 implementation.
     * @dev Migration-only. v1 records live in a different mapping with a different enum,
     *      so they need their own terminal paths. Off-ramp principal goes to the treasury
     *      and on-ramp pays the requester, exactly matching v1 semantics — no fee is
     *      charged, since none was quoted when these orders were created.
     */
    function settleLegacyOrder(bytes32 orderId) external onlyRole(AGGREGATOR_ROLE) whenNotPaused nonReentrant {
        LegacyOrder storage order = legacyOrders[orderId];
        if (order.requester == address(0)) revert OrderNotFound(orderId);
        if (order.status != LegacyOrderStatus.Pending) revert LegacyOrderNotPending(orderId);

        order.status = LegacyOrderStatus.Completed;

        address token = order.token;
        uint256 amount = order.amount;

        if (order.orderType == OrderTypes.OrderType.OffRamp) {
            escrowedBalance[token] -= amount;
            _payout(token, treasury, amount);
        } else {
            // v1 on-ramps never reserved float. Bound the payout to unencumbered
            // liquidity so a migration cannot pay an on-ramp out of pending off-ramp escrow.
            uint256 free = availableLiquidity(token);
            if (free < amount) revert InsufficientLiquidity(token, amount, free);
            _payout(token, order.requester, amount);
        }

        emit OrderSettled(orderId, token, order.requester, amount, 0, bytes32(0));
    }

    /// @notice Refund an order created by the v1 implementation. Migration-only.
    function refundLegacyOrder(bytes32 orderId) external onlyRole(AGGREGATOR_ROLE) whenNotPaused nonReentrant {
        LegacyOrder storage order = legacyOrders[orderId];
        if (order.requester == address(0)) revert OrderNotFound(orderId);
        if (order.status != LegacyOrderStatus.Pending) revert LegacyOrderNotPending(orderId);

        order.status = LegacyOrderStatus.Cancelled;

        address token = order.token;
        uint256 amount = order.amount;

        if (order.orderType == OrderTypes.OrderType.OffRamp) {
            escrowedBalance[token] -= amount;
            _payout(token, order.requester, amount);
        }

        emit OrderRefunded(orderId, token, order.requester, amount);
    }

    /* ----------------------------------------------------- liquidity management */

    /// @notice Deposit on-ramp float. Pull-based so the contract's accounting is authoritative.
    function depositLiquidity(address token, uint256 amount) external whenNotPaused nonReentrant {
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (!isTokenAllowed[token]) revert TokenNotAllowed(token);
        _pullExact(token, msg.sender, amount);
        emit LiquidityDeposited(token, msg.sender, amount);
    }

    /// @notice Withdraw unencumbered on-ramp float.
    /// @dev Bounded by {availableLiquidity}, so this can never reach user escrow or
    ///      float already committed to a pending order.
    function withdrawLiquidity(address token, address to, uint256 amount)
        external
        onlyRole(TREASURER_ROLE)
        nonReentrant
    {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        uint256 free = availableLiquidity(token);
        if (free < amount) revert InsufficientLiquidity(token, amount, free);
        _payout(token, to, amount);
        emit LiquidityWithdrawn(token, to, amount);
    }

    /**
     * @notice Recover tokens that are not accounted for by escrow or reservations.
     * @dev Covers airdrops, mistaken transfers and delisted tokens. The same
     *      {availableLiquidity} bound applies, so admin cannot use this to touch user funds.
     */
    function rescueTokens(address token, address to, uint256 amount) external onlyRole(TREASURER_ROLE) nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 free = availableLiquidity(token);
        if (free < amount) revert InsufficientLiquidity(token, amount, free);
        _payout(token, to, amount);
        emit StuckTokensRescued(token, to, amount);
    }

    /* ------------------------------------------------------------ configuration */

    function setTokenAllowed(address token, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (token == address(0)) revert ZeroAddress();
        isTokenAllowed[token] = allowed;
        emit TokenAllowanceUpdated(token, allowed);
    }

    function setTreasury(address treasury_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setTreasury(treasury_);
    }

    function setFeeRecipient(address feeRecipient_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setFeeRecipient(feeRecipient_);
    }

    function setFeeBps(uint16 feeBps_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setFeeBps(feeBps_);
    }

    function setOrderTtl(uint64 orderTtl_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setOrderTtl(orderTtl_);
    }

    function setProviderRegistry(address registry) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (registry == address(0)) revert ZeroAddress();
        emit ProviderRegistryUpdated(address(providerRegistry), registry);
        providerRegistry = IProviderRegistry(registry);
    }

    /// @dev Validated against the registry on the way in so a typo cannot silently
    ///      point every new order at a non-existent route.
    function setDefaultProviderId(bytes32 providerId) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (providerId != bytes32(0)) _resolveProvider(providerId);
        emit DefaultProviderUpdated(defaultProviderId, providerId);
        defaultProviderId = providerId;
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @dev Unpausing is admin-only by design: restarting the system is a deliberate
    ///      governance decision, whereas halting it should be as frictionless as possible.
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    function _setTreasury(address treasury_) private {
        if (treasury_ == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, treasury_);
        treasury = treasury_;
    }

    function _setFeeRecipient(address feeRecipient_) private {
        if (feeRecipient_ == address(0)) revert ZeroAddress();
        emit FeeRecipientUpdated(feeRecipient, feeRecipient_);
        feeRecipient = feeRecipient_;
    }

    function _setFeeBps(uint16 feeBps_) private {
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh(feeBps_, MAX_FEE_BPS);
        emit FeeBpsUpdated(feeBps, feeBps_);
        feeBps = feeBps_;
    }

    function _setOrderTtl(uint64 orderTtl_) private {
        if (orderTtl_ < MIN_ORDER_TTL || orderTtl_ > MAX_ORDER_TTL) revert InvalidExpiry(orderTtl_);
        emit OrderTtlUpdated(orderTtl, orderTtl_);
        orderTtl = orderTtl_;
    }

    /* ------------------------------------------------------------------ views */

    /// @inheritdoc IElementFlowOrderManager
    /// @dev Bound to chain id and contract address so an intent signed for one deployment
    ///      can never collide with, or be replayed against, another. v1 keyed on
    ///      `block.timestamp`, which made ids both collision-prone (two orders from the
    ///      same user in one block) and front-runnable.
    function computeOrderId(
        address requester,
        uint256 amount,
        address token,
        OrderTypes.OrderType orderType,
        bytes32 intentKey
    ) public view override returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), requester, amount, token, orderType, intentKey));
    }

    /// @notice Float that is neither escrowed for users nor committed to a pending order.
    function availableLiquidity(address token) public view override returns (uint256) {
        uint256 balance = IERC20(token).balanceOf(address(this));
        uint256 committed = escrowedBalance[token] + reservedLiquidity[token];
        return balance > committed ? balance - committed : 0;
    }

    /// @inheritdoc IElementFlowOrderManager
    function getOrderRecord(bytes32 orderId) external view override returns (OrderTypes.Order memory) {
        return _orders[orderId];
    }

    /// @inheritdoc IElementFlowOrderManager
    /// @dev Returns the create-time refund destination. Zero storage means payer (`requester`).
    function getRefundAddress(bytes32 orderId) external view override returns (address) {
        if (_orders[orderId].status == OrderTypes.OrderStatus.None) revert OrderNotFound(orderId);
        return _refundPayout(orderId, _orders[orderId].requester);
    }

    /**
     * @inheritdoc IElementFlowOrderManager
     * @dev Keeping this selector on the v1 shape is load-bearing: the production backend
     *      decodes the result positionally (`order_data[5]` is the status) and treats
     *      0/1/2 as Pending/Settled/Refunded. Returning v2's struct, or v2's raw enum
     *      where `Pending == 1`, would make the backend read every pending order as
     *      already settled. Falls back to the v1 mapping for pre-upgrade orders.
     */
    function getOrder(bytes32 orderId)
        external
        view
        override
        returns (
            bytes32 id,
            address requester,
            address provider,
            address token,
            uint256 amount,
            uint8 status,
            OrderTypes.OrderType orderType,
            string memory messageHash
        )
    {
        OrderTypes.Order memory order = _orders[orderId];
        if (order.status != OrderTypes.OrderStatus.None) {
            return (
                orderId,
                order.requester,
                order.providerId == bytes32(0) ? address(0) : _providerAddressOrZero(order.providerId),
                order.token,
                order.amount,
                uint8(order.status) - 1, // None is absent here, so this cannot underflow.
                order.orderType,
                order.messageHash
            );
        }

        LegacyOrder memory legacy = legacyOrders[orderId];
        if (legacy.requester == address(0)) revert OrderNotFound(orderId);
        return (
            legacy.orderId,
            legacy.requester,
            legacy.provider,
            legacy.token,
            legacy.amount,
            uint8(legacy.status),
            legacy.orderType,
            legacy.messageHash
        );
    }

    /// @notice Allowance this contract holds over `owner`'s `token`.
    /// @dev Retained verbatim from v1 — the backend pre-flights off-ramp orders with it.
    function checkAllowance(address token, address owner) external view returns (uint256) {
        return IERC20(token).allowance(owner, address(this));
    }

    function getContractBalance(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    /// @notice Address currently holding `AGGREGATOR_ROLE` in v1's single-aggregator sense.
    /// @dev Kept so v1 tooling keeps resolving; v2 supports multiple aggregators, so this
    ///      only reports whether the legacy address still has the role.
    function aggregatorAddress() external view returns (address) {
        return _legacyAggregatorAddress;
    }

    function getVersion() external pure virtual returns (string memory) {
        return "2.1.0";
    }

    /* --------------------------------------------------------------- internals */

    /// @dev Stored override or payer when unset.
    function _refundPayout(bytes32 orderId, address payer) private view returns (address) {
        address stored = _refundAddress[orderId];
        return stored == address(0) ? payer : stored;
    }

    /**
     * @dev Transfers `amount` in and asserts the contract actually received it.
     *      Fee-on-transfer and rebasing tokens would otherwise silently under-deliver
     *      and break the accounting invariant; we reject them loudly instead.
     */
    function _pullExact(address token, address from, uint256 amount) private {
        IERC20 erc20 = IERC20(token);
        uint256 before = erc20.balanceOf(address(this));
        erc20.safeTransferFrom(from, address(this), amount);
        uint256 received = erc20.balanceOf(address(this)) - before;
        if (received != amount) revert UnexpectedBalanceDelta(amount, received);
    }

    /// @dev Skips zero-value transfers: some tokens revert on them, and a zero fee is
    ///      the common case when `feeBps` is 0.
    function _payout(address token, address to, uint256 amount) private {
        if (amount == 0) return;
        IERC20(token).safeTransfer(to, amount);
    }

    function _resolveProvider(bytes32 providerId) private view returns (address) {
        IProviderRegistry registry = providerRegistry;
        if (address(registry) == address(0)) revert ProviderRegistryNotSet();
        return registry.requireActiveProvider(providerId);
    }

    /// @dev Like {_resolveProvider} but tolerates a disabled route — refunds only.
    function _resolveProviderForRefund(bytes32 providerId) private view returns (address) {
        IProviderRegistry registry = providerRegistry;
        if (address(registry) == address(0)) revert ProviderRegistryNotSet();
        return registry.requireRegisteredProvider(providerId);
    }

    function _providerAddressOrZero(bytes32 providerId) private view returns (address) {
        if (address(providerRegistry) == address(0)) return address(0);
        return providerRegistry.getProvider(providerId);
    }

    function _buildContext(bytes32 orderId, OrderTypes.Order storage order, uint256 amount, uint256 feeAmount)
        private
        view
        returns (OrderTypes.OrderContext memory)
    {
        return
            OrderTypes.OrderContext({
                orderId: orderId,
                requester: order.requester,
                token: order.token,
                amount: amount,
                netAmount: amount - feeAmount,
                feeAmount: feeAmount,
                orderType: order.orderType,
                providerId: order.providerId,
                messageHash: order.messageHash
            });
    }
}
