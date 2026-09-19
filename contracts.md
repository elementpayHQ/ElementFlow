# ElementFlow contracts

Proxy addresses are what integrators call. Same CREATE2 addresses appear on multiple chains — **always key by `(chainId, address)`**.

## Deployed proxies

| Name | Chain | Env | Link |
|------|-------|-----|------|
| ElementFlowOrderManager | Base | live | [0x4CDa31fc…bb00](https://basescan.org/address/0x4CDa31fc90a1663FA6dBD58CC736097E2344bb00) |
| ProviderRegistry | Base | live | [0x625d81FC…3890](https://basescan.org/address/0x625d81FC3f15e8d556dD03FBb4B8481ee8483890) |
| TreasuryPool | Base | live | [0xb12c702d…f99d](https://basescan.org/address/0xb12c702da1185700D8CaA8Fdc1Fb66ac348df99d) |
| ElementFlowOrderManager | Polygon | live | [0x4CDa31fc…bb00](https://polygonscan.com/address/0x4CDa31fc90a1663FA6dBD58CC736097E2344bb00) |
| ProviderRegistry | Polygon | live | [0x625d81FC…3890](https://polygonscan.com/address/0x625d81FC3f15e8d556dD03FBb4B8481ee8483890) |
| TreasuryPool | Polygon | live | [0xb12c702d…f99d](https://polygonscan.com/address/0xb12c702da1185700D8CaA8Fdc1Fb66ac348df99d) |
| ElementFlowOrderManager | BNB Smart Chain | live | [0x4CDa31fc…bb00](https://bscscan.com/address/0x4CDa31fc90a1663FA6dBD58CC736097E2344bb00) |
| ProviderRegistry | BNB Smart Chain | live | [0x625d81FC…3890](https://bscscan.com/address/0x625d81FC3f15e8d556dD03FBb4B8481ee8483890) |
| TreasuryPool | BNB Smart Chain | live | [0xb12c702d…f99d](https://bscscan.com/address/0xb12c702da1185700D8CaA8Fdc1Fb66ac348df99d) |
| ElementFlowOrderManager | Arbitrum One | live | [0x4CDa31fc…bb00](https://arbiscan.io/address/0x4CDa31fc90a1663FA6dBD58CC736097E2344bb00) |
| ProviderRegistry | Arbitrum One | live | [0x625d81FC…3890](https://arbiscan.io/address/0x625d81FC3f15e8d556dD03FBb4B8481ee8483890) |
| TreasuryPool | Arbitrum One | live | [0xb12c702d…f99d](https://arbiscan.io/address/0xb12c702da1185700D8CaA8Fdc1Fb66ac348df99d) |
| ElementFlowOrderManager | Scroll | live (partial) | [0x4CDa31fc…bb00](https://scrollscan.com/address/0x4CDa31fc90a1663FA6dBD58CC736097E2344bb00) |
| ProviderRegistry | Scroll | live (partial) | [0x625d81FC…3890](https://scrollscan.com/address/0x625d81FC3f15e8d556dD03FBb4B8481ee8483890) |
| TreasuryPool | Scroll | pending | — (deploy failed: insufficient ETH for L1 fee) |
| ElementFlowOrderManager | Base Sepolia | testnet | [0xd3D65B25…1401](https://sepolia.basescan.org/address/0xd3D65B25E8F0762E06123876507DAA5150cC1401) |
| ProviderRegistry | Base Sepolia | testnet | [0x64ed7F77…cDeC](https://sepolia.basescan.org/address/0x64ed7F77245014a34B51709a1e013BcEbbc8cDeC) |
| TreasuryPool | Base Sepolia | testnet | [0x71B13319…2790](https://sepolia.basescan.org/address/0x71B13319d9fE1CC7B1C4c9B89054C9A591e52790) |

Full addresses (copy/paste):

| Role | Address |
|------|---------|
| OrderManager | `0x4CDa31fc90a1663FA6dBD58CC736097E2344bb00` |
| ProviderRegistry | `0x625d81FC3f15e8d556dD03FBb4B8481ee8483890` |
| TreasuryPool | `0xb12c702da1185700D8CaA8Fdc1Fb66ac348df99d` |

(Base Sepolia uses different addresses — see table above.)

## Tokens

| Name | Chain | Env | Link |
|------|-------|-----|------|
| USDC | Base | live | [0x833589fC…2913](https://basescan.org/address/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913) |
| USDT | Base | live | [0xfde4C96c…9bb2](https://basescan.org/address/0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2) |
| USDC | Polygon | live | [0x3c499c54…3359](https://polygonscan.com/address/0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359) |
| USDT | Polygon | live | [0xc2132D05…8e8F](https://polygonscan.com/address/0xc2132D05D31c914a87C6611C10748AEb04B58e8F) |
| USDC | BNB | live | [0x8AC76a51…580d](https://bscscan.com/address/0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d) (18 dec) |
| USDT | BNB | live | [0x55d39832…7955](https://bscscan.com/address/0x55d398326f99059fF775485246999027B3197955) (18 dec) |
| USDC | Arbitrum | live | [0xaf88d065…5831](https://arbiscan.io/address/0xaf88d065e77c8cC2239327C5EDb3A432268e5831) |
| USDT | Arbitrum | live | [0xFD086eC7…68Ce](https://arbiscan.io/address/0xFD086eC7a2C6a2d995f9551CEfa26259845c68Ce) |
| USDC | Scroll | live | [0x06eFdBFf…63A4](https://scrollscan.com/address/0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4) |
| USDT | Scroll | live | [0xf55BEC9c…99Df](https://scrollscan.com/address/0xf55BEC9cafDbE8730f096Aa55dad6D22d44099Df) |
| USDC | Base Sepolia | testnet | [0x036CbD53…CF7e](https://sepolia.basescan.org/address/0x036CbD53842c5426634e7929541eC2318f3dCF7e) |

## Notes

- Aggregator create/settle/refund → **OrderManager** only.
- On-ramp `availableLiquidity` → **TreasuryPool** (not OM).
- Admin Safe must still **wire** each live chain (registry / default provider / allowlists / fund).
- Scroll: fund deployer with ~0.005 ETH, then finish TreasuryPool deploy.
- Fix `.env` RPCs: Polygon key was disabled; Scroll URL returned HTML — use working chain RPCs.
