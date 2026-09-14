/**
 * Fresh deployment of the ElementFlow v2 stack.
 *
 *   ProviderRegistry (UUPS)  -- routes providerId -> adapter
 *   ElementFlowOrderManager (UUPS) -- escrow, settlement, fees
 *   TreasuryPool (UUPS)      -- in-house liquidity, registered as the default adapter
 *
 * Use `scripts/upgrade-v1-to-v2.js` instead when a v1 proxy already exists on the target
 * network — that path preserves the live address and its pending orders.
 *
 *   npx hardhat run scripts/deploy.js --network base-sepolia
 */
const { ethers, upgrades, network } = require("hardhat");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  resolveAndAssertChain,
  envRolePrefix,
  resolveRoleAddress,
  resolveAllowlist,
  assertDistinctRoles,
} = require("./lib/chainConfig");

const TREASURY_PROVIDER_ID = ethers.keccak256(ethers.toUtf8Bytes("ELEMENTFLOW_TREASURY"));

async function main() {
  const [deployer] = await ethers.getSigners();
  const warnings = [];
  const providerNet = await ethers.provider.getNetwork();

  const config = resolveAndAssertChain({
    networkName: network.name,
    providerChainId: providerNet.chainId,
    allowLocal: true,
    allowPlanned: false,
  });

  const prefix = envRolePrefix(network.name);
  const admin = resolveRoleAddress({
    envKey: `${prefix}_ADMIN_ADDRESS`,
    fallback: deployer.address,
    config,
    warnings,
    label: "admin",
  });
  const aggregator = resolveRoleAddress({
    envKey: `${prefix}_AGGREGATOR_ADDRESS`,
    fallback: deployer.address,
    config,
    warnings,
    label: "aggregator",
  });
  const treasury = resolveRoleAddress({
    envKey: `${prefix}_TREASURY_ADDRESS`,
    fallback: deployer.address,
    config,
    warnings,
    label: "treasury",
  });
  const feeRecipient = resolveRoleAddress({
    envKey: `${prefix}_FEE_RECIPIENT_ADDRESS`,
    fallback: treasury,
    config,
    warnings,
    label: "feeRecipient",
  });

  assertDistinctRoles({ admin, aggregator, treasury, feeRecipient }, config);

  const feeBps = Number(process.env.FEE_BPS ?? config.deployment?.feeBpsDefault ?? 0);
  const orderTtl = Number(process.env.ORDER_TTL ?? config.deployment?.orderTtlDefault ?? 3600);
  const allowlist = resolveAllowlist(config);

  console.log(`\nDeploying ElementFlow v2 to ${config.name} (chainId=${config.chainId})`);
  console.log("  hardhat net  :", network.name);
  console.log("  deployer     :", deployer.address);
  console.log("  admin        :", admin);
  console.log("  aggregator   :", aggregator);
  console.log("  treasury     :", treasury);
  console.log("  feeRecipient :", feeRecipient);
  console.log(`  feeBps       : ${feeBps} / 100000`);
  console.log(`  orderTtl     : ${orderTtl}s`);
  console.log("  allowlist    :", allowlist.length ? allowlist.join(", ") : "(none)");

  const Registry = await ethers.getContractFactory("ProviderRegistry");
  const registry = await upgrades.deployProxy(Registry, [admin], { kind: "uups", timeout: 0 });
  await registry.waitForDeployment();
  console.log("\nProviderRegistry proxy:", await registry.getAddress());

  const Manager = await ethers.getContractFactory("ElementFlowOrderManager");
  const manager = await upgrades.deployProxy(
    Manager,
    [admin, aggregator, treasury, feeRecipient, feeBps, orderTtl],
    { kind: "uups", timeout: 0 }
  );
  await manager.waitForDeployment();
  console.log("OrderManager proxy    :", await manager.getAddress());

  const Pool = await ethers.getContractFactory("TreasuryPool");
  const pool = await upgrades.deployProxy(
    Pool,
    [admin, await manager.getAddress(), TREASURY_PROVIDER_ID],
    { kind: "uups", timeout: 0 }
  );
  await pool.waitForDeployment();
  console.log("TreasuryPool proxy    :", await pool.getAddress());

  const deployerIsAdmin = admin.toLowerCase() === deployer.address.toLowerCase();

  if (deployerIsAdmin) {
    console.log("\nWiring...");
    await (await manager.setProviderRegistry(await registry.getAddress())).wait();
    await (await registry.registerProvider(TREASURY_PROVIDER_ID, await pool.getAddress())).wait();
    await (await manager.setDefaultProviderId(TREASURY_PROVIDER_ID)).wait();
    for (const token of allowlist) {
      await (await manager.setTokenAllowed(token, true)).wait();
      await (await pool.setTokenSupported(token, true)).wait();
      console.log("  allowlisted", token);
    }
    console.log("  done");
  } else {
    console.log("\nAdmin is not the deployer — execute these from the admin/multisig account:");
    console.log(`  orderManager.setProviderRegistry(${await registry.getAddress()})`);
    console.log(`  registry.registerProvider(${TREASURY_PROVIDER_ID}, ${await pool.getAddress()})`);
    console.log(`  orderManager.setDefaultProviderId(${TREASURY_PROVIDER_ID})`);
    for (const token of allowlist) {
      console.log(`  orderManager.setTokenAllowed(${token}, true)`);
      console.log(`  treasuryPool.setTokenSupported(${token}, true)`);
    }
  }

  const info = {
    network: network.name,
    chainId: config.chainId,
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    roles: { admin, aggregator, treasury, feeRecipient },
    config: { feeBps, orderTtl, allowlist },
    contracts: {
      orderManager: {
        proxy: await manager.getAddress(),
        implementation: await upgrades.erc1967.getImplementationAddress(await manager.getAddress()),
      },
      providerRegistry: {
        proxy: await registry.getAddress(),
        implementation: await upgrades.erc1967.getImplementationAddress(await registry.getAddress()),
      },
      treasuryPool: {
        proxy: await pool.getAddress(),
        implementation: await upgrades.erc1967.getImplementationAddress(await pool.getAddress()),
        providerId: TREASURY_PROVIDER_ID,
      },
    },
  };

  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  const stamped = path.join(dir, `${network.name}-${Date.now()}.json`);
  fs.writeFileSync(stamped, JSON.stringify(info, null, 2));
  const latest = path.join(dir, `${config.chainId}.${network.name}.latest.json`);
  fs.writeFileSync(latest, JSON.stringify(info, null, 2));
  console.log("\nDeployment record:", stamped);
  console.log("Latest (commit public addresses):", latest);
  if (!config.__local) {
    console.log(
      `  Next: copy proxy addresses into config/chains/${config.chainId}.*.json contracts{} and open a PR.`
    );
    console.log("\nVerifying on explorer (required step)...");
    // REQUIRE_VERIFY=0 to skip (not recommended). Needs ETHERSCAN_API_KEY for Basescan.
    const requireVerify = process.env.REQUIRE_VERIFY !== "0";
    const verify = spawnSync(
      "npx",
      ["hardhat", "run", "scripts/verify-deployment.js", "--network", network.name],
      {
        cwd: path.join(__dirname, ".."),
        stdio: "inherit",
        env: { ...process.env, DEPLOYMENT_FILE: latest },
      }
    );
    if (verify.status !== 0) {
      const msg =
        `Explorer verification failed. Set ETHERSCAN_API_KEY and re-run:\n` +
        `  DEPLOYMENT_FILE=${latest} npx hardhat run scripts/verify-deployment.js --network ${network.name}`;
      if (requireVerify) throw new Error(msg);
      console.warn(msg);
    }
  }

  if (warnings.length) {
    console.log("\nWARNINGS");
    warnings.forEach((w) => console.log("  -", w));
  }

  console.log("\nPost-deploy checklist:");
  console.log("  1. Confirm explorer verification (Read/Write as Proxy works).");
  console.log("  2. Fund TreasuryPool with on-ramp liquidity (treasuryPool.fund).");
  console.log("  3. Point the backend at the OrderManager proxy address.");
  console.log("  4. Move DEFAULT_ADMIN_ROLE and UPGRADER_ROLE to the governance multisig.");
  console.log("  5. Renounce any roles the deployer still holds.");
  console.log("  6. npx hardhat run scripts/post-deploy-check.js --network " + network.name);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
