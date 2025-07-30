const { ethers, upgrades } = require("hardhat");

async function main() {
  console.log("Getting deployment information...\n");
  
  // Get the contract factory
  const OrderManagement = await ethers.getContractFactory("OrderManagement");
  
  // Get addresses from environment variables
  const aggregatorAddress = process.env.AGGREGATOR_ADDRESS;
  const treasuryAddress = process.env.TREASURY_ADDRESS;
  const ownerAddress = process.env.SAFE_ADDRESS || process.env.OWNER_ADDRESS;
  
  console.log("Environment variables:");
  console.log("- Aggregator:", aggregatorAddress);
  console.log("- Treasury:", treasuryAddress);
  console.log("- Owner:", ownerAddress);
  console.log("");
  
  // Deploy the proxy contract
  const orderManagement = await upgrades.deployProxy(
    OrderManagement,
    [aggregatorAddress, treasuryAddress, ownerAddress],
    {
      initializer: "initialize",
      kind: "uups",
    }
  );

  await orderManagement.waitForDeployment();
  
  const proxyAddress = await orderManagement.getAddress();
  
  // Get implementation address
  const implementationAddress = await upgrades.erc1967.getImplementationAddress(proxyAddress);
  
  console.log("=== DEPLOYMENT RESULTS ===");
  console.log("Proxy Address (what users interact with):", proxyAddress);
  console.log("Implementation Address (actual contract logic):", implementationAddress);
  console.log("");
  
  // Get admin address (who can upgrade)
  const adminAddress = await upgrades.erc1967.getAdminAddress(proxyAddress);
  console.log("Admin Address (who can upgrade):", adminAddress);
  console.log("");
  
  console.log("=== VERIFICATION ===");
  console.log("To verify on Etherscan:");
  console.log(`npx hardhat verify --network base-sepolia ${implementationAddress}`);
  console.log("");
  console.log("To interact with proxy:");
  console.log(`Proxy address: ${proxyAddress}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
