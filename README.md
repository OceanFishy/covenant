# Covenant

A local-only app for your Ledger (through Rabby). It chains DeFi steps (withdraw
collateral → redeem PT+YT → repay ...) into **one atomic transaction**, so you
can enter and exit leveraged Pendle PT loops on Morpho Blue with a single
signature. Supported: PT-USD3 / USDC markets A and B, and PT-USD3 / USDT.

- Spec: [`docs/SPEC.md`](docs/SPEC.md)
- Verified mainnet addresses: [`registry/mainnet.json`](registry/mainnet.json)

## Status

- **M0 done:** the `CovenantExecutor` contract, the mainnet allowlist, and fork
  tests against real positions.
- **M1 built:** the app (Positions, Review & Sign, Setup, Access/Revoke). It's
  tested with a TypeScript plan compiler on a mainnet fork, with `eth_simulateV1`
  against live mainnet, and end to end in a browser with a mock Rabby.
- **Not done yet:** a real mainnet run from a Ledger.
- **Unaudited:** start with a small position.

## Run the app

```sh
pnpm install --frozen-lockfile
cp .env.example .env        # VITE_RPC_URL (must support eth_simulateV1), optional ZEROX_API_KEY
pnpm start                  # builds and serves http://127.0.0.1:4173 (local only)
```

Before you sign anything:

1. **Rabby:** set Ethereum's RPC to Flashbots Protect (`https://rpc.flashbots.net`)
   or MEV Blocker (`https://rpc.mevblocker.io/noreverts`), under Settings →
   Custom RPC. The app won't sign until you confirm this.
2. **Ledger:** turn on blind signing (Ethereum app → Settings). The Executor's
   `execute` call can't be clear-signed yet.
3. **Setup page:**
   - Deploy your Executor (one transaction).
   - Authorize it on Morpho and approve YT-USD3. That's done once.
   - It can all be revoked from **Access**. The badge in the header shows
     whether any Executor can act for you.

**Dry run first (recommended):** run `pnpm fork`, then start the app with
`VITE_DEV_FORK=1 VITE_RPC_URL=http://127.0.0.1:8545`. Add chain 31337 with that
RPC to Rabby (see docs/SPEC.md §12). Your real positions are on the fork.

## Tests

```sh
export MAINNET_RPC_URL=...      # fork + simulation tests
pnpm test:unit                  # contract allowlist / access (no network)
pnpm test:fork                  # contracts on a fork: USDC markets A and B
pnpm test:fork:aggregator       # contracts on a fork: USDT market, live 0x/KyberSwap routes
cd app
pnpm test                       # app unit tests (no network)
pnpm test:integration           # TS-compiled plans on a Hardhat fork + eth_simulateV1 on mainnet
pnpm e2e                        # browser end to end (Playwright, mock Rabby)
```

The contract tests also run under Foundry with `forge test` (add `--ffi` for
the USDT tests), after `pnpm install` so that `node_modules/forge-std` exists.
After changing contracts or the registry, run `pnpm sync` to refresh
`app/src/generated/`.

## Layout

```
contracts/CovenantExecutor.sol         personal executor: allowlisted calls, runtime amount patches, flash loans, guards
contracts/CovenantExecutorMainnet.sol  same, with the mainnet allowlist baked in (what the app deploys)
contracts/config/MainnetConfig.sol     mainnet addresses + allowlist (no Pendle router/AMM)
test/                                  Solidity unit + fork tests; test/utils/Plans.sol = Solidity plan prototype
scripts/quote.mjs                      aggregator quotes for the Solidity fork tests
app/src/lib/compiler/                  TypeScript plan compiler (Call/Patch encoding, templates)
app/src/lib/planner.ts                 picks full unwind / deleverage / partial from YT coverage
app/src/lib/simulate.ts                eth_simulateV1 (mainnet) or snapshot/revert (local fork)
app/src/lib/access.ts                  Executor permissions + revoke transactions
app/src/lib/mev.ts                     MEV-protected RPCs + Flashbots routing check
app/src/pages/                         Positions, Review, Setup, Access
app/test/, app/e2e/                    unit, fork integration, browser E2E (+ screenshots)
```
