# Safe upgrade: OrderManager → v2.1.0 (create-time refundAddress)

**Proxy address does not change:** `0x4CDa31fc90a1663FA6dBD58CC736097E2344bb00` on each chain.

**Upgrader Safe:** `0x0764780a743CBF4CE114C072a8908fb37e5DC71F` (holds `UPGRADER_ROLE`)

Implementations were already deployed by `scripts/execute-upgrade-v21.js` (propose path). Import the batch and execute — do **not** redeploy a new proxy.

## Batches

| Chain | Safe Tx Builder JSON | New implementation |
|-------|----------------------|--------------------|
| Base | [`safe-batches/upgrade-om-v21-base.json`](../safe-batches/upgrade-om-v21-base.json) | `0xbE8d22Cfcae47FF065502C8688792317E0E46fe5` |
| BSC | [`safe-batches/upgrade-om-v21-bsc.json`](../safe-batches/upgrade-om-v21-bsc.json) | `0x41f006ff1376E45c5f1E94502d95Bb820f033D9b` |
| Polygon | [`safe-batches/upgrade-om-v21-polygon.json`](../safe-batches/upgrade-om-v21-polygon.json) | `0xb357B0fdF149CB7adcF94c2F28c2970093D50774` |
| Arbitrum | [`safe-batches/upgrade-om-v21-arbitrum.json`](../safe-batches/upgrade-om-v21-arbitrum.json) | `0x5A7d855aA5C981Db7DC79656B5Dc9CDC1605FE97` |
| Scroll | [`safe-batches/upgrade-om-v21-scroll.json`](../safe-batches/upgrade-om-v21-scroll.json) | `0x71B13319d9fE1CC7B1C4c9B89054C9A591e52790` |
| Base Sepolia | [`safe-batches/upgrade-om-v21-base-sepolia.json`](../safe-batches/upgrade-om-v21-base-sepolia.json) | (see JSON) |

## Execute (per chain)

1. Open Safe Transaction Builder for the Safe on that chain.
2. Import the matching `upgrade-om-v21-*.json`.
3. Review: `to` = OrderManager proxy; method = `upgradeToAndCall(newImplementation, 0x)`.
4. Sign (multisig) and execute.
5. Verify: `getVersion()` on the **same proxy** returns `2.1.0`.

## Notes

- Merge to `main` does **not** upgrade chains.
- Deployer EOA used for `prepareUpgrade` must **not** hold `UPGRADER_ROLE`.
- After upgrade, aggregator can use `createOrderWithRefund` for partner OffRamps (see aggregator dual-mode).
