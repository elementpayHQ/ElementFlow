/**
 * Minimal Base Sepolia smoke against a deployment record.
 *
 *   DEPLOYMENT_FILE=deployments/84532.base-sepolia.latest.json \
 *     npx hardhat run scripts/smoke-base-sepolia.js --network base-sepolia
 *
 * Needs deployer key with AGGREGATOR/ORDER_CREATOR roles (true for fresh ephemeral deploy)
 * and ERC20 balance for off-ramp + pool funding. If SMOKE_TOKEN has no faucet mint,
 * on-ramp/off-ramp token legs are skipped with a warning after contract wiring checks.
 */
const { ethers, network } = require("hardhat");
const fs = require("fs");

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function faucet() returns (bool)",
  "function mint(address,uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

async function main() {
  const file = process.env.DEPLOYMENT_FILE;
  if (!file || !fs.existsSync(file)) throw new Error("DEPLOYMENT_FILE missing");
  const dep = JSON.parse(fs.readFileSync(file, "utf8"));
  console.log(`Smoke on ${network.name} chainId=${dep.chainId}`);

  const [signer] = await ethers.getSigners();
  const manager = await ethers.getContractAt("ElementFlowOrderManager", dep.contracts.orderManager.proxy);
  const registry = await ethers.getContractAt("ProviderRegistry", dep.contracts.providerRegistry.proxy);
  const pool = await ethers.getContractAt("TreasuryPool", dep.contracts.treasuryPool.proxy);

  console.log("orderManager", await manager.getAddress());
  console.log("version", await manager.getVersion());
  console.log("defaultProviderId", await manager.defaultProviderId());
  console.log("pool", await pool.getAddress(), "active?", await registry.isProviderActive(dep.contracts.treasuryPool.providerId));

  const tokenAddr = process.env.SMOKE_TOKEN || (dep.config.allowlist && dep.config.allowlist[0]);
  if (!tokenAddr) {
    console.log("No token configured — wiring-only smoke OK");
    return;
  }

  const token = new ethers.Contract(tokenAddr, ERC20_ABI, signer);
  let symbol = "?";
  try {
    symbol = await token.symbol();
  } catch {
    /* ignore */
  }
  console.log("token", tokenAddr, symbol);

  // Try faucet/mint if available (many test USDC variants expose one).
  for (const fn of ["faucet", "mint"]) {
    try {
      if (fn === "faucet") await (await token.faucet()).wait();
      else await (await token.mint(signer.address, 1_000_000n * 10n ** 6n)).wait();
      console.log("obtained test tokens via", fn);
      break;
    } catch {
      /* try next */
    }
  }

  const bal = await token.balanceOf(signer.address);
  console.log("token balance", bal.toString());
  if (bal === 0n) {
    console.warn("No ERC20 for smoke settlement paths — verified wiring only.");
    return;
  }

  const amount = bal > 1_000_000n ? 1_000_000n : bal / 10n;
  if (amount === 0n) {
    console.warn("Balance too small for smoke amounts");
    return;
  }

  // Fund pool for on-ramp
  await (await token.approve(await pool.getAddress(), amount * 2n)).wait();
  await (await pool.fund(tokenAddr, amount)).wait();
  console.log("funded pool", amount.toString());

  // On-ramp create + settle
  const onMsg = `smoke-on-${Date.now()}`;
  const onTx = await manager.createOrder(signer.address, amount, tokenAddr, 0, onMsg);
  const onRc = await onTx.wait();
  const onCreated = onRc.logs
    .map((l) => {
      try {
        return manager.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((l) => l && l.name === "OrderCreated");
  const onId = onCreated.args.orderId;
  console.log("on-ramp created", onId);
  const userBefore = await token.balanceOf(signer.address);
  const settleOn = await (await manager.settleOrder(onId)).wait();
  const settledEv = settleOn.logs
    .map((l) => {
      try {
        return manager.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((l) => l && l.name === "OrderSettled");
  console.log("on-ramp settled event fields", {
    token: settledEv.args.token,
    requester: settledEv.args.requester,
    netAmount: settledEv.args.netAmount.toString(),
    providerId: settledEv.args.providerId,
  });
  const userAfter = await token.balanceOf(signer.address);
  console.log("user delta", (userAfter - userBefore).toString());

  // Off-ramp create + refund (exercises OrderRefunded rich event)
  await (await token.approve(await manager.getAddress(), amount)).wait();
  const offMsg = `smoke-off-${Date.now()}`;
  const offTx = await manager.createOrder(signer.address, amount, tokenAddr, 1, offMsg);
  const offRc = await offTx.wait();
  const offCreated = offRc.logs
    .map((l) => {
      try {
        return manager.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((l) => l && l.name === "OrderCreated");
  const offId = offCreated.args.orderId;
  const refundRc = await (await manager.refundOrder(offId)).wait();
  const refundEv = refundRc.logs
    .map((l) => {
      try {
        return manager.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((l) => l && l.name === "OrderRefunded");
  console.log("off-ramp refunded event fields", {
    token: refundEv.args.token,
    requester: refundEv.args.requester,
    amount: refundEv.args.amount.toString(),
  });

  console.log("SMOKE OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
