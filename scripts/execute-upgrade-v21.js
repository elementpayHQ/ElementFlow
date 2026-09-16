/**
 * In-place UUPS upgrade of OrderManager to current source (v2.1.0).
 *
 * Proxy address unchanged. If the signer holds UPGRADER_ROLE, executes
 * upgradeToAndCall. Otherwise deploys the implementation and writes a Safe
 * Tx Builder batch (same as propose-upgrade.js).
 *
 *   PROXY_ADDRESS=0x4CDa... npx hardhat run scripts/execute-upgrade-v21.js --network base
 */
const fs = require("fs");
const path = require("path");
const { ethers, upgrades, network } = require("hardhat");
const {
  resolveAndAssertChain,
  resolveProxyAddress,
} = require("./lib/chainConfig");

async function main() {
  const [signer] = await ethers.getSigners();
  if (!signer) {
    throw new Error("No signer — set PRIVATE_KEY for this network");
  }

  const providerNet = await ethers.provider.getNetwork();
  const config = resolveAndAssertChain({
    networkName: network.name,
    providerChainId: providerNet.chainId,
    allowLocal: false,
    // Allow pointing at live CREATE2 proxies even if chain JSON status lags.
    allowPlanned: true,
  });

  const proxy = (
    process.env.PROXY_ADDRESS ||
    resolveProxyAddress(config)
  ).trim();
  if (!ethers.isAddress(proxy)) {
    throw new Error(`Invalid proxy: ${proxy}`);
  }

  console.log("network     :", network.name, "chainId", Number(providerNet.chainId));
  console.log("signer      :", signer.address);
  console.log("proxy       :", proxy);

  const Factory = await ethers.getContractFactory("ElementFlowOrderManager");
  const current = await ethers.getContractAt("ElementFlowOrderManager", proxy);

  let currentVersion = "?";
  try {
    currentVersion = await current.getVersion();
  } catch {
    /* older ABI */
  }
  console.log("getVersion  :", currentVersion);

  if (currentVersion === "2.1.0") {
    console.log("Already on 2.1.0 — nothing to do.");
    return;
  }

  // Proxy may not be in local .openzeppelin manifest (deployed elsewhere).
  try {
    await upgrades.forceImport(proxy, Factory, { kind: "uups" });
    console.log("forceImport : ok");
  } catch (e) {
    console.log("forceImport :", e.message.split("\n")[0]);
  }

  console.log("validateUpgrade...");
  await upgrades.validateUpgrade(proxy, Factory, { kind: "uups" });

  const upgraderRole = await current.UPGRADER_ROLE();
  const canUpgrade = await current.hasRole(upgraderRole, signer.address);
  console.log("signer UPGRADER_ROLE:", canUpgrade);

  if (canUpgrade) {
    console.log("Executing upgradeProxy (redeployImplementation=always)...");
    const upgraded = await upgrades.upgradeProxy(proxy, Factory, {
      kind: "uups",
      redeployImplementation: "always",
    });
    await upgraded.waitForDeployment();
    const version = await upgraded.getVersion();
    const impl = await upgrades.erc1967.getImplementationAddress(proxy);
    console.log("upgraded    : version=", version, "impl=", impl);
    if (version !== "2.1.0") {
      throw new Error(`Expected getVersion 2.1.0, got ${version}`);
    }

    const outDir = path.join(__dirname, "..", "deployments");
    fs.mkdirSync(outDir, { recursive: true });
    const record = {
      network: network.name,
      chainId: Number(providerNet.chainId),
      upgradedAt: new Date().toISOString(),
      proxy,
      implementation: impl,
      previousVersion: currentVersion,
      version,
      executor: signer.address,
    };
    const latest = path.join(
      outDir,
      `${Number(providerNet.chainId)}.${network.name}.upgrade.latest.json`,
    );
    fs.writeFileSync(latest, JSON.stringify(record, null, 2));
    console.log("wrote", latest);
    return;
  }

  console.log("Signer cannot upgrade — proposing Safe batch only...");
  // forceImport can make OZ reuse the live v2.0 impl; always redeploy v2.1 bytecode.
  const implAddress = await upgrades.prepareUpgrade(proxy, Factory, {
    kind: "uups",
    redeployImplementation: "always",
  });
  console.log("implementation:", implAddress);

  const upgradeToData = current.interface.encodeFunctionData("upgradeToAndCall", [
    implAddress,
    "0x",
  ]);

  const chainId = Number(providerNet.chainId);
  const safeBatch = {
    version: "1.0",
    chainId: String(chainId),
    createdAt: Date.now(),
    meta: {
      name: `ElementFlow OM upgrade to 2.1.0 — ${network.name}`,
      description:
        `UUPS upgradeToAndCall to ${implAddress}. Proxy stays ${proxy}. ` +
        `Execute with UPGRADER_ROLE (Safe).`,
      txBuilderVersion: "1.18.0",
      createdFromSafeAddress: config.roles?.multisig || config.roles?.admin || "",
      createdFromOwnerAddress: "",
    },
    transactions: [
      {
        to: proxy,
        value: "0",
        data: upgradeToData,
        contractMethod: {
          inputs: [
            { internalType: "address", name: "newImplementation", type: "address" },
            { internalType: "bytes", name: "data", type: "bytes" },
          ],
          name: "upgradeToAndCall",
          payable: false,
        },
        contractInputsValues: {
          newImplementation: implAddress,
          data: "0x",
        },
      },
    ],
  };

  const outDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  const record = {
    network: network.name,
    chainId,
    proposedAt: new Date().toISOString(),
    proposer: signer.address,
    proxy,
    implementation: implAddress,
    previousVersion: currentVersion,
    note: "Import safe-batches JSON into Safe; execute with UPGRADER.",
  };
  fs.writeFileSync(
    path.join(outDir, `${chainId}.${network.name}.upgrade-propose.latest.json`),
    JSON.stringify(record, null, 2),
  );

  const safeDir = path.join(__dirname, "..", "safe-batches");
  fs.mkdirSync(safeDir, { recursive: true });
  const safePath = path.join(safeDir, `upgrade-om-v21-${network.name}.json`);
  fs.writeFileSync(safePath, JSON.stringify(safeBatch, null, 2));
  console.log("wrote", safePath);
  console.log("NEXT: Safe owners execute upgradeToAndCall. Proxy address unchanged.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
