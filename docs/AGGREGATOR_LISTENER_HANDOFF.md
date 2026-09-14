# Handoff: Aggregator + Listener cutover to ElementFlow v2

Copy-paste this into a ticket / Cursor prompt for the **aggregator** (`element-pay-aggregator`) and **listener** ([element-pay-listener](https://github.com/elementpayHQ/element-pay-listener)) teams.

ElementFlow v2 (`ElementFlowOrderManager` + `ProviderRegistry` + `TreasuryPool`) is designed for an **in-place UUPS upgrade** of the live OrderManager proxy. The proxy address does not change. Backend call shapes for create/settle/refund/`getOrder` stay compatible, but **events, reverts, liquidity, and roles** change.

---

## Prompt for engineers (start here)

```text
You are updating element-pay-aggregator and elementpayHQ/element-pay-listener for ElementFlow v2.

Context
- Contracts repo: elementpayHQ/ElementFlow (branch with ElementFlowOrderManager v2).
- In-place upgrade keeps the SAME OrderManager proxy address per chain.
- CONTRACT_ADDRESS_* / CONTRACT_ADDRESS still point at the OrderManager proxy (NOT TreasuryPool, NOT ProviderRegistry).
- v2 default on-ramp liquidity lives on TreasuryPool (IOnRampProvider), registered via ProviderRegistry and set as defaultProviderId. Ops funds the pool with pool.fund(), not depositLiquidity on the manager (unless using internal providerId=0).

Do NOT change:
- createOrder(requester, amount, token, orderType, messageHash) argument order for the default path.
- settleOrder(orderId) / refundOrder(orderId) call sites for happy path.
- getOrder flat 8-tuple positional decode OR status numbering 0=Pending, 1=Settled, 2=Refunded (v2 remaps for backend compatibility).
- OrderCreated indexed fields orderId/token/requester (same as v1).
- Off-ramp ERC20 approve spender = OrderManager proxy.

MUST change — Aggregator (element-pay-aggregator)
1) Custom errors: stop matching revert strings like "Order is not pending" / "Order not found".
   Decode Solidity custom errors (Error(string) is rare now). Map at least:
   - OrderNotPending(bytes32,uint8)
   - OrderNotFound(bytes32)
   - OrderAlreadyExists(bytes32)
   - NotOrderCreator(address,address)
   - InsufficientLiquidity(address,uint256,uint256)
   - TokenNotAllowed(address)
   - ProviderSettlementShortfall(uint256,uint256)
   Update race/idempotency paths in transaction_controller.py and psp_integration.py.

2) OrderAlreadyExists: treat as SUCCESS-idempotent on create (order already recorded). Do not fail the fiat/off-ramp flow as a hard error. This is the on-chain fix for double-payment / replay.

3) On-ramp liquidity preflight: STOP using ERC20.balanceOf(OrderManager).
   With default TreasuryPool routing, float sits on TreasuryPool.
   Use availableLiquidity(token) on TreasuryPool (preferred) and/or OrderManager.availableLiquidity for internal route.
   Add env for TREASURY_POOL_ADDRESS_* per chain (or read from a deployments JSON).

4) Roles (ops + config):
   - Creation hot key must have ORDER_CREATOR_ROLE (or tx must be sent as requester).
   - Settlement/refund hot keys must have AGGREGATOR_ROLE.
   If CREATION_PRIVATE_KEY != SETTLEMENT_PRIVATE_KEY, grant both roles correctly after deploy/upgrade.

5) Token allowlist: tokens must be setTokenAllowed(true) on OrderManager (and setTokenSupported on TreasuryPool for pool route) or create reverts TokenNotAllowed / TokenNotSupported.

6) Fees: if feeBps > 0, settle pays net to user and fee to feeRecipient. Align fiat accounting with net vs gross.

7) Optional later: createOrderWithProvider(...) when routing non-default on-chain adapters (partner IOnRampProvider). Off-chain PSP "provider" strings are NOT the same as bytes32 providerId.

MUST change — Listener (element-pay-listener)
Current abi.json still has v1 OrderSettled/OrderRefunded with ONLY indexed orderId. That WILL MISS v2 logs because the event signature (topic0) changed.

Replace abi event fragments with v2:

event OrderCreated(
  bytes32 indexed orderId,
  address indexed token,
  address indexed requester,
  uint256 amount,
  string messageHash,
  uint256 rate,
  uint8 orderType
);

event OrderSettled(
  bytes32 indexed orderId,
  address indexed token,
  address indexed requester,
  uint256 netAmount,
  uint256 feeAmount,
  bytes32 providerId
);

event OrderRefunded(
  bytes32 indexed orderId,
  address indexed token,
  address indexed requester,
  uint256 amount
);

Update webhook payloads if the aggregator expects only orderId today — prefer forwarding the new fields (token, requester, netAmount, feeAmount, providerId, amount) while keeping orderId + transactionHash for backward compatibility.

Recompute topic0 hashes after ABI update; backfill windows must use the new topics (old v1 settle/refund topics will not appear after upgrade).

CONTRACT_ADDRESS remains the OrderManager proxy. Do not listen to TreasuryPool for order lifecycle events.

Test plan
- After Base Sepolia v2 deploy/upgrade: create off-ramp + on-ramp, settle both, refund one path; confirm listener delivers OrderCreated / OrderSettled / OrderRefunded webhooks.
- Force duplicate create → OrderAlreadyExists handled as idempotent success in aggregator.
- On-ramp with empty OM balance but funded TreasuryPool → preflight passes and settle pays user.
- Delisted token → clear TokenNotAllowed error mapping.

Deliverables
- Aggregator PR + Listener PR (abi.json + any payload mapping).
- Short README note: point CONTRACT_ADDRESS at OrderManager; add TREASURY_POOL_ADDRESS for liquidity checks.
```

---

## Event ABI cheat sheet (v2)

| Event | v1 | v2 |
|-------|----|----|
| `OrderCreated` | orderId, token, requester, amount, messageHash, rate, orderType | **Same shape** (compatible) |
| `OrderSettled` | `orderId` only | + `token`, `requester`, `netAmount`, `feeAmount`, `providerId` |
| `OrderRefunded` | `orderId` only | + `token`, `requester`, `amount` |

Listener `abi.json` today matches **v1** settle/refund — **must update**.

---

## Flow reminders (for backend)

### Off-ramp
1. User approves OrderManager.
2. Aggregator `createOrder` (OffRamp) → user tokens escrowed on OrderManager.
3. Fiat paid off-chain.
4. Aggregator `settleOrder` → principal to treasury address (or provider adapter) + fee to feeRecipient.
5. Or `refundOrder` (aggregator) / `refundExpiredOrder` (anyone after TTL) → tokens back to user.

### On-ramp (default TreasuryPool)
1. Ops funds **TreasuryPool** (`fund`).
2. Aggregator `createOrder` (OnRamp) → no user pull; pool reserves float.
3. User pays fiat off-chain.
4. Aggregator `settleOrder` → pool pushes tokens to user; manager verifies balance delta.
5. Refund only releases reservation (nothing to return on-chain to user).

---

## Ephemeral Base Sepolia lab (deployed 2026-09-14)

| Field | Value |
|-------|-------|
| Chain | Base Sepolia (`84532`) |
| Deployer (ephemeral) | `0xB89fCa8025Ee60C91f74c49aDb4a0a55f5BeB166` |
| OrderManager proxy | `0x5cB2B2b5f8E373bb9c44Cbc190FF103d2bd11716` |
| OrderManager impl | `0xe74781Ee78239596c1c75a58eFaD3a707F201095` |
| ProviderRegistry proxy | `0x53757B0575A6B04aA667834917c04207066CF854` |
| TreasuryPool proxy | `0xE909CF48Fe7a288b844992aAB073CA760d03d0B2` |
| Allowlisted token (Circle USDC) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| Smoke mock token (full settle/refund) | `0x4A5Dd65292233C6AA037480e31CdB3483c138aB5` |
| Artifact | [`deployments/84532.base-sepolia.latest.json`](../deployments/84532.base-sepolia.latest.json) |
| Explorers | [OM](https://sepolia.basescan.org/address/0x5cB2B2b5f8E373bb9c44Cbc190FF103d2bd11716) · [Registry](https://sepolia.basescan.org/address/0x53757B0575A6B04aA667834917c04207066CF854) · [Pool](https://sepolia.basescan.org/address/0xE909CF48Fe7a288b844992aAB073CA760d03d0B2) |

Smoke: wiring check + full on-ramp settle / off-ramp refund / off-ramp settle (`FULL_SMOKE_OK`). Version `2.0.0`, default TreasuryPool provider active.

Private keys for the ephemeral lab wallet are **not** committed. Production deploy should use your multisig / hot keys and overwrite these addresses in env.
