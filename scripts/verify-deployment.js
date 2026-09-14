/**
 * Verify ElementFlow UUPS implementations + link proxies on the explorer.
 *
 * Etherscan API v2 requires:
 *   - hardhat.config.js etherscan.apiKey as a **single string** (not a per-network map)
 *   - chainid query param (hardhat-verify adds it when apiKey is a string)
 *
 * OpenZeppelin's proxy-verify path still calls getLogs without chainid on some versions,
 * so this script verifies **implementations** via hardhat-verify, then links proxies
 * with the official `verifyproxycontract` action (chainid included).
 *
 *   DEPLOYMENT_FILE=deployments/84532.base-sepolia.latest.json \
 *     npx hardhat run scripts/verify-deployment.js --network base-sepolia
 */
const { run, network, upgrades, ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");
const { resolveAndAssertChain } = require("./lib/chainConfig");

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

function isAlreadyVerifiedMessage(msg) {
  return /already verified/i.test(msg) || /already been verified/i.test(msg);
}

async function verifyImplementation(address, label) {
  console.log(`\nVerifying ${label} impl: ${address}`);
  try {
    await run("verify:verify", {
      address,
      constructorArguments: [],
    });
    console.log(`  OK ${label} implementation`);
    return true;
  } catch (error) {
    const msg = error.message || String(error);
    if (isAlreadyVerifiedMessage(msg)) {
      console.log(`  already verified ${label} implementation`);
      return true;
    }
    // Sourcify sometimes returns HTML after Etherscan already succeeded.
    if (/Unexpected token '<'|DOCTYPE/i.test(msg)) {
      console.log(`  OK ${label} implementation (explorer verified; ignoring Sourcify HTML error)`);
      return true;
    }
    console.error(`  FAILED ${label} implementation: ${msg}`);
    return false;
  }
}

/**
 * Link EIP-1967 proxy → implementation on Etherscan/Basescan (API v2).
 */
async function linkProxy(proxy, apiKey, chainId, label) {
  console.log(`\nLinking ${label} proxy: ${proxy}`);
  const url = new URL("https://api.etherscan.io/v2/api");
  url.searchParams.set("chainid", String(chainId));

  const body = new URLSearchParams({
    module: "contract",
    action: "verifyproxycontract",
    address: proxy,
    apikey: apiKey,
  });

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await res.json();
  if (json.status !== "1" && !/already|verified/i.test(String(json.result || json.message))) {
    // Some explorers return GUID in result even when message is NOTOK with pending
    if (!json.result || typeof json.result !== "string") {
      console.error(`  FAILED ${label} proxy link: ${json.message} ${json.result}`);
      return false;
    }
  }

  const guid = json.result;
  console.log(`  submitted proxy link guid=${guid}`);

  // Poll checkproxyverification
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const checkUrl = new URL("https://api.etherscan.io/v2/api");
    checkUrl.searchParams.set("chainid", String(chainId));
    checkUrl.searchParams.set("module", "contract");
    checkUrl.searchParams.set("action", "checkproxyverification");
    checkUrl.searchParams.set("guid", guid);
    checkUrl.searchParams.set("apikey", apiKey);
    const check = await (await fetch(checkUrl)).json();
    const result = String(check.result || "");
    if (check.status === "1" || /successfully|verified|All good/i.test(result)) {
      console.log(`  OK ${label} proxy linked — ${result}`);
      return true;
    }
    if (/fail|error|invalid/i.test(result) && !/Pending/i.test(result)) {
      console.error(`  FAILED ${label} proxy link: ${result}`);
      return false;
    }
    console.log(`  waiting… ${result || check.message}`);
  }
  console.warn(`  WARN ${label} proxy link still pending — check explorer manually`);
  return true; // impl is verified; proxy link often finishes async
}

async function main() {
  if (network.name === "hardhat" || network.name === "localhost") {
    throw new Error("Refuse verify on local in-memory network");
  }

  const providerNet = await ethers.provider.getNetwork();
  const config = resolveAndAssertChain({
    networkName: network.name,
    providerChainId: providerNet.chainId,
    allowLocal: false,
    allowPlanned: true,
  });

  const apiKey = process.env.ETHERSCAN_API_KEY || process.env.BASESCAN_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ETHERSCAN_API_KEY missing. Add it to .env (single Etherscan API v2 key) and re-run.\n" +
        "https://etherscan.io/apidashboard"
    );
  }

  let dep;
  if (process.env.DEPLOYMENT_FILE) {
    dep = JSON.parse(fs.readFileSync(process.env.DEPLOYMENT_FILE, "utf8"));
  } else {
    const latest = loadLatestDeployment(config.chainId, network.name);
    if (!latest?.data) {
      throw new Error(
        `No DEPLOYMENT_FILE and no deployments/${config.chainId}.${network.name}.latest.json`
      );
    }
    dep = latest.data;
  }

  if (Number(dep.chainId) !== Number(config.chainId)) {
    throw new Error(
      `Deployment chainId ${dep.chainId} != network chainId ${config.chainId}`
    );
  }

  console.log(`Verify on ${network.name} chainId=${config.chainId}`);
  console.log(`Artifact deployedAt=${dep.deployedAt}`);

  const results = [];
  const contracts = dep.contracts || {};

  for (const [name, entry] of Object.entries(contracts)) {
    if (!entry?.proxy) continue;

    let impl = entry.implementation;
    if (!impl) {
      impl = await upgrades.erc1967.getImplementationAddress(entry.proxy);
    }

    const okImpl = await verifyImplementation(impl, name);
    results.push({ name: `${name}.implementation`, address: impl, ok: okImpl });

    // Only link proxy after impl is on the explorer (enables Read/Write as Proxy).
    if (okImpl) {
      const okProxy = await linkProxy(entry.proxy, apiKey, config.chainId, name);
      results.push({ name: `${name}.proxy`, address: entry.proxy, ok: okProxy });
    } else {
      results.push({ name: `${name}.proxy`, address: entry.proxy, ok: false });
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log("\n--- verify summary ---");
  for (const r of results) {
    console.log(`  ${r.ok ? "OK" : "FAIL"}  ${r.name}  ${r.address}`);
  }

  if (failed.length) {
    throw new Error(
      `${failed.length} verification(s) failed. Re-run:\n` +
        `  DEPLOYMENT_FILE=deployments/${config.chainId}.${network.name}.latest.json \\\n` +
        `    npm run verify:deployment -- --network ${network.name}`
    );
  }

  console.log("\nAll contracts verified / proxies linked.");
  console.log("Confirm Read/Write as Proxy on Basescan.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
