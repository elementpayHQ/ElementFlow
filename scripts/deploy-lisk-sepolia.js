const { ethers, upgrades } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying contracts with the account:", deployer.address);
  console.log("Account balance:", (await deployer.getBalance()).toString());

  // Get network info
  const network = await ethers.provider.getNetwork();
  console.log("Network:", network.name, "Chain ID:", network.chainId);

  // Create deployments directory if it doesn't exist
  const deploymentsDir = path.join(__dirname, "../deployments");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }

  // Load existing deployment info
  const deploymentFile = path.join(deploymentsDir, `${network.chainId}.json`);
  let deploymentInfo = {};
  
  if (fs.existsSync(deploymentFile)) {
    deploymentInfo = JSON.parse(fs.readFileSync(deploymentFile, "utf8"));
    console.log("Found existing deployment info:", deploymentInfo);
  }

  try {
    // Deploy or upgrade OrderManagement contract
    const OrderManagement = await ethers.getContractFactory("OrderManagement");
    
    let orderManagement;
    
    if (deploymentInfo.orderManagement) {
      console.log("Upgrading existing OrderManagement contract...");
      orderManagement = await upgrades.upgradeProxy(
        deploymentInfo.orderManagement.address,
        OrderManagement,
        {
          timeout: 300000, // 5 minutes timeout
          pollingInterval: 10000, // Poll every 10 seconds
        }
      );
      console.log("OrderManagement upgraded to:", orderManagement.address);
    } else {
      console.log("Deploying new OrderManagement contract...");
      
      // For initial deployment, we need to provide constructor parameters
      const aggregatorAddress = process.env.AGGREGATOR_ADDRESS || deployer.address;
      const treasuryAddress = process.env.TREASURY_ADDRESS || deployer.address;
      const ownerAddress = process.env.OWNER_ADDRESS || deployer.address;
      
      console.log("Deployment parameters:");
      console.log("- Aggregator Address:", aggregatorAddress);
      console.log("- Treasury Address:", treasuryAddress);
      console.log("- Owner Address:", ownerAddress);
      
      // Deploy with extended timeout for Lisk Sepolia
      orderManagement = await upgrades.deployProxy(OrderManagement, [
        aggregatorAddress,
        treasuryAddress,
        ownerAddress
      ], {
        initializer: "initialize",
        kind: "uups",
        timeout: 300000, // 5 minutes timeout
        pollingInterval: 10000, // Poll every 10 seconds
      });
      
      console.log("Waiting for deployment to complete...");
      await orderManagement.deployed();
      console.log("OrderManagement deployed to:", orderManagement.address);
    }

    // Get implementation address
    const implementationAddress = await upgrades.erc1967.getImplementationAddress(orderManagement.address);
    console.log("Implementation address:", implementationAddress);

    // Update deployment info
    deploymentInfo.orderManagement = {
      address: orderManagement.address,
      implementation: implementationAddress,
      deployedAt: new Date().toISOString(),
      network: network.name,
      chainId: network.chainId
    };

    // Save deployment info
    fs.writeFileSync(deploymentFile, JSON.stringify(deploymentInfo, null, 2));
    console.log("Deployment info saved to:", deploymentFile);

    // Wait for confirmations with extended timeout
    console.log("Waiting for contract confirmations...");
    try {
      await orderManagement.deployTransaction.wait(3); // Wait for 3 confirmations
      console.log("Contract confirmed!");
    } catch (waitError) {
      console.log("Warning: Could not wait for confirmations, but deployment may still be successful");
      console.log("Check the transaction hash manually:", orderManagement.deployTransaction.hash);
    }

    console.log("✅ Deployment completed successfully!");
    console.log("Contract Address:", orderManagement.address);
    console.log("Implementation Address:", implementationAddress);
    console.log("Transaction Hash:", orderManagement.deployTransaction.hash);

    // Log Lisk Sepolia explorer link
    if (network.chainId === 4202) { // Lisk Sepolia
      console.log("Lisk Sepolia Explorer:", `https://sepolia-explorer.lisk.com/address/${orderManagement.address}`);
      console.log("Transaction Explorer:", `https://sepolia-explorer.lisk.com/tx/${orderManagement.deployTransaction.hash}`);
    }

  } catch (error) {
    console.error("❌ Deployment failed:", error);
    
    // Provide more helpful error information
    if (error.message.includes("timeout")) {
      console.log("\n💡 Timeout Tips:");
      console.log("1. Check if the transaction was actually submitted to the network");
      console.log("2. Try running the deployment again - it might have succeeded");
      console.log("3. Check the Lisk Sepolia explorer for your transaction");
      console.log("4. Consider using a higher gas price if the network is congested");
    }
    
    if (error.message.includes("insufficient funds")) {
      console.log("\n💡 Insufficient Funds Tips:");
      console.log("1. Get more Lisk Sepolia testnet tokens from the faucet");
      console.log("2. Check your wallet balance");
      console.log("3. Consider using a different wallet with more tokens");
    }
    
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
