// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

interface IOrderManagement {
    // Function to create a new order
    enum OrderType { OnRamp, OffRamp }

    struct FeePayload {
        address user;
        address token;
        uint256 amount;
        uint32  nonce;
        uint16  protocolFeeBps;
        uint16  integratorFeeBps;
        address integrator;
        address integratorRecipient;
        bytes32 orderId;
    }

    // Creates an order with dynamic fee terms validated via EIP-712 signature
    function createOrder(
        FeePayload calldata payload,
        OrderType _orderType,
        string calldata messageHash,
        bytes calldata signature
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