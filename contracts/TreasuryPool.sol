// SPDX-License-Identifier: BSL 1.1
pragma solidity ^0.8.22;

import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title TreasuryPool
 * @dev External liquidity pool for managing OnRamp/OffRamp orders
 * Provides liquidity management, multi-token support, and scalable architecture
 */
contract TreasuryPool is 
    Initializable, 
    PausableUpgradeable, 
    OwnableUpgradeable, 
    UUPSUpgradeable 
{
    using SafeERC20 for IERC20;

    // Treasury management roles
    address public orderManager;
    mapping(address => bool) public liquidityProviders;
    mapping(address => bool) public authorizedManagers;

    // Token liquidity tracking
    struct TokenPool {
        uint256 totalDeposited;
        uint256 totalWithdrawn;
        uint256 availableLiquidity;
        uint256 reservedLiquidity; // For pending orders
        mapping(address => uint256) providerDeposits;
    }

    mapping(address => TokenPool) public tokenPools;
    mapping(address => mapping(address => uint256)) public providerRewards;

    // Events
    event LiquidityDeposited(address indexed token, address indexed provider, uint256 amount);
    event LiquidityWithdrawn(address indexed token, address indexed provider, uint256 amount);
    event OrderProcessed(address indexed token, bytes32 indexed orderId, uint256 amount, bool isOnRamp);
    event OrderManagerUpdated(address indexed oldManager, address indexed newManager);
    event LiquidityProviderAdded(address indexed provider);
    event LiquidityProviderRemoved(address indexed provider);
    event RewardsDistributed(address indexed token, address indexed provider, uint256 amount);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _owner) public initializer {
        require(_owner != address(0), "Invalid owner address");
        
        __Pausable_init_unchained();
        __Ownable_init_unchained(_owner);
        __UUPSUpgradeable_init_unchained();
    }

    modifier onlyOrderManager() {
        require(msg.sender == orderManager, "Caller is not the order manager");
        _;
    }

    modifier onlyLiquidityProvider() {
        require(liquidityProviders[msg.sender], "Caller is not a liquidity provider");
        _;
    }

    modifier onlyAuthorizedManager() {
        require(authorizedManagers[msg.sender], "Caller is not authorized");
        _;
    }

    /**
     * @notice Set the order manager contract address
     * @param _orderManager Address of the OrderManagement contract
     */
    function setOrderManager(address _orderManager) external onlyOwner {
        require(_orderManager != address(0), "Invalid order manager address");
        address oldManager = orderManager;
        orderManager = _orderManager;
        emit OrderManagerUpdated(oldManager, _orderManager);
    }

    /**
     * @notice Add a liquidity provider
     * @param provider Address of the liquidity provider
     */
    function addLiquidityProvider(address provider) external onlyOwner {
        require(provider != address(0), "Invalid provider address");
        liquidityProviders[provider] = true;
        emit LiquidityProviderAdded(provider);
    }

    /**
     * @notice Remove a liquidity provider
     * @param provider Address of the liquidity provider
     */
    function removeLiquidityProvider(address provider) external onlyOwner {
        liquidityProviders[provider] = false;
        emit LiquidityProviderRemoved(provider);
    }

    /**
     * @notice Add an authorized manager
     * @param manager Address of the authorized manager
     */
    function addAuthorizedManager(address manager) external onlyOwner {
        require(manager != address(0), "Invalid manager address");
        authorizedManagers[manager] = true;
    }

    /**
     * @notice Remove an authorized manager
     * @param manager Address of the authorized manager
     */
    function removeAuthorizedManager(address manager) external onlyOwner {
        authorizedManagers[manager] = false;
    }

    /**
     * @notice Deposit liquidity into the pool
     * @param token Address of the token to deposit
     * @param amount Amount of tokens to deposit
     */
    function depositLiquidity(address token, uint256 amount) external whenNotPaused {
        require(token != address(0), "Invalid token address");
        require(amount > 0, "Amount must be greater than 0");

        TokenPool storage pool = tokenPools[token];
        
        // Transfer tokens from user to this contract
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        
        // Update pool state
        pool.totalDeposited += amount;
        pool.availableLiquidity += amount;
        pool.providerDeposits[msg.sender] += amount;
        
        emit LiquidityDeposited(token, msg.sender, amount);
    }

    /**
     * @notice Withdraw liquidity from the pool
     * @param token Address of the token to withdraw
     * @param amount Amount of tokens to withdraw
     */
    function withdrawLiquidity(address token, uint256 amount) external whenNotPaused {
        require(token != address(0), "Invalid token address");
        require(amount > 0, "Amount must be greater than 0");

        TokenPool storage pool = tokenPools[token];
        require(pool.providerDeposits[msg.sender] >= amount, "Insufficient deposit balance");
        require(pool.availableLiquidity >= amount, "Insufficient available liquidity");
        
        // Update pool state
        pool.totalWithdrawn += amount;
        pool.availableLiquidity -= amount;
        pool.providerDeposits[msg.sender] -= amount;
        
        // Transfer tokens to user
        IERC20(token).safeTransfer(msg.sender, amount);
        
        emit LiquidityWithdrawn(token, msg.sender, amount);
    }

    /**
     * @notice Process an OnRamp order - transfer tokens to user
     * @param token Address of the token
     * @param recipient Address of the recipient
     * @param amount Amount of tokens to transfer
     * @param orderId ID of the order being processed
     */
    function processOnRampOrder(
        address token,
        address recipient,
        uint256 amount,
        bytes32 orderId
    ) external onlyOrderManager whenNotPaused {
        require(token != address(0), "Invalid token address");
        require(recipient != address(0), "Invalid recipient address");
        require(amount > 0, "Amount must be greater than 0");

        TokenPool storage pool = tokenPools[token];
        require(pool.availableLiquidity >= amount, "Insufficient liquidity");
        
        // Reserve liquidity for this order
        pool.availableLiquidity -= amount;
        pool.reservedLiquidity += amount;
        
        // Transfer tokens to recipient
        IERC20(token).safeTransfer(recipient, amount);
        
        // Update pool state
        pool.totalWithdrawn += amount;
        pool.reservedLiquidity -= amount;
        
        emit OrderProcessed(token, orderId, amount, true);
    }

    /**
     * @notice Process an OffRamp order - receive tokens from user
     * @param token Address of the token
     * @param amount Amount of tokens received
     * @param orderId ID of the order being processed
     */
    function processOffRampOrder(
        address token,
        uint256 amount,
        bytes32 orderId
    ) external onlyOrderManager whenNotPaused {
        require(token != address(0), "Invalid token address");
        require(amount > 0, "Amount must be greater than 0");

        TokenPool storage pool = tokenPools[token];
        
        // Update pool state
        pool.totalDeposited += amount;
        pool.availableLiquidity += amount;
        
        emit OrderProcessed(token, orderId, amount, false);
    }

    /**
     * @notice Get token pool details
     * @param token Address of the token
     * @return totalDeposited Total tokens deposited
     * @return totalWithdrawn Total tokens withdrawn
     * @return availableLiquidity Available liquidity
     * @return reservedLiquidity Reserved liquidity for pending orders
     */
    function getTokenPoolDetails(address token) external view returns (
        uint256 totalDeposited,
        uint256 totalWithdrawn,
        uint256 availableLiquidity,
        uint256 reservedLiquidity
    ) {
        TokenPool storage pool = tokenPools[token];
        return (
            pool.totalDeposited,
            pool.totalWithdrawn,
            pool.availableLiquidity,
            pool.reservedLiquidity
        );
    }

    /**
     * @notice Get provider's deposit balance for a specific token
     * @param token Address of the token
     * @param provider Address of the provider
     * @return depositBalance Provider's deposit balance
     */
    function getProviderDepositBalance(address token, address provider) external view returns (uint256) {
        return tokenPools[token].providerDeposits[provider];
    }

    /**
     * @notice Get available liquidity for a token
     * @param token Address of the token
     * @return available Available liquidity amount
     */
    function getAvailableLiquidity(address token) external view returns (uint256) {
        return tokenPools[token].availableLiquidity;
    }

    /**
     * @notice Emergency withdrawal function for owner
     * @param token Address of the token to withdraw
     * @param amount Amount to withdraw
     * @param recipient Address to receive the tokens
     */
    function emergencyWithdraw(
        address token,
        uint256 amount,
        address recipient
    ) external onlyOwner {
        require(recipient != address(0), "Invalid recipient address");
        IERC20(token).safeTransfer(recipient, amount);
    }

    /**
     * @dev Authorize upgrade - only owner can upgrade
     */
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
