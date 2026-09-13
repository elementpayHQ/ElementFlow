// SPDX-License-Identifier: BSL-1.1
pragma solidity 0.8.22;

/**
 * @title IProviderRegistry
 * @notice Directory mapping a `providerId` to the adapter contract that implements it.
 * @dev Deliberately a separate contract from the order manager: adding, disabling or
 *      swapping a settlement route is a routine operational action, while upgrading the
 *      order manager is a governance event. Splitting them keeps the blast radius small.
 */
interface IProviderRegistry {
    /// @notice Adapter address for `providerId`, or address(0) if unregistered.
    function getProvider(bytes32 providerId) external view returns (address);

    /// @notice True only if the provider is registered AND currently enabled.
    function isProviderActive(bytes32 providerId) external view returns (bool);

    /**
     * @notice Resolve a provider for use in settlement / new-order routing.
     * @dev Reverts if the provider is unknown or disabled, so callers get an explicit
     *      failure instead of silently falling back to address(0).
     */
    function requireActiveProvider(bytes32 providerId) external view returns (address);

    /**
     * @notice Resolve a registered provider even when it is currently disabled.
     * @dev Used for refunds and other unwind paths so disabling a route cannot trap
     *      funds that were already committed to it.
     */
    function requireRegisteredProvider(bytes32 providerId) external view returns (address);
}
