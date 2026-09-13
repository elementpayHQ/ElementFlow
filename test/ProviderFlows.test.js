const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const {
  OrderType,
  OrderStatus,
  ROLES,
  MAX_BPS,
  TREASURY_PROVIDER_ID,
  PARTNER_PROVIDER_ID,
  deployStack,
  createOrder,
  approve,
  usdc,
  role,
} = require("./helpers");

describe("On-ramp provider abstraction", function () {
  const fixture = () => deployStack();
  const feeFixture = () => deployStack({ feeBps: 1_000 });

  describe("ProviderRegistry", function () {
    it("registers a provider and reports it active", async function () {
      const ctx = await loadFixture(fixture);
      expect(await ctx.registry.getProvider(PARTNER_PROVIDER_ID)).to.equal(await ctx.partner.getAddress());
      expect(await ctx.registry.isProviderActive(PARTNER_PROVIDER_ID)).to.be.true;
      expect(await ctx.registry.allProviderIds()).to.deep.equal([
        TREASURY_PROVIDER_ID,
        PARTNER_PROVIDER_ID,
      ]);
    });

    it("rejects an adapter filed under the wrong id", async function () {
      const ctx = await loadFixture(fixture);
      const Mismatched = await ethers.getContractFactory("MockMismatchedProvider");
      const rogue = await Mismatched.deploy();

      // Registering under the wrong key would silently route orders to the wrong
      // counterparty, so the registry cross-checks the adapter's own claim.
      await expect(
        ctx.registry.connect(ctx.admin).registerProvider(role("SOME_EXPECTED_ID"), await rogue.getAddress())
      ).to.be.revertedWithCustomError(ctx.registry, "ProviderIdMismatch");
    });

    it("rejects duplicate registration and zero addresses", async function () {
      const ctx = await loadFixture(fixture);
      await expect(
        ctx.registry.connect(ctx.admin).registerProvider(PARTNER_PROVIDER_ID, await ctx.partner.getAddress())
      ).to.be.revertedWithCustomError(ctx.registry, "ProviderAlreadyRegistered");

      await expect(
        ctx.registry.connect(ctx.admin).registerProvider(role("NEW"), ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(ctx.registry, "ZeroAddress");
    });

    it("requires PROVIDER_ADMIN_ROLE to register and GUARDIAN to disable", async function () {
      const ctx = await loadFixture(fixture);
      await expect(
        ctx.registry.connect(ctx.outsider).registerProvider(role("X"), await ctx.partner.getAddress())
      ).to.be.revertedWithCustomError(ctx.registry, "AccessControlUnauthorizedAccount");

      await expect(
        ctx.registry.connect(ctx.outsider).disableProvider(PARTNER_PROVIDER_ID)
      ).to.be.revertedWithCustomError(ctx.registry, "AccessControlUnauthorizedAccount");

      // A guardian can pull a route without holding full provider-admin rights.
      await ctx.registry.connect(ctx.admin).grantRole(ROLES.PROVIDER_GUARDIAN, ctx.outsider.address);
      await expect(ctx.registry.connect(ctx.outsider).disableProvider(PARTNER_PROVIDER_ID)).to.not.be
        .reverted;
      await expect(
        ctx.registry.connect(ctx.outsider).enableProvider(PARTNER_PROVIDER_ID)
      ).to.be.revertedWithCustomError(ctx.registry, "AccessControlUnauthorizedAccount");
    });

    it("resolves strictly: unknown and disabled providers revert", async function () {
      const ctx = await loadFixture(fixture);
      await expect(
        ctx.registry.requireActiveProvider(role("UNKNOWN"))
      ).to.be.revertedWithCustomError(ctx.registry, "ProviderNotRegistered");

      await ctx.registry.connect(ctx.admin).disableProvider(PARTNER_PROVIDER_ID);
      await expect(ctx.registry.requireActiveProvider(PARTNER_PROVIDER_ID))
        .to.be.revertedWithCustomError(ctx.registry, "ProviderDisabled")
        .withArgs(PARTNER_PROVIDER_ID);
    });

    it("swaps an adapter implementation while keeping the route id", async function () {
      const ctx = await loadFixture(fixture);
      const Partner = await ethers.getContractFactory("MockOnRampProvider");
      const replacement = await Partner.deploy(PARTNER_PROVIDER_ID);

      await ctx.registry
        .connect(ctx.admin)
        .updateProviderAdapter(PARTNER_PROVIDER_ID, await replacement.getAddress());

      expect(await ctx.registry.getProvider(PARTNER_PROVIDER_ID)).to.equal(
        await replacement.getAddress()
      );
    });
  });

  describe("provider-routed on-ramp settlement", function () {
    it("settles through the partner adapter without touching manager liquidity", async function () {
      const ctx = await loadFixture(fixture);
      const amount = usdc(1000);
      const tokenAddress = await ctx.token.getAddress();
      const managerBalanceBefore = await ctx.token.balanceOf(await ctx.manager.getAddress());

      const { orderId } = await createOrder(ctx, {
        amount,
        orderType: OrderType.OnRamp,
        providerId: PARTNER_PROVIDER_ID,
      });

      // Partner-routed orders consume partner liquidity, so the manager reserves nothing.
      expect(await ctx.manager.reservedLiquidity(tokenAddress)).to.equal(0);
      expect(await ctx.partner.onOrderCreatedCalls()).to.equal(1);

      const userBefore = await ctx.token.balanceOf(ctx.user.address);
      await expect(ctx.manager.connect(ctx.aggregator).settleOrder(orderId))
        .to.emit(ctx.manager, "OrderSettled")
        .withArgs(orderId, tokenAddress, ctx.user.address, amount, 0, PARTNER_PROVIDER_ID);

      expect(await ctx.token.balanceOf(ctx.user.address)).to.equal(userBefore + amount);
      expect(await ctx.token.balanceOf(await ctx.manager.getAddress())).to.equal(managerBalanceBefore);
      expect(await ctx.partner.settleOnRampCalls()).to.equal(1);
    });

    it("routes fees to the fee recipient through the adapter", async function () {
      const ctx = await loadFixture(feeFixture);
      const amount = usdc(1000);
      const fee = (amount * 1_000n) / MAX_BPS;

      const { orderId } = await createOrder(ctx, {
        amount,
        orderType: OrderType.OnRamp,
        providerId: PARTNER_PROVIDER_ID,
      });
      const userBefore = await ctx.token.balanceOf(ctx.user.address);
      await ctx.manager.connect(ctx.aggregator).settleOrder(orderId);

      expect(await ctx.token.balanceOf(ctx.user.address)).to.equal(userBefore + amount - fee);
      expect(await ctx.token.balanceOf(ctx.feeRecipient.address)).to.equal(fee);
    });

    it("settles the in-house TreasuryPool adapter through the same interface", async function () {
      const ctx = await loadFixture(fixture);
      const amount = usdc(1000);

      const { orderId } = await createOrder(ctx, {
        amount,
        orderType: OrderType.OnRamp,
        providerId: TREASURY_PROVIDER_ID,
      });

      const userBefore = await ctx.token.balanceOf(ctx.user.address);
      const poolBefore = await ctx.token.balanceOf(await ctx.pool.getAddress());

      await expect(ctx.manager.connect(ctx.aggregator).settleOrder(orderId))
        .to.emit(ctx.pool, "OnRampSettled")
        .withArgs(orderId, await ctx.token.getAddress(), ctx.user.address, amount);

      expect(await ctx.token.balanceOf(ctx.user.address)).to.equal(userBefore + amount);
      expect(await ctx.token.balanceOf(await ctx.pool.getAddress())).to.equal(poolBefore - amount);
    });

    it("honours a default provider set by governance", async function () {
      const ctx = await loadFixture(fixture);
      await ctx.manager.connect(ctx.admin).setDefaultProviderId(PARTNER_PROVIDER_ID);

      // Plain createOrder now routes through the partner with no ABI change for the backend.
      const { orderId } = await createOrder(ctx, { amount: usdc(500), orderType: OrderType.OnRamp });

      expect((await ctx.manager.getOrderRecord(orderId)).providerId).to.equal(PARTNER_PROVIDER_ID);
      await ctx.manager.connect(ctx.aggregator).settleOrder(orderId);
      expect(await ctx.partner.settleOnRampCalls()).to.equal(1);
    });

    it("rejects a default provider that is not registered", async function () {
      const ctx = await loadFixture(fixture);
      await expect(
        ctx.manager.connect(ctx.admin).setDefaultProviderId(role("GHOST"))
      ).to.be.revertedWithCustomError(ctx.registry, "ProviderNotRegistered");
    });
  });

  describe("adversarial and failing providers", function () {
    it("rejects a settlement where the adapter underpays the user", async function () {
      const ctx = await loadFixture(fixture);
      const amount = usdc(1000);
      const { orderId } = await createOrder(ctx, {
        amount,
        orderType: OrderType.OnRamp,
        providerId: PARTNER_PROVIDER_ID,
      });

      await ctx.partner.setPayoutBps(5_000); // pays only half

      // The manager verifies the beneficiary's balance delta rather than trusting the
      // adapter, so a partial payment cannot mark the order settled.
      await expect(ctx.manager.connect(ctx.aggregator).settleOrder(orderId))
        .to.be.revertedWithCustomError(ctx.manager, "ProviderSettlementShortfall")
        .withArgs(amount, amount / 2n);

      expect((await ctx.manager.getOrderRecord(orderId)).status).to.equal(OrderStatus.Pending);
    });

    it("rejects a settlement where the adapter pays nothing at all", async function () {
      const ctx = await loadFixture(fixture);
      const { orderId } = await createOrder(ctx, {
        amount: usdc(1000),
        orderType: OrderType.OnRamp,
        providerId: PARTNER_PROVIDER_ID,
      });

      await ctx.partner.setPayoutBps(0);
      await expect(
        ctx.manager.connect(ctx.aggregator).settleOrder(orderId)
      ).to.be.revertedWithCustomError(ctx.manager, "ProviderSettlementShortfall");
    });

    it("rejects a settlement where the adapter pays the wrong address", async function () {
      const ctx = await loadFixture(fixture);
      const { orderId } = await createOrder(ctx, {
        amount: usdc(1000),
        orderType: OrderType.OnRamp,
        providerId: PARTNER_PROVIDER_ID,
      });

      await ctx.partner.setMisdirectTo(ctx.outsider.address);

      await expect(
        ctx.manager.connect(ctx.aggregator).settleOrder(orderId)
      ).to.be.revertedWithCustomError(ctx.manager, "ProviderSettlementShortfall");
      expect((await ctx.manager.getOrderRecord(orderId)).status).to.equal(OrderStatus.Pending);
    });

    it("keeps the order settleable after a provider outage is resolved", async function () {
      const ctx = await loadFixture(fixture);
      const amount = usdc(1000);
      const { orderId } = await createOrder(ctx, {
        amount,
        orderType: OrderType.OnRamp,
        providerId: PARTNER_PROVIDER_ID,
      });

      await ctx.partner.setSettleShouldRevert(true);
      await expect(ctx.manager.connect(ctx.aggregator).settleOrder(orderId)).to.be.revertedWith(
        "MockOnRampProvider: settle reverted"
      );

      await ctx.partner.setSettleShouldRevert(false);
      const userBefore = await ctx.token.balanceOf(ctx.user.address);
      await ctx.manager.connect(ctx.aggregator).settleOrder(orderId);
      expect(await ctx.token.balanceOf(ctx.user.address)).to.equal(userBefore + amount);
    });

    it("blocks new orders on a disabled route but keeps existing ones refundable", async function () {
      const ctx = await loadFixture(fixture);
      const amount = usdc(1000);
      const { orderId } = await createOrder(ctx, {
        amount,
        orderType: OrderType.OnRamp,
        providerId: PARTNER_PROVIDER_ID,
      });

      await ctx.registry.connect(ctx.admin).disableProvider(PARTNER_PROVIDER_ID);

      await expect(
        createOrder(ctx, {
          amount,
          orderType: OrderType.OnRamp,
          providerId: PARTNER_PROVIDER_ID,
          messageHash: "after-disable",
        })
      ).to.be.revertedWithCustomError(ctx.registry, "ProviderDisabled");

      // Cutting off a bad route must not strand orders already routed to it. Re-enable to
      // unwind them cleanly.
      await ctx.registry.connect(ctx.admin).enableProvider(PARTNER_PROVIDER_ID);
      await expect(ctx.manager.connect(ctx.aggregator).refundOrder(orderId)).to.not.be.reverted;
      expect(await ctx.partner.onOrderRefundedCalls()).to.equal(1);
    });

    it("surfaces a provider that rejects the creation hook", async function () {
      const ctx = await loadFixture(fixture);
      await ctx.partner.setCreateHookShouldRevert(true);

      await expect(
        createOrder(ctx, {
          amount: usdc(100),
          orderType: OrderType.OnRamp,
          providerId: PARTNER_PROVIDER_ID,
        })
      ).to.be.revertedWith("MockOnRampProvider: create hook reverted");
    });

    it("reverts when no registry is configured", async function () {
      const ctx = await loadFixture(fixture);
      const Manager = await ethers.getContractFactory("ElementFlowOrderManager");
      const { upgrades } = require("hardhat");
      const bare = await upgrades.deployProxy(
        Manager,
        [ctx.admin.address, ctx.aggregator.address, ctx.treasury.address, ctx.feeRecipient.address, 0, 3600],
        { kind: "uups" }
      );
      await bare.connect(ctx.admin).setTokenAllowed(await ctx.token.getAddress(), true);

      await expect(
        bare
          .connect(ctx.aggregator)
          .createOrderWithProvider(
            ctx.user.address,
            usdc(100),
            await ctx.token.getAddress(),
            OrderType.OnRamp,
            "m",
            PARTNER_PROVIDER_ID,
            ethers.ZeroHash
          )
      ).to.be.revertedWithCustomError(bare, "ProviderRegistryNotSet");
    });
  });

  describe("provider-routed off-ramp settlement", function () {
    it("forwards escrowed principal to the adapter for the fiat leg", async function () {
      const ctx = await loadFixture(fixture);
      const amount = usdc(1000);
      await approve(ctx, ctx.user, amount);

      const { orderId } = await createOrder(ctx, {
        amount,
        orderType: OrderType.OffRamp,
        providerId: PARTNER_PROVIDER_ID,
      });

      const partnerBefore = await ctx.token.balanceOf(await ctx.partner.getAddress());
      await ctx.manager.connect(ctx.aggregator).settleOrder(orderId);

      // The adapter is funded before it is asked to run the payout, so it is never
      // expected to front the fiat leg from its own balance sheet.
      expect(await ctx.token.balanceOf(await ctx.partner.getAddress())).to.equal(partnerBefore + amount);
      expect(await ctx.partner.settleOffRampCalls()).to.equal(1);
      expect(await ctx.token.balanceOf(ctx.treasury.address)).to.equal(0);
      expect(await ctx.manager.escrowedBalance(await ctx.token.getAddress())).to.equal(0);
    });

    it("refunds a provider-routed off-ramp order to the user", async function () {
      const ctx = await loadFixture(fixture);
      const amount = usdc(1000);
      await approve(ctx, ctx.user, amount);
      const { orderId } = await createOrder(ctx, {
        amount,
        orderType: OrderType.OffRamp,
        providerId: PARTNER_PROVIDER_ID,
      });

      await ctx.manager.connect(ctx.aggregator).refundOrder(orderId);

      expect(await ctx.token.balanceOf(ctx.user.address)).to.equal(usdc(10_000));
      expect(await ctx.partner.onOrderRefundedCalls()).to.equal(1);
    });
  });

  describe("TreasuryPool", function () {
    it("only lets the order manager drive settlement", async function () {
      const ctx = await loadFixture(fixture);
      const ctxStruct = {
        orderId: ethers.ZeroHash,
        requester: ctx.outsider.address,
        token: await ctx.token.getAddress(),
        amount: usdc(1),
        netAmount: usdc(1),
        feeAmount: 0,
        orderType: OrderType.OnRamp,
        providerId: TREASURY_PROVIDER_ID,
        messageHash: "x",
      };

      await expect(
        ctx.pool.connect(ctx.outsider).settleOnRamp(ctxStruct, ctx.outsider.address, ctx.feeRecipient.address)
      ).to.be.revertedWithCustomError(ctx.pool, "AccessControlUnauthorizedAccount");
    });

    it("rejects an on-ramp order it cannot cover", async function () {
      const ctx = await loadFixture(fixture);
      // The pool holds 50k; ask for more at creation time so the user is told immediately
      // rather than after they have already paid fiat.
      await expect(
        createOrder(ctx, {
          amount: usdc(60_000),
          orderType: OrderType.OnRamp,
          providerId: TREASURY_PROVIDER_ID,
        })
      ).to.be.revertedWithCustomError(ctx.pool, "InsufficientPoolLiquidity");
    });

    it("rejects unsupported tokens", async function () {
      const ctx = await loadFixture(fixture);
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const other = await MockERC20.deploy("Other", "OTH", 18);
      await ctx.manager.connect(ctx.admin).setTokenAllowed(await other.getAddress(), true);

      await expect(
        createOrder(ctx, {
          amount: ethers.parseEther("1"),
          token: other,
          orderType: OrderType.OnRamp,
          providerId: TREASURY_PROVIDER_ID,
        })
      ).to.be.revertedWithCustomError(ctx.pool, "TokenNotSupported");
    });

    it("gates funding and defunding correctly", async function () {
      const ctx = await loadFixture(fixture);
      const tokenAddress = await ctx.token.getAddress();

      await ctx.token.mint(ctx.outsider.address, usdc(100));
      await ctx.token.connect(ctx.outsider).approve(await ctx.pool.getAddress(), usdc(100));
      // Funding is permissionless — anyone may top up the house float.
      await expect(ctx.pool.connect(ctx.outsider).fund(tokenAddress, usdc(100))).to.emit(ctx.pool, "Funded");

      // Removing float is not.
      await expect(
        ctx.pool.connect(ctx.outsider).defund(tokenAddress, ctx.outsider.address, usdc(100))
      ).to.be.revertedWithCustomError(ctx.pool, "AccessControlUnauthorizedAccount");

      await expect(ctx.pool.connect(ctx.admin).defund(tokenAddress, ctx.treasury.address, usdc(100))).to.emit(
        ctx.pool,
        "Defunded"
      );
    });

    it("halts settlement when the pool is paused", async function () {
      const ctx = await loadFixture(fixture);
      const { orderId } = await createOrder(ctx, {
        amount: usdc(100),
        orderType: OrderType.OnRamp,
        providerId: TREASURY_PROVIDER_ID,
      });

      await ctx.pool.connect(ctx.admin).pause();
      await expect(
        ctx.manager.connect(ctx.aggregator).settleOrder(orderId)
      ).to.be.revertedWithCustomError(ctx.pool, "EnforcedPause");

      // Refunds must still work while the pool is halted, or pausing would trap users.
      await expect(ctx.manager.connect(ctx.aggregator).refundOrder(orderId)).to.not.be.reverted;
    });

    it("advertises IOnRampProvider via ERC-165", async function () {
      const ctx = await loadFixture(fixture);
      const iface = ctx.pool.interface;
      const selectors = [
        "providerId()",
        "isTokenSupported(address)",
        "availableLiquidity(address)",
        "settleOnRamp((bytes32,address,address,uint256,uint256,uint256,uint8,bytes32,string),address,address)",
        "settleOffRamp((bytes32,address,address,uint256,uint256,uint256,uint8,bytes32,string))",
        "onOrderCreated((bytes32,address,address,uint256,uint256,uint256,uint8,bytes32,string))",
        "onOrderRefunded((bytes32,address,address,uint256,uint256,uint256,uint8,bytes32,string))",
      ];
      let interfaceId = 0n;
      for (const sig of selectors) {
        interfaceId ^= BigInt(ethers.id(sig).slice(0, 10));
      }
      const asBytes4 = "0x" + interfaceId.toString(16).padStart(8, "0");
      expect(await ctx.pool.supportsInterface(asBytes4)).to.be.true;
      void iface;
    });
  });
});
