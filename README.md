# Covenant

A block-based transaction composer for Ledger wallets (connected through
Rabby). You chain DeFi steps (withdraw collateral → redeem PT+YT → repay ...)
into **one atomic transaction** to enter and exit leveraged loops such as
PT-USD3 (3Jane) and PT-reUSD (Re Protocol) on Morpho Blue with a single
signature.

- Spec: [`docs/SPEC.md`](docs/SPEC.md)
- Verified mainnet addresses: [`registry/mainnet.json`](registry/mainnet.json)

## Status

**M0 is done:** the `CovenantExecutor` contract, the mainnet allowlist and fork
tests. One fork test fully unwinds a real PT-USD3/USDC Morpho loop in one
transaction. The frontend (M1) isn't built yet.

## Layout

```
contracts/CovenantExecutor.sol        personal executor: allowlisted calls, runtime amount patches, Morpho flash loans, guards
contracts/config/MainnetConfig.sol    mainnet addresses + allowlist rules (no Pendle router/AMM)
test/CovenantExecutor.t.sol           access-control / allowlist unit tests
test/fork/PtUsd3Usdc.t.sol            mainnet-fork: markets A/B real-position unwinds, enter→unwind, YT shortfall
test/fork/PtUsd3Usdt.t.sol            mainnet-fork: USDT market with live 0x/KyberSwap routes (needs ffi)
scripts/quote.mjs                     aggregator quotes (0x if ZEROX_API_KEY, else KyberSwap)
test/utils/Plans.sol                  Solidity prototype of the plan compiler (templates §7)
registry/mainnet.json                 verified addresses
```

## Run the tests

```sh
pnpm install --frozen-lockfile
cp .env.example .env    # set MAINNET_RPC_URL
export MAINNET_RPC_URL=...   # Hardhat reads it from the environment
pnpm test:unit          # no network needed
pnpm test:fork          # mainnet fork, USDC markets A and B
pnpm test:fork:aggregator  # USDT market, live aggregator routes (ZEROX_API_KEY optional)
```

The same files also run under Foundry with `forge test` (add `--ffi` for the USDT tests), after
`pnpm install` so that `node_modules/forge-std` exists.
