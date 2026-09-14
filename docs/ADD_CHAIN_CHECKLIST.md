# Checklist — adding a new EVM chain

Do **not** mark a chain production-ready merely because contracts compile and deploy.

Gate: `config/chains/<chainId>.*.json` stays `"status": "planned"` until this list is signed off, then flip to `testnet` or `live`.

## Network

- [ ] Confirm official **chain ID**
- [ ] Document finality / reorg / sequencer assumptions
- [ ] Confirm native gas token symbol + decimals
- [ ] Choose RPC provider(s); set `rpcEnv` (no secrets in git)
- [ ] Configure block explorer `browserURL` + `apiURL`; set `explorerApiEnv`
- [ ] Uncomment Hardhat network in `hardhat.config.js` only when status ≥ testnet

## Tokens and integrations

- [ ] List supported stablecoins with **chain-specific** addresses
- [ ] Verify decimals and transfer quirks (USDT-style, fee-on-transfer — rejected by `_pullExact`)
- [ ] Oracle availability (N/A today; re-check if pricing is added)
- [ ] External protocol / partner adapter addresses (if any) — chain-specific only
- [ ] Relayer / aggregator hot keys scoped **per chain** env

## Contracts and authority

- [ ] Deploy implementation(s) to this chain only
- [ ] Deploy/configure UUPS proxies (OrderManager, ProviderRegistry, TreasuryPool)
- [ ] **Verify on explorer** (`npm run verify:deployment -- --network <name>`) — needs `ETHERSCAN_API_KEY`; confirm Read/Write as Proxy works
- [ ] Set admin / upgrader / pauser / aggregator / treasurer / fee recipient
- [ ] Configure **multisig** (and ideally timelock) for admin + upgrader
- [ ] `setDefaultProviderId` + fund TreasuryPool
- [ ] Allowlist tokens on manager **and** pool
- [ ] Security review / audit sign-off ([SECURITY_AUDIT_REPORT.md](SECURITY_AUDIT_REPORT.md)) for this chain’s deploy path
- [ ] Commit public addresses to `config/chains` + `deployments/<chainId>.*.latest.json`

## Testing

- [ ] Unit/integration Hardhat suite green
- [ ] `scripts/post-deploy-check.js --network <name>`
- [ ] Test deposits / off-ramp escrow
- [ ] Test on-ramp settle from TreasuryPool
- [ ] Test withdrawals / cashouts (defund + settle paths)
- [ ] Test emergency pause / unpause / provider disable
- [ ] Test upgrade path (`validateUpgrade` + dry-run)
- [ ] Aggregator + listener cutover ([AGGREGATOR_LISTENER_HANDOFF.md](AGGREGATOR_LISTENER_HANDOFF.md)) including **v2 events**

## Ops

- [ ] Add chain to CI allowlists (testnet workflow only — never auto prod)
- [ ] Monitoring / alerts for this chainId
- [ ] Incident runbook owners know per-chain pause keys ([INCIDENT_RESPONSE.md](INCIDENT_RESPONSE.md))
- [ ] Controlled production rollout (canary volume, then expand)

## Sign-off

| Role | Name | Date |
|------|------|------|
| Eng | | |
| Security | | |
| Ops | | |
