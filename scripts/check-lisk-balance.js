const { ethers } = require("hardhat");

async function main() {
  console.log("🔍 Checking balance on Lisk Sepolia network...");
  
  // Get the signer
  const [signer] = await ethers.getSigners();
  const address = await signer.getAddress();
  
  console.log("Account:", address);
  
  // Get balance
  const balance = await ethers.provider.getBalance(address);
  const balanceInEth = ethers.formatEther(balance);
  
  console.log("💰 Balance on Lisk Sepolia:", balanceInEth, "ETH");
  console.log("💰 Balance in Wei:", balance.toString());
  
  // Check if balance is sufficient for deployment
  const estimatedGas = ethers.parseUnits("0.05", "ether"); // Rough estimate
  if (balance < estimatedGas) {
    console.log("❌ Insufficient balance for deployment");
    console.log("💡 You need Lisk Sepolia ETH, not regular Sepolia ETH");
    console.log("🌐 Get Lisk Sepolia ETH from: https://sepolia-faucet.lisk.com/");
  } else {
    console.log("✅ Sufficient balance for deployment");
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });


