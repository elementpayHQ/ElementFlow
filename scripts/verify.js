const { run } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const network = await ethers.provider.getNetwork();
  console.log("Verifying contracts on network:", network.name, "Chain ID:", network.chainId);

  // Load deployment info
  const deploymentFile = path.join(__dirname, "../deployments", `${network.chainId}.json`);
  
  if (!fs.existsSync(deploymentFile)) {
    console.error("❌ No deployment info found for this network");
    process.exit(1);
  }

  const deploymentInfo = JSON.parse(fs.readFileSync(deploymentFile, "utf8"));
  console.log("Found deployment info:", deploymentInfo);

  try {
    // Verify the implementation contract
    console.log("Verifying implementation contract...");
    await run("verify:verify", {
      address: deploymentInfo.orderManagement.implementation,
      constructorArguments: [],
    });
    console.log("✅ Implementation verified successfully!");

    // Verify the proxy contract
    console.log("Verifying proxy contract...");
    await run("verify:verify", {
      address: deploymentInfo.orderManagement.address,
      constructorArguments: [],
    });
    console.log("✅ Proxy verified successfully!");

    console.log("🎉 All contracts verified successfully!");
    
  } catch (error) {
    console.error("❌ Verification failed:", error.message);
    console.log("You can verify manually using:");
    console.log(`npx hardhat verify --network ${network.name} ${deploymentInfo.orderManagement.implementation}`);
    console.log(`npx hardhat verify --network ${network.name} ${deploymentInfo.orderManagement.address}`);
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  }); 