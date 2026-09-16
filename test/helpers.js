const { ethers, upgrades } = require("hardhat");

/** Order type enum, mirroring OrderTypes.OrderType. */
const OrderType = { OnRamp: 0, OffRamp: 1 };

/** v2 lifecycle enum, mirroring OrderTypes.OrderStatus. */
const OrderStatus = { None: 0, Pending: 1, Settled: 2, Refunded: 3 };

/** v1 lifecycle encoding, which `getOrder()` still returns for backend compatibility. */
const LegacyStatus = { Pending: 0, Settled: 1, Refunded: 2 };

const MAX_BPS = 100_000n;
const ONE_HOUR = 3600;

const role = (name) => ethers.keccak256(ethers.toUtf8Bytes(name));

const ROLES = {
  DEFAULT_ADMIN: ethers.ZeroHash,
  UPGRADER: role("UPGRADER_ROLE"),
  PAUSER: role("PAUSER_ROLE"),
  AGGREGATOR: role("AGGREGATOR_ROLE"),
  ORDER_CREATOR: role("ORDER_CREATOR_ROLE"),
  TREASURER: role("TREASURER_ROLE"),
  ORDER_MANAGER: role("ORDER_MANAGER_ROLE"),
  PROVIDER_ADMIN: role("PROVIDER_ADMIN_ROLE"),
  PROVIDER_GUARDIAN: role("PROVIDER_GUARDIAN_ROLE"),
};

const TREASURY_PROVIDER_ID = role("ELEMENTFLOW_TREASURY");
const PARTNER_PROVIDER_ID = role("YELLOWCARD_STYLE_PARTNER");

/** The `intentKey` that the v1-compatible `createOrder` derives internally. */
const intentKeyFor = (messageHash) => ethers.keccak256(ethers.toUtf8Bytes(messageHash));

/** USDC-style 6-decimal amount. */
const usdc = (n) => ethers.parseUnits(String(n), 6);

/**
 * Deploys the full v2 stack: order manager, provider registry, treasury pool and a
 * partner adapter, wired together the way production is expected to be configured.
 *
 * Fees default to zero so lifecycle assertions stay arithmetic-free; the fee suite
 * opts in explicitly via `setFeeBps`.
 */
async function deployStack(options = {}) {
  const { feeBps = 0, orderTtl = ONE_HOUR } = options;

  const [deployer, admin, aggregator, treasury, feeRecipient, user, otherUser, outsider] =
    await ethers.getSigners();

  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const token = await MockERC20.deploy("USD Coin", "USDC", 6);

  const Manager = await ethers.getContractFactory("ElementFlowOrderManager");
  const manager = await upgrades.deployProxy(
    Manager,
    [admin.address, aggregator.address, treasury.address, feeRecipient.address, feeBps, orderTtl],
    { kind: "uups" }
  );

  const Registry = await ethers.getContractFactory("ProviderRegistry");
  const registry = await upgrades.deployProxy(Registry, [admin.address], { kind: "uups" });

  const Pool = await ethers.getContractFactory("TreasuryPool");
  const pool = await upgrades.deployProxy(
    Pool,
    [admin.address, await manager.getAddress(), TREASURY_PROVIDER_ID],
    { kind: "uups" }
  );

  const Partner = await ethers.getContractFactory("MockOnRampProvider");
  const partner = await Partner.deploy(PARTNER_PROVIDER_ID);

  // Wiring.
  await manager.connect(admin).setProviderRegistry(await registry.getAddress());
  await manager.connect(admin).setTokenAllowed(await token.getAddress(), true);
  await registry.connect(admin).registerProvider(TREASURY_PROVIDER_ID, await pool.getAddress());
  await registry.connect(admin).registerProvider(PARTNER_PROVIDER_ID, await partner.getAddress());
  await pool.connect(admin).setTokenSupported(await token.getAddress(), true);
  await partner.setSupportedToken(await token.getAddress(), true);

  // Seed balances.
  await token.mint(user.address, usdc(10_000));
  await token.mint(otherUser.address, usdc(10_000));
  await token.mint(await pool.getAddress(), usdc(50_000));
  await token.mint(await partner.getAddress(), usdc(50_000));

  return {
    deployer,
    admin,
    aggregator,
    treasury,
    feeRecipient,
    user,
    otherUser,
    outsider,
    token,
    manager,
    registry,
    pool,
    partner,
  };
}

/**
 * Creates an order and returns its id.
 *
 * `createOrder` returns the id to on-chain callers but an EOA transaction only yields a
 * receipt, so we derive the same id through the contract's own `computeOrderId` view.
 */
async function createOrder(ctx, overrides = {}) {
  const {
    signer = ctx.aggregator,
    requester = ctx.user,
    amount = usdc(1000),
    token = ctx.token,
    orderType = OrderType.OffRamp,
    messageHash = `order-${Math.random()}`,
    providerId = null,
    intentKey = null,
    refundAddress = null,
  } = overrides;

  const tokenAddress = await token.getAddress();
  const key = intentKey ?? intentKeyFor(messageHash);
  const payer = requester.address ?? requester;

  const orderId = await ctx.manager.computeOrderId(
    payer,
    amount,
    tokenAddress,
    orderType,
    key
  );

  let tx;
  if (refundAddress !== null) {
    const refund =
      typeof refundAddress === "string" ? refundAddress : refundAddress.address;
    if (providerId === null) {
      tx = await ctx.manager
        .connect(signer)
        .createOrderWithRefund(
          payer,
          refund,
          amount,
          tokenAddress,
          orderType,
          messageHash
        );
    } else {
      tx = await ctx.manager
        .connect(signer)
        .createOrderWithProviderAndRefund(
          payer,
          refund,
          amount,
          tokenAddress,
          orderType,
          messageHash,
          providerId,
          key
        );
    }
  } else if (providerId === null) {
    tx = await ctx.manager
      .connect(signer)
      .createOrder(payer, amount, tokenAddress, orderType, messageHash);
  } else {
    tx = await ctx.manager
      .connect(signer)
      .createOrderWithProvider(
        payer,
        amount,
        tokenAddress,
        orderType,
        messageHash,
        providerId,
        key
      );
  }

  return { orderId, tx, amount, messageHash, intentKey: key };
}

/** Approves the manager to pull `amount` of `token` from `owner`. */
async function approve(ctx, owner, amount, token = ctx.token) {
  await token.connect(owner).approve(await ctx.manager.getAddress(), amount);
}

module.exports = {
  OrderType,
  OrderStatus,
  LegacyStatus,
  ROLES,
  MAX_BPS,
  ONE_HOUR,
  TREASURY_PROVIDER_ID,
  PARTNER_PROVIDER_ID,
  deployStack,
  createOrder,
  approve,
  intentKeyFor,
  usdc,
  role,
};
