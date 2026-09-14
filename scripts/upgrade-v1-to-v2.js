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
 * PROXY_ADDRESS must match config/chains/<chainId>.*.json contracts.orderManagerProxy
 * unless ALLOW_PROXY_OVERRIDE=1.
 */
const { ethers, upgrades, network } = require("hardhat");
const fs = require("fs");
const path = require("path");
const {
  resolveAndAssertChain,
  envRolePrefix,
  resolveRoleAddress,
  resolveProxyAddress,
  assertDistinctRoles,
} = require("./lib/chainConfig");

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
  const [signer] = await ethers.getSigners();
  const warnings = [];
  const providerNet = await ethers.provider.getNetwork();
  const config = resolveAndAssertChain({
    networkName: network.name,
    providerChainId: providerNet.chainId,
    allowLocal: false,
    allowPlanned: false,
  });

  const proxyAddress = resolveProxyAddress(config);
  const prefix = envRolePrefix(network.name);

  const admin = resolveRoleAddress({
    envKey: `${prefix}_ADMIN_ADDRESS`,
    fallback: signer.address,
    config,
    warnings,
    label: "admin",
  });
  const aggregator = resolveRoleAddress({
    envKey: `${prefix}_AGGREGATOR_ADDRESS`,
    fallback: signer.address,
    config,
    warnings,
    label: "aggregator",
  });
  const feeRecipient = resolveRoleAddress({
    envKey: `${prefix}_FEE_RECIPIENT_ADDRESS`,
    fallback: admin,
    config,
    warnings,
    label: "feeRecipient",
  });
  assertDistinctRoles({ admin, aggregator, feeRecipient }, config);

  const feeBps = Number(process.env.FEE_BPS ?? config.deployment?.feeBpsDefault ?? 0);
  const orderTtl = Number(process.env.ORDER_TTL ?? config.deployment?.orderTtlDefault ?? 3600);
  const { tokens, amounts } = parseLegacyEscrow(process.env.LEGACY_ESCROW);

  const v1 = await ethers.getContractAt("OrderManagement", proxyAddress);
  const currentOwner = await v1.owner();
  const currentTreasury = await v1.treasury();

  console.log(`\nUpgrading ${proxyAddress} on ${config.name} (chainId=${config.chainId})`);
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
    if (process.env.ALLOW_EMPTY_LEGACY_ESCROW !== "1") {
      throw new Error(
        "LEGACY_ESCROW is empty. Run scan-legacy-orders.js first, or set ALLOW_EMPTY_LEGACY_ESCROW=1 " +
          "only if you are sure no v1 off-ramp is still pending."
      );
    }
    console.log(
      "\n  WARNING: ALLOW_EMPTY_LEGACY_ESCROW=1 — proceeding with no seed. " +
        "Only correct if no v1 off-ramp order is still pending."
    );
  }

  const V2 = await ethers.getContractFactory("ElementFlowOrderManager");

  console.log("\nValidating storage layout...");
  await upgrades.validateUpgrade(proxyAddress, V2, { kind: "uups" });
  console.log("  layout is compatible");

  const wasPaused = await v1.paused();
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
  console.log("  paused        :", await v2.paused(), wasPaused ? "(preserved from v1)" : "");

  if (wasPaused && !(await v2.paused())) {
    throw new Error("Post-upgrade check failed: v1 was paused but v2 is not");
  }

  for (const [i, token] of tokens.entries()) {
    const seeded = await v2.escrowedBalance(token);
    const held = await (await ethers.getContractAt("IERC20", token)).balanceOf(proxyAddress);
    console.log(`  ${token}: escrow=${seeded} held=${held} free=${await v2.availableLiquidity(token)}`);
    if (seeded !== amounts[i]) throw new Error(`escrow seed mismatch for ${token}`);
    if (held < seeded) console.log("    WARNING: held balance is below the seeded escrow.");
  }

  const record = {
    network: network.name,
    chainId: config.chainId,
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
  fs.writeFileSync(
    path.join(dir, `${config.chainId}.${network.name}.upgrade.latest.json`),
    JSON.stringify(record, null, 2)
  );

  if (warnings.length) {
    console.log("\nWARNINGS");
    warnings.forEach((w) => console.log("  -", w));
  }

  console.log("\nNext steps:");
  console.log("  1. Allowlist tokens: setTokenAllowed(token, true) — v2 rejects unlisted tokens.");
  console.log("  2. Deploy + register ProviderRegistry and TreasuryPool, then setProviderRegistry.");
  console.log("  3. Drain pending v1 orders with settleLegacyOrder / refundLegacyOrder.");
  console.log("  4. Move DEFAULT_ADMIN_ROLE and UPGRADER_ROLE to the governance multisig.");
  console.log("  5. Update config/chains + run scripts/post-deploy-check.js — this chain only.");
  console.log("  6. Do NOT assume other chains are upgraded because this one succeeded.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
