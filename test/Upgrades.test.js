const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const {
  OrderType,
  OrderStatus,
  LegacyStatus,
  ROLES,
  deployStack,
  createOrder,
  approve,
  usdc,
} = require("./helpers");

/**
 * The v1 implementation is live behind UUPS proxies on Base and Base Sepolia. These tests
 * reproduce that deployment from the original source, demonstrate the vulnerabilities it
 * carries, then upgrade the very same proxy to v2 and assert that state survives and the
 * vulnerabilities are closed.
 */
describe("Upgrade safety", function () {
  async function deployV1Fixture() {
    const [deployer, owner, aggregator, treasury, user, attacker, feeRecipient] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const token = await MockERC20.deploy("USD Coin", "USDC", 6);
    await token.mint(user.address, usdc(10_000));

    const V1 = await ethers.getContractFactory("OrderManagement");
    const v1 = await upgrades.deployProxy(V1, [aggregator.address, treasury.address, owner.address], {
      kind: "uups",
      initializer: "initialize",
    });

    return { deployer, owner, aggregator, treasury, user, attacker, feeRecipient, token, v1 };
  }

  /** Creates a v1 off-ramp order and pulls its id out of the emitted event. */
  async function createV1OffRampOrder(ctx, amount, messageHash = "legacy-order") {
    await ctx.token.connect(ctx.user).approve(await ctx.v1.getAddress(), amount);
    const tx = await ctx.v1
      .connect(ctx.aggregator)
      .createOrder(ctx.user.address, amount, await ctx.token.getAddress(), OrderType.OffRamp, messageHash);
    const receipt = await tx.wait();

    const log = receipt.logs
      .map((l) => {
        try {
          return ctx.v1.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((l) => l && l.name === "OrderCreated");

    return log.args.orderId;
  }

  describe("v1 vulnerabilities (regression baseline)", function () {
    it("v1 lets anyone permanently freeze another user's escrow", async function () {
      const ctx = await loadFixture(deployV1Fixture);
      const amount = usdc(1000);
      const orderId = await createV1OffRampOrder(ctx, amount);

      // escrowFunds has no access control and moves no funds; it only records a provider.
      await ctx.v1.connect(ctx.attacker).escrowFunds(orderId, 0);
      // releaseEscrow then lets that self-appointed provider mark the order Completed.
      await ctx.v1.connect(ctx.attacker).releaseEscrow(orderId);

      const order = await ctx.v1.getOrder(orderId);
      expect(order[5]).to.equal(1); // v1 OrderStatus.Completed

      // The order is now terminal, so neither settlement nor refund can ever run. The
      // user's 1000 USDC is stranded in the contract with no code path that releases it.
      await expect(ctx.v1.connect(ctx.aggregator).settleOrder(orderId)).to.be.revertedWith(
        "Order is not pending"
      );
      await expect(ctx.v1.connect(ctx.aggregator).refundOrder(orderId)).to.be.revertedWith(
        "Order is not pending"
      );
      expect(await ctx.token.balanceOf(await ctx.v1.getAddress())).to.equal(amount);
    });

    it("v1 lets anyone create orders that spend a third party's allowance", async function () {
      const ctx = await loadFixture(deployV1Fixture);
      await ctx.token.connect(ctx.user).approve(await ctx.v1.getAddress(), usdc(1000));

      // No role check at all: the attacker moves the victim's tokens into escrow.
      await expect(
        ctx.v1
          .connect(ctx.attacker)
          .createOrder(ctx.user.address, usdc(1000), await ctx.token.getAddress(), OrderType.OffRamp, "x")
      ).to.not.be.reverted;

      expect(await ctx.token.balanceOf(await ctx.v1.getAddress())).to.equal(usdc(1000));
    });

    it("v1 cannot refund an on-ramp order, stranding it as Pending forever", async function () {
      const ctx = await loadFixture(deployV1Fixture);
      await ctx.token.mint(await ctx.v1.getAddress(), usdc(5000));

      const tx = await ctx.v1
        .connect(ctx.aggregator)
        .createOrder(ctx.user.address, usdc(1000), await ctx.token.getAddress(), OrderType.OnRamp, "onramp");
      const receipt = await tx.wait();
      const orderId = receipt.logs
        .map((l) => {
          try {
            return ctx.v1.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((l) => l && l.name === "OrderCreated").args.orderId;

      await expect(ctx.v1.connect(ctx.aggregator).refundOrder(orderId)).to.be.revertedWith(
        "Only OffRamp orders can be refunded"
      );
    });

    it("v1 reverts against USDT-style tokens that return no boolean", async function () {
      const ctx = await loadFixture(deployV1Fixture);
      const NoReturn = await ethers.getContractFactory("MockNoReturnERC20");
      const usdt = await NoReturn.deploy();
      await usdt.mint(ctx.user.address, usdc(1000));
      await usdt.connect(ctx.user).approve(await ctx.v1.getAddress(), usdc(1000));

      // `require(IERC20(token).transferFrom(...))` cannot decode an empty return value.
      await expect(
        ctx.v1
          .connect(ctx.aggregator)
          .createOrder(ctx.user.address, usdc(1000), await usdt.getAddress(), OrderType.OffRamp, "m")
      ).to.be.reverted;
    });
  });

  describe("in-place v1 -> v2 upgrade", function () {
    async function upgradedFixture() {
      const ctx = await deployV1Fixture();
      const amount = usdc(1000);

      // A pending off-ramp order and its escrow exist at the moment of the upgrade.
      const legacyOrderId = await createV1OffRampOrder(ctx, amount, "pre-upgrade");

      const V2 = await ethers.getContractFactory("ElementFlowOrderManager", ctx.owner);
      const v2 = await upgrades.upgradeProxy(await ctx.v1.getAddress(), V2, {
        kind: "uups",
        call: {
          fn: "initializeV2",
          args: [
            ctx.owner.address,
            ctx.aggregator.address,
            ctx.feeRecipient.address,
            0,
            3600,
            [await ctx.token.getAddress()],
            [amount], // seed the escrow v1 never tracked
          ],
        },
      });

      return { ...ctx, v2, legacyOrderId, legacyAmount: amount };
    }

    it("keeps the same proxy address", async function () {
      const ctx = await loadFixture(upgradedFixture);
      expect(await ctx.v2.getAddress()).to.equal(await ctx.v1.getAddress());
      expect(await ctx.v2.getVersion()).to.equal("2.1.0");
    });

    it("preserves v1 storage: treasury and legacy orders", async function () {
      const ctx = await loadFixture(upgradedFixture);

      expect(await ctx.v2.treasury()).to.equal(ctx.treasury.address);

      const legacy = await ctx.v2.legacyOrders(ctx.legacyOrderId);
      expect(legacy.requester).to.equal(ctx.user.address);
      expect(legacy.amount).to.equal(ctx.legacyAmount);
      expect(legacy.token).to.equal(await ctx.token.getAddress());
      expect(legacy.status).to.equal(0); // still Pending
    });

    it("reads a pre-upgrade order through the v1-compatible getOrder", async function () {
      const ctx = await loadFixture(upgradedFixture);
      const view = await ctx.v2.getOrder(ctx.legacyOrderId);

      expect(view[0]).to.equal(ctx.legacyOrderId);
      expect(view[1]).to.equal(ctx.user.address);
      expect(view[4]).to.equal(ctx.legacyAmount);
      expect(view[5]).to.equal(LegacyStatus.Pending);
      expect(view[7]).to.equal("pre-upgrade");
    });

    it("migrates authority from Ownable to role-based access control", async function () {
      const ctx = await loadFixture(upgradedFixture);

      expect(await ctx.v2.hasRole(ROLES.DEFAULT_ADMIN, ctx.owner.address)).to.be.true;
      expect(await ctx.v2.hasRole(ROLES.UPGRADER, ctx.owner.address)).to.be.true;
      expect(await ctx.v2.hasRole(ROLES.AGGREGATOR, ctx.aggregator.address)).to.be.true;
      expect(await ctx.v2.hasRole(ROLES.AGGREGATOR, ctx.owner.address)).to.be.false;
      expect(await ctx.v2.aggregatorAddress()).to.equal(ctx.aggregator.address);
    });

    it("preserves an emergency pause across the v1 -> v2 migration", async function () {
      const ctx = await deployV1Fixture();
      const amount = usdc(500);
      await createV1OffRampOrder(ctx, amount, "paused-upgrade");

      await ctx.v1.connect(ctx.owner).pause();
      expect(await ctx.v1.paused()).to.equal(true);

      const V2 = await ethers.getContractFactory("ElementFlowOrderManager", ctx.owner);
      const v2 = await upgrades.upgradeProxy(await ctx.v1.getAddress(), V2, {
        kind: "uups",
        call: {
          fn: "initializeV2",
          args: [
            ctx.owner.address,
            ctx.aggregator.address,
            ctx.feeRecipient.address,
            0,
            3600,
            [await ctx.token.getAddress()],
            [amount],
          ],
        },
      });

      expect(await v2.paused()).to.equal(true);
      await expect(
        v2
          .connect(ctx.aggregator)
          .createOrder(ctx.user.address, ethers.ZeroAddress, usdc(100), await ctx.token.getAddress(), OrderType.OffRamp, "blocked")
      ).to.be.revertedWithCustomError(v2, "EnforcedPause");
    });

    it("closes the escrow-freezing vulnerability", async function () {
      const ctx = await loadFixture(upgradedFixture);

      // escrowFunds and releaseEscrow no longer exist on the proxy's ABI.
      expect(ctx.v2.interface.hasFunction("escrowFunds(bytes32,uint256)")).to.be.false;
      expect(ctx.v2.interface.hasFunction("releaseEscrow(bytes32)")).to.be.false;

      // Calling the old selectors now hits no function and reverts.
      const frozenCall = ctx.v1.interface.encodeFunctionData("releaseEscrow", [ctx.legacyOrderId]);
      await expect(
        ctx.attacker.sendTransaction({ to: await ctx.v2.getAddress(), data: frozenCall })
      ).to.be.reverted;
    });

    it("drains a pre-upgrade order through the legacy settlement path", async function () {
      const ctx = await loadFixture(upgradedFixture);
      const tokenAddress = await ctx.token.getAddress();

      expect(await ctx.v2.escrowedBalance(tokenAddress)).to.equal(ctx.legacyAmount);

      await ctx.v2.connect(ctx.aggregator).settleLegacyOrder(ctx.legacyOrderId);

      expect(await ctx.token.balanceOf(ctx.treasury.address)).to.equal(ctx.legacyAmount);
      expect(await ctx.v2.escrowedBalance(tokenAddress)).to.equal(0);
      expect((await ctx.v2.legacyOrders(ctx.legacyOrderId)).status).to.equal(1); // Completed
    });

    it("refunds a pre-upgrade order through the legacy refund path", async function () {
      const ctx = await loadFixture(upgradedFixture);

      await ctx.v2.connect(ctx.aggregator).refundLegacyOrder(ctx.legacyOrderId);

      expect(await ctx.token.balanceOf(ctx.user.address)).to.equal(usdc(10_000));
      expect((await ctx.v2.legacyOrders(ctx.legacyOrderId)).status).to.equal(2); // Cancelled
    });

    it("restricts the legacy drain paths to the aggregator", async function () {
      const ctx = await loadFixture(upgradedFixture);
      await expect(
        ctx.v2.connect(ctx.attacker).settleLegacyOrder(ctx.legacyOrderId)
      ).to.be.revertedWithCustomError(ctx.v2, "AccessControlUnauthorizedAccount");
      await expect(
        ctx.v2.connect(ctx.attacker).refundLegacyOrder(ctx.legacyOrderId)
      ).to.be.revertedWithCustomError(ctx.v2, "AccessControlUnauthorizedAccount");
    });

    it("protects the seeded legacy escrow from being treated as free liquidity", async function () {
      const ctx = await loadFixture(upgradedFixture);
      const tokenAddress = await ctx.token.getAddress();

      // The proxy holds 1000 USDC, all of it belonging to the pre-upgrade off-ramp user.
      expect(await ctx.token.balanceOf(await ctx.v2.getAddress())).to.equal(ctx.legacyAmount);
      expect(await ctx.v2.availableLiquidity(tokenAddress)).to.equal(0);

      await expect(
        ctx.v2.connect(ctx.owner).withdrawLiquidity(tokenAddress, ctx.owner.address, 1)
      ).to.be.revertedWithCustomError(ctx.v2, "InsufficientLiquidity");
    });

    it("refuses to settle a legacy on-ramp out of pending off-ramp escrow", async function () {
      const ctx = await deployV1Fixture();
      const escrowed = usdc(1000);
      const onRampAmount = usdc(500);

      const offRampId = await createV1OffRampOrder(ctx, escrowed, "off-escrow");
      const onRampTx = await ctx.v1
        .connect(ctx.aggregator)
        .createOrder(ctx.user.address, onRampAmount, await ctx.token.getAddress(), OrderType.OnRamp, "legacy-on");
      const onRampReceipt = await onRampTx.wait();
      const onRampId = onRampReceipt.logs
        .map((l) => {
          try {
            return ctx.v1.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((l) => l && l.name === "OrderCreated").args.orderId;

      const V2 = await ethers.getContractFactory("ElementFlowOrderManager", ctx.owner);
      const v2 = await upgrades.upgradeProxy(await ctx.v1.getAddress(), V2, {
        kind: "uups",
        call: {
          fn: "initializeV2",
          args: [
            ctx.owner.address,
            ctx.aggregator.address,
            ctx.feeRecipient.address,
            0,
            3600,
            [await ctx.token.getAddress()],
            [escrowed],
          ],
        },
      });

      // Proxy balance is entirely off-ramp escrow — settling the legacy on-ramp must fail closed.
      await expect(v2.connect(ctx.aggregator).settleLegacyOrder(onRampId)).to.be.revertedWithCustomError(
        v2,
        "InsufficientLiquidity"
      );
      expect(await v2.escrowedBalance(await ctx.token.getAddress())).to.equal(escrowed);
      expect((await v2.legacyOrders(offRampId)).status).to.equal(0); // still Pending
    });

    it("serves new v2 orders on the upgraded proxy", async function () {
      const ctx = await loadFixture(upgradedFixture);
      const tokenAddress = await ctx.token.getAddress();
      await ctx.v2.connect(ctx.owner).setTokenAllowed(tokenAddress, true);

      const amount = usdc(500);
      await ctx.token.connect(ctx.user).approve(await ctx.v2.getAddress(), amount);

      const intentKey = ethers.keccak256(ethers.toUtf8Bytes("post-upgrade"));
      const orderId = await ctx.v2.computeOrderId(
        ctx.user.address,
        amount,
        tokenAddress,
        OrderType.OffRamp,
        intentKey
      );
      await ctx.v2
        .connect(ctx.aggregator)
        .createOrder(ctx.user.address, ethers.ZeroAddress, amount, tokenAddress, OrderType.OffRamp, "post-upgrade");

      expect((await ctx.v2.getOrderRecord(orderId)).status).to.equal(OrderStatus.Pending);

      // New escrow accumulates on top of the seeded legacy escrow.
      expect(await ctx.v2.escrowedBalance(tokenAddress)).to.equal(ctx.legacyAmount + amount);

      await ctx.v2.connect(ctx.aggregator).settleOrder(orderId);
      expect(await ctx.token.balanceOf(ctx.treasury.address)).to.equal(amount);
    });

    it("cannot re-run initializeV2", async function () {
      const ctx = await loadFixture(upgradedFixture);
      await expect(
        ctx.v2
          .connect(ctx.attacker)
          .initializeV2(ctx.attacker.address, ctx.attacker.address, ctx.attacker.address, 0, 3600, [], [])
      ).to.be.revertedWithCustomError(ctx.v2, "InvalidInitialization");
    });

    it("cannot run initialize on a proxy that was migrated via initializeV2", async function () {
      const ctx = await loadFixture(upgradedFixture);
      await expect(
        ctx.v2
          .connect(ctx.attacker)
          .initialize(
            ctx.attacker.address,
            ctx.attacker.address,
            ctx.attacker.address,
            ctx.attacker.address,
            0,
            3600
          )
      ).to.be.revertedWithCustomError(ctx.v2, "InvalidInitialization");
    });
  });

  describe("storage layout validation", function () {
    it("accepts the v1 -> v2 layout as compatible", async function () {
      const ctx = await loadFixture(deployV1Fixture);
      const V2 = await ethers.getContractFactory("ElementFlowOrderManager");

      await expect(upgrades.validateUpgrade(await ctx.v1.getAddress(), V2, { kind: "uups" })).to.not.be
        .rejected;
    });

    it("rejects an implementation with a reordered layout", async function () {
      const ctx = await loadFixture(deployV1Fixture);
      const Bad = await ethers.getContractFactory("ElementFlowOrderManagerBadLayout");

      // `treasury` and the aggregator slot are swapped, which would silently reinterpret
      // the treasury address as the aggregator.
      await expect(upgrades.validateUpgrade(await ctx.v1.getAddress(), Bad, { kind: "uups" })).to.be
        .rejected;
    });

    it("rejects a non-UUPS implementation", async function () {
      const ctx = await loadFixture(deployV1Fixture);
      const NotUUPS = await ethers.getContractFactory("NotUUPSImplementation");

      await expect(upgrades.validateUpgrade(await ctx.v1.getAddress(), NotUUPS, { kind: "uups" })).to.be
        .rejected;
    });
  });

  describe("v2 -> v3 upgrade", function () {
    const fixture = () => deployStack();

    it("preserves orders, balances, roles and accounting across an upgrade", async function () {
      const ctx = await loadFixture(fixture);
      const tokenAddress = await ctx.token.getAddress();

      // Build up meaningful state: one settled order, one still pending.
      await approve(ctx, ctx.user, usdc(3000));
      const settled = await createOrder(ctx, {
        amount: usdc(1000),
        orderType: OrderType.OffRamp,
        messageHash: "settled",
      });
      await ctx.manager.connect(ctx.aggregator).settleOrder(settled.orderId);

      const pending = await createOrder(ctx, {
        amount: usdc(2000),
        orderType: OrderType.OffRamp,
        messageHash: "pending",
      });

      const escrowBefore = await ctx.manager.escrowedBalance(tokenAddress);

      const V3 = await ethers.getContractFactory("ElementFlowOrderManagerV3Mock", ctx.admin);
      const v3 = await upgrades.upgradeProxy(await ctx.manager.getAddress(), V3, {
        kind: "uups",
        call: { fn: "initializeV3", args: [] },
      });

      expect(await v3.getVersion()).to.equal("3.0.0");
      expect(await v3.getAddress()).to.equal(await ctx.manager.getAddress());

      // Orders survive.
      expect((await v3.getOrderRecord(settled.orderId)).status).to.equal(OrderStatus.Settled);
      const stillPending = await v3.getOrderRecord(pending.orderId);
      expect(stillPending.status).to.equal(OrderStatus.Pending);
      expect(stillPending.amount).to.equal(usdc(2000));

      // Accounting, config and roles survive.
      expect(await v3.escrowedBalance(tokenAddress)).to.equal(escrowBefore);
      expect(await v3.treasury()).to.equal(ctx.treasury.address);
      expect(await v3.isTokenAllowed(tokenAddress)).to.be.true;
      expect(await v3.hasRole(ROLES.AGGREGATOR, ctx.aggregator.address)).to.be.true;

      // The pending order is still settleable through the new implementation.
      await v3.connect(ctx.aggregator).settleOrder(pending.orderId);
      expect(await ctx.token.balanceOf(ctx.treasury.address)).to.equal(usdc(3000));
    });

    it("exposes new v3 state without disturbing inherited storage", async function () {
      const ctx = await loadFixture(fixture);
      const V3 = await ethers.getContractFactory("ElementFlowOrderManagerV3Mock", ctx.admin);
      const v3 = await upgrades.upgradeProxy(await ctx.manager.getAddress(), V3, {
        kind: "uups",
        call: { fn: "initializeV3", args: [] },
      });

      const orderId = ethers.keccak256(ethers.toUtf8Bytes("note-target"));
      await v3.connect(ctx.aggregator).setSettlementNote(orderId, "manual review");

      expect(await v3.settlementNotes(orderId)).to.equal("manual review");
      expect(await v3.totalSettlementNotes()).to.equal(1);
      expect(await v3.treasury()).to.equal(ctx.treasury.address);
    });

    it("upgrades the provider registry independently of the order manager", async function () {
      const ctx = await loadFixture(fixture);
      const Registry = await ethers.getContractFactory("ProviderRegistry", ctx.admin);

      const upgraded = await upgrades.upgradeProxy(await ctx.registry.getAddress(), Registry, {
        kind: "uups",
      });

      // Routes survive an independent registry upgrade — the whole point of splitting them.
      expect(await upgraded.getProvider(require("./helpers").PARTNER_PROVIDER_ID)).to.equal(
        await ctx.partner.getAddress()
      );
    });
  });

  describe("v2.1 refundAddress layout", function () {
    /**
     * Deploy the frozen v2.0.0 OrderManager layout (no `_refundAddress`, `__gap` = 38).
     * Production upgrades go v2.0 → v2.1; validating current-vs-current would miss layout bugs.
     */
    async function v20ProxyFixture() {
      const [admin, aggregator, treasury, feeRecipient, user, otherUser] = await ethers.getSigners();
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const token = await MockERC20.deploy("USD Coin", "USDC", 6);
      await token.mint(user.address, usdc(10_000));

      const V20 = await ethers.getContractFactory("ElementFlowOrderManagerV20", admin);
      const manager = await upgrades.deployProxy(
        V20,
        [admin.address, aggregator.address, treasury.address, feeRecipient.address, 0, 3600],
        { kind: "uups", initializer: "initialize" },
      );
      await manager.connect(admin).setTokenAllowed(await token.getAddress(), true);

      return { admin, aggregator, treasury, feeRecipient, user, otherUser, token, manager };
    }

    it("validateUpgrade accepts ElementFlowOrderManager from a real v2.0 proxy", async function () {
      const ctx = await loadFixture(v20ProxyFixture);
      expect(await ctx.manager.getVersion()).to.equal("2.0.0");

      const V21 = await ethers.getContractFactory("ElementFlowOrderManager", ctx.admin);
      await upgrades.validateUpgrade(await ctx.manager.getAddress(), V21, { kind: "uups" });
    });

    it("upgrades v2.0 → v2.1 in place and preserves pending OffRamp escrow", async function () {
      const ctx = await loadFixture(v20ProxyFixture);
      const tokenAddress = await ctx.token.getAddress();
      const proxy = await ctx.manager.getAddress();

      await ctx.token.connect(ctx.user).approve(proxy, usdc(500));
      const tx = await ctx.manager
        .connect(ctx.aggregator)
        .createOrder(ctx.user.address, usdc(500), tokenAddress, OrderType.OffRamp, "v20-pending");
      const receipt = await tx.wait();
      const created = receipt.logs
        .map((l) => {
          try {
            return ctx.manager.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((p) => p && p.name === "OrderCreated");
      const orderId = created.args.orderId;

      expect(await ctx.manager.escrowedBalance(tokenAddress)).to.equal(usdc(500));

      const V21 = await ethers.getContractFactory("ElementFlowOrderManager", ctx.admin);
      const v21 = await upgrades.upgradeProxy(proxy, V21, { kind: "uups" });

      expect(await v21.getAddress()).to.equal(proxy);
      expect(await v21.getVersion()).to.equal("2.1.0");
      expect(await v21.escrowedBalance(tokenAddress)).to.equal(usdc(500));
      expect((await v21.getOrderRecord(orderId)).status).to.equal(OrderStatus.Pending);
      // Pre-upgrade orders have no stored refundAddress → payout defaults to payer.
      expect(await v21.getRefundAddress(orderId)).to.equal(ctx.user.address);

      await v21.connect(ctx.aggregator).refundOrder(orderId);
      expect(await ctx.token.balanceOf(ctx.user.address)).to.equal(usdc(10_000));
    });

    it("after v2.0 → v2.1 upgrade, createOrder pays the distinct refundAddress", async function () {
      const ctx = await loadFixture(v20ProxyFixture);
      const proxy = await ctx.manager.getAddress();
      const V21 = await ethers.getContractFactory("ElementFlowOrderManager", ctx.admin);
      const v21 = await upgrades.upgradeProxy(proxy, V21, { kind: "uups" });

      await ctx.token.connect(ctx.user).approve(proxy, usdc(200));
      const tx = await v21
        .connect(ctx.aggregator)
        .createOrder(
          ctx.user.address,
          ctx.otherUser.address,
          usdc(200),
          await ctx.token.getAddress(),
          OrderType.OffRamp,
          "post-upgrade-refund",
        );
      const receipt = await tx.wait();
      const created = receipt.logs
        .map((l) => {
          try {
            return v21.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((p) => p && p.name === "OrderCreated");
      const orderId = created.args.orderId;

      const balOtherBefore = await ctx.token.balanceOf(ctx.otherUser.address);
      await v21.connect(ctx.aggregator).refundOrder(orderId);
      expect(await ctx.token.balanceOf(ctx.otherUser.address)).to.equal(balOtherBefore + usdc(200));
    });
  });
});
