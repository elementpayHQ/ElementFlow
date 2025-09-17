# CI/CD Setup for Contract Upgrades

This document explains the CI/CD pipeline for automatically upgrading the OrderManagement contract when merging to the `dev` branch.

## Overview

The CI/CD pipeline consists of the following stages:

1. **Testing**: Compile contracts, run tests, and perform linting
2. **Testnet Deployment**: Deploy/upgrade contracts on Base Sepolia
3. **Mainnet Deployment**: Deploy/upgrade contracts on Base Mainnet (only after testnet success)
4. **Verification**: Verify contracts on blockchain explorers
5. **Summary**: Generate deployment summary with contract addresses and explorer links

## Workflow Triggers

The workflow is triggered on:
- Push to `dev` branch
- Pull requests targeting `dev` branch

## Required GitHub Secrets

You need to configure the following secrets in your GitHub repository:

### Required Secrets

| Secret Name | Description | Example |
|-------------|-------------|---------|
| `DEPLOYER_PRIVATE_KEY` | Private key of the deployer account | `0x1234567890abcdef...` |

### RPC URLs (Required)
| Secret Name | Description | Example |
|-------------|-------------|---------|
| `BASE_SEPOLIA_RPC` | RPC URL for Base Sepolia testnet | `https://sepolia.base.org` |
| `BASE_MAINNET_RPC` | RPC URL for Base mainnet | `https://mainnet.base.org` |
| `ARBITRUM_SEPOLIA_RPC` | RPC URL for Arbitrum Sepolia testnet | `https://sepolia-rollup.arbitrum.io/rpc` |
| `ARBITRUM_MAINNET_RPC` | RPC URL for Arbitrum mainnet | `https://arb1.arbitrum.io/rpc` |
| `SCROLL_SEPOLIA_RPC` | RPC URL for Scroll Sepolia testnet | `https://sepolia-rpc.scroll.io` |
| `SCROLL_MAINNET_RPC` | RPC URL for Scroll mainnet | `https://rpc.scroll.io` |
| `LISK_SEPOLIA_RPC` | RPC URL for Lisk Sepolia testnet | `https://rpc.sepolia-api.lisk.com` |
| `LISK_MAINNET_RPC` | RPC URL for Lisk mainnet | `https://rpc.lisk.com/` |

### API Keys (Required)
| Secret Name | Description | Example |
|-------------|-------------|---------|
| `BASESCAN_API_KEY` | API key for BaseScan verification | `ABC123DEF456...` |
| `ARBISCAN_API_KEY` | API key for Arbiscan verification | `ABC123DEF456...` |
| `SCROLLSCAN_API_KEY` | API key for ScrollScan verification | `ABC123DEF456...` |
| `LISKSCAN_API_KEY` | API key for LiskScan verification | `ABC123DEF456...` |

### Optional Secrets

| Secret Name | Description | Default |
|-------------|-------------|---------|
| `AGGREGATOR_ADDRESS` | Address for the aggregator role | Deployer address |
| `TREASURY_ADDRESS` | Address for the treasury | Deployer address |
| `OWNER_ADDRESS` | Address for the contract owner | Deployer address |

## Environment Setup

The workflow uses two environments for security:

### Testnet Environment
- Used for Base Sepolia deployments
- Requires approval for first-time deployments
- Configure in GitHub: Settings → Environments → testnet

### Mainnet Environment
- Used for Base mainnet deployments
- Requires approval for all deployments
- Configure in GitHub: Settings → Environments → mainnet

## Deployment Process

### 1. Initial Deployment
When deploying for the first time:
1. The script creates a new proxy contract
2. Initializes the contract with provided parameters
3. Saves deployment information to `deployments/{chainId}.json`

### 2. Contract Upgrades
For subsequent deployments:
1. The script reads existing deployment information
2. Upgrades the proxy to the new implementation
3. Updates deployment information with new implementation address

## Contract Architecture

The OrderManagement contract uses OpenZeppelin's UUPS upgradeable pattern:

- **Proxy Contract**: The address users interact with (never changes)
- **Implementation Contract**: The actual contract logic (can be upgraded)

## Deployment Files

The deployment process creates/updates files in the `deployments/` directory:

```
deployments/
├── 8453.json      # Base mainnet deployment info
├── 84532.json     # Base Sepolia deployment info
├── 42161.json     # Arbitrum mainnet deployment info
├── 421614.json    # Arbitrum Sepolia deployment info
├── 534352.json    # Scroll mainnet deployment info
├── 534351.json    # Scroll Sepolia deployment info
├── 1135.json      # Lisk mainnet deployment info
└── 4202.json      # Lisk Sepolia deployment info
```

Each file contains:
```json
{
  "orderManagement": {
    "address": "0x...",           // Proxy address
    "implementation": "0x...",     // Implementation address
    "deployedAt": "2024-01-01T...",
    "network": "base",
    "chainId": 8453
  }
}
```

## Manual Deployment

If you need to deploy manually:

```bash
# Deploy to individual networks
npm run deploy:base-sepolia
npm run deploy:base
npm run deploy:arbitrum-sepolia
npm run deploy:arbitrum
npm run deploy:scroll-sepolia
npm run deploy:scroll
npm run deploy:lisk-sepolia
npm run deploy:lisk

# Deploy to all testnets
npm run deploy:all-testnets

# Deploy to all mainnets
npm run deploy:all-mainnets

# Verify contracts
npm run verify:base-sepolia
npm run verify:base
npm run verify:arbitrum-sepolia
npm run verify:arbitrum
npm run verify:scroll-sepolia
npm run verify:scroll
npm run verify:lisk-sepolia
npm run verify:lisk

# Verify all testnets
npm run verify:all-testnets

# Verify all mainnets
npm run verify:all-mainnets
```

## Troubleshooting

### Common Issues

1. **Insufficient Gas**: Ensure the deployer account has enough ETH for gas fees
2. **Verification Failed**: Check that the BASESCAN_API_KEY is correct
3. **Deployment Failed**: Verify the private key and RPC URLs are correct

### Debugging Steps

1. Check the GitHub Actions logs for detailed error messages
2. Verify all required secrets are set correctly
3. Ensure the deployer account has sufficient balance
4. Check that the contract compiles successfully locally

### Manual Verification

If automatic verification fails, you can verify manually:

```bash
# Verify implementation
npx hardhat verify --network base-sepolia <IMPLEMENTATION_ADDRESS>
npx hardhat verify --network arbitrum-sepolia <IMPLEMENTATION_ADDRESS>
npx hardhat verify --network scroll-sepolia <IMPLEMENTATION_ADDRESS>
npx hardhat verify --network lisk-sepolia <IMPLEMENTATION_ADDRESS>

# Verify proxy
npx hardhat verify --network base-sepolia <PROXY_ADDRESS>
npx hardhat verify --network arbitrum-sepolia <PROXY_ADDRESS>
npx hardhat verify --network scroll-sepolia <PROXY_ADDRESS>
npx hardhat verify --network lisk-sepolia <PROXY_ADDRESS>
```

## Security Considerations

1. **Private Key Security**: Never commit private keys to the repository
2. **Environment Protection**: Use GitHub environments to protect mainnet deployments
3. **Access Control**: Limit who can approve deployments to mainnet
4. **Audit Trail**: All deployments are logged in GitHub Actions

## Monitoring

After deployment, monitor:
- Contract events on the blockchain
- Gas usage and transaction costs
- Any errors in contract interactions
- Explorer verification status

## Support

For issues with the CI/CD pipeline:
1. Check the GitHub Actions logs
2. Verify all secrets are configured correctly
3. Test deployment locally first
4. Contact the development team for assistance 