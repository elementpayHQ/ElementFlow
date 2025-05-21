// SPDX-License-Identifier: BSL 1.1
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
     * @param _treasury The address of the treasury.
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

        // Check balances based on order type
        if (_orderType == OrderType.OffRamp) {
            require(IERC20(_token).balanceOf(_userAddress) >= _amount, "Insufficient balance");

            //if allowed transfer tokens from user to contract
            require(
                IERC20(_token).transferFrom(_userAddress, address(this), _amount),
                "Token transfer failed"
            );
        } else if (_orderType == OrderType.OnRamp) {
            //ensure we have enough funds in this smartcontract
            require(IERC20(_token).balanceOf(address(this)) >= _amount, "Insufficient funds");
        }
        // Check balances based on order type
        else {
            require(IERC20(_token).balanceOf(treasury) >= _amount, "Insufficient treasury balance");
        }

        // Generate order ID
        orderId = keccak256(abi.encodePacked(block.timestamp, _userAddress, _amount, _token));
        require(orders[orderId].requester == address(0), "Order already exists");

        // Create the order
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



        emit OrderCreated(orderId, _token, _userAddress, _amount, messageHash, 0, _orderType);
    }

    /**
     * @notice Helper function to check current token allowance
     * @param _token The token address
     * @param _owner The owner of the tokens
     * @return The current allowance for this contract
     */
    function checkAllowance(address _token, address _owner) external view returns (uint256) {
        return IERC20(_token).allowance(_owner, address(this));
    }

    /**
     * @notice Cancels an order and refunds the tokens to the requester.
     * @param _orderId ID of the order.
     */
    function refundOrder(bytes32 _orderId) external override payable onlyAggregator whenNotPaused {
        Order storage order = orders[_orderId];
        require(order.status == OrderStatus.Pending, "Order is not pending");
        require(order.orderType == OrderType.OffRamp, "Only OffRamp orders can be refunded");

        // Refund the tokens to the requester
        require(
            IERC20(order.token).transfer(order.requester, order.amount),
            "Refund transfer failed"
        );

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
        
        //if order is onramp we transfer tokens from this smartcontract to user
        if (order.orderType == OrderType.OnRamp) {
            require(IERC20(order.token).balanceOf(address(this))>= order.amount, "Insufficient funds");

            require (
                IERC20(order.token).transferFrom(address(this), order.requester, order.amount ), 
                "Token transfer failed"
            );
        } else {
            //if order is offramp we transfer tokens from contract to the treasury
            require(
                IERC20(order.token).transfer(treasury, order.amount),
                "Token transfer failed"
            );
        }

        //Set the order status to completed
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
    /**
     * @notice Helper function to approve tokens for testing in Remix
     * @param _token The address of the ERC20 token
     * @param _amount The amount to approve
     */
    function approveTokensForContract(address _token, uint256 _amount) external {
        require(_token != address(0), "Invalid token address");
        require(_amount > 0, "Amount must be greater than 0");
        
        // Call approve on the ERC20 token contract
        bool success = IERC20(_token).approve(address(this), _amount);
        require(success, "Token approval failed");
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
        
        order.provider = msg.sender;

        emit EscrowReleased(_orderId);
    }

    /**
     * @notice Releases escrowed funds for an order.
     * @param _orderId ID of the order.
     */
    function releaseEscrow(bytes32 _orderId) external override whenNotPaused {
        Order storage order = orders[_orderId];
        require(order.provider == msg.sender, "Caller is not the escrow provider");
        require(order.status == OrderStatus.Pending, "Order is not pending");

        order.status = OrderStatus.Completed;

        emit EscrowReleased(_orderId);
    }

    /**
     * @notice Updates the treasury address (only owner).
     * @param _treasury The new treasury address.
     */
    function updateTreasury(address _treasury) external onlyOwner {
        require(_treasury != address(0), "Invalid treasury address");
        treasury = _treasury;
    }

    /**
     * @notice Gets the treasury balance for a specific token.
     * @param token The token address to check.
     * @return The treasury's balance of the specified token.
     */
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
}