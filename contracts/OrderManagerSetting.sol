// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.22;

import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";

/**
 * @title SettingsManager
 * @dev A contract for managing global settings and configurations.
 */
contract SettingsManager is Ownable2StepUpgradeable {
    mapping(address => bool) private supportedTokens;

    event TokenSupportUpdated(address indexed token, bool isSupported);

    // Initialize the contract
    function initialize() external initializer {
        __Ownable2Step_init();
    }

    // Add or remove token support
    function setTokenSupport(address token, bool isSupported) external onlyOwner {
        require(token != address(0), "Invalid token address");
        supportedTokens[token] = isSupported;
        emit TokenSupportUpdated(token, isSupported);
    }

    // Check if a token is supported
    function isTokenSupported(address token) external view returns (bool) {
        return supportedTokens[token];
    }
}
