// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

interface IOrderManagement {
    // Function to create a new order
    function createOrder(address _userAddress, uint256 _amount) external returns (bytes32);

    // Function to settle an order
    function settleOrder(bytes32 _orderId) external;

    // Function to refund an order
    function refundOrder(bytes32 _orderId) external;

    // Function to escrow funds for an order
    function escrowFunds(bytes32 _orderId, uint256 _amount) external;

    // Function to release escrowed funds
    function releaseEscrow(bytes32 _orderId) external;
}