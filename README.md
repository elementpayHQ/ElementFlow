# ElementFlow

Upgradeable escrow and settlement contracts for fiat on-ramp and off-ramp orders.

> **Full audit and architecture review:** [`docs/ElementFlow-Security-Architecture.ipynb`](docs/ElementFlow-Security-Architecture.ipynb)

## Status

`ElementFlowOrderManager` (v2) is a **storage-compatible successor** to the v1
`OrderManagement` contract currently live behind UUPS proxies on Base and Base Sepolia. It
is designed to be deployed by **upgrading the existing proxies in place** — the address does
not change and pending orders survive. See §6.2 of the notebook for the runbook.

The v1 implementation carries two vulnerabilities that are exploitable by any address:
permissionless `escrowFunds`/`releaseEscrow` can permanently freeze a user's escrow, and
`createOrder` has no access control. Both are closed in v2.

## Architecture

```
  ProviderRegistry (UUPS) ──── providerId ──▶ adapter
          │ resolves
          ▼
  ElementFlowOrderManager (UUPS)          escrowedBalance[token]  ← user funds
   escrow · settlement · fees · roles     reservedLiquidity[token] ← house float
          │ IOnRampProvider               invariant: balance ≥ escrowed + reserved
     ┌────┴─────┐
     ▼          ▼
 TreasuryPool   Partner adapter
 (in-house)     (Yellow Card-style)
```

| Contract | Role |
|----------|------|
| `ElementFlowOrderManager` | Order lifecycle, escrow, settlement, fees, access control |
| `ProviderRegistry` | Maps `providerId` → settlement adapter; enable/disable/swap routes |
| `TreasuryPool` | ElementFlow's own liquidity, implemented as the default `IOnRampProvider` |
| `IOnRampProvider` | Adapter interface — a partner is added, not built in |
| `legacy/OrderManagementV1.sol` | Retained solely so upgrade tests run against real v1 bytecode |

Settlement adapters are **never trusted to report success**: the manager verifies the
beneficiary's token balance delta across the call, so an adapter that underpays or
misdirects funds can only fail closed.

## Quick start

```bash
npm install
npm run compile
npm test          # 113 tests
```

## Deployment

```bash
cp .env.example .env    # fill in four DISTINCT role addresses; admin should be a multisig
npm run deploy -- --network base-sepolia
```

Upgrading a live v1 proxy (compute the escrow seed first — see the script header, it is the
one input that can cause fund loss if wrong):

```bash
PROXY_ADDRESS=0x... FROM_BLOCK=<deploy block> npm run scan:legacy -- --network base
PROXY_ADDRESS=0x... LEGACY_ESCROW=0xToken:amount npm run upgrade:v2 -- --network base
```

## Roles

| Role | Capability |
|------|-----------|
| `DEFAULT_ADMIN_ROLE` | Configuration, token allowlist, role management, unpause |
| `UPGRADER_ROLE` | Authorise implementation upgrades |
| `PAUSER_ROLE` | Emergency pause (unpause is admin-only, by design) |
| `AGGREGATOR_ROLE` | Settle and refund orders |
| `ORDER_CREATOR_ROLE` | Create orders on a user's behalf (backend relay) |
| `TREASURER_ROLE` | Deposit/withdraw float and rescue stray tokens, bounded so neither can reach user escrow |

The backend's hot settlement key holds only `AGGREGATOR_ROLE` and `ORDER_CREATOR_ROLE` — it
cannot upgrade, pause, or move liquidity.

## Backend integration

The v2 ABI preserves `createOrder`, `settleOrder`, `refundOrder`, `checkAllowance`, the
`OrderCreated` event signature, and the flat 8-tuple `getOrder` view **including v1's status
numbering** (`0=Pending, 1=Settled, 2=Refunded`). `getOrderRecord` returns the richer v2
struct for new code.

Two changes are required backend-side:

- v2 reverts with **typed custom errors** rather than strings; retry logic that matches on
  revert strings must be updated.
- `OrderAlreadyExists` means the intent was already recorded — treat it as
  **success-idempotent**, not failure. This is the contract-level fix for the BUG-01
  off-ramp double-payment class.

## Security

- UUPS upgrades, authorised by a role held apart from settlement
- Role-based access control with owner/admin/aggregator/treasurer separation
- Pausable, with asymmetric pause/unpause authority
- `ReentrancyGuard` on every state-changing entry point, strict checks-effects-interactions
- `SafeERC20` throughout — USDT-style no-return tokens work; fee-on-transfer tokens are
  rejected at creation rather than silently breaking accounting
- User escrow and house float are segregated and separately accounted
- Permissionless refund after order expiry, so a stalled aggregator cannot trap user funds

Known accepted trade-offs are documented in §3 of the notebook. Recommended before mainnet:
coverage, fuzz/invariant testing, Slither/Mythril in CI, and an external audit.

## Testing

```bash
npm test                # full suite
npm run test:gas        # with gas reporting
npm run coverage
```

| Suite | Tests |
|-------|-------|
| `OrderLifecycle.test.js` | 29 — happy paths, idempotency, state transitions, expiry, ABI compatibility |
| `Security.test.js` | 36 — access control, pause, reentrancy, hostile tokens, fees, liquidity safety |
| `ProviderFlows.test.js` | 26 — registry, provider settlement, adversarial adapters, `TreasuryPool` |
| `Upgrades.test.js` | 22 — v1 exploit reproduction, in-place upgrade, layout validation |

## License

BSL-1.1

## Backend cutover

Aggregator + listener handoff (events, errors, liquidity): [`docs/AGGREGATOR_LISTENER_HANDOFF.md`](docs/AGGREGATOR_LISTENER_HANDOFF.md)
