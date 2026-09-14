const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deployStack, OrderType, intentKeyFor, usdc } = require("./helpers");

describe("Multichain order id scoping", function () {
  async function fixture() {
    return deployStack();
  }

  it("binds computeOrderId to chainId and contract address", async function () {
    const ctx = await loadFixture(fixture);
    const token = await ctx.token.getAddress();
    const amount = usdc(100);
    const key = intentKeyFor("multichain-id");
    const chainId = (await ethers.provider.getNetwork()).chainId;

    const onChain = await ctx.manager.computeOrderId(
      ctx.user.address,
      amount,
      token,
      OrderType.OffRamp,
      key
    );

    const expected = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint256", "address", "address", "uint256", "address", "uint8", "bytes32"],
        [chainId, await ctx.manager.getAddress(), ctx.user.address, amount, token, OrderType.OffRamp, key]
      )
    );
    expect(onChain).to.equal(expected);

    // A different chainId yields a different id (replay across chains cannot collide).
    const otherChain = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint256", "address", "address", "uint256", "address", "uint8", "bytes32"],
        [chainId + 1n, await ctx.manager.getAddress(), ctx.user.address, amount, token, OrderType.OffRamp, key]
      )
    );
    expect(otherChain).to.not.equal(onChain);
  });

  it("two manager deployments produce different ids for the same intent", async function () {
    const ctx = await loadFixture(fixture);
    const other = await deployStack();
    const token = await ctx.token.getAddress();
    const amount = usdc(50);
    const key = intentKeyFor("same-intent");

    const a = await ctx.manager.computeOrderId(
      ctx.user.address,
      amount,
      token,
      OrderType.OnRamp,
      key
    );
    const b = await other.manager.computeOrderId(
      ctx.user.address,
      amount,
      await other.token.getAddress(),
      OrderType.OnRamp,
      key
    );
    // Different contract address and/or token address → different id
    expect(a).to.not.equal(b);
  });
});

describe("chainConfig loader", function () {
  const {
    getChainById,
    resolveAndAssertChain,
    resolveAllowlist,
    resolveProxyAddress,
  } = require("../scripts/lib/chainConfig");

  it("loads Base and Base Sepolia by chainId", function () {
    expect(getChainById(8453).hardhatNetwork).to.equal("base");
    expect(getChainById(84532).status).to.equal("testnet");
    expect(getChainById(534352).status).to.equal("planned");
  });

  it("asserts provider chainId against hardhat network", function () {
    const cfg = resolveAndAssertChain({
      networkName: "base",
      providerChainId: 8453n,
      allowPlanned: false,
    });
    expect(cfg.chainId).to.equal(8453);
    expect(() =>
      resolveAndAssertChain({ networkName: "base", providerChainId: 1n })
    ).to.throw(/Chain ID mismatch/);
  });

  it("refuses planned chains for deploy by default", function () {
    expect(() =>
      resolveAndAssertChain({
        networkName: "scroll",
        providerChainId: 534352n,
        allowPlanned: false,
      })
    ).to.throw(/planned/);
  });

  it("scopes ALLOWED_TOKENS to config token list", function () {
    const cfg = getChainById(8453);
    process.env.ALLOWED_TOKENS = cfg.tokens[0].address;
    expect(resolveAllowlist(cfg)).to.deep.equal([
      ethers.getAddress(cfg.tokens[0].address),
    ]);
    process.env.ALLOWED_TOKENS = "0x0000000000000000000000000000000000000001";
    expect(() => resolveAllowlist(cfg)).to.throw(/not in config/);
    delete process.env.ALLOWED_TOKENS;
  });

  it("requires PROXY_ADDRESS to match configured orderManagerProxy", function () {
    const cfg = getChainById(84532);
    delete process.env.PROXY_ADDRESS;
    delete process.env.ALLOW_PROXY_OVERRIDE;
    expect(resolveProxyAddress(cfg)).to.equal(
      ethers.getAddress(cfg.contracts.orderManagerProxy)
    );
    process.env.PROXY_ADDRESS = "0x0000000000000000000000000000000000000001";
    expect(() => resolveProxyAddress(cfg)).to.throw(/does not match/);
    process.env.ALLOW_PROXY_OVERRIDE = "1";
    expect(resolveProxyAddress(cfg)).to.equal(
      ethers.getAddress("0x0000000000000000000000000000000000000001")
    );
    delete process.env.PROXY_ADDRESS;
    delete process.env.ALLOW_PROXY_OVERRIDE;
  });
});
