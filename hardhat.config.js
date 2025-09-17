require("@nomicfoundation/hardhat-toolbox");
require("@openzeppelin/hardhat-upgrades");
require("dotenv").config();

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.22",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    // Local development
    hardhat: {
      chainId: 31337,
      allowUnlimitedContractSize: true,
    },
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
    },

    // Base Networks
    base: {
      url: process.env.BASE_MAINNET_RPC || "https://mainnet.base.org",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: 8453,
    },
    "base-sepolia": {
      url: process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: 84532,
    },

    // // Arbitrum Networks
    // arbitrum: {
    //   url: process.env.ARBITRUM_MAINNET_RPC || "https://arb1.arbitrum.io/rpc",
    //   accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    //   chainId: 42161,
    // },
    // "arbitrum-sepolia": {
    //   url: process.env.ARBITRUM_SEPOLIA_RPC || "https://sepolia-rollup.arbitrum.io/rpc",
    //   accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    //   chainId: 421614,
    // },

    // // Scroll Networks
    // scroll: {
    //   url: process.env.SCROLL_MAINNET_RPC || "https://rpc.scroll.io",
    //   accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    //   chainId: 534352,
    // },
    // "scroll-sepolia": {
    //   url: process.env.SCROLL_SEPOLIA_RPC || "https://sepolia-rpc.scroll.io",
    //   accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    //   chainId: 534351,
    // },

    // // Lisk Networks
    // lisk: {
    //   url: process.env.LISK_MAINNET_RPC || "https://rpc.lisk.com/",
    //   accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    //   chainId: 1135,
    // },
    "lisk-sepolia": {
      url: process.env.LISK_SEPOLIA_RPC || "https://rpc.sepolia-api.lisk.com",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: 4202,
      timeout: 300000, // 5 minutes timeout
      gasPrice: 1000000, // 1 gwei (much lower)
    },
  },
  // Etherscan verification
  etherscan: {
    apiKey: {
      // Base
      "base": process.env.BASESCAN_API_KEY || "",
      "base-sepolia": process.env.BASESCAN_API_KEY || "",
      
      // Arbitrum
      "arbitrum": process.env.ARBISCAN_API_KEY || "",
      "arbitrum-sepolia": process.env.ARBISCAN_API_KEY || "",
      
      // Scroll
      "scroll": process.env.SCROLLSCAN_API_KEY || "",
      "scroll-sepolia": process.env.SCROLLSCAN_API_KEY || "",
      
      // Lisk
      "lisk": process.env.LISKSCAN_API_KEY || "",
      "lisk-sepolia": process.env.LISKSCAN_API_KEY || "",
    },
    customChains: [
      // Base
      {
        network: "base",
        chainId: 8453,
        urls: {
          apiURL: "https://api.basescan.org/api",
          browserURL: "https://basescan.org",
        },
      },
      {
        network: "base-sepolia",
        chainId: 84532,
        urls: {
          apiURL: "https://api-sepolia.basescan.org/api",
          browserURL: "https://sepolia.basescan.org",
        },
      },
      
      // Arbitrum
      {
        network: "arbitrum",
        chainId: 42161,
        urls: {
          apiURL: "https://api.arbiscan.io/api",
          browserURL: "https://arbiscan.io/",
        },
      },
      {
        network: "arbitrum-sepolia",
        chainId: 421614,
        urls: {
          apiURL: "https://api-sepolia.arbiscan.io/api",
          browserURL: "https://sepolia.arbiscan.io/",
        },
      },
      
      // Scroll
      {
        network: "scroll",
        chainId: 534352,
        urls: {
          apiURL: "https://api.scrollscan.com/api",
          browserURL: "https://scrollscan.com/",
        },
      },
      {
        network: "scroll-sepolia",
        chainId: 534351,
        urls: {
          apiURL: "https://api-sepolia.scrollscan.com/api",
          browserURL: "https://sepolia.scrollscan.com/",
        },
      },
      
      // Lisk (Note: Update these with actual Lisk explorer URLs when available)
      {
        network: "lisk",
        chainId: 1135,
        urls: {
          apiURL: "https://explorer.lisk.com/api",
          browserURL: "https://explorer.lisk.com",
        },
      },
      {
        network: "lisk-sepolia",
        chainId: 4202,
        urls: {
          apiURL: "https://sepolia-explorer.lisk.com/api",
          browserURL: "https://sepolia-explorer.lisk.com",
        },
      },
    ],
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS !== undefined,
    currency: "USD",
  },
};