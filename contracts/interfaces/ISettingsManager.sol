// SPDX-License-Identifier: BSL 1.1
pragma solidity 0.8.22;

/**
 * @title ISettingsManager
 * @notice Interface for the ElementFlow token whitelist registry.
 */
interface ISettingsManager {
    /**
     * @notice Returns true if the token is whitelisted for use in orders.
     */
    function isTokenSupported(address token) external view returns (bool);
}
