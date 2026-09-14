/**
 * Computes the `LEGACY_ESCROW` seed required by `scripts/upgrade-v1-to-v2.js`.
 *
 *   PROXY_ADDRESS=0x... FROM_BLOCK=12345678 \
 *     npx hardhat run scripts/scan-legacy-orders.js --network base
 *
 * PROXY_ADDRESS must match config orderManagerProxy unless ALLOW_PROXY_OVERRIDE=1.
 */
const { ethers, network } = require("hardhat");
const {
  resolveAndAssertChain,
  resolveProxyAddress,
} = require("./lib/chainConfig");

const V1_STATUS = { Pending: 0, Completed: 1, Cancelled: 2 };
const ORDER_TYPE = { OnRamp: 0, OffRamp: 1 };
const CHUNK = Number(process.env.LOG_CHUNK ?? 50_000);
if (!Number.isFinite(CHUNK) || CHUNK <= 0) {
  throw new Error(`LOG_CHUNK must be a positive number (got ${process.env.LOG_CHUNK})`);
}

async function main() {
  const providerNet = await ethers.provider.getNetwork();
  const config = resolveAndAssertChain({
    networkName: network.name,
    providerChainId: providerNet.chainId,
    allowLocal: false,
    allowPlanned: false,
  });

  const proxyAddress = resolveProxyAddress(config);
  const fromBlock = Number(process.env.FROM_BLOCK ?? 0);
  const toBlock = Number(process.env.TO_BLOCK ?? (await ethers.provider.getBlockNumber()));

  const v1 = await ethers.getContractAt("OrderManagement", proxyAddress);
  const filter = v1.filters.OrderCreated();

  console.log(
    `Scanning ${proxyAddress} on ${config.name} (chainId=${config.chainId}), blocks ${fromBlock}..${toBlock}`
  );

  const orderIds = new Set();
  for (let start = fromBlock; start <= toBlock; start += CHUNK) {
    const end = Math.min(start + CHUNK - 1, toBlock);
    const logs = await v1.queryFilter(filter, start, end);
    logs.forEach((log) => orderIds.add(log.args.orderId));
    if (logs.length) console.log(`  ${start}..${end}: ${logs.length} orders (total ${orderIds.size})`);
  }

  console.log(`\nFound ${orderIds.size} orders. Reading current status...`);

  const pendingOffRampByToken = new Map();
  const summary = { pendingOffRamp: 0, pendingOnRamp: 0, completed: 0, cancelled: 0 };

  for (const orderId of orderIds) {
    let order;
    try {
      order = await v1.getOrder(orderId);
    } catch (error) {
      throw new Error(
        `Failed to read order ${orderId}; refusing to emit LEGACY_ESCROW. Underlying: ${error.message}`
      );
    }

    const [, , , token, amount, status, orderType] = order;

    if (Number(status) === V1_STATUS.Completed) summary.completed++;
    else if (Number(status) === V1_STATUS.Cancelled) summary.cancelled++;
    else if (Number(orderType) === ORDER_TYPE.OffRamp) {
      summary.pendingOffRamp++;
      const key = ethers.getAddress(token);
      pendingOffRampByToken.set(key, (pendingOffRampByToken.get(key) ?? 0n) + amount);
    } else {
      summary.pendingOnRamp++;
    }
  }

  console.log("\nStatus summary:", summary);
  console.log("\nPending off-ramp escrow by token:");
  for (const [token, amount] of pendingOffRampByToken) {
    const held = await (await ethers.getContractAt("IERC20", token)).balanceOf(proxyAddress);
    console.log(`  ${token}  escrow=${amount}  proxyBalance=${held}`);
    if (held < amount) {
      console.log("    WARNING: the proxy holds less than the pending escrow for this token.");
    }
  }

  const seed = [...pendingOffRampByToken.entries()].map(([t, a]) => `${t}:${a}`).join(",");
  console.log("\nLEGACY_ESCROW=" + (seed || "(none)"));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
