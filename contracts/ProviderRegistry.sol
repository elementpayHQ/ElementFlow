// SPDX-License-Identifier: BSL-1.1
pragma solidity 0.8.22;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";

import {IProviderRegistry} from "./interfaces/IProviderRegistry.sol";
import {IOnRampProvider} from "./interfaces/IOnRampProvider.sol";

/**
 * @title ProviderRegistry
 * @notice Directory of settlement adapters, keyed by `providerId`.
 *
 * @dev Kept separate from the order manager on purpose. Onboarding a partner
 *      (Yellow Card, an OTC desk, a second treasury) is an operations task that should
 *      not require an implementation upgrade of the contract holding user escrow.
 *      Registering an adapter is privileged; disabling one is deliberately cheaper to
 *      authorise, because cutting off a misbehaving route is the time-critical action.
 */
contract ProviderRegistry is IProviderRegistry, Initializable, AccessControlUpgradeable, UUPSUpgradeable {
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    /// @notice May register new adapters and re-enable disabled ones.
    bytes32 public constant PROVIDER_ADMIN_ROLE = keccak256("PROVIDER_ADMIN_ROLE");
    /// @notice May disable an adapter. Held more widely than PROVIDER_ADMIN_ROLE so an
    ///         on-call operator can pull a broken route without a governance round-trip.
    bytes32 public constant PROVIDER_GUARDIAN_ROLE = keccak256("PROVIDER_GUARDIAN_ROLE");

    error ZeroAddress();
    error ProviderIdMismatch(bytes32 expected, bytes32 actual);
    error ProviderAlreadyRegistered(bytes32 providerId);
    error ProviderNotRegistered(bytes32 providerId);
    error ProviderDisabled(bytes32 providerId);

    event ProviderRegistered(bytes32 indexed providerId, address indexed adapter);
    event ProviderAdapterUpdated(bytes32 indexed providerId, address indexed previousAdapter, address indexed adapter);
    event ProviderEnabledSet(bytes32 indexed providerId, bool enabled);

    struct ProviderInfo {
        address adapter;
        bool enabled;
    }

    mapping(bytes32 => ProviderInfo) private _providers;
    bytes32[] private _providerIds;

    uint256[47] private __gap;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address admin) external initializer {
        if (admin == address(0)) revert ZeroAddress();
        __AccessControl_init();
        __UUPSUpgradeable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(UPGRADER_ROLE, admin);
        _grantRole(PROVIDER_ADMIN_ROLE, admin);
        _grantRole(PROVIDER_GUARDIAN_ROLE, admin);
    }

    function _authorizeUpgrade(address) internal override onlyRole(UPGRADER_ROLE) {}

    /**
     * @notice Register a new settlement route.
     * @dev Cross-checks the adapter's self-reported `providerId` against the key it is
     *      being filed under. Registering an adapter under the wrong key would silently
     *      route orders to the wrong counterparty, so we make that unrepresentable.
     */
    function registerProvider(bytes32 providerId, address adapter) external onlyRole(PROVIDER_ADMIN_ROLE) {
        if (adapter == address(0)) revert ZeroAddress();
        if (_providers[providerId].adapter != address(0)) revert ProviderAlreadyRegistered(providerId);

        bytes32 reported = IOnRampProvider(adapter).providerId();
        if (reported != providerId) revert ProviderIdMismatch(providerId, reported);

        _providers[providerId] = ProviderInfo({adapter: adapter, enabled: true});
        _providerIds.push(providerId);

        emit ProviderRegistered(providerId, adapter);
        emit ProviderEnabledSet(providerId, true);
    }

    /// @notice Point an existing route at a new adapter implementation.
    /// @dev The route keeps its id, so orders already referencing it stay settleable.
    /**
     * @notice Hot-swap the adapter behind an existing `providerId`.
     * @dev Ops constraint: do **not** call while TreasuryPool still has
     *      `reservedLiquidity` for this providerId — reservations stay keyed by
     *      providerId but settlement/refunds go through the new adapter. Drain or
     *      settle open on-ramps first (disable → wait → update), or migrate
     *      carefully offline.
     */
    function updateProviderAdapter(bytes32 providerId, address adapter) external onlyRole(PROVIDER_ADMIN_ROLE) {
        if (adapter == address(0)) revert ZeroAddress();
        address previous = _providers[providerId].adapter;
        if (previous == address(0)) revert ProviderNotRegistered(providerId);

        bytes32 reported = IOnRampProvider(adapter).providerId();
        if (reported != providerId) revert ProviderIdMismatch(providerId, reported);

        _providers[providerId].adapter = adapter;
        emit ProviderAdapterUpdated(providerId, previous, adapter);
    }

    /// @notice Disable a route. Blocks new orders and blocks settlement through it.
    function disableProvider(bytes32 providerId) external onlyRole(PROVIDER_GUARDIAN_ROLE) {
        if (_providers[providerId].adapter == address(0)) revert ProviderNotRegistered(providerId);
        _providers[providerId].enabled = false;
        emit ProviderEnabledSet(providerId, false);
    }

    /// @notice Re-enable a previously disabled route.
    function enableProvider(bytes32 providerId) external onlyRole(PROVIDER_ADMIN_ROLE) {
        if (_providers[providerId].adapter == address(0)) revert ProviderNotRegistered(providerId);
        _providers[providerId].enabled = true;
        emit ProviderEnabledSet(providerId, true);
    }

    /* ------------------------------------------------------------------ views */

    /// @inheritdoc IProviderRegistry
    function getProvider(bytes32 providerId) external view override returns (address) {
        return _providers[providerId].adapter;
    }

    /// @inheritdoc IProviderRegistry
    function isProviderActive(bytes32 providerId) external view override returns (bool) {
        ProviderInfo memory info = _providers[providerId];
        return info.adapter != address(0) && info.enabled;
    }

    /// @inheritdoc IProviderRegistry
    function requireActiveProvider(bytes32 providerId) external view override returns (address) {
        ProviderInfo memory info = _providers[providerId];
        if (info.adapter == address(0)) revert ProviderNotRegistered(providerId);
        if (!info.enabled) revert ProviderDisabled(providerId);
        return info.adapter;
    }

    /// @inheritdoc IProviderRegistry
    function requireRegisteredProvider(bytes32 providerId) external view override returns (address) {
        address adapter = _providers[providerId].adapter;
        if (adapter == address(0)) revert ProviderNotRegistered(providerId);
        return adapter;
    }

    /// @notice All registered provider ids, including disabled ones. Off-chain use only.
    function allProviderIds() external view returns (bytes32[] memory) {
        return _providerIds;
    }
}
