/**
 * In-place upgrade of a live v1 `OrderManagement` proxy to `ElementFlowOrderManager` v2.
 *
 * The proxy address does not change, so the backend, the frontend and every pending v1
 * order keep working. Two v1 vulnerabilities are live (permissionless `escrowFunds` /
 * `releaseEscrow` can freeze user escrow forever, and `createOrder` has no access
 * control), which is why this is an upgrade rather than a migration to a new address.
 *
 *   PROXY_ADDRESS=0x... LEGACY_ESCROW=0xTokenA:1000000,0xTokenB:5000000 \
 *     npx hardhat run scripts/upgrade-v1-to-v2.js --network base-sepolia
 *
 * ## Computing LEGACY_ESCROW (required, and easy to get wrong)
 *
 * v1 kept no escrow accounting. Without a seed, v2 would treat the proxy's entire balance
 * as unencumbered house float and could pay it out from under off-ramp users whose orders
 * are still pending. For each token, sum `amount` over every v1 order that is currently
 * `status == Pending (0)` AND `orderType == OffRamp (1)`. `scripts/scan-legacy-orders.js`
 * derives this from OrderCreated/OrderSettled/OrderRefunded logs.
 *
 * Seeding too low risks paying out user escrow; seeding too high only locks house float,
 * which a treasurer can release later. When in doubt, round up.
 */
const { ethers, upgrades, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

function parseLegacyEscrow(raw) {
  if (!raw) return { tokens: [], amounts: [] };
  const tokens = [];
  const amounts = [];
  for (const entry of raw.split(",").map((e) => e.trim()).filter(Boolean)) {
    const [token, amount] = entry.split(":");
    if (!token || !amount) throw new Error(`Malformed LEGACY_ESCROW entry: "${entry}" (want 0xToken:amount)`);
    tokens.push(ethers.getAddress(token.trim()));
    amounts.push(BigInt(amount.trim()));
  }
  return { tokens, amounts };
}

async function main() {
  const proxyAddress = process.env.PROXY_ADDRESS;
  if (!proxyAddress) throw new Error("PROXY_ADDRESS is required");

  const [signer] = await ethers.getSigners();
  const prefix = network.name.toUpperCase().replace(/-/g, "_");

  const admin = ethers.getAddress(process.env[`${prefix}_ADMIN_ADDRESS`] ?? signer.address);
  const aggregator = ethers.getAddress(process.env[`${prefix}_AGGREGATOR_ADDRESS`] ?? signer.address);
  const feeRecipient = ethers.getAddress(process.env[`${prefix}_FEE_RECIPIENT_ADDRESS`] ?? admin);
  const feeBps = Number(process.env.FEE_BPS ?? 0);
  const orderTtl = Number(process.env.ORDER_TTL ?? 3600);
  const { tokens, amounts } = parseLegacyEscrow(process.env.LEGACY_ESCROW);

  const v1 = await ethers.getContractAt("OrderManagement", proxyAddress);
  const currentOwner = await v1.owner();
  const currentTreasury = await v1.treasury();

  console.log(`\nUpgrading ${proxyAddress} on ${network.name}`);
  console.log("  signer          :", signer.address);
  console.log("  current owner   :", currentOwner);
  console.log("  current treasury:", currentTreasury, "(carried over from v1 storage)");
  console.log("  new admin       :", admin);
  console.log("  new aggregator  :", aggregator);
  console.log("  fee recipient   :", feeRecipient);
  console.log(`  feeBps          : ${feeBps} / 100000`);
  console.log(`  orderTtl        : ${orderTtl}s`);
  console.log(
    "  legacy escrow   :",
    tokens.length ? tokens.map((t, i) => `${t}=${amounts[i]}`).join(", ") : "(none)"
  );

  if (currentOwner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(
      `Signer is not the v1 owner. v1 gates upgrades with onlyOwner, so ${currentOwner} must run this.`
    );
  }
  if (!tokens.length) {
    console.log(
      "\n  WARNING: no LEGACY_ESCROW seed. Only correct if no v1 off-ramp order is still pending."
    );
  }

  const V2 = await ethers.getContractFactory("ElementFlowOrderManager");

  // Fails loudly on any storage-layout incompatibility before anything is broadcast.
  console.log("\nValidating storage layout...");
  await upgrades.validateUpgrade(proxyAddress, V2, { kind: "uups" });
  console.log("  layout is compatible");

  const v2 = await upgrades.upgradeProxy(proxyAddress, V2, {
    kind: "uups",
    call: {
      fn: "initializeV2",
      args: [admin, aggregator, feeRecipient, feeBps, orderTtl, tokens, amounts],
    },
  });
  await v2.waitForDeployment();

  const implementation = await upgrades.erc1967.getImplementationAddress(proxyAddress);
  console.log("\nUpgrade complete");
  console.log("  proxy         :", proxyAddress, "(unchanged)");
  console.log("  implementation:", implementation);
  console.log("  version       :", await v2.getVersion());
  console.log("  treasury      :", await v2.treasury());

  for (const [i, token] of tokens.entries()) {
    const seeded = await v2.escrowedBalance(token);
    const held = await (await ethers.getContractAt("IERC20", token)).balanceOf(proxyAddress);
    console.log(`  ${token}: escrow=${seeded} held=${held} free=${await v2.availableLiquidity(token)}`);
    if (seeded !== amounts[i]) throw new Error(`escrow seed mismatch for ${token}`);
    if (held < seeded) console.log("    WARNING: held balance is below the seeded escrow.");
  }

  const record = {
    network: network.name,
    upgradedAt: new Date().toISOString(),
    proxy: proxyAddress,
    implementation,
    from: "OrderManagement v1",
    to: "ElementFlowOrderManager v2",
    roles: { admin, aggregator, treasury: currentTreasury, feeRecipient },
    legacyEscrowSeed: tokens.map((t, i) => ({ token: t, amount: amounts[i].toString() })),
  };
  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `upgrade-${network.name}-${Date.now()}.json`), JSON.stringify(record, null, 2));

  console.log("\nNext steps:");
  console.log("  1. Allowlist tokens: setTokenAllowed(token, true) — v2 rejects unlisted tokens.");
  console.log("  2. Deploy + register ProviderRegistry and TreasuryPool, then setProviderRegistry.");
  console.log("  3. Drain pending v1 orders with settleLegacyOrder / refundLegacyOrder.");
  console.log("  4. Move DEFAULT_ADMIN_ROLE and UPGRADER_ROLE to the governance multisig.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
