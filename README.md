# ElementFlow

Upgradeable escrow and settlement contracts for fiat on-ramp and off-ramp orders.

> **Full audit and architecture review:** [`docs/ElementFlow-Security-Architecture.ipynb`](docs/ElementFlow-Security-Architecture.ipynb)  
> **Pre-deploy QA & security report (2026-09-14):** [`docs/SECURITY_AUDIT_REPORT.md`](docs/SECURITY_AUDIT_REPORT.md) — **Go-with-conditions** for Base

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
npm test          # 123 tests
```

## Deployment

```bash
cp .env.example .env
# Fill DISTINCT role addresses — ADMIN/TREASURY/FEE should be Safe multisigs on live.
# Set ETHERSCAN_API_KEY (Etherscan API v2 — one key for Base + Base Sepolia).
npm run deploy -- --network base-sepolia
# deploy.js verifies proxies+impls automatically. Re-run anytime with:
DEPLOYMENT_FILE=deployments/84532.base-sepolia.latest.json \
  npm run verify:deployment -- --network base-sepolia
npm run postdeploy:check -- --network base-sepolia
```

Upgrading a live v1 proxy (compute the escrow seed first — see the script header, it is the
one input that can cause fund loss if wrong):

```bash
PROXY_ADDRESS=0x... FROM_BLOCK=<deploy block> npm run scan:legacy -- --network base
PROXY_ADDRESS=0x... LEGACY_ESCROW=0xToken:amount npm run upgrade:v2 -- --network base
# Then verify the new implementation / proxy link on the explorer.
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

Contract properties:

- UUPS upgrades, authorised by a role held apart from settlement
- Role-based access control with owner/admin/aggregator/treasurer separation
- Pausable, with asymmetric pause/unpause authority
- `ReentrancyGuard` on every OrderManager state-changing entry point, strict CEI
- `SafeERC20` throughout — USDT-style no-return tokens work; fee-on-transfer tokens are
  rejected at creation rather than silently breaking accounting
- User escrow and house float are segregated (`escrowedBalance` vs `reservedLiquidity`)
- Permissionless refund after order TTL (when **not** paused)

Pre-deploy report: [`docs/SECURITY_AUDIT_REPORT.md`](docs/SECURITY_AUDIT_REPORT.md).  
Known accepted trade-offs: notebook §3 + report residual risks.

### Operational best practices (mainnet)

1. **Multisig for governance** — Put `DEFAULT_ADMIN_ROLE` / `UPGRADER_ROLE` / `PAUSER_ROLE` /
   `TREASURER_ROLE` on a Safe (ideally behind a Timelock). Put **treasury** and **fee recipient**
   on Safes or custody wallets. Never leave live roles as the deployer EOA.
2. **Hot keys only for create/settle** — `ORDER_CREATOR_ROLE` and `AGGREGATOR_ROLE` may share a
   backend key or be split; they must **not** hold upgrader/admin. Scope keys **per chain**.
3. **No deployer fallback on live** — `config/chains` `requireDistinctRoles` / status=`live`
   hard-fails missing role env vars. Do not override that for Base.
4. **Upgrade seeding** — Run `scan-legacy-orders.js` (fail-closed). Dual-review `LEGACY_ESCROW`
   before `upgrade-v1-to-v2`. Undercount turns pending user escrow into spendable float.
5. **Liquidity** — Default on-ramp float lives on **TreasuryPool** (`fund`), not “whatever is
   sitting on OrderManager.” Never treat raw `balanceOf(OM)` as free liquidity.
6. **Dual allowlists** — Allowlist tokens on OrderManager **and** TreasuryPool (post-deploy check).
7. **Pause vs user liveness** — Manager pause also blocks `refundExpiredOrder`. Prefer
   `disableProvider` / pool pause when you need to halt routes without freezing self-refunds.
   See [`docs/INCIDENT_RESPONSE.md`](docs/INCIDENT_RESPONSE.md).
8. **Verify every deploy** — `ETHERSCAN_API_KEY` (API v2 single string) +
   `npm run verify:deployment`. Confirm Read/Write as Proxy on the explorer.
9. **Adapters** — Only register audited `IOnRampProvider` implementations; a reverting
   `onOrderRefunded` can brick refunds for that route.
10. **Backend cutover** — Custom errors, `OrderAlreadyExists` idempotency, v2 settle/refund
    event ABI, pool `availableLiquidity` preflight:
    [`docs/AGGREGATOR_LISTENER_HANDOFF.md`](docs/AGGREGATOR_LISTENER_HANDOFF.md).

Recommended before large TVL: external audit, fuzz/invariants, Slither gating in CI.

## Testing

```bash
npm test                # full suite (123)
npm run test:gas        # with gas reporting
npm run coverage
```

| Suite | Tests |
|-------|-------|
| `OrderLifecycle.test.js` | Happy paths, idempotency, state transitions, expiry, ABI compatibility |
| `Security.test.js` | Access control, pause, reentrancy, hostile tokens, fees, liquidity safety |
| `ProviderFlows.test.js` | Registry, provider settlement, adversarial adapters, `TreasuryPool` |
| `Upgrades.test.js` | v1 exploit reproduction, in-place upgrade, layout validation |
| `Multichain.test.js` | chainId-bound order ids + `config/chains` loader guards |

## Multichain

- Chain configs: [`config/chains/`](config/chains/)
- Ops guide: [`docs/MULTICHAIN.md`](docs/MULTICHAIN.md)
- Incident response: [`docs/INCIDENT_RESPONSE.md`](docs/INCIDENT_RESPONSE.md)
- New chain checklist: [`docs/ADD_CHAIN_CHECKLIST.md`](docs/ADD_CHAIN_CHECKLIST.md)
- Security audit (pre-deploy): [`docs/SECURITY_AUDIT_REPORT.md`](docs/SECURITY_AUDIT_REPORT.md)

## License

BSL-1.1

## Backend cutover

Aggregator + listener handoff (events, errors, liquidity): [`docs/AGGREGATOR_LISTENER_HANDOFF.md`](docs/AGGREGATOR_LISTENER_HANDOFF.md)
