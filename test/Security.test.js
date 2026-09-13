const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

const {
  OrderType,
  OrderStatus,
  ROLES,
  MAX_BPS,
  deployStack,
  createOrder,
  approve,
  usdc,
} = require("./helpers");

describe("ElementFlowOrderManager — security controls", function () {
  const fixture = () => deployStack();

  describe("access control", function () {
    it("blocks order creation on behalf of a third party without ORDER_CREATOR_ROLE", async function () {
      const ctx = await loadFixture(fixture);
      const amount = usdc(100);
      // The victim has approved the manager, as any off-ramp user must.
      await approve(ctx, ctx.user, amount);

      // v1 let anyone call createOrder with any address, so an attacker could burn a
      // victim's allowance and pin their order ids at will.
      await expect(
        ctx.manager
          .connect(ctx.outsider)
          .createOrder(ctx.user.address, amount, await ctx.token.getAddress(), OrderType.OffRamp, "m")
      )
        .to.be.revertedWithCustomError(ctx.manager, "NotOrderCreator")
        .withArgs(ctx.outsider.address, ctx.user.address);
    });

    it("restricts settleOrder to AGGREGATOR_ROLE", async function () {
      const ctx = await loadFixture(fixture);
      const amount = usdc(100);
      await approve(ctx, ctx.user, amount);
      const { orderId } = await createOrder(ctx, { amount, orderType: OrderType.OffRamp });

      for (const signer of [ctx.outsider, ctx.user, ctx.admin]) {
        await expect(ctx.manager.connect(signer).settleOrder(orderId))
          .to.be.revertedWithCustomError(ctx.manager, "AccessControlUnauthorizedAccount")
          .withArgs(signer.address, ROLES.AGGREGATOR);
      }
    });

    it("restricts refundOrder to AGGREGATOR_ROLE", async function () {
      const ctx = await loadFixture(fixture);
      const amount = usdc(100);
      await approve(ctx, ctx.user, amount);
      const { orderId } = await createOrder(ctx, { amount, orderType: OrderType.OffRamp });

      // Notably the order's own requester cannot force an early refund.
      await expect(
        ctx.manager.connect(ctx.user).refundOrder(orderId)
      ).to.be.revertedWithCustomError(ctx.manager, "AccessControlUnauthorizedAccount");
    });

    it("restricts configuration to DEFAULT_ADMIN_ROLE", async function () {
      const ctx = await loadFixture(fixture);
      const calls = [
        ["setTreasury", [ctx.outsider.address]],
        ["setFeeRecipient", [ctx.outsider.address]],
        ["setFeeBps", [100]],
        ["setOrderTtl", [7200]],
        ["setTokenAllowed", [await ctx.token.getAddress(), false]],
        ["setProviderRegistry", [ethers.ZeroAddress]],
        ["setDefaultProviderId", [ethers.ZeroHash]],
        ["unpause", []],
      ];

      for (const [fn, args] of calls) {
        await expect(
          ctx.manager.connect(ctx.aggregator)[fn](...args),
          `${fn} should be admin-only`
        ).to.be.revertedWithCustomError(ctx.manager, "AccessControlUnauthorizedAccount");
      }
    });

    it("restricts liquidity movement to TREASURER_ROLE", async function () {
      const ctx = await loadFixture(fixture);
      const tokenAddress = await ctx.token.getAddress();

      await expect(
        ctx.manager.connect(ctx.aggregator).withdrawLiquidity(tokenAddress, ctx.outsider.address, 1)
      ).to.be.revertedWithCustomError(ctx.manager, "AccessControlUnauthorizedAccount");

      await expect(
        ctx.manager.connect(ctx.aggregator).rescueTokens(tokenAddress, ctx.outsider.address, 1)
      ).to.be.revertedWithCustomError(ctx.manager, "AccessControlUnauthorizedAccount");
    });

    it("restricts upgrades to UPGRADER_ROLE", async function () {
      const ctx = await loadFixture(fixture);
      const Manager = await ethers.getContractFactory("ElementFlowOrderManager");
      const newImpl = await Manager.deploy();

      await expect(
        ctx.manager.connect(ctx.admin).upgradeToAndCall(await newImpl.getAddress(), "0x")
      ).to.not.be.reverted;

      await expect(
        ctx.manager.connect(ctx.outsider).upgradeToAndCall(await newImpl.getAddress(), "0x")
      )
        .to.be.revertedWithCustomError(ctx.manager, "AccessControlUnauthorizedAccount")
        .withArgs(ctx.outsider.address, ROLES.UPGRADER);
    });

    it("separates duties: the aggregator cannot upgrade, pause or move liquidity", async function () {
      const ctx = await loadFixture(fixture);
      expect(await ctx.manager.hasRole(ROLES.AGGREGATOR, ctx.aggregator.address)).to.be.true;
      expect(await ctx.manager.hasRole(ROLES.UPGRADER, ctx.aggregator.address)).to.be.false;
      expect(await ctx.manager.hasRole(ROLES.PAUSER, ctx.aggregator.address)).to.be.false;
      expect(await ctx.manager.hasRole(ROLES.TREASURER, ctx.aggregator.address)).to.be.false;
      expect(await ctx.manager.hasRole(ROLES.DEFAULT_ADMIN, ctx.aggregator.address)).to.be.false;
    });

    it("lets admin rotate the aggregator by moving the role", async function () {
      const ctx = await loadFixture(fixture);
      const amount = usdc(100);
      await approve(ctx, ctx.user, amount);
      const { orderId } = await createOrder(ctx, { amount, orderType: OrderType.OffRamp });

      await ctx.manager.connect(ctx.admin).revokeRole(ROLES.AGGREGATOR, ctx.aggregator.address);
      await ctx.manager.connect(ctx.admin).grantRole(ROLES.AGGREGATOR, ctx.otherUser.address);

      await expect(
        ctx.manager.connect(ctx.aggregator).settleOrder(orderId)
      ).to.be.revertedWithCustomError(ctx.manager, "AccessControlUnauthorizedAccount");
      await expect(ctx.manager.connect(ctx.otherUser).settleOrder(orderId)).to.not.be.reverted;
    });

    it("leaves the implementation contract permanently uninitialised", async function () {
      const ctx = await loadFixture(fixture);
      const implAddress = await upgradesErc1967ImplAddress(ctx.manager);
      const impl = await ethers.getContractAt("ElementFlowOrderManager", implAddress);

      // An unprotected implementation can be initialised by anyone and then self-destructed
      // or upgraded out from under the proxy.
      await expect(
        impl.initialize(ctx.outsider.address, ctx.outsider.address, ctx.outsider.address, ctx.outsider.address, 0, 3600)
      ).to.be.revertedWithCustomError(impl, "InvalidInitialization");
    });
  });

  describe("pausing", function () {
    it("halts creation, settlement and refunds", async function () {
      const ctx = await loadFixture(fixture);
      const amount = usdc(100);
      await approve(ctx, ctx.user, amount * 2n);
      const { orderId } = await createOrder(ctx, { amount, orderType: OrderType.OffRamp });

      await ctx.manager.connect(ctx.admin).pause();

      await expect(createOrder(ctx, { amount, messageHash: "while-paused" })).to.be.revertedWithCustomError(
        ctx.manager,
        "EnforcedPause"
      );
      await expect(
        ctx.manager.connect(ctx.aggregator).settleOrder(orderId)
      ).to.be.revertedWithCustomError(ctx.manager, "EnforcedPause");
      await expect(
        ctx.manager.connect(ctx.aggregator).refundOrder(orderId)
      ).to.be.revertedWithCustomError(ctx.manager, "EnforcedPause");

      await time.increase(3601);
      await expect(
        ctx.manager.connect(ctx.outsider).refundExpiredOrder(orderId)
      ).to.be.revertedWithCustomError(ctx.manager, "EnforcedPause");
    });

    it("resumes cleanly after unpause", async function () {
      const ctx = await loadFixture(fixture);
      const amount = usdc(100);
      await approve(ctx, ctx.user, amount);
      const { orderId } = await createOrder(ctx, { amount, orderType: OrderType.OffRamp });

      await ctx.manager.connect(ctx.admin).pause();
      await ctx.manager.connect(ctx.admin).unpause();

      await expect(ctx.manager.connect(ctx.aggregator).settleOrder(orderId)).to.not.be.reverted;
    });

    it("uses an asymmetric pause: PAUSER can stop, only admin can restart", async function () {
      const ctx = await loadFixture(fixture);
      await ctx.manager.connect(ctx.admin).grantRole(ROLES.PAUSER, ctx.outsider.address);

      await expect(ctx.manager.connect(ctx.outsider).pause()).to.not.be.reverted;
      await expect(
        ctx.manager.connect(ctx.outsider).unpause()
      ).to.be.revertedWithCustomError(ctx.manager, "AccessControlUnauthorizedAccount");
      await expect(ctx.manager.connect(ctx.admin).unpause()).to.not.be.reverted;
    });

    it("still allows treasurer recovery while paused", async function () {
      const ctx = await loadFixture(fixture);
      const tokenAddress = await ctx.token.getAddress();
      await ctx.token.mint(await ctx.manager.getAddress(), usdc(500));

      await ctx.manager.connect(ctx.admin).pause();

      // Pausing is an incident control, not a reason to lock the treasury out of
      // recovering unencumbered funds.
      await expect(
        ctx.manager.connect(ctx.admin).rescueTokens(tokenAddress, ctx.treasury.address, usdc(500))
      ).to.not.be.reverted;
    });
  });

  describe("reentrancy", function () {
    async function reentrantFixture() {
      const ctx = await deployStack();
      const Reentrant = await ethers.getContractFactory("MockReentrantERC20");
      const evil = await Reentrant.deploy();
      await ctx.manager.connect(ctx.admin).setTokenAllowed(await evil.getAddress(), true);
      await evil.mint(ctx.user.address, ethers.parseEther("1000"));
      return { ...ctx, evil };
    }

    it("blocks re-entry through a token callback during settlement", async function () {
      const ctx = await loadFixture(reentrantFixture);
      const amount = ethers.parseEther("100");

      await ctx.evil.connect(ctx.user).approve(await ctx.manager.getAddress(), amount);
      const { orderId } = await createOrder(ctx, {
        amount,
        token: ctx.evil,
        orderType: OrderType.OffRamp,
      });

      await time.increase(3601);

      // The token re-enters the permissionless refund path while settlement is mid-flight.
      await ctx.evil.arm(
        await ctx.manager.getAddress(),
        ctx.manager.interface.encodeFunctionData("refundExpiredOrder", [orderId])
      );

      await expect(
        ctx.manager.connect(ctx.aggregator).settleOrder(orderId)
      ).to.be.revertedWithCustomError(ctx.manager, "ReentrancyGuardReentrantCall");
    });

    it("blocks re-entry through a token callback during order creation", async function () {
      const ctx = await loadFixture(reentrantFixture);
      const amount = ethers.parseEther("100");
      await ctx.evil.connect(ctx.user).approve(await ctx.manager.getAddress(), amount * 2n);

      await ctx.evil.arm(
        await ctx.manager.getAddress(),
        ctx.manager.interface.encodeFunctionData("createOrder", [
          ctx.user.address,
          amount,
          await ctx.evil.getAddress(),
          OrderType.OffRamp,
          "nested",
        ])
      );

      await expect(
        createOrder(ctx, { amount, token: ctx.evil, orderType: OrderType.OffRamp })
      ).to.be.revertedWithCustomError(ctx.manager, "ReentrancyGuardReentrantCall");
    });

    it("keeps escrow accounting intact after a reverted reentrant settlement", async function () {
      const ctx = await loadFixture(reentrantFixture);
      const amount = ethers.parseEther("100");
      const evilAddress = await ctx.evil.getAddress();

      await ctx.evil.connect(ctx.user).approve(await ctx.manager.getAddress(), amount);
      const { orderId } = await createOrder(ctx, {
        amount,
        token: ctx.evil,
        orderType: OrderType.OffRamp,
      });
      await time.increase(3601);
      await ctx.evil.arm(
        await ctx.manager.getAddress(),
        ctx.manager.interface.encodeFunctionData("refundExpiredOrder", [orderId])
      );

      await expect(ctx.manager.connect(ctx.aggregator).settleOrder(orderId)).to.be.reverted;

      // The whole transaction unwound: the order is still pending and still fully escrowed.
      expect((await ctx.manager.getOrderRecord(orderId)).status).to.equal(OrderStatus.Pending);
      expect(await ctx.manager.escrowedBalance(evilAddress)).to.equal(amount);
      expect(await ctx.evil.balanceOf(await ctx.manager.getAddress())).to.equal(amount);
    });
  });

  describe("non-standard and failing tokens", function () {
    it("supports USDT-style tokens that return no boolean", async function () {
      const ctx = await loadFixture(fixture);
      const NoReturn = await ethers.getContractFactory("MockNoReturnERC20");
      const usdt = await NoReturn.deploy();
      const usdtAddress = await usdt.getAddress();

      await ctx.manager.connect(ctx.admin).setTokenAllowed(usdtAddress, true);
      await usdt.mint(ctx.user.address, usdc(1000));
      await usdt.connect(ctx.user).approve(await ctx.manager.getAddress(), usdc(1000));

      // v1 wrapped transfers in `require(token.transfer(...))`, which cannot decode a
      // missing return value and therefore reverts against USDT. SafeERC20 handles it.
      const { orderId } = await createOrder(ctx, {
        amount: usdc(1000),
        token: usdt,
        orderType: OrderType.OffRamp,
      });
      await ctx.manager.connect(ctx.aggregator).settleOrder(orderId);

      expect(await usdt.balanceOf(ctx.treasury.address)).to.equal(usdc(1000));
    });

    it("rejects fee-on-transfer tokens rather than silently under-escrowing", async function () {
      const ctx = await loadFixture(fixture);
      const FeeToken = await ethers.getContractFactory("MockFeeOnTransferERC20");
      const fot = await FeeToken.deploy(100); // 1% skim
      const fotAddress = await fot.getAddress();

      await ctx.manager.connect(ctx.admin).setTokenAllowed(fotAddress, true);
      await fot.mint(ctx.user.address, ethers.parseEther("1000"));
      await fot.connect(ctx.user).approve(await ctx.manager.getAddress(), ethers.parseEther("1000"));

      // Accepting this token would record 1000 escrowed while only 990 arrived, quietly
      // breaking the accounting invariant and leaving the last refund unpayable.
      await expect(
        createOrder(ctx, {
          amount: ethers.parseEther("1000"),
          token: fot,
          orderType: OrderType.OffRamp,
        })
      ).to.be.revertedWithCustomError(ctx.manager, "UnexpectedBalanceDelta");
    });

    it("surfaces a transfer that returns false instead of assuming success", async function () {
      const ctx = await loadFixture(fixture);
      const Reverting = await ethers.getContractFactory("MockRevertingERC20");
      const bad = await Reverting.deploy();
      const badAddress = await bad.getAddress();

      await ctx.manager.connect(ctx.admin).setTokenAllowed(badAddress, true);
      await bad.mint(ctx.user.address, ethers.parseEther("100"));
      await bad.connect(ctx.user).approve(await ctx.manager.getAddress(), ethers.parseEther("100"));

      const { orderId } = await createOrder(ctx, {
        amount: ethers.parseEther("100"),
        token: bad,
        orderType: OrderType.OffRamp,
      });

      await bad.setTransferShouldReturnFalse(true);
      await expect(
        ctx.manager.connect(ctx.aggregator).settleOrder(orderId)
      ).to.be.revertedWithCustomError(ctx.manager, "SafeERC20FailedOperation");

      // Failure is atomic: the order stays pending and settleable once the token recovers.
      expect((await ctx.manager.getOrderRecord(orderId)).status).to.equal(OrderStatus.Pending);
      await bad.setTransferShouldReturnFalse(false);
      await expect(ctx.manager.connect(ctx.aggregator).settleOrder(orderId)).to.not.be.reverted;
    });

    it("propagates a hard revert from a failing token", async function () {
      const ctx = await loadFixture(fixture);
      const Reverting = await ethers.getContractFactory("MockRevertingERC20");
      const bad = await Reverting.deploy();

      await ctx.manager.connect(ctx.admin).setTokenAllowed(await bad.getAddress(), true);
      await bad.mint(ctx.user.address, ethers.parseEther("100"));
      await bad.connect(ctx.user).approve(await ctx.manager.getAddress(), ethers.parseEther("100"));
      await bad.setTransferShouldRevert(true);

      await expect(
        createOrder(ctx, {
          amount: ethers.parseEther("100"),
          token: bad,
          orderType: OrderType.OffRamp,
        })
      ).to.be.revertedWith("MockRevertingERC20: transfer reverted");
    });

    it("reverts creation when the user has not approved enough", async function () {
      const ctx = await loadFixture(fixture);
      await approve(ctx, ctx.user, usdc(10));

      await expect(
        createOrder(ctx, { amount: usdc(1000), orderType: OrderType.OffRamp })
      ).to.be.revertedWithCustomError(ctx.token, "ERC20InsufficientAllowance");
    });

    it("reverts creation when the user cannot cover the amount", async function () {
      const ctx = await loadFixture(fixture);
      await approve(ctx, ctx.user, usdc(999_999));

      await expect(
        createOrder(ctx, { amount: usdc(99_999), orderType: OrderType.OffRamp })
      ).to.be.revertedWithCustomError(ctx.token, "ERC20InsufficientBalance");
    });
  });

  describe("fees", function () {
    const FEE_BPS = 1_000; // 1% of MAX_BPS (100_000)
    const feeFixture = () => deployStack({ feeBps: FEE_BPS });

    it("splits an off-ramp settlement between treasury and fee recipient", async function () {
      const ctx = await loadFixture(feeFixture);
      const amount = usdc(1000);
      await approve(ctx, ctx.user, amount);
      const { orderId } = await createOrder(ctx, { amount, orderType: OrderType.OffRamp });

      const fee = (amount * BigInt(FEE_BPS)) / MAX_BPS;
      await ctx.manager.connect(ctx.aggregator).settleOrder(orderId);

      expect(await ctx.token.balanceOf(ctx.treasury.address)).to.equal(amount - fee);
      expect(await ctx.token.balanceOf(ctx.feeRecipient.address)).to.equal(fee);
    });

    it("pays an on-ramp user net of fees", async function () {
      const ctx = await loadFixture(feeFixture);
      const tokenAddress = await ctx.token.getAddress();
      await ctx.token.mint(ctx.admin.address, usdc(20_000));
      await ctx.token.connect(ctx.admin).approve(await ctx.manager.getAddress(), usdc(20_000));
      await ctx.manager.connect(ctx.admin).depositLiquidity(tokenAddress, usdc(20_000));

      const amount = usdc(1000);
      const fee = (amount * BigInt(FEE_BPS)) / MAX_BPS;
      const before = await ctx.token.balanceOf(ctx.user.address);

      const { orderId } = await createOrder(ctx, { amount, orderType: OrderType.OnRamp });
      await ctx.manager.connect(ctx.aggregator).settleOrder(orderId);

      expect(await ctx.token.balanceOf(ctx.user.address)).to.equal(before + amount - fee);
      expect(await ctx.token.balanceOf(ctx.feeRecipient.address)).to.equal(fee);
    });

    it("snapshots the fee at creation so later changes do not repriced pending orders", async function () {
      const ctx = await loadFixture(feeFixture);
      const amount = usdc(1000);
      await approve(ctx, ctx.user, amount);
      const { orderId } = await createOrder(ctx, { amount, orderType: OrderType.OffRamp });

      // Governance raises the fee to the cap after the user committed.
      await ctx.manager.connect(ctx.admin).setFeeBps(5_000);
      await ctx.manager.connect(ctx.aggregator).settleOrder(orderId);

      const quotedFee = (amount * BigInt(FEE_BPS)) / MAX_BPS;
      expect(await ctx.token.balanceOf(ctx.feeRecipient.address)).to.equal(quotedFee);
      expect(await ctx.token.balanceOf(ctx.treasury.address)).to.equal(amount - quotedFee);
    });

    it("refunds the gross amount regardless of the quoted fee", async function () {
      const ctx = await loadFixture(feeFixture);
      const amount = usdc(1000);
      await approve(ctx, ctx.user, amount);
      const { orderId } = await createOrder(ctx, { amount, orderType: OrderType.OffRamp });

      await ctx.manager.connect(ctx.aggregator).refundOrder(orderId);

      expect(await ctx.token.balanceOf(ctx.user.address)).to.equal(usdc(10_000));
      expect(await ctx.token.balanceOf(ctx.feeRecipient.address)).to.equal(0);
    });

    it("caps the fee at MAX_FEE_BPS", async function () {
      const ctx = await loadFixture(fixture);
      await expect(ctx.manager.connect(ctx.admin).setFeeBps(5_001))
        .to.be.revertedWithCustomError(ctx.manager, "FeeTooHigh")
        .withArgs(5_001, 5_000);

      await expect(ctx.manager.connect(ctx.admin).setFeeBps(5_000)).to.not.be.reverted;
    });

    it("bounds the order TTL", async function () {
      const ctx = await loadFixture(fixture);
      await expect(
        ctx.manager.connect(ctx.admin).setOrderTtl(60)
      ).to.be.revertedWithCustomError(ctx.manager, "InvalidExpiry");
      await expect(
        ctx.manager.connect(ctx.admin).setOrderTtl(31 * 24 * 3600)
      ).to.be.revertedWithCustomError(ctx.manager, "InvalidExpiry");
      await expect(ctx.manager.connect(ctx.admin).setOrderTtl(2 * 3600)).to.not.be.reverted;
    });

    it("rejects zero addresses for treasury and fee recipient", async function () {
      const ctx = await loadFixture(fixture);
      await expect(
        ctx.manager.connect(ctx.admin).setTreasury(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(ctx.manager, "ZeroAddress");
      await expect(
        ctx.manager.connect(ctx.admin).setFeeRecipient(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(ctx.manager, "ZeroAddress");
    });

    it("routes settlement to an updated treasury", async function () {
      const ctx = await loadFixture(fixture);
      const amount = usdc(100);
      await approve(ctx, ctx.user, amount);
      const { orderId } = await createOrder(ctx, { amount, orderType: OrderType.OffRamp });

      await ctx.manager.connect(ctx.admin).setTreasury(ctx.otherUser.address);
      await ctx.manager.connect(ctx.aggregator).settleOrder(orderId);

      expect(await ctx.token.balanceOf(ctx.otherUser.address)).to.equal(usdc(10_000) + amount);
      expect(await ctx.token.balanceOf(ctx.treasury.address)).to.equal(0);
    });
  });

  describe("liquidity safety", function () {
    it("never lets a withdrawal reach user escrow", async function () {
      const ctx = await loadFixture(fixture);
      const tokenAddress = await ctx.token.getAddress();
      const escrowAmount = usdc(1000);

      await approve(ctx, ctx.user, escrowAmount);
      await createOrder(ctx, { amount: escrowAmount, orderType: OrderType.OffRamp });

      // The contract holds 1000, all of it user money.
      await expect(
        ctx.manager.connect(ctx.admin).withdrawLiquidity(tokenAddress, ctx.admin.address, 1)
      ).to.be.revertedWithCustomError(ctx.manager, "InsufficientLiquidity");
    });

    it("never lets a rescue reach user escrow or committed float", async function () {
      const ctx = await loadFixture(fixture);
      const tokenAddress = await ctx.token.getAddress();

      await approve(ctx, ctx.user, usdc(1000));
      await createOrder(ctx, { amount: usdc(1000), orderType: OrderType.OffRamp });
      // Someone also sends 200 by mistake.
      await ctx.token.mint(await ctx.manager.getAddress(), usdc(200));

      expect(await ctx.manager.availableLiquidity(tokenAddress)).to.equal(usdc(200));

      await expect(
        ctx.manager.connect(ctx.admin).rescueTokens(tokenAddress, ctx.admin.address, usdc(201))
      ).to.be.revertedWithCustomError(ctx.manager, "InsufficientLiquidity");

      await expect(ctx.manager.connect(ctx.admin).rescueTokens(tokenAddress, ctx.admin.address, usdc(200)))
        .to.emit(ctx.manager, "StuckTokensRescued")
        .withArgs(tokenAddress, ctx.admin.address, usdc(200));

      // Escrow survives the rescue untouched.
      expect(await ctx.token.balanceOf(await ctx.manager.getAddress())).to.equal(usdc(1000));
    });

    it("cannot withdraw float already committed to a pending on-ramp order", async function () {
      const ctx = await loadFixture(fixture);
      const tokenAddress = await ctx.token.getAddress();
      await ctx.token.mint(ctx.admin.address, usdc(5000));
      await ctx.token.connect(ctx.admin).approve(await ctx.manager.getAddress(), usdc(5000));
      await ctx.manager.connect(ctx.admin).depositLiquidity(tokenAddress, usdc(5000));

      await createOrder(ctx, { amount: usdc(4000), orderType: OrderType.OnRamp });

      await expect(
        ctx.manager.connect(ctx.admin).withdrawLiquidity(tokenAddress, ctx.admin.address, usdc(1001))
      ).to.be.revertedWithCustomError(ctx.manager, "InsufficientLiquidity");

      await expect(
        ctx.manager.connect(ctx.admin).withdrawLiquidity(tokenAddress, ctx.admin.address, usdc(1000))
      ).to.not.be.reverted;
    });

    it("maintains balance >= escrow + reservations across a mixed workload", async function () {
      const ctx = await loadFixture(fixture);
      const tokenAddress = await ctx.token.getAddress();
      const managerAddress = await ctx.manager.getAddress();

      await ctx.token.mint(ctx.admin.address, usdc(10_000));
      await ctx.token.connect(ctx.admin).approve(managerAddress, usdc(10_000));
      await ctx.manager.connect(ctx.admin).depositLiquidity(tokenAddress, usdc(10_000));

      await approve(ctx, ctx.user, usdc(5000));
      await approve(ctx, ctx.otherUser, usdc(5000));

      const invariant = async () => {
        const balance = await ctx.token.balanceOf(managerAddress);
        const committed =
          (await ctx.manager.escrowedBalance(tokenAddress)) +
          (await ctx.manager.reservedLiquidity(tokenAddress));
        expect(balance).to.be.gte(committed);
      };

      const off1 = await createOrder(ctx, { amount: usdc(2000), orderType: OrderType.OffRamp, messageHash: "o1" });
      await invariant();
      const on1 = await createOrder(ctx, { amount: usdc(3000), orderType: OrderType.OnRamp, messageHash: "o2" });
      await invariant();
      const off2 = await createOrder(ctx, {
        requester: ctx.otherUser,
        amount: usdc(1500),
        orderType: OrderType.OffRamp,
        messageHash: "o3",
      });
      await invariant();

      await ctx.manager.connect(ctx.aggregator).settleOrder(off1.orderId);
      await invariant();
      await ctx.manager.connect(ctx.aggregator).refundOrder(on1.orderId);
      await invariant();
      // A late settlement of the already-refunded order must be rejected, not absorbed.
      await expect(
        ctx.manager.connect(ctx.aggregator).settleOrder(on1.orderId)
      ).to.be.revertedWithCustomError(ctx.manager, "OrderNotPending");
      await invariant();
      await ctx.manager.connect(ctx.aggregator).refundOrder(off2.orderId);
      await invariant();

      // Everything terminal: only house float should remain committed-free.
      expect(await ctx.manager.escrowedBalance(tokenAddress)).to.equal(0);
      expect(await ctx.manager.reservedLiquidity(tokenAddress)).to.equal(0);
      expect(await ctx.manager.availableLiquidity(tokenAddress)).to.equal(usdc(10_000));
    });

    it("rejects deposits of non-allowlisted tokens", async function () {
      const ctx = await loadFixture(fixture);
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const rogue = await MockERC20.deploy("Rogue", "RGE", 18);
      await rogue.mint(ctx.admin.address, ethers.parseEther("1"));
      await rogue.connect(ctx.admin).approve(await ctx.manager.getAddress(), ethers.parseEther("1"));

      await expect(
        ctx.manager.connect(ctx.admin).depositLiquidity(await rogue.getAddress(), ethers.parseEther("1"))
      ).to.be.revertedWithCustomError(ctx.manager, "TokenNotAllowed");
    });

    it("does not accept native ETH", async function () {
      const ctx = await loadFixture(fixture);
      // v1 marked settleOrder payable with no withdrawal path, so any ETH sent was lost.
      await expect(
        ctx.user.sendTransaction({ to: await ctx.manager.getAddress(), value: ethers.parseEther("1") })
      ).to.be.reverted;
    });
  });
});

/** Reads the ERC-1967 implementation slot of a proxy. */
async function upgradesErc1967ImplAddress(proxy) {
  const slot = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
  const raw = await ethers.provider.getStorage(await proxy.getAddress(), slot);
  return ethers.getAddress("0x" + raw.slice(-40));
}
