const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

const {
  OrderType,
  OrderStatus,
  LegacyStatus,
  deployStack,
  createOrder,
  approve,
  intentKeyFor,
  usdc,
} = require("./helpers");

describe("ElementFlowOrderManager — order lifecycle", function () {
  const fixture = () => deployStack();

  describe("off-ramp: happy path", function () {
    it("escrows the user's tokens and records a pending order", async function () {
      const ctx = await loadFixture(fixture);
      const amount = usdc(1000);
      await approve(ctx, ctx.user, amount);

      const { orderId } = await createOrder(ctx, { amount, orderType: OrderType.OffRamp });

      const order = await ctx.manager.getOrderRecord(orderId);
      expect(order.status).to.equal(OrderStatus.Pending);
      expect(order.requester).to.equal(ctx.user.address);
      expect(order.amount).to.equal(amount);
      expect(order.orderType).to.equal(OrderType.OffRamp);

      expect(await ctx.token.balanceOf(await ctx.manager.getAddress())).to.equal(amount);
      expect(await ctx.manager.escrowedBalance(await ctx.token.getAddress())).to.equal(amount);
      expect(await ctx.token.balanceOf(ctx.user.address)).to.equal(usdc(9000));
    });

    it("emits OrderCreated with the v1-compatible signature", async function () {
      const ctx = await loadFixture(fixture);
      const amount = usdc(500);
      await approve(ctx, ctx.user, amount);

      const { tx, orderId } = await createOrder(ctx, {
        amount,
        orderType: OrderType.OffRamp,
        messageHash: "encrypted-payload",
      });

      await expect(tx)
        .to.emit(ctx.manager, "OrderCreated")
        .withArgs(
          orderId,
          await ctx.token.getAddress(),
          ctx.user.address,
          amount,
          "encrypted-payload",
          0,
          OrderType.OffRamp
        );
    });

    it("settles principal to the treasury and clears the escrow", async function () {
      const ctx = await loadFixture(fixture);
      const amount = usdc(1000);
      await approve(ctx, ctx.user, amount);
      const { orderId } = await createOrder(ctx, { amount, orderType: OrderType.OffRamp });

      await expect(ctx.manager.connect(ctx.aggregator).settleOrder(orderId))
        .to.emit(ctx.manager, "OrderSettled")
        .withArgs(orderId, await ctx.token.getAddress(), ctx.user.address, amount, 0, ethers.ZeroHash);

      expect(await ctx.token.balanceOf(ctx.treasury.address)).to.equal(amount);
      expect(await ctx.manager.escrowedBalance(await ctx.token.getAddress())).to.equal(0);
      expect((await ctx.manager.getOrderRecord(orderId)).status).to.equal(OrderStatus.Settled);
    });

    it("refunds the full amount back to the requester", async function () {
      const ctx = await loadFixture(fixture);
      const amount = usdc(1000);
      await approve(ctx, ctx.user, amount);
      const { orderId } = await createOrder(ctx, { amount, orderType: OrderType.OffRamp });

      await expect(ctx.manager.connect(ctx.aggregator).refundOrder(orderId))
        .to.emit(ctx.manager, "OrderRefunded")
        .withArgs(orderId, await ctx.token.getAddress(), ctx.user.address, amount);

      expect(await ctx.token.balanceOf(ctx.user.address)).to.equal(usdc(10_000));
      expect(await ctx.manager.escrowedBalance(await ctx.token.getAddress())).to.equal(0);
      expect((await ctx.manager.getOrderRecord(orderId)).status).to.equal(OrderStatus.Refunded);
    });

    it("lets a user create their own order without a relayer role", async function () {
      const ctx = await loadFixture(fixture);
      const amount = usdc(100);
      await approve(ctx, ctx.user, amount);

      const { orderId } = await createOrder(ctx, {
        signer: ctx.user,
        requester: ctx.user,
        amount,
        orderType: OrderType.OffRamp,
      });

      expect((await ctx.manager.getOrderRecord(orderId)).status).to.equal(OrderStatus.Pending);
    });
  });

  describe("on-ramp: happy path", function () {
    async function fundedFixture() {
      const ctx = await deployStack();
      // House float for internally-settled on-ramp orders.
      await ctx.token.mint(ctx.admin.address, usdc(20_000));
      await ctx.token.connect(ctx.admin).approve(await ctx.manager.getAddress(), usdc(20_000));
      await ctx.manager.connect(ctx.admin).depositLiquidity(await ctx.token.getAddress(), usdc(20_000));
      return ctx;
    }

    it("reserves liquidity at creation and pays the user at settlement", async function () {
      const ctx = await loadFixture(fundedFixture);
      const amount = usdc(1000);
      const tokenAddress = await ctx.token.getAddress();

      const { orderId } = await createOrder(ctx, { amount, orderType: OrderType.OnRamp });

      expect(await ctx.manager.reservedLiquidity(tokenAddress)).to.equal(amount);
      expect(await ctx.manager.availableLiquidity(tokenAddress)).to.equal(usdc(19_000));

      const before = await ctx.token.balanceOf(ctx.user.address);
      await ctx.manager.connect(ctx.aggregator).settleOrder(orderId);

      expect(await ctx.token.balanceOf(ctx.user.address)).to.equal(before + amount);
      expect(await ctx.manager.reservedLiquidity(tokenAddress)).to.equal(0);
    });

    it("releases the reservation on refund without moving tokens", async function () {
      const ctx = await loadFixture(fundedFixture);
      const amount = usdc(1000);
      const tokenAddress = await ctx.token.getAddress();
      const { orderId } = await createOrder(ctx, { amount, orderType: OrderType.OnRamp });

      const userBefore = await ctx.token.balanceOf(ctx.user.address);
      await ctx.manager.connect(ctx.aggregator).refundOrder(orderId);

      // The user paid fiat off-chain, so an on-ramp refund is purely an accounting release.
      expect(await ctx.token.balanceOf(ctx.user.address)).to.equal(userBefore);
      expect(await ctx.manager.reservedLiquidity(tokenAddress)).to.equal(0);
      expect(await ctx.manager.availableLiquidity(tokenAddress)).to.equal(usdc(20_000));
      expect((await ctx.manager.getOrderRecord(orderId)).status).to.equal(OrderStatus.Refunded);
    });

    it("rejects an on-ramp order that exceeds unreserved liquidity", async function () {
      const ctx = await loadFixture(fundedFixture);
      await expect(
        createOrder(ctx, { amount: usdc(25_000), orderType: OrderType.OnRamp })
      ).to.be.revertedWithCustomError(ctx.manager, "InsufficientLiquidity");
    });

    it("prevents concurrent on-ramp orders from oversubscribing the same float", async function () {
      const ctx = await loadFixture(fundedFixture);

      // Two orders of 15k against 20k of float: the second must be rejected, because the
      // first has already committed its share. v1 only compared each order against the
      // raw balance, so both would have been accepted and one would fail at settlement.
      await createOrder(ctx, { amount: usdc(15_000), orderType: OrderType.OnRamp, messageHash: "a" });

      await expect(
        createOrder(ctx, { amount: usdc(15_000), orderType: OrderType.OnRamp, messageHash: "b" })
      ).to.be.revertedWithCustomError(ctx.manager, "InsufficientLiquidity");
    });

    it("never treats off-ramp escrow as on-ramp liquidity", async function () {
      const ctx = await loadFixture(fixture); // no house float at all
      const tokenAddress = await ctx.token.getAddress();
      const escrowAmount = usdc(5000);

      await approve(ctx, ctx.user, escrowAmount);
      await createOrder(ctx, { amount: escrowAmount, orderType: OrderType.OffRamp, messageHash: "esc" });

      // The contract now holds 5000 USDC, but every unit of it belongs to a pending
      // off-ramp user. An on-ramp order must not be able to spend it.
      expect(await ctx.token.balanceOf(await ctx.manager.getAddress())).to.equal(escrowAmount);
      expect(await ctx.manager.availableLiquidity(tokenAddress)).to.equal(0);

      await expect(
        createOrder(ctx, { amount: usdc(100), orderType: OrderType.OnRamp, messageHash: "onramp" })
      ).to.be.revertedWithCustomError(ctx.manager, "InsufficientLiquidity");
    });
  });

  describe("order id derivation and idempotency", function () {
    it("derives ids deterministically from the intent, not the block timestamp", async function () {
      const ctx = await loadFixture(fixture);
      const amount = usdc(100);
      const tokenAddress = await ctx.token.getAddress();
      const key = intentKeyFor("stable-intent");

      const first = await ctx.manager.computeOrderId(
        ctx.user.address,
        amount,
        tokenAddress,
        OrderType.OffRamp,
        key
      );
      await time.increase(5000);
      const second = await ctx.manager.computeOrderId(
        ctx.user.address,
        amount,
        tokenAddress,
        OrderType.OffRamp,
        key
      );

      expect(first).to.equal(second);
    });

    it("rejects a replayed intent, giving on-chain idempotency", async function () {
      const ctx = await loadFixture(fixture);
      const amount = usdc(100);
      await approve(ctx, ctx.user, amount * 2n);

      await createOrder(ctx, { amount, orderType: OrderType.OffRamp, messageHash: "same-intent" });

      // A retried backend submission for the same intent must not create a second order.
      await expect(
        createOrder(ctx, { amount, orderType: OrderType.OffRamp, messageHash: "same-intent" })
      ).to.be.revertedWithCustomError(ctx.manager, "OrderAlreadyExists");
    });

    it("allows two genuinely distinct orders with identical parameters in one block", async function () {
      const ctx = await loadFixture(fixture);
      const amount = usdc(100);
      await approve(ctx, ctx.user, amount * 2n);

      // v1 hashed block.timestamp, so a user's two identical orders in the same block
      // collided and the second reverted. Distinct intent keys now separate them.
      const a = await createOrder(ctx, { amount, orderType: OrderType.OffRamp, messageHash: "intent-a" });
      const b = await createOrder(ctx, { amount, orderType: OrderType.OffRamp, messageHash: "intent-b" });

      expect(a.orderId).to.not.equal(b.orderId);
      expect((await ctx.manager.getOrderRecord(b.orderId)).status).to.equal(OrderStatus.Pending);
    });
  });

  describe("state transitions", function () {
    it("refuses to settle an already settled order", async function () {
      const ctx = await loadFixture(fixture);
      const amount = usdc(100);
      await approve(ctx, ctx.user, amount);
      const { orderId } = await createOrder(ctx, { amount, orderType: OrderType.OffRamp });

      await ctx.manager.connect(ctx.aggregator).settleOrder(orderId);
      await expect(ctx.manager.connect(ctx.aggregator).settleOrder(orderId))
        .to.be.revertedWithCustomError(ctx.manager, "OrderNotPending")
        .withArgs(orderId, OrderStatus.Settled);
    });

    it("refuses to refund an already settled order", async function () {
      const ctx = await loadFixture(fixture);
      const amount = usdc(100);
      await approve(ctx, ctx.user, amount);
      const { orderId } = await createOrder(ctx, { amount, orderType: OrderType.OffRamp });

      await ctx.manager.connect(ctx.aggregator).settleOrder(orderId);
      await expect(
        ctx.manager.connect(ctx.aggregator).refundOrder(orderId)
      ).to.be.revertedWithCustomError(ctx.manager, "OrderNotPending");
    });

    it("refuses to settle a refunded order", async function () {
      const ctx = await loadFixture(fixture);
      const amount = usdc(100);
      await approve(ctx, ctx.user, amount);
      const { orderId } = await createOrder(ctx, { amount, orderType: OrderType.OffRamp });

      await ctx.manager.connect(ctx.aggregator).refundOrder(orderId);
      await expect(
        ctx.manager.connect(ctx.aggregator).settleOrder(orderId)
      ).to.be.revertedWithCustomError(ctx.manager, "OrderNotPending");
    });

    it("reverts on an unknown order id", async function () {
      const ctx = await loadFixture(fixture);
      const unknown = ethers.keccak256(ethers.toUtf8Bytes("nope"));
      await expect(ctx.manager.connect(ctx.aggregator).settleOrder(unknown))
        .to.be.revertedWithCustomError(ctx.manager, "OrderNotFound")
        .withArgs(unknown);
    });
  });

  describe("expiry and permissionless refunds", function () {
    it("blocks an expiry refund before the TTL elapses", async function () {
      const ctx = await loadFixture(fixture);
      const amount = usdc(100);
      await approve(ctx, ctx.user, amount);
      const { orderId } = await createOrder(ctx, { amount, orderType: OrderType.OffRamp });

      await expect(
        ctx.manager.connect(ctx.outsider).refundExpiredOrder(orderId)
      ).to.be.revertedWithCustomError(ctx.manager, "OrderNotExpired");
    });

    it("lets anyone rescue an expired off-ramp escrow back to its owner", async function () {
      const ctx = await loadFixture(fixture);
      const amount = usdc(100);
      await approve(ctx, ctx.user, amount);
      const { orderId } = await createOrder(ctx, { amount, orderType: OrderType.OffRamp });

      await time.increase(3601);

      // Liveness guarantee: even a stalled or censoring aggregator cannot trap user funds.
      // Note the refund goes to the requester, not to whoever triggers it.
      const outsiderBefore = await ctx.token.balanceOf(ctx.outsider.address);
      await ctx.manager.connect(ctx.outsider).refundExpiredOrder(orderId);

      expect(await ctx.token.balanceOf(ctx.user.address)).to.equal(usdc(10_000));
      expect(await ctx.token.balanceOf(ctx.outsider.address)).to.equal(outsiderBefore);
      expect((await ctx.manager.getOrderRecord(orderId)).status).to.equal(OrderStatus.Refunded);
    });

    it("cannot expiry-refund an order that was already settled", async function () {
      const ctx = await loadFixture(fixture);
      const amount = usdc(100);
      await approve(ctx, ctx.user, amount);
      const { orderId } = await createOrder(ctx, { amount, orderType: OrderType.OffRamp });

      await ctx.manager.connect(ctx.aggregator).settleOrder(orderId);
      await time.increase(3601);

      await expect(
        ctx.manager.connect(ctx.outsider).refundExpiredOrder(orderId)
      ).to.be.revertedWithCustomError(ctx.manager, "OrderNotPending");
    });
  });

  describe("input validation", function () {
    it("rejects a zero amount", async function () {
      const ctx = await loadFixture(fixture);
      await expect(createOrder(ctx, { amount: 0n })).to.be.revertedWithCustomError(
        ctx.manager,
        "ZeroAmount"
      );
    });

    it("rejects a zero requester", async function () {
      const ctx = await loadFixture(fixture);
      await expect(
        ctx.manager
          .connect(ctx.aggregator)
          .createOrder(ethers.ZeroAddress, usdc(1), await ctx.token.getAddress(), OrderType.OffRamp, "m")
      ).to.be.revertedWithCustomError(ctx.manager, "ZeroAddress");
    });

    it("rejects an empty message hash", async function () {
      const ctx = await loadFixture(fixture);
      await expect(createOrder(ctx, { messageHash: "" })).to.be.revertedWithCustomError(
        ctx.manager,
        "EmptyMessageHash"
      );
    });

    it("rejects a token that is not allowlisted", async function () {
      const ctx = await loadFixture(fixture);
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const rogue = await MockERC20.deploy("Rogue", "RGE", 18);

      await expect(createOrder(ctx, { token: rogue })).to.be.revertedWithCustomError(
        ctx.manager,
        "TokenNotAllowed"
      );
    });

    it("still settles an order whose token was delisted after creation", async function () {
      const ctx = await loadFixture(fixture);
      const amount = usdc(100);
      await approve(ctx, ctx.user, amount);
      const { orderId } = await createOrder(ctx, { amount, orderType: OrderType.OffRamp });

      // Delisting must not strand funds already in escrow.
      await ctx.manager.connect(ctx.admin).setTokenAllowed(await ctx.token.getAddress(), false);

      await ctx.manager.connect(ctx.aggregator).settleOrder(orderId);
      expect(await ctx.token.balanceOf(ctx.treasury.address)).to.equal(amount);
    });
  });

  describe("backend compatibility", function () {
    it("getOrder returns the v1 flat tuple with v1 status numbering", async function () {
      const ctx = await loadFixture(fixture);
      const amount = usdc(250);
      await approve(ctx, ctx.user, amount);
      const { orderId } = await createOrder(ctx, {
        amount,
        orderType: OrderType.OffRamp,
        messageHash: "payload-x",
      });

      const view = await ctx.manager.getOrder(orderId);
      expect(view[0]).to.equal(orderId);
      expect(view[1]).to.equal(ctx.user.address);
      expect(view[3]).to.equal(await ctx.token.getAddress());
      expect(view[4]).to.equal(amount);
      // The backend reads index 5 as 0=Pending / 1=Settled / 2=Refunded.
      expect(view[5]).to.equal(LegacyStatus.Pending);
      expect(view[6]).to.equal(OrderType.OffRamp);
      expect(view[7]).to.equal("payload-x");

      await ctx.manager.connect(ctx.aggregator).settleOrder(orderId);
      expect((await ctx.manager.getOrder(orderId))[5]).to.equal(LegacyStatus.Settled);

      const refundCtx = await loadFixture(fixture);
      await approve(refundCtx, refundCtx.user, amount);
      const { orderId: refundId } = await createOrder(refundCtx, {
        amount,
        orderType: OrderType.OffRamp,
      });
      await refundCtx.manager.connect(refundCtx.aggregator).refundOrder(refundId);
      expect((await refundCtx.manager.getOrder(refundId))[5]).to.equal(LegacyStatus.Refunded);
    });

    it("keeps checkAllowance, used by the backend pre-flight", async function () {
      const ctx = await loadFixture(fixture);
      await approve(ctx, ctx.user, usdc(777));
      expect(
        await ctx.manager.checkAllowance(await ctx.token.getAddress(), ctx.user.address)
      ).to.equal(usdc(777));
    });

    it("reverts getOrder for an unknown id, as v1 did", async function () {
      const ctx = await loadFixture(fixture);
      await expect(
        ctx.manager.getOrder(ethers.keccak256(ethers.toUtf8Bytes("missing")))
      ).to.be.revertedWithCustomError(ctx.manager, "OrderNotFound");
    });

    it("reports version 2.0.0", async function () {
      const ctx = await loadFixture(fixture);
      expect(await ctx.manager.getVersion()).to.equal("2.0.0");
    });
  });
});
