// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import "./interfaces/IOrderManagement.sol"; // Importing the interface

contract OrderManagement is IOrderManagement {
    // Enum to represent the status of an order
    enum OrderStatus { Pending, Completed, Cancelled }

    // Enum to represent the type of an order
    enum OrderType { OnRamp, OffRamp }

    // Struct to represent an order this is just a sample you can modify it as you like
    struct Order {
        uint256 orderId;
        address requester;
        address provider;
        address token;
        uint256 amount;
        OrderStatus status;
        OrderType orderType;
    }

    // Mapping to store the orders
    mapping(uint256 => Order) public orders;

    // Function to create an order
    function createOrder(uint256 _orderId) external override {
        @TODO: Implement the createOrder function to create an order

        // Hint: You can use the _orderId to create the order
        // call the event OrderCreated
        // call the move to escrow function to transfer the funds from the provider to the escrow
        // return the order id

    }

    // Function to get an order
    function getOrder(uint256 _orderId) external view override returns (Order memory) {
        // should return the order with the given order id
        return orders[_orderId];

    }


    // function settle the order
    function settleOrder(uint256 _orderId) external override {
        //this function should move the token from escrow to the provider if its aa success offramp
        // if its a failed offramp, the token should be moved to the requester

        //if its an onramp, the token should be moved from the escrow to the user(buyer)

        // call the event OrderSettled
    }


    // Function to cancel an order and refund the requester

    function cancelOrder(uint256 _orderId) external override {
        //this function should refund the requester if the order is cancelled
        // call the event OrderCancelled
    }
}