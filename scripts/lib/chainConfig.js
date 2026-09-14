/**
 * Strongly typed ElementFlow chain configuration loader.
 *
 * Config files live in config/chains/<chainId>.<slug>.json and are keyed by chainId —
 * never by bare address alone (same CREATE address can appear on Base and Base Sepolia).
 */
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const CHAINS_DIR = path.join(__dirname, "..", "..", "config", "chains");

function listChainFiles() {
  return fs
    .readdirSync(CHAINS_DIR)
    .filter((f) => /^\d+\..+\.json$/.test(f) && f !== "schema.json")
    .map((f) => path.join(CHAINS_DIR, f));
}

function loadAllChains() {
  const byId = new Map();
  for (const file of listChainFiles()) {
    const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof cfg.chainId !== "number") {
      throw new Error(`Invalid chain config (missing chainId): ${file}`);
    }
    if (byId.has(cfg.chainId)) {
      throw new Error(`Duplicate chainId ${cfg.chainId} in ${file}`);
    }
    cfg.__file = file;
    byId.set(cfg.chainId, cfg);
  }
  return byId;
}

function getChainById(chainId) {
  const id = Number(chainId);
  const cfg = loadAllChains().get(id);
  if (!cfg) {
    throw new Error(
      `No config/chains entry for chainId=${id}. Add a file before deploying.`
    );
  }
  return cfg;
}

function getChainByHardhatNetwork(networkName) {
  for (const cfg of loadAllChains().values()) {
    if (cfg.hardhatNetwork === networkName) return cfg;
  }
  throw new Error(
    `No chain config with hardhatNetwork="${networkName}". Local hardhat/localhost are exempt — pass allowLocal.`
  );
}

/**
 * Resolve config for the current Hardhat run and assert provider chainId matches.
 * @param {object} opts
 * @param {string} opts.networkName hardhat network.name
 * @param {bigint|number|string} opts.providerChainId from ethers.provider.getNetwork()
 * @param {boolean} [opts.allowLocal] permit hardhat/localhost without a config file
 * @param {boolean} [opts.allowPlanned] permit status=planned (default false for deploy/upgrade)
 */
function resolveAndAssertChain({
  networkName,
  providerChainId,
  allowLocal = false,
  allowPlanned = false,
}) {
  const local = networkName === "hardhat" || networkName === "localhost";
  if (local && allowLocal) {
    return {
      chainId: Number(providerChainId),
      name: networkName,
      hardhatNetwork: networkName,
      status: "testnet",
      tokens: [],
      contracts: {
        orderManagerProxy: null,
        orderManagerImpl: null,
        providerRegistryProxy: null,
        treasuryPoolProxy: null,
      },
      roles: {},
      deployment: { confirmations: 0, requireDistinctRoles: false, feeBpsDefault: 0, orderTtlDefault: 3600 },
      __local: true,
    };
  }

  const cfg = getChainByHardhatNetwork(networkName);
  const actual = Number(providerChainId);
  if (actual !== cfg.chainId) {
    throw new Error(
      `Chain ID mismatch: hardhat network "${networkName}" expects chainId ${cfg.chainId} ` +
        `but provider reported ${actual}. Refusing to continue (wrong RPC / wrong network).`
    );
  }
  if (cfg.status === "planned" && !allowPlanned) {
    throw new Error(
      `Chain ${cfg.name} (${cfg.chainId}) is status=planned. Complete docs/ADD_CHAIN_CHECKLIST.md ` +
        `and flip status before deploy/upgrade.`
    );
  }
  return cfg;
}

function envRolePrefix(networkName) {
  return networkName.toUpperCase().replace(/-/g, "_");
}

/**
 * Resolve an address from env, optionally falling back.
 * On live chains with requireDistinctRoles, missing env is a hard error (no deployer fallback).
 */
function resolveRoleAddress({
  envKey,
  fallback,
  config,
  warnings,
  label,
}) {
  const raw = process.env[envKey];
  if (raw) return ethers.getAddress(raw);

  const requireDistinct = Boolean(config.deployment?.requireDistinctRoles) || config.status === "live";
  if (requireDistinct) {
    throw new Error(
      `${envKey} is required for ${config.name} (${label}). ` +
        `Live/mainnet deployments must not fall back to the deployer.`
    );
  }
  warnings.push(`${envKey} not set — defaulting to ${fallback} (${label}).`);
  return ethers.getAddress(fallback);
}

/**
 * Token allowlist: prefer config.tokens; if ALLOWED_TOKENS env is set, it must be a
 * subset of config (when config has tokens) or is used as-is for local/empty config.
 */
function resolveAllowlist(config) {
  const fromConfig = (config.tokens || []).map((t) => ethers.getAddress(t.address));
  const envRaw = process.env.ALLOWED_TOKENS ?? "";
  const fromEnv = envRaw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => ethers.getAddress(t));

  if (!fromEnv.length) return fromConfig;

  if (fromConfig.length) {
    const allowed = new Set(fromConfig.map((a) => a.toLowerCase()));
    const bad = fromEnv.filter((a) => !allowed.has(a.toLowerCase()));
    if (bad.length) {
      throw new Error(
        `ALLOWED_TOKENS contains addresses not in config/chains for chainId=${config.chainId}: ${bad.join(", ")}`
      );
    }
    return fromEnv;
  }
  return fromEnv;
}

/**
 * Upgrade/scan proxy: must match config.contracts.orderManagerProxy unless override.
 */
function resolveProxyAddress(config) {
  const envProxy = process.env.PROXY_ADDRESS;
  const configured = config.contracts?.orderManagerProxy;
  const allowOverride = process.env.ALLOW_PROXY_OVERRIDE === "1";

  if (!envProxy) {
    if (configured) return ethers.getAddress(configured);
    throw new Error(
      `PROXY_ADDRESS is required (or set contracts.orderManagerProxy in ${config.__file || "chain config"}).`
    );
  }

  const proxy = ethers.getAddress(envProxy);
  if (configured && !allowOverride && proxy.toLowerCase() !== configured.toLowerCase()) {
    throw new Error(
      `PROXY_ADDRESS ${proxy} does not match config orderManagerProxy ${configured} ` +
        `for chainId=${config.chainId}. Set ALLOW_PROXY_OVERRIDE=1 only for deliberate exceptions.`
    );
  }
  return proxy;
}

function assertDistinctRoles(roles, config) {
  if (!(config.deployment?.requireDistinctRoles || config.status === "live")) return;
  const entries = Object.entries(roles).filter(([, v]) => v);
  const seen = new Map();
  for (const [name, addr] of entries) {
    const key = addr.toLowerCase();
    if (seen.has(key)) {
      throw new Error(
        `Role addresses must be distinct on ${config.name}: ${seen.get(key)} and ${name} both ${addr}`
      );
    }
    seen.set(key, name);
  }
}

module.exports = {
  CHAINS_DIR,
  loadAllChains,
  getChainById,
  getChainByHardhatNetwork,
  resolveAndAssertChain,
  envRolePrefix,
  resolveRoleAddress,
  resolveAllowlist,
  resolveProxyAddress,
  assertDistinctRoles,
};
