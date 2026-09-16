require("@nomicfoundation/hardhat-toolbox");
require("@openzeppelin/hardhat-upgrades");
const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

/**
 * Load `.env` without clobbering non-empty process.env (e.g. ephemeral deploy scripts
 * that set PRIVATE_KEY / roles then spawn Hardhat). Still replace blank exports so a
 * stale `ETHERSCAN_API_KEY=` in the shell does not block `.env`.
 */
function loadDotenvFile(file) {
  const full = path.isAbsolute(file) ? file : path.join(__dirname, file);
  if (!fs.existsSync(full)) return;
  const parsed = dotenv.parse(fs.readFileSync(full));
  for (const [key, value] of Object.entries(parsed)) {
    const cur = process.env[key];
    if (cur === undefined || cur === "") {
      process.env[key] = value;
    }
  }
}

loadDotenvFile(".env");
loadDotenvFile(".env.testnet-ephemeral");

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

    polygon: {
      url: process.env.POLYGON_RPC || "https://polygon-bor-rpc.publicnode.com",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: 137,
    },
    bsc: {
      url: process.env.BSC_MAINNET_RPC || "https://bsc-dataseed.binance.org",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: 56,
    },
    arbitrum: {
      url: process.env.ARBITRUM_RPC || "https://arb1.arbitrum.io/rpc",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: 42161,
    },
    scroll: {
      url: process.env.SCROLL_RPC || "https://rpc.scroll.io",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: 534352,
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
    // "lisk-sepolia": {
    //   url: process.env.LISK_SEPOLIA_RPC || "https://rpc.sepolia-api.lisk.com",
    //   accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    //   chainId: 4202,
    // },
  },
  // Etherscan API v2: apiKey MUST be a single string (not a per-network map).
  // A map disables v2 → "Missing chainid parameter". One key covers Base + Base Sepolia.
  // Create key: https://etherscan.io/apidashboard
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY || process.env.BASESCAN_API_KEY || "",
    customChains: [
      {
        network: "base",
        chainId: 8453,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api",
          browserURL: "https://basescan.org",
        },
      },
      {
        network: "base-sepolia",
        chainId: 84532,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api",
          browserURL: "https://sepolia.basescan.org",
        },
      },
      // Planned chains — when you flip status, prefer ETHERSCAN_API_KEY (v2) if listed
      // on https://api.etherscan.io/v2/chainlist; otherwise use a chain-specific explorer key
      // temporarily via a dedicated hardhat config override.
      {
        network: "arbitrum",
        chainId: 42161,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api",
          browserURL: "https://arbiscan.io",
        },
      },
      {
        network: "arbitrum-sepolia",
        chainId: 421614,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api",
          browserURL: "https://sepolia.arbiscan.io",
        },
      },
      {
        network: "scroll",
        chainId: 534352,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api",
          browserURL: "https://scrollscan.com",
        },
      },
      {
        network: "scroll-sepolia",
        chainId: 534351,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api",
          browserURL: "https://sepolia.scrollscan.com",
        },
      },
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
  // Sourcify disabled during explorer verify — it can return HTML and fail the task
  // after Etherscan already succeeded. Re-enable if you want dual submission.
  sourcify: {
    enabled: false,
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS !== undefined,
    currency: "USD",
  },
};