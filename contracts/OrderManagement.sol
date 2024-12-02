// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./interfaces/IOrderManagement.sol";

/**
 * @title OrderManagement
 * @dev A smart contract for managing on-ramp and off-ramp orders with token-based payments,
 * including escrow, refunds, and settlements.
 */
contract OrderManagement is IOrderManagement, PausableUpgradeable, OwnableUpgradeable {
    // Address with aggregator privileges for restricted functions
    address internal _aggregatorAddress;

    // Basis points denominator (used for fee calculations)
    uint256 internal constant MAX_BPS = 100_000;

    /// Enum representing the current status of an order
    enum OrderStatus { Pending, Completed, Cancelled }

    /// Enum representing the type of an order
    enum OrderType { OnRamp, OffRamp }

    /// Struct for storing detailed order data
    struct Order {
        bytes32 orderId;       // Unique identifier for the order
        address requester;     // Address of the order creator
        address provider;      // Address of the escrow provider
        address token;         // ERC20 token used for the transaction
        uint256 amount;        // Token amount involved in the order
        OrderStatus status;    // Current status of the order
        OrderType orderType;   // Type of the order (on-ramp/off-ramp)
        string messageHash;    // Additional order metadata stored as a hash
    }

    // Mapping of order IDs to Order structs
    mapping(bytes32 => Order) public orders;

    // Events for tracking key lifecycle actions
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
     * @notice Contract constructor to set the aggregator address.
     * @param aggregator The address of the aggregator.
     */
    constructor(address aggregator) {
        require(aggregator != address(0), "Invalid aggregator address");
        _aggregatorAddress = aggregator;
    }

    /**
     * @dev Restricts access to aggregator-only functions.
     */
    modifier onlyAggregator() {
        require(msg.sender == _aggregatorAddress, "Caller is not the aggregator");
        _;
    }

    /**
     * @notice Creates a new order.
     * @param _userAddress Address of the requester creating the order.
     * @param _amount Token amount involved in the order.
     * @param _token Address of the ERC20 token used.
     * @param messageHash Additional order metadata.
     * @return orderId Unique ID of the newly created order.
     */
    function createOrder(
        address _userAddress,
        uint256 _amount,
        address _token,
        string calldata messageHash
    ) external override whenNotPaused returns (bytes32 orderId) {
        require(_userAddress != address(0), "Invalid requester address");
        require(_amount > 0, "Amount must be greater than 0");
        require(bytes(messageHash).length != 0, "Invalid message hash");

        orderId = keccak256(abi.encodePacked(block.timestamp, _userAddress, _amount, _token));
        require(orders[orderId].requester == address(0), "Order already exists");

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

        emit OrderCreated(orderId, _token, _userAddress, _amount, messageHash, 0);
    }

    /**
     * @notice Assigns a provider and marks funds as escrowed for an order.
     * @param _orderId ID of the order.
     * @param _amount Amount being escrowed (must match order amount).
     */
    function escrowFunds(bytes32 _orderId, uint256 _amount) external override whenNotPaused {
        Order storage order = orders[_orderId];
        require(order.status == OrderStatus.Pending, "Order is not pending");
        require(order.amount == _amount, "Escrow amount mismatch");
        require(order.provider == address(0), "Order already has a provider");

        order.provider = msg.sender;
        emit EscrowReleased(_orderId);
    }

    /**
     * @notice Cancels an order and marks it for refund.
     * @param _orderId ID of the order.
     */
    function refundOrder(bytes32 _orderId) external override whenNotPaused {
        Order storage order = orders[_orderId];
        require(order.status == OrderStatus.Pending, "Order is not pending");

        order.status = OrderStatus.Cancelled;
        emit OrderRefunded(_orderId);
    }

    /**
     * @notice Releases escrow and completes an order.
     * @param _orderId ID of the order.
     */
    function releaseEscrow(bytes32 _orderId) external override whenNotPaused {
        Order storage order = orders[_orderId];
        require(order.status == OrderStatus.Pending, "Order is not pending");
        require(order.provider == msg.sender, "Caller is not the provider");

        order.status = OrderStatus.Completed;
        emit EscrowReleased(_orderId);
    }

    //function to take in the ordermangement ca

    /**
    * @notice Returns the balance of the specified ERC20 token held by the contract.
    * @param token The address of the ERC20 token.
    * @return The token balance of the contract.
    */
    function getContractBalance(address token) external view returns (uint256) {
        require(token != address(0), "Invalid token address");
        return IERC20(token).balanceOf(address(this));
    }

    /**
    * @notice Returns the address of the contract.
    * @return The contract address.
    */
    function getContractAddress() external view returns (address) {
        return address(this);
    }

    /**
     * @notice Settles an order and transfers tokens to the requester.
     * @param _orderId ID of the order.
     */
    function settleOrder(bytes32 _orderId) payable external override onlyAggregator whenNotPaused {
        Order storage order = orders[_orderId];
        require(order.status == OrderStatus.Pending, "Order is not pending");

        IERC20 token = IERC20(order.token);
        require(token.balanceOf(address(this)) >= order.amount, "Insufficient contract balance");
        token.transfer(order.requester, order.amount);

        order.status = OrderStatus.Completed;
        emit OrderSettled(_orderId);
    }

    /**
     * @notice Retrieves order details.
     * @param _orderId ID of the order.
     */
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