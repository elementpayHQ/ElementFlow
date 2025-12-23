// SPDX-License-Identifier: BSL 1.1
pragma solidity ^0.8.22;

/**
 * @title IOrderManagement
 * @dev Enhanced interface for order management with dynamic fees and improved security
 */
interface IOrderManagement {
    // =============================================================================
    // ENUMS & STRUCTS
    // =============================================================================
    
    /// @dev Order types supported by the system
    enum OrderType { OnRamp, OffRamp }
    
    /// @dev Order status enumeration
    enum OrderStatus { Pending, Completed, Cancelled, Failed }

    // =============================================================================
    // EVENTS
    // =============================================================================
    
    event OrderCreated(
        bytes32 indexed orderId,
        address indexed token,
        address indexed requester,
        uint256 grossAmount,
        uint256 netAmount,
        string messageHash,
        OrderType orderType
    );
    
    event OrderSettled(
        bytes32 indexed orderId,
        uint256 netAmount
    );
    
    event OrderRefunded(
        bytes32 indexed orderId,
        uint256 refundAmount
    );
    
    event EscrowReleased(bytes32 indexed orderId);
    event FeesCalculated(
        bytes32 indexed orderId,
        uint256 grossAmount,
        uint256 protocolFee,
        uint256 providerFee,
        uint256 netAmount
    );
    event FeesWithdrawn(address indexed recipient, address indexed token, uint256 amount);

    // =============================================================================
    // CORE FUNCTIONS
    // =============================================================================

    /**
     * @notice Creates a new order with dynamic fee structure
     * @param _userAddress Address of the requester creating the order
     * @param _grossAmount Gross token amount involved in the order (before fees)
     * @param _token Address of the ERC20 token used
     * @param _orderType Type of the order (on-ramp/off-ramp)
     * @param messageHash Additional order metadata
     * @param _protocolFeeBPS Protocol fee in basis points
     * @param _protocolFeeWallet Protocol fee recipient wallet
     * @param _providerFeeBPS Provider fee in basis points
     * @param _providerWallet Provider fee recipient wallet
     * @param _minNetAmount Minimum net amount after fees (slippage protection)
     * @return orderId Unique ID of the newly created order
     */
    function createOrder(
        address _userAddress,
        uint256 _grossAmount,
        address _token,
        OrderType _orderType,
        string calldata messageHash,
        uint256 _protocolFeeBPS,
        address _protocolFeeWallet,
        uint256 _providerFeeBPS,
        address _providerWallet,
        uint256 _minNetAmount
    ) external returns (bytes32 orderId);

    /**
     * @notice Settles an order and handles final token transfers
     * @param _orderId ID of the order to settle
     */
    function settleOrder(bytes32 _orderId) external payable;

    /**
     * @notice Refunds an order and returns tokens to requester
     * @param _orderId ID of the order to refund
     */
    function refundOrder(bytes32 _orderId) external;

    /**
     * @notice Escrows funds for an order
     * @param _orderId ID of the order
     * @param _amount Amount to be escrowed
     */
    function escrowFunds(bytes32 _orderId, uint256 _amount) external;

    /**
     * @notice Releases escrowed funds for an order
     * @param _orderId ID of the order
     */
    function releaseEscrow(bytes32 _orderId) external;

    // =============================================================================
    // VIEW FUNCTIONS
    // =============================================================================

    /**
     * @notice Retrieves order details
     * @param _orderId ID of the order
     * @return orderId Order identifier
     * @return requester Address of the order creator
     * @return provider Address of the escrow provider
     * @return token ERC20 token address
     * @return amount Token amount
     * @return status Current order status
     * @return orderType Type of order (on-ramp/off-ramp)
     * @return messageHash Order metadata hash
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
        );

    /**
     * @notice Returns the balance of the specified ERC20 token held by the contract
     * @param token The address of the ERC20 token
     * @return The token balance of the contract
     */
    function getContractBalance(address token) external view returns (uint256);

    /**
     * @notice Gets the treasury balance for a specific token
     * @param token The token address to check
     * @return The treasury's balance of the specified token
     */
    function getTreasuryBalance(address token) external view returns (uint256);

    /**
     * @notice Gets the current aggregator address
     * @return The current aggregator address
     */
    function aggregatorAddress() external view returns (address);

    /**
     * @notice Helper function to check current token allowance
     * @param _token The token address
     * @param _owner The owner of the tokens
     * @return The current allowance for this contract
     */
    function checkAllowance(address _token, address _owner) external view returns (uint256);
}