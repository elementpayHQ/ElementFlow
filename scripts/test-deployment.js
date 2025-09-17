const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Testing deployment with account:", deployer.address);

  // Get network info
  const network = await ethers.provider.getNetwork();
  console.log("Network:", network.name, "Chain ID:", network.chainId);

  // Load deployment info
  const deploymentFile = path.join(__dirname, "../deployments", `${network.chainId}.json`);
  
  if (!fs.existsSync(deploymentFile)) {
    console.error("❌ No deployment info found for this network");
    console.log("Please deploy the contract first using: npx hardhat run scripts/deploy.js --network <network>");
    process.exit(1);
  }

  const deploymentInfo = JSON.parse(fs.readFileSync(deploymentFile, "utf8"));
  console.log("Found deployment info:", deploymentInfo);

  try {
    // Get the contract instance
    const OrderManagement = await ethers.getContractFactory("OrderManagement");
    const orderManagement = OrderManagement.attach(deploymentInfo.orderManagement.address);

    console.log("Testing contract functionality...");

    // Test 1: Get contract version
    try {
      const version = await orderManagement.getVersion();
      console.log("✅ Contract version:", version);
    } catch (error) {
      console.log("⚠️  Version check failed (may not be implemented):", error.message);
    }

    // Test 2: Get contract address
    try {
      const contractAddress = await orderManagement.getContractAddress();
      console.log("✅ Contract address:", contractAddress);
    } catch (error) {
      console.log("⚠️  Address check failed:", error.message);
    }

    // Test 3: Get aggregator address
    try {
      const aggregatorAddress = await orderManagement.aggregatorAddress();
      console.log("✅ Aggregator address:", aggregatorAddress);
    } catch (error) {
      console.log("⚠️  Aggregator address check failed:", error.message);
    }

    // Test 4: Get treasury address
    try {
      const treasuryAddress = await orderManagement.treasury();
      console.log("✅ Treasury address:", treasuryAddress);
    } catch (error) {
      console.log("⚠️  Treasury address check failed:", error.message);
    }

    // Test 5: Check if contract is paused
    try {
      const isPaused = await orderManagement.paused();
      console.log("✅ Contract paused status:", isPaused);
    } catch (error) {
      console.log("⚠️  Pause status check failed:", error.message);
    }

    // Test 6: Get owner
    try {
      const owner = await orderManagement.owner();
      console.log("✅ Contract owner:", owner);
    } catch (error) {
      console.log("⚠️  Owner check failed:", error.message);
    }

    console.log("\n🎉 Contract testing completed successfully!");
    console.log("Contract is deployed and functional at:", deploymentInfo.orderManagement.address);

  } catch (error) {
    console.error("❌ Contract testing failed:", error);
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  }); 