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
const { ethers, upgrades, network, run } = require("hardhat");
const fs = require("fs");
const path = require("path");

const TREASURY_PROVIDER_ID = ethers.keccak256(ethers.toUtf8Bytes("ELEMENTFLOW_TREASURY"));

/** Reads an address from env, falling back to the deployer with a loud warning. */
function envAddress(key, fallback, warnings) {
  const value = process.env[key];
  if (!value) {
    warnings.push(`${key} not set — defaulting to the deployer (${fallback}).`);
    return fallback;
  }
  return ethers.getAddress(value);
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const warnings = [];

  const prefix = network.name.toUpperCase().replace(/-/g, "_");
  const admin = envAddress(`${prefix}_ADMIN_ADDRESS`, deployer.address, warnings);
  const aggregator = envAddress(`${prefix}_AGGREGATOR_ADDRESS`, deployer.address, warnings);
  const treasury = envAddress(`${prefix}_TREASURY_ADDRESS`, deployer.address, warnings);
  const feeRecipient = envAddress(`${prefix}_FEE_RECIPIENT_ADDRESS`, treasury, warnings);

  const feeBps = Number(process.env.FEE_BPS ?? 0); // denominator is MAX_BPS = 100_000
  const orderTtl = Number(process.env.ORDER_TTL ?? 3600);
  const allowlist = (process.env.ALLOWED_TOKENS ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => ethers.getAddress(t));

  console.log(`\nDeploying ElementFlow v2 to ${network.name}`);
  console.log("  deployer     :", deployer.address);
  console.log("  admin        :", admin);
  console.log("  aggregator   :", aggregator);
  console.log("  treasury     :", treasury);
  console.log("  feeRecipient :", feeRecipient);
  console.log(`  feeBps       : ${feeBps} / 100000`);
  console.log(`  orderTtl     : ${orderTtl}s`);
  console.log("  allowlist    :", allowlist.length ? allowlist.join(", ") : "(none — set ALLOWED_TOKENS)");

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

  // Wiring only runs automatically when the deployer still holds admin. When admin is a
  // multisig, these become the proposal payload printed below instead.
  const deployerIsAdmin = admin.toLowerCase() === deployer.address.toLowerCase();

  if (deployerIsAdmin) {
    console.log("\nWiring...");
    await (await manager.setProviderRegistry(await registry.getAddress())).wait();
    await (await registry.registerProvider(TREASURY_PROVIDER_ID, await pool.getAddress())).wait();
    for (const token of allowlist) {
      await (await manager.setTokenAllowed(token, true)).wait();
      await (await pool.setTokenSupported(token, true)).wait();
      console.log("  allowlisted", token);
    }
    console.log("  done");
  } else {
    console.log("\nAdmin is not the deployer — execute these from the admin account:");
    console.log(`  orderManager.setProviderRegistry(${await registry.getAddress()})`);
    console.log(`  registry.registerProvider(${TREASURY_PROVIDER_ID}, ${await pool.getAddress()})`);
    for (const token of allowlist) {
      console.log(`  orderManager.setTokenAllowed(${token}, true)`);
      console.log(`  treasuryPool.setTokenSupported(${token}, true)`);
    }
  }

  const info = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
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
  const file = path.join(dir, `${network.name}-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(info, null, 2));
  console.log("\nDeployment record:", file);

  for (const [, contract] of Object.entries(info.contracts)) {
    try {
      await run("verify:verify", { address: contract.implementation, constructorArguments: [] });
    } catch (error) {
      console.log(`  verification skipped for ${contract.implementation}: ${error.message}`);
    }
  }

  if (warnings.length) {
    console.log("\nWARNINGS");
    warnings.forEach((w) => console.log("  -", w));
    console.log(
      "  Production deployments must set every role to a distinct address, with admin on a multisig."
    );
  }

  console.log("\nPost-deploy checklist:");
  console.log("  1. Fund TreasuryPool with on-ramp liquidity (treasuryPool.fund).");
  console.log("  2. Point the backend at the OrderManager proxy address.");
  console.log("  3. Move DEFAULT_ADMIN_ROLE and UPGRADER_ROLE to the governance multisig.");
  console.log("  4. Renounce any roles the deployer still holds.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
