# Incident response — minimize blast radius

ElementFlow deployments are **independent per chain**. An incident on Base must not automatically pause Scroll, Lisk, or others.

## Principles

1. Act on the **affected `chainId` only** unless evidence shows a shared key/process compromise.
2. Prefer pause / route-disable over rushed upgrades.
3. Preserve user escrow liveness where possible (note: manager pause also blocks `refundExpiredOrder`).
4. Rotate hot keys **per chain backend env**.

## Playbook

### 1. Detect and scope
- Which chainId / proxy?
- User escrow at risk vs house float vs settlement key only?
- Shared aggregator EOA across chains? If yes, treat as multi-chain until proven otherwise.

### 2. Contain (affected chain)
1. `OrderManager.pause()` via `PAUSER_ROLE` on that chain.
2. Optionally `TreasuryPool.pause()` on that chain.
3. Optionally `ProviderRegistry.disableProvider(providerId)` for a bad adapter route (refunds still resolve disabled adapters).
4. Leave other chains running if unaffected.

### 3. Credentials
- Rotate aggregator / order-creator hot keys in the **backend env for that chain**.
- If admin/upgrader key suspected: multisig `revokeRole` / `renounceRole` on that chain’s contracts; do not assume other chains share the same role holders without checking `config/chains`.

### 4. Investigate
- On-chain: paused flag, implementation slot (ERC1967), allowlists, `defaultProviderId`, recent upgrades.
- Off-chain: listener topics (v2 settle/refund ABI), aggregator revert decoding, liquidity preflight.

### 5. Patch (if required)
1. Fix + tests in ElementFlow repo.
2. Storage-layout validate.
3. Deploy new implementation **to the incident chain only**.
4. Verify explorer + `scripts/post-deploy-check.js --network <that-network>`.
5. Multisig upgrade that chain.
6. Confirm pause policy: if you need expiry refunds during residual risk, unpause only after controls restored — or accept halt until safe.

### 6. Resume
- Unpause (`DEFAULT_ADMIN_ROLE`) on the incident chain after validation.
- Re-enable providers deliberately.
- Monitor create/settle/refund events on that chain before touching others.

## Role cheat sheet

| Role | Containment use |
|------|-----------------|
| `PAUSER_ROLE` | Halt manager/pool quickly |
| `PROVIDER_GUARDIAN_ROLE` | Disable a settlement route |
| `DEFAULT_ADMIN_ROLE` | Unpause, role surgery, allowlist |
| `UPGRADER_ROLE` | Implementation upgrade (multisig) |
| `TREASURER_ROLE` | Withdraw unreserved float only |

## Cross-chain warning

Finishing remediation on one chain **never** authorizes upgrading another. Repeat the checklist per `chainId`.
