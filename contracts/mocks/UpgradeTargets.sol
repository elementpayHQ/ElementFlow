// SPDX-License-Identifier: MIT
pragma solidity 0.8.22;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";

import {ElementFlowOrderManager} from "../ElementFlowOrderManager.sol";
import {OrderTypes} from "../libraries/OrderTypes.sol";

/**
 * @notice A well-formed v3 implementation.
 * @dev Appends state by inheritance, which places new variables after the parent's
 *      storage gap. Used to prove that a real upgrade preserves orders, balances,
 *      roles and accounting.
 */
contract ElementFlowOrderManagerV3Mock is ElementFlowOrderManager {
    /// @dev New state introduced in v3. Neither variable needs seeding.
    mapping(bytes32 => string) public settlementNotes;
    uint256 public totalSettlementNotes;

    /**
     * @notice Reinitializer for the v3 upgrade.
     * @dev Note what is deliberately absent: `__Pausable_init()`. Parent `__X_init`
     *      functions are `onlyInitializing`, so a `reinitializer` may legally call them —
     *      and `__Pausable_init()` sets `_paused = false`. Re-running it during an upgrade
     *      would silently unpause a contract that governance had halted, which is exactly
     *      when you least want the system to restart itself. Only ReentrancyGuard, which
     *      the upgrade validator requires and which is idempotent here, is re-run.
     * @custom:oz-upgrades-validate-as-initializer
     */
    function initializeV3() external reinitializer(3) {
        __ReentrancyGuard_init();
    }

    function setSettlementNote(bytes32 orderId, string calldata note) external onlyRole(AGGREGATOR_ROLE) {
        if (bytes(settlementNotes[orderId]).length == 0) totalSettlementNotes++;
        settlementNotes[orderId] = note;
    }

    function getVersion() external pure override returns (string memory) {
        return "3.0.0";
    }
}

/**
 * @notice An implementation with an incompatible storage layout.
 * @dev `treasury` and `_legacyAggregatorAddress` are swapped relative to the deployed
 *      implementation. Deploying this would silently reinterpret the treasury address as
 *      the aggregator. Used to prove the OpenZeppelin upgrade validator rejects it.
 */
contract ElementFlowOrderManagerBadLayout is Initializable, AccessControlUpgradeable, UUPSUpgradeable {
    address public treasury; // slot 0 — was `_legacyAggregatorAddress`
    address private _legacyAggregatorAddress; // slot 1 — was `treasury`
    mapping(bytes32 => uint256) public legacyOrders; // slot 2 — retyped

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}

/// @notice Implementation missing `_authorizeUpgrade`/UUPS wiring, used to prove the
///         proxy rejects an upgrade to a non-UUPS-compatible target.
contract NotUUPSImplementation {
    uint256 public value;

    function setValue(uint256 v) external {
        value = v;
    }
}
