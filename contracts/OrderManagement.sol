// SPDX-License-Identifier: BSL 1.1
pragma solidity ^0.8.22;

import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts-upgradeable/utils/cryptography/ECDSAUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import "./interfaces/IOrderManagement.sol";

/**
 * @title OrderManagement
 * @dev A smart contract for managing on-ramp and off-ramp orders with token-based payments,
 * including escrow, refunds, and settlements.
 */
contract OrderManagement is 
    IOrderManagement, 
    Initializable, 
    PausableUpgradeable, 
    OwnableUpgradeable, 
    UUPSUpgradeable,
    EIP712Upgradeable
{
    // Address with aggregator privileges for restricted functions
    address internal _aggregatorAddress;

    // Treasury address that will store the funds
    address public treasury;

    // Address that will receive protocol fees
    address public feeRecipient;

    // Default protocol fee in basis points (denominator BPS_DENOMINATOR)
    uint256 public protocolFeeBps;

    // Basis points denominator for fee calculations
    uint256 internal constant BPS_DENOMINATOR = 10_000;

    // Caps
    uint16 public maxProtocolFeeBps;      // Max allowed protocol fee bps
    uint16 public maxIntegratorFeeBps;    // Max allowed integrator fee bps (global)
    uint16 public maxTotalFeeBps;         // Max allowed sum of protocol + integrator fee bps

    // Optional per-token protocol fee defaults
    mapping(address => uint16) public tokenProtocolFeeBps;

    // Integrator registry and per-integrator max cap
    mapping(address => bool) public integratorEnabled;
    mapping(address => uint16) public integratorMaxFeeBps;

    // Signer registry for EIP-712 payloads
    mapping(address => bool) public signerEnabled;
    mapping(address => mapping(uint32 => bool)) public nonceUsed; // signer => nonce => used

    // Unsigned orders control: allow trusted creators to submit without signatures
    bool public allowUnsignedOrders; // default disabled unless set by owner
    mapping(address => bool) public creatorWhitelisted; // additional trusted creators besides aggregator

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
        uint16 protocolFeeBps; // Snapshot protocol fee bps (denominator 10_000)
        uint16 integratorFeeBps; // Snapshot integrator fee bps (denominator 10_000)
        address integrator;            // Integrator address (identity)
        address integratorRecipient;   // Integrator fee recipient
        address signer;                // Signer that authorized fee terms
        uint32 nonce;                  // Nonce used for replay protection
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

    // Events related to dynamic fee management and admin
    event FeesCollected(bytes32 indexed orderId, address indexed token, uint256 protocolFee, uint256 integratorFee, address feeRecipient, address integratorRecipient);
    event IntegratorToggled(address indexed integrator, bool enabled);
    event SignerToggled(address indexed signer, bool enabled);
    event CreatorToggled(address indexed creator, bool enabled);
    event ProtocolFeeBpsUpdated(uint256 oldBps, uint256 newBps);
    event TokenProtocolFeeBpsUpdated(address indexed token, uint16 oldBps, uint16 newBps);
    event MaxProtocolFeeBpsUpdated(uint16 oldBps, uint16 newBps);
    event MaxIntegratorFeeBpsUpdated(uint16 oldBps, uint16 newBps);
    event MaxTotalFeeBpsUpdated(uint16 oldBps, uint16 newBps);
    event FeeRecipientUpdated(address indexed oldRecipient, address indexed newRecipient);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address aggregator, 
        address _treasury, 
        address _owner
    ) public initializer {
        require(aggregator != address(0), "Invalid aggregator address");
        require(_treasury != address(0), "Invalid treasury address");
        require(_owner != address(0), "Invalid owner address");
        
        __Pausable_init_unchained();
        __Ownable_init_unchained(_owner);
        __UUPSUpgradeable_init_unchained();
        __EIP712_init("ElementPay-OrderManagement", "1");
        
        _aggregatorAddress = aggregator;
        treasury = _treasury;
        // Default fee settings
        feeRecipient = _treasury;
        protocolFeeBps = 0; // start with zero default fee; owner can update later
        maxProtocolFeeBps = 2000;    // 20% default cap
        maxIntegratorFeeBps = 5000;  // 50% default cap
        maxTotalFeeBps = 7000;       // 70% default cap
        allowUnsignedOrders = true;  // enable unsigned orders by default for aggregator-led flows
        // Remove _transferOwnership(_owner) since __Ownable_init_unchained sets the owner
    }
    /**
     * @dev Restricts access to aggregator-only functions.
     */
    modifier onlyAggregator() {
        require(msg.sender == _aggregatorAddress, "Caller is not the aggregator");
        _;
    }

    /**
     * @dev Authorize upgrade - only owner can upgrade
     */
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    // ---------------- Admin configuration ----------------
    function setProtocolFeeBps(uint256 newBps) external onlyOwner {
        require(newBps <= BPS_DENOMINATOR, "Fee too high");
        uint256 old = protocolFeeBps;
        protocolFeeBps = newBps;
        emit ProtocolFeeBpsUpdated(old, newBps);
    }

    function setTokenProtocolFeeBps(address token, uint16 newBps) external onlyOwner {
        require(token != address(0), "Invalid token");
        require(newBps <= BPS_DENOMINATOR, "Fee too high");
        uint16 old = tokenProtocolFeeBps[token];
        tokenProtocolFeeBps[token] = newBps;
        emit TokenProtocolFeeBpsUpdated(token, old, newBps);
    }

    function setMaxProtocolFeeBps(uint16 newBps) external onlyOwner {
        require(newBps <= BPS_DENOMINATOR, "Cap too high");
        uint16 old = maxProtocolFeeBps;
        maxProtocolFeeBps = newBps;
        emit MaxProtocolFeeBpsUpdated(old, newBps);
    }

    function setMaxIntegratorFeeBps(uint16 newBps) external onlyOwner {
        require(newBps <= BPS_DENOMINATOR, "Cap too high");
        uint16 old = maxIntegratorFeeBps;
        maxIntegratorFeeBps = newBps;
        emit MaxIntegratorFeeBpsUpdated(old, newBps);
    }

    function setMaxTotalFeeBps(uint16 newBps) external onlyOwner {
        require(newBps <= BPS_DENOMINATOR, "Cap too high");
        uint16 old = maxTotalFeeBps;
        maxTotalFeeBps = newBps;
        emit MaxTotalFeeBpsUpdated(old, newBps);
    }

    function setFeeRecipient(address newRecipient) external onlyOwner {
        require(newRecipient != address(0), "Invalid fee recipient");
        address old = feeRecipient;
        feeRecipient = newRecipient;
        emit FeeRecipientUpdated(old, newRecipient);
    }

    function enableIntegrator(address integrator, bool enabled) external onlyOwner {
        require(integrator != address(0), "Invalid integrator");
        integratorEnabled[integrator] = enabled;
        emit IntegratorToggled(integrator, enabled);
    }

    function setIntegratorMaxFeeBps(address integrator, uint16 newBps) external onlyOwner {
        require(integrator != address(0), "Invalid integrator");
        require(newBps <= BPS_DENOMINATOR, "Cap too high");
        integratorMaxFeeBps[integrator] = newBps;
        emit MaxIntegratorFeeBpsUpdated(0, newBps);
    }

    function setSigner(address signer, bool enabled) external onlyOwner {
        require(signer != address(0), "Invalid signer");
        signerEnabled[signer] = enabled;
        emit SignerToggled(signer, enabled);
    }

    function setCreator(address creator, bool enabled) external onlyOwner {
        require(creator != address(0), "Invalid creator");
        creatorWhitelisted[creator] = enabled;
        emit CreatorToggled(creator, enabled);
    }

    function setAllowUnsignedOrders(bool enabled) external onlyOwner {
        allowUnsignedOrders = enabled;
    }

    // ---------------- EIP-712 support ----------------
    bytes32 private constant FEE_PAYLOAD_TYPEHASH = keccak256(
        "FeePayload(address user,address token,uint256 amount,uint32 nonce,uint16 protocolFeeBps,uint16 integratorFeeBps,address integrator,address integratorRecipient,bytes32 orderId)"
    );

    function _hashFeePayload(IOrderManagement.FeePayload calldata p) internal view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    FEE_PAYLOAD_TYPEHASH,
                    p.user,
                    p.token,
                    p.amount,
                    p.nonce,
                    p.protocolFeeBps,
                    p.integratorFeeBps,
                    p.integrator,
                    p.integratorRecipient,
                    p.orderId
                )
            )
        );
    }

    /**
     * @notice Creates a new order.
     * @param payload Fee and core fields payload authorized by signer.
     * @param _orderType Type of the order (on-ramp/off-ramp).
     * @param messageHash Additional order metadata.
     * @param signature EIP-712 signature from an enabled signer.
     * @return orderId Unique ID of the newly created order.
     */
    function createOrder(
        IOrderManagement.FeePayload calldata payload,
        OrderType _orderType,
        string calldata messageHash,
        bytes calldata signature
    ) external override whenNotPaused returns (bytes32 orderId) {
        require(payload.user != address(0), "Invalid requester address");
        require(payload.token != address(0), "Invalid token address");
        require(_orderType == OrderType.OnRamp || _orderType == OrderType.OffRamp, "Invalid order type");
        require(payload.amount > 0, "Amount must be greater than 0");
        require(bytes(messageHash).length != 0, "Invalid message hash");

        // Determine authorization mode: signed vs unsigned
        address signer = address(0);
        if (signature.length > 0) {
            // Signed path
            bytes32 digest = _hashFeePayload(payload);
            signer = ECDSAUpgradeable.recover(digest, signature);
            require(signerEnabled[signer], "Signer not enabled");
            require(!nonceUsed[signer][payload.nonce], "Nonce used");
            nonceUsed[signer][payload.nonce] = true;
        } else {
            // Unsigned path: require global toggle and trusted caller
            require(allowUnsignedOrders, "Unsigned orders disabled");
            require(msg.sender == _aggregatorAddress || creatorWhitelisted[msg.sender], "Creator not authorized");
            // ignore nonce usage when unsigned
        }

        // Enforce fee caps
        require(payload.protocolFeeBps <= maxProtocolFeeBps, "Protocol fee too high");
        require(payload.integratorFeeBps <= maxIntegratorFeeBps, "Integrator fee too high");
        require(payload.protocolFeeBps + payload.integratorFeeBps <= maxTotalFeeBps, "Total fee too high");

        // Integrator checks
        if (payload.integrator != address(0)) {
            require(integratorEnabled[payload.integrator], "Integrator not enabled");
            uint16 perIntegratorCap = integratorMaxFeeBps[payload.integrator];
            if (perIntegratorCap > 0) {
                require(payload.integratorFeeBps <= perIntegratorCap, "Integrator cap exceeded");
            }
            require(payload.integratorRecipient != address(0), "Invalid integrator recipient");
        } else {
            // If no integrator, integrator fee must be zero
            require(payload.integratorFeeBps == 0, "Integrator fee without integrator");
            require(payload.integratorRecipient == address(0), "Unexpected integrator recipient");
        }

        // Check balances based on order type
        if (_orderType == OrderType.OffRamp) {
            require(IERC20(payload.token).balanceOf(payload.user) >= payload.amount, "Insufficient balance");

            //if allowed transfer tokens from user to contract
            require(
                IERC20(payload.token).transferFrom(payload.user, address(this), payload.amount),
                "Token transfer failed"
            );
        } else if (_orderType == OrderType.OnRamp) {
            //ensure we have enough funds in this smartcontract
            require(IERC20(payload.token).balanceOf(address(this)) >= payload.amount, "Insufficient funds");
        }
        // Check balances based on order type
        else {
            require(IERC20(payload.token).balanceOf(treasury) >= payload.amount, "Insufficient treasury balance");
        }

        // Use provided orderId and ensure it is unused
        orderId = payload.orderId;
        require(orders[orderId].requester == address(0), "Order already exists");

        // Create the order
        orders[orderId] = Order({
            orderId: orderId,
            requester: payload.user,
            provider: address(0),
            token: payload.token,
            amount: payload.amount,
            status: OrderStatus.Pending,
            orderType: _orderType,
            messageHash: messageHash,
            protocolFeeBps: payload.protocolFeeBps,
            integratorFeeBps: payload.integratorFeeBps,
            integrator: payload.integrator,
            integratorRecipient: payload.integratorRecipient,
            signer: signer,
            nonce: payload.nonce
        });

        emit OrderCreated(orderId, payload.token, payload.user, payload.amount, messageHash, 0, _orderType);
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
    function refundOrder(bytes32 _orderId) external override onlyAggregator whenNotPaused {
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
        
        // Calculate fees and net amount using the order's snapshots
        uint256 protocolFee = (order.amount * uint256(order.protocolFeeBps)) / BPS_DENOMINATOR;
        uint256 integratorFee = (order.amount * uint256(order.integratorFeeBps)) / BPS_DENOMINATOR;
        uint256 totalFees = protocolFee + integratorFee;
        require(totalFees <= order.amount, "Fees exceed amount");
        uint256 net = order.amount - totalFees;

        // Transfer protocol fee
        if (protocolFee > 0) {
            require(IERC20(order.token).transfer(feeRecipient, protocolFee), "Protocol fee transfer failed");
        }
        // Transfer integrator fee
        if (integratorFee > 0) {
            require(order.integratorRecipient != address(0), "Missing integrator recipient");
            require(IERC20(order.token).transfer(order.integratorRecipient, integratorFee), "Integrator fee transfer failed");
        }

        // Transfer net
        if (order.orderType == OrderType.OnRamp) {
            require(IERC20(order.token).balanceOf(address(this)) >= net, "Insufficient funds");
            require(IERC20(order.token).transfer(order.requester, net), "Net transfer failed");
        } else {
            require(IERC20(order.token).transfer(treasury, net), "Net transfer failed");
        }

        //Set the order status to completed
        order.status = OrderStatus.Completed;
        emit FeesCollected(_orderId, order.token, protocolFee, integratorFee, feeRecipient, order.integratorRecipient);
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
     * @notice Updates the aggregator address (only owner).
     * @param _aggregator The new aggregator address.
     */
    function updateAggregatorAddress(address _aggregator) external onlyOwner {
        require(_aggregator != address(0), "Invalid aggregator address");
        _aggregatorAddress = _aggregator;
    }

    /**
     * @notice Gets the current aggregator address.
     * @return The current aggregator address.
     */
    function aggregatorAddress() external view returns (address) {
        return _aggregatorAddress;
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

    /**
     * @notice Get the current implementation version
     * @return The version string
     */
    function getVersion() external pure returns (string memory) {
        return "1.0.0";
    }
}