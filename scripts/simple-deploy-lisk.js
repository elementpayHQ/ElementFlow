const { ethers, upgrades, run } = require("hardhat");

async function main() {
    console.log("🚀 Starting simple deployment on Lisk Sepolia...");
    
    // Get the deployer account
    const [deployer] = await ethers.getSigners();
    console.log("👤 Deploying with account:", deployer.address);
    console.log("💰 Balance:", ethers.utils.formatEther(await deployer.getBalance()), "LSK");
    
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
    
    try {
        const orderManagement = await upgrades.deployProxy(
            OrderManagement,
            [aggregatorAddress, treasuryAddress, ownerAddress],
            {
                initializer: 'initialize',
                kind: 'uups',
                timeout: 300000, // 5 minutes timeout
                pollingInterval: 10000, // Poll every 10 seconds
            }
        );
        
        console.log("⏳ Waiting for deployment to complete...");
        await orderManagement.waitForDeployment();
        const proxyAddress = await orderManagement.getAddress();
        const implementationAddress = await upgrades.erc1967.getImplementationAddress(proxyAddress);
        
        console.log("   ✅ OrderManagement deployed!");
        console.log("   📍 Proxy:", proxyAddress);
        console.log("   🔧 Implementation:", implementationAddress);
        
        // Save deployment info
        const fs = require("fs");
        const path = require("path");
        const deploymentsDir = path.join(__dirname, "../deployments");
        if (!fs.existsSync(deploymentsDir)) {
            fs.mkdirSync(deploymentsDir, { recursive: true });
        }
        
        const deploymentInfo = {
            orderManagement: {
                address: proxyAddress,
                implementation: implementationAddress,
                deployedAt: new Date().toISOString(),
                network: "lisk-sepolia",
                chainId: 4202
            }
        };
        
        fs.writeFileSync(
            path.join(deploymentsDir, "4202.json"), 
            JSON.stringify(deploymentInfo, null, 2)
        );
        console.log("   💾 Deployment info saved!");
        
        // Summary
        console.log("\n📄 Summary:");
        console.log("   Network: Lisk Sepolia");
        console.log("   Proxy Address:", proxyAddress);
        console.log("   Implementation Address:", implementationAddress);
        console.log("   Explorer:", `https://sepolia-explorer.lisk.com/address/${proxyAddress}`);
        
        console.log("\n🎉 Deployment complete!");
        console.log("🔗 View on Lisk Explorer:", `https://sepolia-explorer.lisk.com/address/${proxyAddress}`);
        
    } catch (error) {
        console.error("❌ Deployment failed:");
        console.error(error);
        
        if (error.message.includes("timeout")) {
            console.log("\n💡 Timeout Tips:");
            console.log("1. The transaction might have been submitted successfully");
            console.log("2. Check the Lisk Sepolia explorer for your transaction");
            console.log("3. Try running the deployment again");
        }
        
        process.exit(1);
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("❌ Script failed:");
        console.error(error);
        process.exit(1);
    });
