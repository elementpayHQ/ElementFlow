const { ethers, upgrades } = require("hardhat");

async function main() {
  const proxyAddress = "0x226324DA94d6698E8dA7137C081Fbd619FdC783f";
  
  console.log("Checking existing deployment...");
  console.log("Proxy Address:", proxyAddress);
  console.log("");
  
  try {
    // Get implementation address
    const implementationAddress = await upgrades.erc1967.getImplementationAddress(proxyAddress);
    console.log("Implementation Address:", implementationAddress);
    
    // Get admin address
    const adminAddress = await upgrades.erc1967.getAdminAddress(proxyAddress);
    console.log("Admin Address:", adminAddress);
    
    console.log("");
    console.log("=== CONTRACT INFO ===");
    console.log("Proxy:", proxyAddress);
    console.log("Implementation:", implementationAddress);
    console.log("Admin:", adminAddress);
    
  } catch (error) {
    console.error("Error getting deployment info:", error.message);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
