// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;
import '@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol';

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./interfaces/IOrderManagement.sol"; // Importing the interface

contract OrderManagement is IOrderManagement, PausableUpgradeable {
    address internal _aggregatorAddress;
	uint256 internal MAX_BPS;

    // Enum to represent the status of an order
    enum OrderStatus { Pending, Completed, Cancelled }

    // Enum to represent the type of an order
    enum OrderType { OnRamp, OffRamp }

    // Struct to represent an order
    struct Order {
        bytes32 orderId;
        address requester;
        address provider;
        address token;
        uint256 amount;
        OrderStatus status;
        OrderType orderType;
        string messageHash;

    }

    // Mapping to store orders
    mapping(bytes32 => Order) public orders;

    /// @custom:oz-upgrades-unsafe-allow constructor
        constructor() {
            _disableInitializers();
        }

	/**
	 * @dev Initialize function.
	 */
	function initialize() external initializer {
		MAX_BPS = 100_000;
		__Ownable2Step_init();
		__Pausable_init();
	}

	/**
	 * @dev Modifier that allows only the aggregator to call a function.
	 */
	modifier onlyAggregator() {
		require(msg.sender == _aggregatorAddress, 'OnlyAggregator');
		_;
	}


	/* ##################################################################
                                OWNER FUNCTIONS
    ################################################################## */
	// /**
	//  * @dev Pause the contract.
	//  */
	// function pause() external onlyOwner {
	// 	_pause();
	// }

	// /**
	//  * @dev Unpause the contract.
	//  */
	// function unpause() external onlyOwner {
	// 	_unpause();
	// }



	/* ##################################################################
                                USER CALLS FUNCTIONS

    - The following functions are the ones that the user will call to interact with the contract

    ################################################################## */
    // Events
    event OrderCreated(bytes32 indexed orderId, address requester, uint256 amount, string messageHash, uint256 rate);
    event OrderSettled(bytes32 indexed orderId);
    event OrderRefunded(bytes32 indexed orderId);
    event EscrowReleased(bytes32 indexed orderId);


    function createOrder(address _userAddress, uint256 _amount, uint96 _rate, string calldata messageHash) external override returns (bytes32) {
        require(_amount > 0, "Amount must be greater than 0");

        bytes32 orderId = keccak256(abi.encodePacked(block.timestamp, _userAddress, _amount));
        require(orders[orderId].requester == address(0), "Order already exists");
		require(bytes(messageHash).length != 0, 'InvalidMessageHash');

        orders[orderId] = Order({
            orderId: orderId,
            requester: _userAddress,
            provider: address(0), // Will be set during escrow or matching
            token: address(0),    // Token address can be set dynamically
            amount: _amount,
            status: OrderStatus.Pending,
            orderType: OrderType.OnRamp
        });

        emit OrderCreated(orderId, _userAddress, _amount, messageHash, _rate);
        return orderId;
    }




    // Escrow funds for an order this will come in handy when we are dealing with offramp orders but for now 
    // we will just settle an order  by transferring from our contract to the provider
    // function escrowFunds(bytes32 _orderId, uint256 _amount) external override {
    //     Order storage order = orders[_orderId];
    //     require(order.status == OrderStatus.Pending, "Order is not pending");
    //     require(order.amount == _amount, "Incorrect amount");

    //     // Logic to transfer funds to escrow (e.g., using ERC20)

    //     order.provider = msg.sender; // Assume the caller is the provider
    //     emit EscrowReleased(_orderId);
    // }





    // // Refund an order
    // function refundOrder(bytes32 _orderId) external override {
    //     Order storage order = orders[_orderId];
    //     require(order.status == OrderStatus.Pending, "Order is not pending");

    //     // Logic to refund funds to the requester
    //     // ...

    //     order.status = OrderStatus.Cancelled;
    //     emit OrderRefunded(_orderId);
    // }

    // // Release escrow funds for an order
    // function releaseEscrow(bytes32 _orderId) external override {
    //     Order storage order = orders[_orderId];
    //     require(order.status == OrderStatus.Pending, "Order is not pending");

    //     // Logic to release escrow funds (e.g., transfer to the provider)
    //     // ...

    //     order.status = OrderStatus.Completed;
    //     emit EscrowReleased(_orderId);
    // }


	/* ##################################################################
                                AGGREGATOR FUNCTIONS
    ################################################################## */


    function settleOrder(bytes32 _orderId) external override onlyAggregator {
        Order storage order = orders[_orderId];
        require(order.status == OrderStatus.Pending, "Order is not pending");

        //confirm the contract has enough funds to settle the order
        require(IERC20(order.token).balanceOf(address(this)) >= order.amount, "Insufficient funds to settle order");

        // Logic to transfer funds to the requester
        IERC20(order.token).transfer(order.requester, order.amount);

        order.status = OrderStatus.Completed;

        emit OrderSettled(_orderId);

    }



	/* ##################################################################
                                VIEW CALLS
    ################################################################## */
	/** @dev See {getOrderInfo-IGateway}. */
	function getOrderInfo(bytes32 _orderId) external view returns (Order memory) {
		return orders[_orderId];
	}

}
