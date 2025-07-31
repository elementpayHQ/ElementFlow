# ElementFlow - Order Management System

A decentralized order management system built on Base Sepolia, enabling secure on-chain order processing with upgradeable smart contracts.

## 🏗️ Architecture

- **Proxy Pattern**: Uses OpenZeppelin's upgradeable proxy contracts
- **Base Sepolia**: Deployed on Base's testnet for low-cost transactions
- **Order Types**: Supports both OnRamp and OffRamp order processing
- **Access Control**: Role-based permissions for aggregator and owner functions

## 📋 Prerequisites

- Node.js v18.20.8+
- npm v10.8.2+
- MetaMask or similar wallet
- Base Sepolia testnet ETH

## 🚀 Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Environment Setup
Create `.env` file in project root:
```bash
# Network Configuration
BASE_SEPOLIA_URL=https://sepolia.base.org
PRIVATE_KEY=your_private_key_here

# Explorer API Keys
BASESCAN_API_KEY=your_basescan_api_key_here

# Optional
REPORT_GAS=true
```

### 3. Compile Contracts
```bash
npx hardhat compile
```

### 4. Run Tests
```bash
npx hardhat test
```

## 🎯 Deployment Guide

### Deploy to Base Sepolia

#### Option A: Deploy Proxy + Implementation (Recommended)
```bash
npx hardhat run scripts/deploy.js --network base-sepolia
```

**Output Example:**
```
✅ Deployment successful!
📋 Contract Addresses:
   Proxy (interact with this): 0x8B5B742A62AeC73542112a98C5E3684c26dbcd01
   Implementation: 0xc097A370b03128FCBF15e49b4696c44B89337767
```

#### Option B: Deploy Implementation Only
```bash
npx hardhat run scripts/deploy-base-sepolia.js --network base-sepolia
```

**Output Example:**
```
OrderManagement deployed to: 0x29DC3fe6026FE4d9bCA6bcF73054E2D9255C7814
```

## 🔍 Verification Guide

### 1. Verify Implementation Contract
```bash
npx hardhat verify --network base-sepolia IMPLEMENTATION_ADDRESS
```

**Example:**
```bash
npx hardhat verify --network base-sepolia 0xc097A370b03128FCBF15e49b4696c44B89337767
```

### 2. Verify with Constructor Arguments (if needed)
```bash
npx hardhat verify --network base-sepolia IMPLEMENTATION_ADDRESS --constructor-args scripts/args.js
```

### 3. Check Verification Status
- Visit: `https://sepolia.basescan.org/address/IMPLEMENTATION_ADDRESS#code`
- Look for green checkmark ✅

## 📝 Contract Addresses (Current)

### Base Sepolia Testnet
- **Proxy:** `0x8B5B742A62AeC73542112a98C5E3684c26dbcd01`
- **Implementation:** `0xc097A370b03128FCBF15e49b4696c44B89337767`
- **Treasury:** `0x10b85FF94B64EE33BF6D5795CeE03eD9B3306C3f`

## 🔗 Frontend Integration

### Connect to Proxy Contract
```javascript
import { ethers } from 'ethers';
import OrderManagementABI from './artifacts/contracts/OrderManagement.sol/OrderManagement.json';

const PROXY_ADDRESS = "0x8B5B742A62AeC73542112a98C5E3684c26dbcd01";

const provider = new ethers.providers.Web3Provider(window.ethereum);
const signer = provider.getSigner();

const contract = new ethers.Contract(
  PROXY_ADDRESS,
  OrderManagementABI.abi,
  signer
);

// Create an order
await contract.createOrder(tokenAddress, amount, orderType);

// Read order details
const order = await contract.orders(orderId);
```

### Available Methods
- `createOrder(token, amount, orderType)`
- `fulfillOrder(orderId, provider)`
- `refundOrder(orderId)`
- `orders(orderId)` - Read order details
- `checkAllowance(token, owner)`

## 🧪 Testing

### Run All Tests
```bash
npx hardhat test
```

### Run Specific Test
```bash
npx hardhat test test/OrderManagement.test.js
```

### Run with Coverage
```bash
npx hardhat coverage
```

## 🔧 Development Commands

```bash
# Start local node
npx hardhat node

# Deploy to local network
npx hardhat run scripts/deploy.js --network localhost

# Console interaction
npx hardhat console --network base-sepolia

# Gas estimation
npx hardhat run scripts/gas-estimation.js
```

## 📊 Gas Optimization

- **Compiler:** Solidity 0.8.22
- **Optimizer:** Enabled (200 runs)
- **Target:** EVM Paris

## 🚨 Security Considerations

- **Access Control:** Only aggregator can fulfill/refund orders
- **Pausable:** Emergency pause functionality
- **Reentrancy Guards:** Protected against reentrancy attacks
- **Input Validation:** Comprehensive parameter validation

## 📱 BaseScan Links

- **Proxy:** https://sepolia.basescan.org/address/0x8B5B742A62AeC73542112a98C5E3684c26dbcd01
- **Implementation:** https://sepolia.basescan.org/address/0xc097A370b03128FCBF15e49b4696c44B89337767#code

## 🆘 Troubleshooting

### Common Issues

1. **"No API token found"**
   - Add `BASESCAN_API_KEY` to `.env`
   - Run verification again

2. **"Contract already verified"**
   - Use `--force` flag if updating
   - Check existing verification

3. **"Proxy shows no methods"**
   - This is expected behavior
   - Use implementation address for reading ABI
   - Use proxy address for interactions

4. **"Insufficient funds"**
   - Get testnet ETH from Base Sepolia faucet
   - Check wallet balance

### Get Help
- Check deployment logs in `scripts/deploy.js`
- Verify contract addresses in deployment output
- Test with local Hardhat network first

## 📞 Support

For issues or questions:
1. Check troubleshooting section
2. Review deployment logs
3. Verify all environment variables
4. Test with local network before testnet