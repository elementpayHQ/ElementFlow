# Contract Verification Guide

## 🔍 How to Verify Your Contracts

### 1. Get Your BaseScan API Key

1. Go to [BaseScan](https://sepolia.basescan.org)
2. Sign up for an account
3. Navigate to API Keys section
4. Generate a new API key

### 2. Update Your .env File

Add this to your `.env` file:
```bash
BASESCAN_API_KEY=your_actual_api_key_here
```

### 3. Verification Commands

#### For Implementation Contract:
```bash
npx hardhat verify --network base-sepolia CONTRACT_ADDRESS
```

#### For Proxy Contract (if needed):
```bash
npx hardhat verify --network base-sepolia PROXY_ADDRESS
```

### 4. Manual Verification Steps

If automatic verification fails, use these steps:

1. **Get your contract addresses** from deployment output
2. **Go to BaseScan** at https://sepolia.basescan.org
3. **Search for your contract** using the address
4. **Click "Verify & Publish"**
5. **Fill in the details:**
   - Contract Name: OrderManagement
   - Compiler: Solidity 0.8.22
   - Optimization: Yes (200 runs)
   - Constructor Arguments: None (proxy)

### 5. Verification Status Check

You can check verification status at:
```bash
npx hardhat verify --list --network base-sepolia
```

## 📋 Summary of Your Deployment

**Addresses to verify:**
- Implementation: `0xc097A370b03128FCBF15e49b4696c44B89337767`
- Proxy: Check your latest deployment output

**Verification URLs:**
- BaseScan: https://sepolia.basescan.org/address/[YOUR_ADDRESS]

## 🚨 Common Issues & Solutions

1. **"No API token found"** → Add BASESCAN_API_KEY to .env
2. **"Contract doesn't look like ERC1967 proxy"** → Use implementation address
3. **"Contract already verified"** → Check if already verified on BaseScan
4. **"Constructor arguments missing"** → Use implementation address, not proxy

## ✅ Quick Verification Command

```bash
# Set your API key first
echo "BASESCAN_API_KEY=your_key_here" >> .env

# Verify implementation
npx hardhat verify --network base-sepolia 0xc097A370b03128FCBF15e49b4696c44B89337767
```
