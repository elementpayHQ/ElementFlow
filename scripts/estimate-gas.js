const { ethers, upgrades } = require("hardhat");

async function main() {
  console.log("🔍 Estimating gas costs for deployment...");
  
  const [deployer] = await ethers.getSigners();
  console.log("Account:", deployer.address);
  
  // Get current balance
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("💰 Current balance:", ethers.formatEther(balance), "ETH");
  
  // Get current gas price
  const gasPrice = await ethers.provider.getFeeData();
  console.log("⛽ Current gas price:", ethers.formatUnits(gasPrice.gasPrice, "gwei"), "gwei");
  
  try {
    // Estimate gas for deployment
    const OrderManagement = await ethers.getContractFactory("OrderManagement");
    
    const aggregatorAddress = deployer.address;
    const treasuryAddress = deployer.address;
    const ownerAddress = deployer.address;
    
    // Estimate gas for proxy deployment
    const deploymentData = OrderManagement.interface.encodeFunctionData("initialize", [
      aggregatorAddress,
      treasuryAddress,
      ownerAddress
    ]);
    
    // Rough estimate for proxy deployment (implementation + proxy + initialization)
    const estimatedGas = 3000000n; // Conservative estimate
    
    const estimatedCost = estimatedGas * gasPrice.gasPrice;
    const estimatedCostEth = ethers.formatEther(estimatedCost);
    
    console.log("📊 Gas Estimation:");
    console.log("   Estimated gas units:", estimatedGas.toLocaleString());
    console.log("   Estimated cost:", estimatedCostEth, "ETH");
    console.log("   Gas price:", ethers.formatUnits(gasPrice.gasPrice, "gwei"), "gwei");
    
    if (balance < estimatedCost) {
      const shortfall = estimatedCost - balance;
      console.log("❌ Insufficient balance!");
      console.log("   Shortfall:", ethers.formatEther(shortfall), "ETH");
      console.log("💡 You need more Lisk Sepolia ETH");
      console.log("🌐 Get it from: https://sepolia-faucet.lisk.com/");
    } else {
      const remaining = balance - estimatedCost;
      console.log("✅ Sufficient balance!");
      console.log("   Remaining after deployment:", ethers.formatEther(remaining), "ETH");
    }
    
  } catch (error) {
    console.error("❌ Error estimating gas:", error);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });


