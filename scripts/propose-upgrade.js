/**
 * Propose an in-place UUPS OrderManager upgrade (implementation + Safe batch).
 *
 * Does NOT execute the upgrade. CI / operators import the Safe Tx Builder JSON
 * and execute with UPGRADER_ROLE (Safe). Proxy address stays unchanged.
 *
 *   npx hardhat run scripts/propose-upgrade.js --network base-sepolia
 *
 * Outputs:
 *   - deployments/<chainId>.<network>.upgrade-propose.*.json
 *   - safe-batches/upgrade-om-<network>.json
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
  const providerNet = await ethers.provider.getNetwork();
  const config = resolveAndAssertChain({
    networkName: network.name,
    providerChainId: providerNet.chainId,
    allowLocal: false,
    allowPlanned: false,
  });

  const proxy = resolveProxyAddress(config);
  const chainId = config.chainId;

  console.log("network     :", network.name, "chainId", chainId);
  console.log("proposer    :", signer.address);
  console.log("proxy       :", proxy);

  const current = await ethers.getContractAt("ElementFlowOrderManager", proxy);
  let currentVersion = "?";
  try {
    currentVersion = await current.getVersion();
  } catch {
    /* v1 or unreachable */
  }
  console.log("getVersion  :", currentVersion);

  const Factory = await ethers.getContractFactory("ElementFlowOrderManager");
  console.log("validateUpgrade...");
  await upgrades.validateUpgrade(proxy, Factory, { kind: "uups" });

  console.log("prepareUpgrade (deploy impl if needed)...");
  const implAddress = await upgrades.prepareUpgrade(proxy, Factory, {
    kind: "uups",
  });
  console.log("implementation:", implAddress);

  // UUPS: upgradeToAndCall on the proxy (called by UPGRADER / Safe).
  const upgradeToData = current.interface.encodeFunctionData("upgradeToAndCall", [
    implAddress,
    "0x",
  ]);

  const safeBatch = {
    version: "1.0",
    chainId: String(chainId),
    createdAt: Date.now(),
    meta: {
      name: `ElementFlow OM upgrade — ${config.name || network.name}`,
      description:
        `UUPS upgradeToAndCall to ${implAddress}. Proxy stays ${proxy}. ` +
        `CI propose only — Safe with UPGRADER_ROLE must execute. Merge ≠ upgrade.`,
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
    note: "Import safe-batches/upgrade-om-*.json into Safe; execute with UPGRADER. Proxy address unchanged.",
  };
  const recordPath = path.join(
    outDir,
    `${chainId}.${network.name}.upgrade-propose.${Date.now()}.json`,
  );
  fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));
  fs.writeFileSync(
    path.join(outDir, `${chainId}.${network.name}.upgrade-propose.latest.json`),
    JSON.stringify(record, null, 2),
  );

  const safeDir = path.join(__dirname, "..", "safe-batches");
  fs.mkdirSync(safeDir, { recursive: true });
  const safePath = path.join(safeDir, `upgrade-om-${network.name}.json`);
  fs.writeFileSync(safePath, JSON.stringify(safeBatch, null, 2));

  console.log("wrote", recordPath);
  console.log("wrote", safePath);
  console.log("NEXT: Safe owners review + execute. Then post-deploy-check + smoke.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
