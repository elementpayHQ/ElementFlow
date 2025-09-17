const { ethers, upgrades } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying contracts with the account:", deployer.address);
  
  // Get balance before deployment
  const balance = await deployer.getBalance();
  console.log("💰 Account balance:", ethers.formatEther(balance), "ETH");

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
    // Deploy or upgrade OrderManagement contract with optimized gas settings
    const OrderManagement = await ethers.getContractFactory("OrderManagement");
    
    let orderManagement;
    
    if (deploymentInfo.orderManagement) {
      console.log("Upgrading existing OrderManagement contract...");
      orderManagement = await upgrades.upgradeProxy(
        deploymentInfo.orderManagement.address,
        OrderManagement,
        {
          gasLimit: 2000000, // Lower gas limit
          gasPrice: ethers.parseUnits("15", "gwei"), // Lower gas price (15 gwei)
        }
      );
      console.log("OrderManagement upgraded to:", orderManagement.address);
    } else {
      console.log("Deploying new OrderManagement contract...");
      
      // For initial deployment, we need to provide constructor parameters
      const aggregatorAddress = process.env.AGGREGATOR_ADDRESS || deployer.address;
      const treasuryAddress = process.env.TREASURY_ADDRESS || deployer.address;
      const ownerAddress = process.env.OWNER_ADDRESS || deployer.address;
      
      orderManagement = await upgrades.deployProxy(OrderManagement, [
        aggregatorAddress,
        treasuryAddress,
        ownerAddress
      ], {
        initializer: "initialize",
        kind: "uups",
        gasLimit: 3000000, // Lower gas limit for deployment
        gasPrice: ethers.parseUnits("15", "gwei"), // Lower gas price (15 gwei)
      });
      
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

    // Get balance after deployment
    const balanceAfter = await deployer.getBalance();
    const gasUsed = balance.sub(balanceAfter);
    console.log("💰 Gas used:", ethers.formatEther(gasUsed), "ETH");
    console.log("💰 Remaining balance:", ethers.formatEther(balanceAfter), "ETH");

    console.log("✅ Deployment completed successfully!");
    console.log("Contract Address:", orderManagement.address);
    console.log("Implementation Address:", implementationAddress);

    // Log network-specific explorer links
    if (network.chainId === 4202) { // Lisk Sepolia
      console.log("Lisk Sepolia Explorer:", `https://sepolia-explorer.lisk.com/address/${orderManagement.address}`);
    }

  } catch (error) {
    console.error("❌ Deployment failed:", error);
    
    // If it's a gas error, provide helpful information
    if (error.message.includes("insufficient funds")) {
      console.log("\n💡 Gas optimization tips:");
      console.log("1. Try getting more Lisk Sepolia ETH from: https://sepolia-faucet.lisk.com/");
      console.log("2. Wait for lower gas prices on the network");
      console.log("3. Consider deploying during off-peak hours");
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


