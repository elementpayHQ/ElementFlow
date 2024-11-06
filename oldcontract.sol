// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract SimpleOrderHandler {
    IERC20 public usdcToken;

    struct Order {
        address user;
        uint256 amount;
        bool isSettled;
    }

    mapping(bytes32 => Order) public orders;

    event OrderCreated(bytes32 indexed orderId, address indexed user, uint256 amount);
    event OrderSettled(bytes32 indexed orderId, address indexed user, uint256 amount);
    event USDCDeposited(address indexed user, uint256 amount);
    event USDCWithdrawn(address indexed admin, uint256 amount);

    constructor(address _usdcTokenAddress) {
        usdcToken = IERC20(_usdcTokenAddress);
    }

    // Function to allow users to deposit USDC into the contract
    function depositUSDC(uint256 _amount) external {
        require(_amount > 0, "Amount must be greater than zero");

        // Transfer USDC from the user to the contract
        require(usdcToken.transferFrom(msg.sender, address(this), _amount), "Transfer failed");

        emit USDCDeposited(msg.sender, _amount);
    }

    // Function to withdraw USDC from the contract (admin only)
    function withdrawUSDC(uint256 _amount) external {
        require(_amount > 0, "Amount must be greater than zero");

        // Transfer USDC from the contract to the caller (assumed to be an admin)
        require(usdcToken.transfer(msg.sender, _amount), "Transfer failed");

        emit USDCWithdrawn(msg.sender, _amount);
    }

    function createOrder(address _userAddress, uint256 _amount) external returns (bytes32) {
        require(_amount > 0, "Amount must be greater than zero");

        // Generate order ID
        bytes32 orderId = keccak256(abi.encodePacked(_userAddress, block.timestamp, _amount));

        // Store order details
        orders[orderId] = Order({
            user: _userAddress,
            amount: _amount,
            isSettled: false
        });

        emit OrderCreated(orderId, _userAddress, _amount);

        return orderId;
    }

    function settleOrder(bytes32 _orderId) external {
        Order storage order = orders[_orderId];
        require(!order.isSettled, "Order already settled");

        // Transfer USDC from contract to user
        require(usdcToken.transfer(order.user, order.amount), "Transfer failed");

        // Mark order as settled
        order.isSettled = true;

        emit OrderSettled(_orderId, order.user, order.amount);
    }
}
