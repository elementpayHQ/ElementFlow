const { ethers, upgrades } = require("hardhat");

async function main() {
    console.log("🚀 Starting final deployment on Base Sepolia...");
    
    // Get the deployer account
    const [deployer] = await ethers.getSigners();
    console.log("👤 Deploying with account:", deployer.address);
    
    // Configuration
    const aggregatorAddress = process.env.AGGREGATOR_ADDRESS || deployer.address;
    const treasuryAddress = process.env.TREASURY_ADDRESS || deployer.address;
    const ownerAddress = process.env.OWNER_ADDRESS || deployer.address;
    
    console.log("\n📋 Configuration:");
    console.log("   Aggregator:", aggregatorAddress);
    console.log("   Treasury:", treasuryAddress);
    console.log("   Owner:", ownerAddress);
    
    // Deploy OrderManagement
    console.log("\n📦 Deploying OrderManagement...");
    const OrderManagement = await ethers.getContractFactory("OrderManagement");
    const orderManagement = await upgrades.deployProxy(
        OrderManagement,
        [aggregatorAddress, treasuryAddress, ownerAddress],
        {
            initializer: 'initialize',
            kind: 'uups'
        }
    );
    
    await orderManagement.waitForDeployment();
    const proxyAddress = await orderManagement.getAddress();
    
    console.log("   ✅ OrderManagement deployed!");
    console.log("   📍 Proxy:", proxyAddress);
    
    // Get implementation address
    const implementationAddress = await upgrades.erc1967.getImplementationAddress(proxyAddress);
    console.log("   🔧 Implementation:", implementationAddress);
    
    // Summary
    console.log("\n📄 Deployment Summary:");
    console.log("   Proxy Address:", proxyAddress);
    console.log("   Implementation Address:", implementationAddress);
    console.log("   BaseScan URL:", `https://sepolia.basescan.org/address/${proxyAddress}`);
    console.log("   Verification Command:", `npx hardhat verify --network base-sepolia ${implementationAddress}`);
    
    console.log("\n🎉 Deployment complete!");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("❌ Deployment failed:");
        console.error(error);
        process.exit(1);
    });
