// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

interface IOrderManagement {
    // Function to create a new order
    enum OrderType { OnRamp, OffRamp }
    // function createOrder(address _userAddress, uint256 _amount, OrderType _orderType,  address _token, string calldata messageHash) external returns (bytes32);
    function createOrder(
        address _userAddress,
        uint256 _amount,
        address _token,
        OrderType _orderType,
        string calldata messageHash
    ) external returns (bytes32);
    // Function to settle an order
    function settleOrder(bytes32 _orderId) payable external;

    // Function to refund an order
    function refundOrder(bytes32 _orderId) external;

    // Function to escrow funds for an order
    function escrowFunds(bytes32 _orderId, uint256 _amount) external;

    // Function to release escrowed funds
    function releaseEscrow(bytes32 _orderId) external;
}