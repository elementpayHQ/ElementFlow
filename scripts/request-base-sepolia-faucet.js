/**
 * Request Base Sepolia ETH (and optionally USDC) via Coinbase CDP Faucets API.
 *
 * Requires CDP_API_KEY_ID + CDP_API_KEY_SECRET from https://portal.cdp.coinbase.com/
 * Each ETH claim is 0.0001 ETH; repeat until balance covers deploy (~0.0002+ at current gas).
 *
 *   node scripts/request-base-sepolia-faucet.js
 *   node scripts/request-base-sepolia-faucet.js --usdc
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
require("dotenv").config({
  path: require("path").join(__dirname, "..", ".env.testnet-ephemeral"),
  override: true,
});

const { ethers } = require("ethers");

async function main() {
  const id = process.env.CDP_API_KEY_ID;
  const secret = process.env.CDP_API_KEY_SECRET;
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error("PRIVATE_KEY missing");
  const wallet = new ethers.Wallet(pk.startsWith("0x") ? pk : `0x${pk}`);
  const address = wallet.address;
  const wantUsdc = process.argv.includes("--usdc");

  console.log("address", address);
  if (!id || !secret) {
    console.log(`
No CDP_API_KEY_ID / CDP_API_KEY_SECRET in env.

1. Create free keys at https://portal.cdp.coinbase.com/
2. Add to .env.testnet-ephemeral (gitignored):
     CDP_API_KEY_ID=...
     CDP_API_KEY_SECRET=...
3. Re-run this script (or claim in the CDP Portal UI for Base Sepolia).
4. Then: node scripts/wait-and-deploy-base-sepolia.js

Public faucet UIs (may need captcha / eligibility):
  https://www.alchemy.com/faucets/base-sepolia
  https://faucet.quicknode.com/base/sepolia
`);
    process.exit(2);
  }

  // Lazy-load SDK so the repo works without the dep until faucet is needed.
  let CdpClient;
  try {
    ({ CdpClient } = require("@coinbase/cdp-sdk"));
  } catch {
    console.error("Install faucet SDK: npm install -D @coinbase/cdp-sdk");
    process.exit(1);
  }

  const cdp = new CdpClient({ apiKeyId: id, apiKeySecret: secret });
  const tokens = wantUsdc ? ["eth", "usdc"] : ["eth"];
  for (const token of tokens) {
    const res = await cdp.evm.requestFaucet({
      address,
      network: "base-sepolia",
      token,
    });
    console.log(token, "tx", res.transactionHash);
  }

  const provider = new ethers.JsonRpcProvider(
    process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org"
  );
  // brief wait for inclusion
  await new Promise((r) => setTimeout(r, 8000));
  const bal = await provider.getBalance(address);
  console.log("balance", ethers.formatEther(bal), "ETH");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
