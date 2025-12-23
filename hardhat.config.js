require("@nomicfoundation/hardhat-toolbox");
require("@nomiclabs/hardhat-etherscan");
require("dotenv").config();

module.exports = {
  solidity: {
    version: "0.8.22", // Match your contract version
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      viaIR: true, // This is the key part
    },
  },
  networks: {
    "base-sepolia": {
      url: "https://sepolia.base.org",
      accounts: [process.env.PRIVATE_KEY], // Add your private key to .env
    },
  },
  etherscan: {
    apiKey: {
      "base-sepolia": "YOUR_BASESCAN_API_KEY", // Get from BaseScan
    },
    customChains: [
      {
        network: "base-sepolia",
        chainId: 84532,
        urls: {
          apiURL: "https://api-sepolia.basescan.org/api",
          browserURL: "https://sepolia.basescan.org",
        },
      },
    ],
  },
};