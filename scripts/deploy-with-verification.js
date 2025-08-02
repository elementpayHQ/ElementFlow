const { ethers, upgrades, run } = require("hardhat");

async function main() {
    console.log("🚀 Starting comprehensive deployment on Base Sepolia...");
    
    // Get the deployer account
    const [deployer] = await ethers.getSigners();
    console.log("👤 Deploying with account:", deployer.address);
    
    // Configuration - Update these addresses in your .env file!
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
    const orderManagementProxy = await orderManagement.getAddress();
    const orderManagementImpl = await upgrades.erc1967.getImplementationAddress(orderManagementProxy);
    
    console.log("   ✅ OrderManagement deployed!");
    console.log("   📍 Proxy:", orderManagementProxy);
    console.log("   🔧 Implementation:", orderManagementImpl);
    
    // Deploy TreasuryPool
    console.log("\n📦 Deploying TreasuryPool...");
    const TreasuryPool = await ethers.getContractFactory("TreasuryPool");
    const treasuryPool = await upgrades.deployProxy(
        TreasuryPool,
        [ownerAddress],
        {
            initializer: 'initialize',
            kind: 'uups'
        }
    );
    
    await treasuryPool.waitForDeployment();
    const treasuryPoolProxy = await treasuryPool.getAddress();
    const treasuryPoolImpl = await upgrades.erc1967.getImplementationAddress(treasuryPoolProxy);
    
    console.log("   ✅ TreasuryPool deployed!");
    console.log("   📍 Proxy:", treasuryPoolProxy);
    console.log("   🔧 Implementation:", treasuryPoolImpl);
    
    // Verification section
    console.log("\n🔍 Starting verification process...");
    
    // Verify OrderManagement Implementation
    console.log("   Verifying OrderManagement Implementation...");
    try {
        await run("verify:verify", {
            address: orderManagementImpl,
            constructorArguments: [],
        });
        console.log("   ✅ OrderManagement Implementation verified!");
    } catch (error) {
        console.log("   ⚠️  OrderManagement Implementation verification issue:", error.message);
        console.log(`   Manual verification: npx hardhat verify --network base-sepolia ${orderManagementImpl}`);
    }
    
    // Verify TreasuryPool Implementation
    console.log("   Verifying TreasuryPool Implementation...");
    try {
        await run("verify:verify", {
            address: treasuryPoolImpl,
            constructorArguments: [],
        });
        console.log("   ✅ TreasuryPool Implementation verified!");
    } catch (error) {
        console.log("   ⚠️  TreasuryPool Implementation verification issue:", error.message);
        console.log(`   Manual verification: npx hardhat verify --network base-sepolia ${treasuryPoolImpl}`);
    }
    
    // Create deployment summary
    const deploymentSummary = {
        network: "base-sepolia",
        deployer: deployer.address,
        timestamp: new Date().toISOString(),
        contracts: {
            orderManagement: {
                proxy: orderManagementProxy,
                implementation: orderManagementImpl,
                basescan: `https://sepolia.basescan.org/address/${orderManagementProxy}`
            },
            treasuryPool: {
                proxy: treasuryPoolProxy,
                implementation: treasuryPoolImpl,
                basescan: `https://sepolia.basescan.org/address/${treasuryPoolProxy}`
            }
        },
        configuration: {
            aggregator: aggregatorAddress,
            treasury: treasuryAddress,
            owner: ownerAddress
        },
        verificationCommands: {
            orderManagementImpl: `npx hardhat verify --network base-sepolia ${orderManagementImpl}`,
            treasuryPoolImpl: `npx hardhat verify --network base-sepolia ${treasuryPoolImpl}`
        }
    };
    
    console.log("\n📄 Deployment Summary:");
    console.log(JSON.stringify(deploymentSummary, null, 2));
    
    // Save to file
    const fs = require('fs');
    fs.writeFileSync('deployment-summary.json', JSON.stringify(deploymentSummary, null, 2));
    console.log("\n💾 Deployment summary saved to deployment-summary.json");
    
    console.log("\n🎉 Deployment complete!");
    console.log("📊 View contracts on:");
    console.log(`   OrderManagement: https://sepolia.basescan.org/address/${orderManagementProxy}`);
    console.log(`   TreasuryPool: https://sepolia.basescan.org/address/${treasuryPoolProxy}`);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("❌ Deployment failed:");
        console.error(error);
        process.exit(1);
    });
