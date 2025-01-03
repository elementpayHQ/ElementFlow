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

    // Treasury address that will store the funds
    address public treasury;

    // Basis points denominator (used for fee calculations)
    uint256 internal constant MAX_BPS = 100_000;

    /// Enum representing the current status of an order
    enum OrderStatus { Pending, Completed, Cancelled }

    /// Enum representing the type of an order
    // enum OrderType { OnRamp, OffRamp }

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
        uint256 rate,
        OrderType orderType
    );
    event OrderSettled(bytes32 indexed orderId);
    event OrderRefunded(bytes32 indexed orderId);
    event EscrowReleased(bytes32 indexed orderId);

    /**
     * @notice Contract constructor to set the aggregator address.
     * @param aggregator The address of the aggregator.
     */
    constructor(address aggregator, address _treasury) {
        require(aggregator != address(0), "Invalid aggregator address");
        require(_treasury != address(0), "Invalid treasury address");
        _aggregatorAddress = aggregator;
        treasury = _treasury;
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
     * @param _orderType Type of the order (on-ramp/off-ramp).
     * @param messageHash Additional order metadata.
     * @return orderId Unique ID of the newly created order.
     */
    function createOrder(
        address _userAddress,
        uint256 _amount,
        address _token,
        OrderType _orderType,
        string calldata messageHash
    ) external override whenNotPaused returns (bytes32 orderId) {
        require(_userAddress != address(0), "Invalid requester address");
        require(_token != address(0), "Invalid token address");
        require(_orderType == OrderType.OnRamp || _orderType == OrderType.OffRamp, "Invalid order type");
        require(_amount > 0, "Amount must be greater than 0");
        require(bytes(messageHash).length != 0, "Invalid message hash");

        // If off-ramp, ensure user has enough balance; else if on-ramp, ensure treasury has enough balance
        if (_orderType == OrderType.OffRamp) {
            require(IERC20(_token).balanceOf(_userAddress) >= _amount, "Insufficient balance");
        } else {
            require(IERC20(_token).balanceOf(treasury) >= _amount, "Insufficient balance");
        }

        orderId = keccak256(abi.encodePacked(block.timestamp, _userAddress, _amount, _token));
        require(orders[orderId].requester == address(0), "Order already exists");

        orders[orderId] = Order({
            orderId: orderId,
            requester: _userAddress,
            provider: address(0),
            token: _token,
            amount: _amount,
            status: OrderStatus.Pending,
            orderType: _orderType,
            messageHash: messageHash
        });

        // Transfer tokens from the requester to the contract if it is an off-ramp order
        //ensure that the contract has the required allowance to spend the tokens if not request the user to approve the contract to spend the tokens
        if (_orderType == OrderType.OffRamp) {
            IERC20(_token).transferFrom(_userAddress, address(this), _amount);
        }


        emit OrderCreated(orderId, _token, _userAddress, _amount, messageHash, 0, _orderType);
    }

    /**
     * @notice Cancels an order and refunds the tokens to the requester.
     * @param _orderId ID of the order.
     */
    function refundOrder(bytes32 _orderId) external override onlyAggregator whenNotPaused {
        Order storage order = orders[_orderId];
        require(order.status == OrderStatus.Pending, "Order is not pending");
        require(order.orderType == OrderType.OffRamp, "Only OffRamp orders can be refunded");

        // Refund the tokens to the requester
        IERC20(order.token).transfer(order.requester, order.amount);

        order.status = OrderStatus.Cancelled;
        emit OrderRefunded(_orderId);
    }

    /**
     * @notice Settles an order and transfers tokens to the treasury.
     * @param _orderId ID of the order.
     */
    function settleOrder(bytes32 _orderId) external override payable onlyAggregator whenNotPaused {
        Order storage order = orders[_orderId];
        require(order.status == OrderStatus.Pending, "Order is not pending");
        require(order.orderType == OrderType.OffRamp, "Only OffRamp orders can be settled");

        // Transfer tokens to the treasury if the order is an off-ramp order else transfer to the requester if it is an on-ramp order
        if (order.orderType == OrderType.OffRamp) {
            IERC20(order.token).transfer(treasury, order.amount);
        } else {
            IERC20(order.token).transfer(order.requester, order.amount);
        }

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
            //retunr the value at the index of the enum
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
     * @notice Escrows funds for an order.
     * @param _orderId ID of the order.
     * @param _amount Amount to be escrowed.
     */
    function escrowFunds(bytes32 _orderId, uint256 _amount) external override whenNotPaused {
        Order storage order = orders[_orderId];
        require(order.status == OrderStatus.Pending, "Order is not pending");
        require(order.amount >= _amount, "Escrow amount exceeds order amount");
        
        // Assuming `order.provider` will hold the address that provides escrow service
        order.provider = msg.sender;

        emit EscrowReleased(_orderId); // Emit relevant event
    }

    /**
     * @notice Releases escrowed funds for an order.
     * @param _orderId ID of the order.
     */
    function releaseEscrow(bytes32 _orderId) external override whenNotPaused {
        Order storage order = orders[_orderId];
        require(order.provider == msg.sender, "Caller is not the escrow provider");
        require(order.status == OrderStatus.Pending, "Order is not pending");

        // Handle fund release logic
        order.status = OrderStatus.Completed;

        emit EscrowReleased(_orderId); // Emit relevant event
    }

    //update the treasury address this action can only be done by the owner
    function updateTreasury(address _treasury) external onlyOwner {
        require(_treasury != address(0), "Invalid treasury address");
        treasury = _treasury;
    }

    //get the treasury address balance

    function getTreasuryBalance(address token) external view returns (uint256) {
        require(token != address(0), "Invalid token address");
        return IERC20(token).balanceOf(treasury);
    }


    /**
     * @notice Pauses the contract.
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice Unpauses the contract.
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @notice Approves the contract to spend a specified amount of tokens on behalf of the user.
     * @param _token The address of the ERC20 token.
     * @param _amount The amount of tokens to approve.
     */
    function approveTokens(address _token, uint256 _amount) external {
        require(_token != address(0), "Invalid token address");
        require(_amount > 0, "Amount must be greater than 0");

        // Call the approve function on the ERC20 token contract
        IERC20(_token).approve(address(this), _amount);
    }

}
