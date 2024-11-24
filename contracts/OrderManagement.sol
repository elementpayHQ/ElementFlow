// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import '@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol';
import '@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol';
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./interfaces/IOrderManagement.sol";

/**
 * @title OrderManagement
 * @dev Smart contract for managing on-ramp and off-ramp orders with token-based payments.
 * Supports order creation, escrow management, refunds, and settlements.
 */
contract OrderManagement is IOrderManagement, PausableUpgradeable, Ownable2StepUpgradeable {
    // Aggregator address for restricted function access
    address internal _aggregatorAddress;

    // Basis points denominator (used for fee calculations)
    uint256 internal constant MAX_BPS = 100_000;

    /// Enum to represent the current status of an order
    enum OrderStatus { Pending, Completed, Cancelled }

    /// Enum to represent the type of an order
    enum OrderType { OnRamp, OffRamp }

    /// Struct to store order details
    struct Order {
        bytes32 orderId;       // Unique order identifier
        address requester;     // Address of the order requester
        address provider;      // Address of the service provider (if any)
        address token;         // Token used in the transaction
        uint256 amount;        // Amount of tokens involved
        OrderStatus status;    // Current status of the order
        OrderType orderType;   // Type of the order (on-ramp/off-ramp)
        string messageHash;    // Message hash for additional order details
    }

    // Mapping of order IDs to Order structs
    mapping(bytes32 => Order) public orders;

    // Events for order lifecycle actions
    event OrderCreated(
        bytes32 indexed orderId,
        address indexed token,
        address indexed requester,
        uint256 amount,
        string messageHash,
        uint256 rate
    );
    event OrderSettled(bytes32 indexed orderId);
    event OrderRefunded(bytes32 indexed orderId);
    event EscrowReleased(bytes32 indexed orderId);

    /**
     * @dev Initializes the contract with the owner and sets up base configurations.
     */
    function initialize() external initializer {
        __Ownable2Step_init();
        __Pausable_init();
    }

    /**
     * @dev Restricts access to functions to the aggregator address only.
     */
    modifier onlyAggregator() {
        require(msg.sender == _aggregatorAddress, "OnlyAggregator");
        _;
    }

    /**
     * @notice Creates a new order.
     * @param _userAddress Address of the requester creating the order.
     * @param _amount Amount of tokens for the order.
     * @param _token Address of the token being traded.
     * @param messageHash Additional details as a hash string.
     * @return orderId The unique identifier for the created order.
     */
    function createOrder(
        address _userAddress,
        uint256 _amount,
        address _token,
        string calldata messageHash
    ) external override returns (bytes32 orderId) {
        require(_amount > 0, "Amount must be greater than 0");
        require(bytes(messageHash).length != 0, "InvalidMessageHash");

        // Generate a unique order ID based on timestamp, user address, amount, and token
        orderId = keccak256(abi.encodePacked(block.timestamp, _userAddress, _amount, _token));
        require(orders[orderId].requester == address(0), "Order already exists");

        // Save order details
        orders[orderId] = Order({
            orderId: orderId,
            requester: _userAddress,
            provider: address(0),
            token: _token,
            amount: _amount,
            status: OrderStatus.Pending,
            orderType: OrderType.OnRamp,
            messageHash: messageHash
        });

        emit OrderCreated(orderId, _token, _userAddress, _amount, messageHash, 0); // `_rate` can be used if needed
    }

    /**
     * @notice Escrows funds for an order by the provider.
     * @param _orderId Unique ID of the order.
     * @param _amount Amount to be escrowed (must match order amount).
     */
    function escrowFunds(bytes32 _orderId, uint256 _amount) external override {
        Order storage order = orders[_orderId];
        require(order.status == OrderStatus.Pending, "Order is not pending");
        require(order.amount == _amount, "Incorrect amount");

        // Assign provider and record escrow
        order.provider = msg.sender;
        emit EscrowReleased(_orderId);
    }

    /**
     * @notice Cancels and refunds an order.
     * @param _orderId Unique ID of the order.
     */
    function refundOrder(bytes32 _orderId) external override {
        Order storage order = orders[_orderId];
        require(order.status == OrderStatus.Pending, "Order is not pending");

        // Mark order as cancelled
        order.status = OrderStatus.Cancelled;
        emit OrderRefunded(_orderId);
    }

    /**
     * @notice Releases escrow funds, marking the order as completed.
     * @param _orderId Unique ID of the order.
     */
    function releaseEscrow(bytes32 _orderId) external override {
        Order storage order = orders[_orderId];
        require(order.status == OrderStatus.Pending, "Order is not pending");

        // Mark order as completed
        order.status = OrderStatus.Completed;
        emit EscrowReleased(_orderId);
    }

    /**
     * @notice Settles an order, transferring the token to the requester.
     * @param _orderId Unique ID of the order.
     */
    function settleOrder(bytes32 _orderId) external override onlyAggregator {
        Order storage order = orders[_orderId];
        require(order.status == OrderStatus.Pending, "Order is not pending");

        // Ensure the contract holds sufficient funds
        require(
            IERC20(order.token).balanceOf(address(this)) >= order.amount,
            "Insufficient funds"
        );

        // Transfer funds to the requester
        IERC20(order.token).transfer(order.requester, order.amount);

        // Mark order as settled
        order.status = OrderStatus.Completed;
        emit OrderSettled(_orderId);
    }


	function getOrder(bytes32 _orderId)
		external
		view
		returns (
			bytes32 orderId,
			address requester,
			address provider,
			address token,
			uint256 amount,
			OrderStatus status,
			OrderType orderType,
			string memory messageHash
		)
	{
		Order memory order = orders[_orderId];
		require(order.requester != address(0), "Order not found");

		return (
			order.orderId,
			order.requester,
			order.provider,
			order.token,
			order.amount,
			order.status,
			order.orderType,
			order.messageHash
		);
	}

}
