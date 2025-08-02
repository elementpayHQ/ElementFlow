const { ethers, upgrades, run, network } = require("hardhat");

// Chain configurations
const CHAINS = {
    'lisk': {
        name: 'Lisk',
        explorer: 'LiskScan',
        verifyCommand: 'npx hardhat verify --network lisk',
        nativeToken: 'LSK'
    },
    'base': {
        name: 'Base',
        explorer: 'BaseScan',
        verifyCommand: 'npx hardhat verify --network base',
        nativeToken: 'ETH'
    },
    'arbitrum': {
        name: 'Arbitrum',
        explorer: 'Arbiscan',
        verifyCommand: 'npx hardhat verify --network arbitrum',
        nativeToken: 'ETH'
    },
    'scroll': {
        name: 'Scroll',
        explorer: 'ScrollScan',
        verifyCommand: 'npx hardhat verify --network scroll',
        nativeToken: 'ETH'
    }
};

async function deployOnChain(chainName) {
    const chainConfig = CHAINS[chainName];
    if (!chainConfig) {
        throw new Error(`Unsupported chain: ${chainName}`);
    }

    console.log(`\n🚀 Starting deployment on ${chainConfig.name}...`);
    
    // Get the deployer account
    const [deployer] = await ethers.getSigners();
    console.log("Deploying with account:", deployer.address);
    
    // Check balance
    // const balance = await deployer.getBalance();
    // console.log(`Account balance: ${ethers.utils.formatEther(balance)} ${chainConfig.nativeToken}`);
    
    // if (balance.lt(ethers.utils.parseEther("0.01"))) {
    //     console.warn(`⚠️  Low balance warning: ${ethers.utils.formatEther(balance)} ${chainConfig.nativeToken}`);
    // }
    
    // Configuration - Update these addresses!
    const aggregatorAddress = process.env[`${chainName.toUpperCase()}_AGGREGATOR_ADDRESS`] || deployer.address;
    const treasuryAddress = process.env[`${chainName.toUpperCase()}_TREASURY_ADDRESS`] || deployer.address;
    const ownerAddress = process.env[`${chainName.toUpperCase()}_OWNER_ADDRESS`] || deployer.address;
    
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
            kind: 'uups',
            timeout: 0 // Disable timeout for slower networks
        }
    );
    
    await orderManagement.waitForDeployment();
    
    // Get addresses
    const proxyAddress = await orderManagement.getAddress();
    const implementationAddress = await upgrades.erc1967.getImplementationAddress(proxyAddress);
    
    console.log("\n✅ Deployment successful!");
    console.log("📋 Contract Addresses:");
    console.log("   Proxy (interact with this):", proxyAddress);
    console.log("   Implementation:", implementationAddress);
    
    // Save deployment info
    const deploymentInfo = {
        network: chainName,
        chainId: (await ethers.provider.getNetwork()).chainId,
        proxyAddress: proxyAddress,
        implementationAddress: implementationAddress,
        deployer: deployer.address,
        aggregator: aggregatorAddress,
        treasury: treasuryAddress,
        owner: ownerAddress,
        blockNumber: await ethers.provider.getBlockNumber(),
        timestamp: new Date().toISOString()
    };
    
    // BigInt replacer for JSON.stringify
    const replacer = (key, value) => 
      typeof value === 'bigint' ? value.toString() : value;
    
    console.log("\n📄 Deployment Info:");
    console.log(JSON.stringify(deploymentInfo, replacer, 2));
    
    // Verify the deployment
    console.log("\n🔍 Verifying deployment...");
    try {
        const version = await orderManagement.getVersion();
        console.log("   Contract version:", version);
    } catch (error) {
        console.log("   Version check skipped - not available");
    }
    
    // Verify contracts on explorer
    console.log("\n🔍 Verifying contracts on " + chainConfig.explorer + "...");
    try {
        console.log("   Verifying implementation...");
        await run("verify:verify", {
            address: implementationAddress,
            constructorArguments: [],
        });
        console.log("   ✅ Implementation verified!");
        
        console.log("   Verifying proxy...");
        await run("verify:verify", {
            address: proxyAddress,
            constructorArguments: [],
        });
        console.log("   ✅ Proxy verified!");
        
    } catch (error) {
        console.log("   ⚠️  Verification issue:", error.message);
        console.log("   You can verify manually later using:");
        console.log(`   ${chainConfig.verifyCommand} ${implementationAddress}`);
    }
    
    console.log("\n🎉 Ready to use! Interact with the proxy address:", proxyAddress);
    console.log("🔗 View on " + chainConfig.explorer + ":", `${chainConfig.explorer.toLowerCase()}.io/address/${proxyAddress}`);
    
    return deploymentInfo;
}

async function main() {
    // Get target chain from command line arguments or use the network name
    const targetChain = process.argv[2] || network.name;
    
    if (!CHAINS[targetChain]) {
        console.error(`❌ Unsupported chain: ${targetChain}`);
        console.log(`\nSupported chains: ${Object.keys(CHAINS).join(', ')}`);
        process.exit(1);
    }
    
    console.log(`\n🌐 Deploying to ${CHAINS[targetChain].name} (${targetChain})`);
    console.log('='.repeat(60));
    
    try {
        const deploymentInfo = await deployOnChain(targetChain);
        console.log('\n' + '='.repeat(60));
        console.log(`✅ Successfully deployed to ${CHAINS[targetChain].name}!`);
        console.log(`🔗 Proxy: ${deploymentInfo.proxyAddress}`);
        console.log(`📋 Full deployment info saved above`);
        
        // Save deployment info to a file
        const fs = require('fs');
        const path = require('path');
        const deploymentsDir = path.join(__dirname, '../deployments');
        if (!fs.existsSync(deploymentsDir)) {
            fs.mkdirSync(deploymentsDir, { recursive: true });
        }
        const deploymentFile = path.join(deploymentsDir, `deployment-${targetChain}-${Date.now()}.json`);
        fs.writeFileSync(deploymentFile, JSON.stringify(deploymentInfo, null, 2));
        console.log(`💾 Deployment info saved to: ${deploymentFile}`);
        
    } catch (error) {
        console.error('\n' + '='.repeat(60));
        console.error(`❌ Deployment to ${targetChain} failed!`);
        console.error(error);
        process.exit(1);
    }
}

// Run the deployment
main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("❌ Fatal error:");
        console.error(error);
        process.exit(1);
    });