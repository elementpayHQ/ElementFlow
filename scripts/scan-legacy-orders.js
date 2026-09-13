/**
 * Computes the `LEGACY_ESCROW` seed required by `scripts/upgrade-v1-to-v2.js`.
 *
 * Enumerates every v1 `OrderCreated` event, then reads each order's *current* on-chain
 * status rather than replaying settle/refund events. That matters: v1's `releaseEscrow`
 * also moves an order to `Completed` without emitting `OrderSettled`, so an event-only
 * reconstruction would over-count pending escrow.
 *
 *   PROXY_ADDRESS=0x... FROM_BLOCK=12345678 \
 *     npx hardhat run scripts/scan-legacy-orders.js --network base
 */
const { ethers, network } = require("hardhat");

const V1_STATUS = { Pending: 0, Completed: 1, Cancelled: 2 };
const ORDER_TYPE = { OnRamp: 0, OffRamp: 1 };
const CHUNK = Number(process.env.LOG_CHUNK ?? 50_000);

async function main() {
  const proxyAddress = process.env.PROXY_ADDRESS;
  if (!proxyAddress) throw new Error("PROXY_ADDRESS is required");

  const fromBlock = Number(process.env.FROM_BLOCK ?? 0);
  const toBlock = Number(process.env.TO_BLOCK ?? (await ethers.provider.getBlockNumber()));

  const v1 = await ethers.getContractAt("OrderManagement", proxyAddress);
  const filter = v1.filters.OrderCreated();

  console.log(`Scanning ${proxyAddress} on ${network.name}, blocks ${fromBlock}..${toBlock}`);

  const orderIds = new Set();
  for (let start = fromBlock; start <= toBlock; start += CHUNK) {
    const end = Math.min(start + CHUNK - 1, toBlock);
    // RPC providers cap log ranges, so page through rather than asking for everything.
    const logs = await v1.queryFilter(filter, start, end);
    logs.forEach((log) => orderIds.add(log.args.orderId));
    if (logs.length) console.log(`  ${start}..${end}: ${logs.length} orders (total ${orderIds.size})`);
  }

  console.log(`\nFound ${orderIds.size} orders. Reading current status...`);

  const pendingOffRampByToken = new Map();
  const summary = { pendingOffRamp: 0, pendingOnRamp: 0, completed: 0, cancelled: 0, unreadable: 0 };

  for (const orderId of orderIds) {
    let order;
    try {
      order = await v1.getOrder(orderId);
    } catch {
      summary.unreadable++;
      continue;
    }

    const [, , , token, amount, status, orderType] = order;

    if (Number(status) === V1_STATUS.Completed) summary.completed++;
    else if (Number(status) === V1_STATUS.Cancelled) summary.cancelled++;
    else if (Number(orderType) === ORDER_TYPE.OffRamp) {
      summary.pendingOffRamp++;
      const key = ethers.getAddress(token);
      pendingOffRampByToken.set(key, (pendingOffRampByToken.get(key) ?? 0n) + amount);
    } else {
      // Pending on-ramp orders hold no on-chain escrow, so they contribute nothing.
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
