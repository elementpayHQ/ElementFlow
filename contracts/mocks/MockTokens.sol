// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Well-behaved ERC20 with configurable decimals.
contract MockERC20 is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }
}

/**
 * @notice USDT-style token whose transfer/approve return nothing.
 * @dev This is the single most common production footgun for payment contracts: the v1
 *      implementation wrapped every transfer in `require(token.transfer(...))`, which
 *      reverts against tokens like this because there is no return value to decode.
 *      SafeERC20 handles it; these tests prove it.
 */
contract MockNoReturnERC20 {
    string public name = "No Return Token";
    string public symbol = "NRT";
    uint8 public decimals = 6;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    // Deliberately no `returns (bool)` — matches USDT on mainnet.
    function transfer(address to, uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external {
        allowance[msg.sender][spender] = amount;
    }

    function transferFrom(address from, address to, uint256 amount) external {
        require(balanceOf[from] >= amount, "insufficient");
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "not allowed");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

/// @notice Token that skims a fee on every transfer, so the recipient receives less than sent.
contract MockFeeOnTransferERC20 is ERC20 {
    uint256 public feeBps;

    constructor(uint256 feeBps_) ERC20("Fee On Transfer", "FOT") {
        feeBps = feeBps_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0) || feeBps == 0) {
            super._update(from, to, value);
            return;
        }
        uint256 fee = (value * feeBps) / 10_000;
        super._update(from, to, value - fee);
        super._update(from, address(0xdead), fee);
    }
}

/// @notice Token whose transfers can be switched to fail on demand.
contract MockRevertingERC20 is ERC20 {
    bool public transferShouldRevert;
    bool public transferShouldReturnFalse;

    constructor() ERC20("Reverting", "REV") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setTransferShouldRevert(bool value) external {
        transferShouldRevert = value;
    }

    function setTransferShouldReturnFalse(bool value) external {
        transferShouldReturnFalse = value;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        require(!transferShouldRevert, "MockRevertingERC20: transfer reverted");
        if (transferShouldReturnFalse) return false;
        return super.transfer(to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        require(!transferShouldRevert, "MockRevertingERC20: transfer reverted");
        if (transferShouldReturnFalse) return false;
        return super.transferFrom(from, to, amount);
    }
}

/**
 * @notice ERC777-style token that hands control to a configured attacker on transfer.
 * @dev Used to prove the reentrancy guard and checks-effects-interactions ordering hold
 *      when a token callback re-enters the order manager mid-settlement.
 */
contract MockReentrantERC20 is ERC20 {
    address public attacker;
    bytes public attackCalldata;
    address public target;
    bool public armed;

    constructor() ERC20("Reentrant", "RE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(address target_, bytes calldata data) external {
        target = target_;
        attackCalldata = data;
        armed = true;
    }

    function disarm() external {
        armed = false;
    }

    /// @dev Fires once, on the way out of a transfer, mimicking an ERC777 `tokensReceived` hook.
    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (armed && target != address(0)) {
            armed = false; // one shot, so a failed re-entry cannot loop forever
            (bool ok, bytes memory ret) = target.call(attackCalldata);
            if (!ok) {
                assembly {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
        }
    }
}
