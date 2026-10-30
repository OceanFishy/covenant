# Covenant

A local-only app for your Ledger (through Rabby). It chains DeFi steps (withdraw
collateral → redeem PT+YT → repay ...) into **one atomic transaction**, so you
can enter and exit leveraged Pendle PT loops on Morpho Blue with a single
signature. Supported: PT-USD3 / USDC markets A and B, PT-USD3 / USDT, and PT-reUSD / USDC.
Aave v3 Core (USDC / USDT) is available as Builder blocks: supply, withdraw,
borrow, repay, and health / no-debt guards. That's enough to close an Aave
position in one transaction with a Morpho flash loan sized to the Aave debt.
Aave has frozen every v3 Ethereum reserve (LTV 0) for now, so supply and borrow
revert until it unfreezes them. Repay and withdraw work.

- Spec: [`docs/SPEC.md`](docs/SPEC.md)
- Verified mainnet addresses: [`registry/mainnet.json`](registry/mainnet.json)

## Status

- **M0 done:** the `CovenantExecutor` contract, the mainnet allowlist, and fork
  tests against real positions.
- **M1 built:** the app (Positions, Review & Sign, Setup, Access/Revoke). It's
  tested with a TypeScript plan compiler on a mainnet fork, with `eth_simulateV1`
  against live mainnet, and end to end in a browser with a mock Rabby.
- **M2 built:** the Builder (`#/builder`). Assemble any flow from 20 blocks (Morpho,
  Aave, Pendle mint/redeem, stablecoin swaps, guards, flash loans), or start from a
  template (unwind, deleverage, partial, max unwind, enter, move a loop A → B). Then simulate
  and sign. Flows can be saved, exported or shared.
- **EIP-7702 mode built (optional, Nano S Plus):** your account itself runs plans
  (no Executor, approvals or Morpho authorization). See below.
- **Not done yet:** a real mainnet run from a Ledger, and the first 7702
  delegation from a real device.
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
   - Optional, for the Aave blocks: allow the Executor to borrow USDC/USDT for
     you (credit delegation) and approve aEthUSDC/aEthUSDT (withdraw).
   - An Executor deployed before Aave support fails verification. Deploy a new
     one and revoke the old one in Access.
   - It can all be revoked from **Access**. The badge in the header shows
     whether any Executor can act for you.

**Dry run first (recommended):** run `pnpm fork`, then start the app with
`VITE_DEV_FORK=1 VITE_RPC_URL=http://127.0.0.1:8545`. Add chain 31337 with that
RPC to Rabby (see docs/SPEC.md §12). Your real positions are on the fork.

### EIP-7702 mode (optional, Ledger Nano S Plus)

Instead of an Executor, your EOA delegates to the shared Covenant delegate and
runs plans itself (docs/SPEC.md §5.4). A plan can only spend what it allots from
your wallet, and allowances it grants are reset at the end, but **your whole
account runs the delegate's code** until you revoke. Ledger's Ethereum app only
signs 7702 delegations to whitelisted contracts, so the one-time step uses a
sideloaded build:

```sh
# 1. Setup page → "Deploy" the shared delegate (once, by anyone)
./ledger/build-app.sh --load    # 2. app-ethereum 1.23.0 + the delegate in its whitelist → "Covenant 7702" (needs Docker, pip install ledgerblue)
# 3. on the device, in Covenant 7702: Settings → enable "EIP-7702" and "Blind signing"; close Rabby and Ledger Live
cd app && node --env-file=../.env scripts/ledger7702.mjs delegate --rpc https://rpc.flashbots.net
# 4. remove the sideloaded app; plans and revoking work with the official Ethereum app:
node --env-file=../.env scripts/ledger7702.mjs revoke --rpc https://rpc.flashbots.net
```

The app detects the delegation and switches to it (Setup shows "Your account runs
plans itself"). Any contract change moves the delegate's address, which needs a
new app build and a new authorization.

## Tests

```sh
export MAINNET_RPC_URL=...      # fork + simulation tests
pnpm test:unit                  # contract allowlist / access (no network)
pnpm test:fork                  # contracts on a fork: USDC markets A and B, Aave v3, EIP-7702 mode
pnpm test:fork:aggregator       # contracts on a fork: USDT and PT-reUSD markets, live 0x/KyberSwap routes
cd app
pnpm test                       # app unit tests (no network)
pnpm test:integration           # TS-compiled plans on a Hardhat fork + eth_simulateV1 on mainnet
pnpm e2e                        # browser end to end (Playwright, mock Rabby)
```

The contract tests also run under Foundry with `forge test` (add `--ffi` for
the USDT and reUSD tests), after `pnpm install` so that `node_modules/forge-std` exists.
After changing contracts or the registry, run `pnpm sync` to refresh
`app/src/generated/`.

## Layout

```
contracts/CovenantCore.sol             shared engine: allowlisted calls, runtime amount patches, flash loans, guards
contracts/CovenantExecutor.sol         personal executor on the engine (pulls, sweeps back to the owner)
contracts/CovenantExecutorMainnet.sol  same, with the mainnet allowlist baked in (what the app deploys)
contracts/CovenantDelegate.sol         EIP-7702 delegate on the engine (self-only, allot, tracked balances)
contracts/CovenantDelegateMainnet.sol  same, with initialize() writing the mainnet allowlist
contracts/config/MainnetConfig.sol     mainnet addresses + allowlist (no Pendle router/AMM)
ledger/                                patched Ethereum app build (7702 whitelist) + APDU bridge
app/scripts/ledger7702.mjs             delegate / revoke / status from the Ledger (type-4 transaction)
test/                                  Solidity unit + fork tests; test/utils/Plans.sol = Solidity plan prototype
scripts/quote.mjs                      aggregator quotes for the Solidity fork tests
app/src/lib/compiler/                  TypeScript plan compiler (Call/Patch encoding, templates)
app/src/lib/planner.ts                 picks full unwind / deleverage / partial from YT coverage
app/src/lib/simulate.ts                eth_simulateV1 (mainnet) or snapshot/revert (local fork)
app/src/lib/access.ts                  Executor permissions + revoke transactions
app/src/lib/aave.ts                    Aave v3 account reader (supply, debt, health, frozen reserves)
app/src/lib/mev.ts                     MEV-protected RPCs + Flashbots routing check
app/src/lib/builder/                   Builder blocks, catalog, validation, compiler, templates, storage
app/src/pages/                         Positions, Builder, Review, Setup, Access
app/test/, app/e2e/                    unit, fork integration, browser E2E (+ screenshots)
```
