/**
 * Polls Base Sepolia for ETH on the ephemeral deployer, then deploys v2 + runs a minimal smoke.
 *
 *   node scripts/wait-and-deploy-base-sepolia.js
 *
 * Expects .env / .env.testnet-ephemeral with PRIVATE_KEY and role addresses.
 * Exit 0 = deployed+smoke ok; 2 = still unfunded; 1 = failure.
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const { spawnSync } = require("child_process");
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const MIN_ETH = ethers.parseEther("0.002");
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

async function main() {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error("PRIVATE_KEY missing");
  const provider = new ethers.JsonRpcProvider(process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org");
  const wallet = new ethers.Wallet(pk.startsWith("0x") ? pk : `0x${pk}`, provider);
  const bal = await provider.getBalance(wallet.address);
  console.log(`deployer=${wallet.address} balance=${ethers.formatEther(bal)} ETH`);

  if (bal < MIN_ETH) {
    console.log(`Need >= ${ethers.formatEther(MIN_ETH)} ETH on Base Sepolia. Still waiting on faucet.`);
    process.exit(2);
  }

  const deploy = spawnSync(
    "npx",
    ["hardhat", "run", "scripts/deploy.js", "--network", "base-sepolia"],
    { cwd: path.join(__dirname, ".."), stdio: "inherit", env: process.env }
  );
  if (deploy.status !== 0) process.exit(deploy.status || 1);

  // Pick newest deployments/base-sepolia-*.json
  const dir = path.join(__dirname, "..", "deployments");
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("base-sepolia-") && f.endsWith(".json"))
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (!files.length) throw new Error("No deployment record written");
  const latest = JSON.parse(fs.readFileSync(path.join(dir, files[0].f), "utf8"));
  const stable = path.join(dir, "84532.base-sepolia.latest.json");
  fs.writeFileSync(stable, JSON.stringify(latest, null, 2));
  console.log("Wrote", stable);

  const smoke = spawnSync("npx", ["hardhat", "run", "scripts/smoke-base-sepolia.js", "--network", "base-sepolia"], {
    cwd: path.join(__dirname, ".."),
    stdio: "inherit",
    env: { ...process.env, DEPLOYMENT_FILE: stable, SMOKE_TOKEN: USDC },
  });
  process.exit(smoke.status || 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
