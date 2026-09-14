/**
 * Polls Base Sepolia for ETH on the ephemeral deployer, then deploys v2 + runs a minimal smoke.
 *
 *   node scripts/wait-and-deploy-base-sepolia.js
 *
 * Expects .env / .env.testnet-ephemeral with PRIVATE_KEY and role addresses.
 * Exit 0 = deployed+smoke ok; 2 = still unfunded; 1 = failure.
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
require("dotenv").config({
  path: path.join(__dirname, "..", ".env.testnet-ephemeral"),
  override: true,
});
const { spawnSync } = require("child_process");
const { ethers } = require("ethers");
const fs = require("fs");

// Base Sepolia gas is tiny (~0.00005 ETH for a full v2 stack at ~0.006 gwei).
// CDP drips 0.0001 ETH per claim — one drip is usually enough.
const MIN_ETH = ethers.parseEther(process.env.MIN_DEPLOY_ETH || "0.00012");
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

async function main() {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error("PRIVATE_KEY missing");
  const provider = new ethers.JsonRpcProvider(process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org");
  const wallet = new ethers.Wallet(pk.startsWith("0x") ? pk : `0x${pk}`, provider);
  const bal = await provider.getBalance(wallet.address);
  console.log(`deployer=${wallet.address} balance=${ethers.formatEther(bal)} ETH`);

  if (bal < MIN_ETH) {
    console.log(`Need >= ${ethers.formatEther(MIN_ETH)} ETH on Base Sepolia.`);
    console.log(`Fund via: node scripts/request-base-sepolia-faucet.js`);
    console.log(`Or send ETH to ${wallet.address}`);
    process.exit(2);
  }

  const deploy = spawnSync(
    "npx",
    ["hardhat", "run", "scripts/deploy.js", "--network", "base-sepolia"],
    { cwd: path.join(__dirname, ".."), stdio: "inherit", env: process.env }
  );
  if (deploy.status !== 0) process.exit(deploy.status || 1);

  const dir = path.join(__dirname, "..", "deployments");
  const stable = path.join(dir, "84532.base-sepolia.latest.json");
  if (!fs.existsSync(stable)) {
    throw new Error(`Expected ${stable} from deploy.js`);
  }
  console.log("Using", stable);

  const smoke = spawnSync("npx", ["hardhat", "run", "scripts/smoke-base-sepolia.js", "--network", "base-sepolia"], {
    cwd: path.join(__dirname, ".."),
    stdio: "inherit",
    env: { ...process.env, DEPLOYMENT_FILE: stable, SMOKE_TOKEN: USDC },
  });
  if (smoke.status !== 0) process.exit(smoke.status || 1);

  const check = spawnSync("npx", ["hardhat", "run", "scripts/post-deploy-check.js", "--network", "base-sepolia"], {
    cwd: path.join(__dirname, ".."),
    stdio: "inherit",
    env: process.env,
  });
  if (check.status !== 0) process.exit(check.status || 1);

  const verify = spawnSync("npx", ["hardhat", "run", "scripts/verify-deployment.js", "--network", "base-sepolia"], {
    cwd: path.join(__dirname, ".."),
    stdio: "inherit",
    env: { ...process.env, DEPLOYMENT_FILE: stable },
  });
  process.exit(verify.status || 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
