// SPDX-License-Identifier: BSL 1.1
pragma solidity ^0.8.22;

import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "./interfaces/IOrderManagement.sol";
import "./OrderManagerSetting.sol";

contract OrderManagement is
    IOrderManagement,
    Initializable,
    PausableUpgradeable,
    OwnableUpgradeable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable
{
    using SafeERC20 for IERC20;
    
    // --- State Variables ---
    address internal _aggregatorAddress;
    address public treasury;
    SettingsManager public settingsManager;
    uint256 internal constant MAX_BPS = 10_000;
    uint256 internal constant DEFAULT_MAX_FEE_BPS = 1_000;
    mapping(address => uint256) private userNonces;

    // --- Order Struct (Optimized) ---
    struct Order {
        bytes32 orderId;
        address requester;
        address provider;
        address token;
        uint256 amount;
        uint256 grossAmount;
        OrderStatus status;
        OrderType orderType;
        string messageHash;
        uint256 protocolFeeBPS;
        address protocolFeeWallet;
        uint256 providerFeeBPS;
        address providerWallet;
        uint256[50] __gap;
    }

    mapping(bytes32 => Order) public orders;

    // --- Struct to bundle creation parameters ---
    struct OrderParams {
        address userAddress;
        uint256 grossAmount;
        address token;
        OrderType orderType;
        string messageHash;
        uint256 protocolFeeBPS;
        address protocolFeeWallet;
        uint256 providerFeeBPS;
        address providerWallet;
        uint256 minNetAmount;
    }

    // --- Initialization ---
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address aggregator,
        address _treasury,
        address _owner,
        address _settingsManager
    ) public initializer {
        require(aggregator != address(0), "Invalid aggregator address");
        require(_treasury != address(0), "Invalid treasury address");
        require(_owner != address(0), "Invalid owner address");
        require(_settingsManager != address(0), "Invalid settings manager");

        __Pausable_init_unchained();
        __Ownable_init_unchained(_owner);
        __UUPSUpgradeable_init_unchained();
        __ReentrancyGuard_init_unchained();

        _aggregatorAddress = aggregator;
        treasury = _treasury;
        settingsManager = SettingsManager(_settingsManager);
    }

    modifier onlyAggregator() {
        require(msg.sender == _aggregatorAddress, "Caller is not the aggregator");
        _;
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    // --- Core Functions (Optimized to avoid stack too deep) ---
    function createOrder(
        address _userAddress,
        uint256 _grossAmount,
        address _token,
        OrderType _orderType,
        string calldata messageHash,
        uint256 _protocolFeeBPS,
        address _protocolFeeWallet,
        uint256 _providerFeeBPS,
        address _providerWallet,
        uint256 _minNetAmount
    ) external override whenNotPaused nonReentrant returns (bytes32 orderId) {
        OrderParams memory params = OrderParams({
            userAddress: _userAddress,
            grossAmount: _grossAmount,
            token: _token,
            orderType: _orderType,
            messageHash: messageHash,
            protocolFeeBPS: _protocolFeeBPS,
            protocolFeeWallet: _protocolFeeWallet,
            providerFeeBPS: _providerFeeBPS,
            providerWallet: _providerWallet,
            minNetAmount: _minNetAmount
        });
        
        return _createOrder(params);
    }

    function _createOrder(OrderParams memory params) internal returns (bytes32 orderId) {
        // Validations
        require(params.userAddress != address(0), "Invalid requester address");
        require(params.token != address(0), "Invalid token address");
        require(params.orderType == OrderType.OnRamp || params.orderType == OrderType.OffRamp, "Invalid order type");
        require(params.grossAmount > 0, "Amount must be > 0");
        require(bytes(params.messageHash).length != 0, "Invalid message hash");
        require(params.protocolFeeBPS <= DEFAULT_MAX_FEE_BPS, "Protocol fee exceeds max");
        require(params.providerFeeBPS <= DEFAULT_MAX_FEE_BPS, "Provider fee exceeds max");
        
        // Set defaults
        address protocolFeeWallet = params.protocolFeeWallet == address(0) ? address(0xDead) : params.protocolFeeWallet;
        address providerWallet = params.providerWallet == address(0) ? address(0xDead) : params.providerWallet;
        uint256 minNetAmount = params.minNetAmount == 0 ? params.grossAmount : params.minNetAmount;
        
        require(settingsManager.isTokenSupported(params.token), "Token not supported");

        // Fee calculations (using inline math to avoid stack issues)
        uint256 protocolFee = (params.grossAmount * params.protocolFeeBPS) / MAX_BPS;
        uint256 providerFee = (params.grossAmount * params.providerFeeBPS) / MAX_BPS;
        uint256 netAmount = params.grossAmount - protocolFee - providerFee;
        
        require(netAmount >= minNetAmount, "Slippage too high");
        require(netAmount > 0, "Net amount must be > 0");

        // Token transfers
        if (params.orderType == OrderType.OffRamp) {
            _handleOffRampTransfer(params.token, params.userAddress, params.grossAmount, protocolFee, protocolFeeWallet, providerFee, providerWallet);
        } else {
            require(
                IERC20(params.token).balanceOf(address(this)) + IERC20(params.token).balanceOf(treasury) >= params.grossAmount,
                "Insufficient funds"
            );
        }

        // Generate orderId
        orderId = keccak256(
            abi.encode(
                block.prevrandao,
                userNonces[params.userAddress]++,
                params.userAddress,
                params.grossAmount,
                params.token
            )
        );
        require(orders[orderId].requester == address(0), "Order exists");

        // Store order
        Order storage newOrder = orders[orderId];
        newOrder.orderId = orderId;
        newOrder.requester = params.userAddress;
        newOrder.token = params.token;
        newOrder.amount = netAmount;
        newOrder.grossAmount = params.grossAmount;
        newOrder.status = OrderStatus.Pending;
        newOrder.orderType = params.orderType;
        newOrder.messageHash = params.messageHash;
        newOrder.protocolFeeBPS = params.protocolFeeBPS;
        newOrder.protocolFeeWallet = protocolFeeWallet;
        newOrder.providerFeeBPS = params.providerFeeBPS;
        newOrder.providerWallet = providerWallet;

        emit OrderCreated(orderId, params.token, params.userAddress, params.grossAmount, netAmount, params.messageHash, params.orderType);
        emit FeesCalculated(orderId, params.grossAmount, protocolFee, providerFee, netAmount);
        
        return orderId;
    }

    function _handleOffRampTransfer(
        address token,
        address userAddress,
        uint256 grossAmount,
        uint256 protocolFee,
        address protocolFeeWallet,
        uint256 providerFee,
        address providerWallet
    ) internal {
        require(IERC20(token).balanceOf(userAddress) >= grossAmount, "Insufficient balance");
        IERC20(token).safeTransferFrom(userAddress, address(this), grossAmount);

        // Distribute fees (Off-Ramp)
        if (protocolFee > 0 && protocolFeeWallet != address(0xDead)) {
            IERC20(token).safeTransfer(protocolFeeWallet, protocolFee);
        }
        if (providerFee > 0 && providerWallet != address(0xDead)) {
            IERC20(token).safeTransfer(providerWallet, providerFee);
        }
    }

    function settleOrder(bytes32 _orderId) external override payable whenNotPaused nonReentrant {
        Order storage order = orders[_orderId];
        require(order.status == OrderStatus.Pending, "Order not pending");

        address token = order.token;
        IERC20 tokenContract = IERC20(token);

        if (order.orderType == OrderType.OnRamp) {
            _settleOnRampOrder(order, tokenContract);
        } else {
            _settleOffRampOrder(order, tokenContract);
        }

        order.status = OrderStatus.Completed;
        emit OrderSettled(_orderId, order.amount);
    }

    function _settleOnRampOrder(Order storage order, IERC20 tokenContract) internal {
        uint256 protocolFee = (order.grossAmount * order.protocolFeeBPS) / MAX_BPS;
        uint256 providerFee = (order.grossAmount * order.providerFeeBPS) / MAX_BPS;
        uint256 netAmount = order.grossAmount - protocolFee - providerFee;

        require(tokenContract.balanceOf(address(this)) >= order.grossAmount, "Insufficient funds");
        tokenContract.safeTransfer(order.requester, netAmount);

        if (protocolFee > 0 && order.protocolFeeWallet != address(0xDead)) {
            tokenContract.safeTransfer(order.protocolFeeWallet, protocolFee);
            emit FeesWithdrawn(order.protocolFeeWallet, order.token, protocolFee);
        }
        if (providerFee > 0 && order.providerWallet != address(0xDead)) {
            tokenContract.safeTransfer(order.providerWallet, providerFee);
            emit FeesWithdrawn(order.providerWallet, order.token, providerFee);
        }
    }

    function _settleOffRampOrder(Order storage order, IERC20 tokenContract) internal {
        require(tokenContract.balanceOf(address(this)) >= order.amount, "Insufficient funds");
        tokenContract.safeTransfer(treasury, order.amount);
    }

    function refundOrder(bytes32 _orderId) external override onlyAggregator whenNotPaused nonReentrant {
        Order storage order = orders[_orderId];
        require(order.status == OrderStatus.Pending, "Order not pending");
        require(order.orderType == OrderType.OffRamp, "Only OffRamp can be refunded");

        IERC20(order.token).safeTransfer(order.requester, order.amount);
        order.status = OrderStatus.Cancelled;
        emit OrderRefunded(_orderId, order.amount);
    }

    function escrowFunds(bytes32 _orderId, uint256 _amount) external override whenNotPaused nonReentrant {
        Order storage order = orders[_orderId];
        require(order.status == OrderStatus.Pending, "Order not pending");
        require(order.amount >= _amount, "Escrow amount exceeds order amount");

        order.provider = msg.sender;
        emit EscrowReleased(_orderId);
    }

    function releaseEscrow(bytes32 _orderId) external override whenNotPaused nonReentrant {
        Order storage order = orders[_orderId];
        require(order.provider == msg.sender, "Not escrow provider");
        require(order.status == OrderStatus.Pending, "Order not pending");

        order.status = OrderStatus.Completed;
        emit EscrowReleased(_orderId);
    }

    // --- Optimized View Functions ---
    function getOrderWithFees(bytes32 _orderId) external view returns (OrderWithFees memory) {
        Order storage order = orders[_orderId];
        require(order.requester != address(0), "Order not found");

        return OrderWithFees({
            orderId: order.orderId,
            requester: order.requester,
            provider: order.provider,
            token: order.token,
            amount: order.amount,
            grossAmount: order.grossAmount,
            status: order.status,
            orderType: order.orderType,
            messageHash: order.messageHash,
            protocolFeeBPS: order.protocolFeeBPS,
            protocolFeeWallet: order.protocolFeeWallet,
            providerFeeBPS: order.providerFeeBPS,
            providerWallet: order.providerWallet
        });
    }

    struct OrderWithFees {
        bytes32 orderId;
        address requester;
        address provider;
        address token;
        uint256 amount;
        uint256 grossAmount;
        OrderStatus status;
        OrderType orderType;
        string messageHash;
        uint256 protocolFeeBPS;
        address protocolFeeWallet;
        uint256 providerFeeBPS;
        address providerWallet;
    }

    function getOrder(bytes32 _orderId) external view override returns (
        bytes32 orderId,
        address requester,
        address provider,
        address token,
        uint256 amount,
        OrderStatus status,
        OrderType orderType,
        string memory messageHash
    ) {
        Order storage order = orders[_orderId];
        require(order.requester != address(0), "Order not found");

        orderId = order.orderId;
        requester = order.requester;
        provider = order.provider;
        token = order.token;
        amount = order.amount;
        status = order.status;
        orderType = order.orderType;
        messageHash = order.messageHash;
    }

    // --- Admin Functions ---
    function updateTreasury(address _treasury) external onlyOwner {
        require(_treasury != address(0), "Invalid treasury address");
        treasury = _treasury;
    }

    function updateAggregatorAddress(address _aggregator) external onlyOwner {
        require(_aggregator != address(0), "Invalid aggregator address");
        _aggregatorAddress = _aggregator;
    }

    function aggregatorAddress() external view override returns (address) {
        return _aggregatorAddress;
    }

    // --- Utility Functions ---
    function getContractBalance(address token) external view override returns (uint256) {
        require(token != address(0), "Invalid token address");
        return IERC20(token).balanceOf(address(this));
    }

    function getTreasuryBalance(address token) external view override returns (uint256) {
        require(token != address(0), "Invalid token address");
        return IERC20(token).balanceOf(treasury);
    }

    function checkAllowance(address _token, address _owner) external view override returns (uint256) {
        return IERC20(_token).allowance(_owner, address(this));
    }

    function withdrawFees(address _token) external nonReentrant {
        require(_token != address(0), "Invalid token address");
        uint256 balance = IERC20(_token).balanceOf(address(this));
        require(balance > 0, "No fees to withdraw");

        IERC20(_token).safeTransfer(msg.sender, balance);
        emit FeesWithdrawn(msg.sender, _token, balance);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function getVersion() external pure returns (string memory) {
        return "2.0.0";
    }
}