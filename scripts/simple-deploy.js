const { ethers, upgrades, run } = require("hardhat");

async function main() {
    console.log("🚀 Starting simple deployment on Base Sepolia...");
    
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
    
    // Deploy OrderManagement only
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
    const implementationAddress = await upgrades.erc1967.getImplementationAddress(proxyAddress);
    
    console.log("   ✅ OrderManagement deployed!");
    console.log("   📍 Proxy:", proxyAddress);
    console.log("   🔧 Implementation:", implementationAddress);
    
    // Verification
    console.log("\n🔍 Verifying implementation...");
    try {
        await run("verify:verify", {
            address: implementationAddress,
            constructorArguments: [],
        });
        console.log("   ✅ Implementation verified!");
    } catch (error) {
        console.log("   ⚠️  Verification issue:", error.message);
        console.log(`   Manual: npx hardhat verify --network base-sepolia ${implementationAddress}`);
    }
    
    // Summary
    const summary = {
        network: "base-sepolia",
        proxyAddress: proxyAddress,
        implementationAddress: implementationAddress,
        basescan: `https://sepolia.basescan.org/address/${proxyAddress}`,
        verification: `npx hardhat verify --network base-sepolia ${implementationAddress}`
    };
    
    console.log("\n📄 Summary:", summary);
    
    console.log("\n🎉 Deployment complete!");
    console.log("🔗 View on BaseScan:", `https://sepolia.basescan.org/address/${proxyAddress}`);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("❌ Deployment failed:");
        console.error(error);
        process.exit(1);
    });
