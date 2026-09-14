/**
 * Post-deploy / post-upgrade checks for a single Hardhat network (one chain only).
 *
 *   npx hardhat run scripts/post-deploy-check.js --network base-sepolia
 *
 * Reads addresses from config/chains and optional deployments/<chainId>.*.latest.json.
 */
const { ethers, network, upgrades } = require("hardhat");
const fs = require("fs");
const path = require("path");
const { resolveAndAssertChain, getChainById } = require("./lib/chainConfig");

const ERC1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

function loadLatestDeployment(chainId, networkName) {
  const dir = path.join(__dirname, "..", "deployments");
  const candidates = [
    path.join(dir, `${chainId}.${networkName}.latest.json`),
    path.join(dir, `${chainId}.${networkName}.upgrade.latest.json`),
  ];
  for (const f of candidates) {
    if (fs.existsSync(f)) return { file: f, data: JSON.parse(fs.readFileSync(f, "utf8")) };
  }
  return null;
}

async function implementationOf(address) {
  const raw = await ethers.provider.getStorage(address, ERC1967_IMPL);
  return ethers.getAddress("0x" + raw.slice(26));
}

async function main() {
  const providerNet = await ethers.provider.getNetwork();
  const config = resolveAndAssertChain({
    networkName: network.name,
    providerChainId: providerNet.chainId,
    allowLocal: true,
    allowPlanned: false,
  });

  const latest = loadLatestDeployment(config.chainId || Number(providerNet.chainId), network.name);
  // Prefer the deployment artifact from this run over a stale PROXY_ADDRESS in .env
  // (lab .env.example pins an older OM). Set FORCE_PROXY_ADDRESS=1 to force env.
  const forceEnvProxy = process.env.FORCE_PROXY_ADDRESS === "1";
  const omProxy = forceEnvProxy
    ? process.env.PROXY_ADDRESS ||
      latest?.data?.contracts?.orderManager?.proxy ||
      latest?.data?.proxy ||
      config.contracts?.orderManagerProxy
    : latest?.data?.contracts?.orderManager?.proxy ||
      latest?.data?.proxy ||
      process.env.PROXY_ADDRESS ||
      config.contracts?.orderManagerProxy;
  const registryProxy =
    latest?.data?.contracts?.providerRegistry?.proxy || config.contracts?.providerRegistryProxy;
  const poolProxy =
    latest?.data?.contracts?.treasuryPool?.proxy || config.contracts?.treasuryPoolProxy;

  if (
    !forceEnvProxy &&
    process.env.PROXY_ADDRESS &&
    latest?.data?.contracts?.orderManager?.proxy &&
    ethers.getAddress(process.env.PROXY_ADDRESS) !==
      ethers.getAddress(latest.data.contracts.orderManager.proxy)
  ) {
    console.warn(
      `  NOTE: PROXY_ADDRESS=${process.env.PROXY_ADDRESS} differs from latest deploy ` +
        `${latest.data.contracts.orderManager.proxy} — checking the latest deploy. ` +
        `Set FORCE_PROXY_ADDRESS=1 to force env.`
    );
  }
  if (!omProxy) throw new Error("No OrderManager proxy to check");

  const code = await ethers.provider.getCode(omProxy);
  if (code === "0x") {
    throw new Error(
      `No contract code at ${omProxy} on ${network.name}. ` +
        `Hardhat in-memory chains reset between processes — run deploy then check in the same process, ` +
        `or pass PROXY_ADDRESS for a live network.`
    );
  }

  console.log(`\nPost-deploy check — ${config.name || network.name} chainId=${Number(providerNet.chainId)}`);
  if (latest) console.log("  deployment file:", latest.file);

  const manager = await ethers.getContractAt("ElementFlowOrderManager", omProxy);
  const impl = await implementationOf(omProxy);
  console.log("  orderManager proxy:", omProxy);
  console.log("  orderManager impl :", impl);

  let version = "?";
  try {
    version = await manager.getVersion();
  } catch {
    /* v1 */
  }
  console.log("  version           :", version);
  console.log("  paused            :", await manager.paused());

  const failures = [];

  if (config.contracts?.orderManagerImpl && version.startsWith("2")) {
    // After v2 upgrade, impl should match latest deployment if present
  }
  if (latest?.data?.contracts?.orderManager?.implementation) {
    const expected = ethers.getAddress(latest.data.contracts.orderManager.implementation);
    if (impl.toLowerCase() !== expected.toLowerCase()) {
      failures.push(`impl mismatch: on-chain ${impl} vs record ${expected}`);
    }
  }

  // Token allowlist sync (manager vs pool) when both exist
  if (registryProxy && poolProxy) {
    const pool = await ethers.getContractAt("TreasuryPool", poolProxy);
    console.log("  registry          :", registryProxy);
    console.log("  treasuryPool      :", poolProxy);
    for (const t of config.tokens || []) {
      const allowed = await manager.isTokenAllowed(t.address);
      const supported = await pool.isTokenSupported(t.address);
      console.log(`  token ${t.symbol} managerAllowed=${allowed} poolSupported=${supported}`);
      if (allowed !== supported) {
        failures.push(`allowlist diverge for ${t.symbol}: manager=${allowed} pool=${supported}`);
      }
    }
    const defaultId = await manager.defaultProviderId();
    console.log("  defaultProviderId :", defaultId);
  } else {
    console.log("  registry/pool     : not configured (v1-only or pending wire-up)");
  }

  if (failures.length) {
    console.error("\nFAILURES");
    failures.forEach((f) => console.error("  -", f));
    process.exitCode = 1;
    return;
  }
  console.log("\nPost-deploy check OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
