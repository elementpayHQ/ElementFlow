const { ethers, upgrades } = require("hardhat");

async function main() {
  console.log("Deploying OrderManagement to Base Sepolia...");

  // Get the contract factory
  const OrderManagement = await ethers.getContractFactory("OrderManagement");

  // Get addresses from environment variables
  const aggregatorAddress = process.env.AGGREGATOR_ADDRESS;
  const treasuryAddress = process.env.TREASURY_ADDRESS;
  
  // Use Safe multisig wallet as owner if provided, otherwise use OWNER_ADDRESS
  const ownerAddress = process.env.SAFE_ADDRESS || process.env.OWNER_ADDRESS;
  
  // Validate addresses
  if (!aggregatorAddress || !treasuryAddress || !ownerAddress) {
    throw new Error("Missing required environment variables: AGGREGATOR_ADDRESS, TREASURY_ADDRESS, and SAFE_ADDRESS or OWNER_ADDRESS must be set");
  }

  // Deploy the proxy contract
  const orderManagement = await upgrades.deployProxy(
    OrderManagement,
    [aggregatorAddress, treasuryAddress, ownerAddress],
    {
      initializer: "initialize",
      kind: "uups", // Using UUPS proxy pattern
    }
  );

  await orderManagement.waitForDeployment();

  console.log("OrderManagement deployed to:", await orderManagement.getAddress());
  console.log("Transaction hash:", orderManagement.deploymentTransaction().hash);

  // Verify deployment
  console.log("\nDeployment successful!");
  console.log("Contract address:", await orderManagement.getAddress());
  console.log("Transaction confirmed on Base Sepolia");
  console.log("Contract is ready for use!");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
