const { ethers, upgrades } = require("hardhat");

async function main() {
    console.log("Starting deployment on Base Sepolia...");
    
    // Get the deployer account
    const [deployer] = await ethers.getSigners();
    console.log("Deploying with account:", deployer.address);
    
    // Check balance
    const balance = await deployer.getBalance();
    console.log("Account balance:", ethers.utils.formatEther(balance), "ETH");
    
    if (balance.lt(ethers.utils.parseEther("0.01"))) {
        throw new Error("Insufficient balance. Need at least 0.01 ETH for deployment.");
    }
    
    // Configuration - use Safe multisig address for owner
    const aggregatorAddress = process.env.AGGREGATOR_ADDRESS || deployer.address;
    const treasuryAddress = process.env.TREASURY_ADDRESS || deployer.address;
    const ownerAddress = process.env.SAFE_ADDRESS || process.env.OWNER_ADDRESS || deployer.address;
    
    console.log("Configuration:");
    console.log("- Aggregator:", aggregatorAddress);
    console.log("- Treasury:", treasuryAddress);
    console.log("- Owner:", ownerAddress);
    
    // Get contract factory
    const OrderManagement = await ethers.getContractFactory("OrderManagement");
    
    console.log("\nDeploying OrderManagement proxy...");
    
    // Deploy upgradeable contract
    const orderManagement = await upgrades.deployProxy(
        OrderManagement,
        [aggregatorAddress, treasuryAddress, ownerAddress],
        {
            initializer: 'initialize',
            kind: 'uups'
        }
    );
    
    await orderManagement.deployed();
    
    // Get addresses
    const proxyAddress = orderManagement.address;
    const implementationAddress = await upgrades.erc1967.getImplementationAddress(proxyAddress);
    
    console.log("\n✅ Deployment successful!");
    console.log("📋 Contract Addresses:");
    console.log("   Proxy (interact with this):", proxyAddress);
    console.log("   Implementation:", implementationAddress);
    
    // Verify the deployment
    console.log("\n🔍 Verifying deployment...");
    const version = await orderManagement.getVersion();
    console.log("   Contract version:", version);
    
    // Save deployment info
    const deploymentInfo = {
        network: "base-sepolia",
        proxyAddress: proxyAddress,
        implementationAddress: implementationAddress,
        deployer: deployer.address,
        aggregator: aggregatorAddress,
        treasury: treasuryAddress,
        owner: ownerAddress,
        blockNumber: await ethers.provider.getBlockNumber(),
        timestamp: new Date().toISOString()
    };
    
    console.log("\n📄 Deployment Info:");
    console.log(JSON.stringify(deploymentInfo, null, 2));
    
    console.log("\n🎉 Ready to use! Interact with the proxy address:", proxyAddress);
    console.log("🔗 View on BaseScan:", `https://sepolia.basescan.org/address/${proxyAddress}`);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("❌ Deployment failed:");
        console.error(error);
        process.exit(1);
    });