# Covenant: Transaction Composer for Ledger

**Status:** v1.0 (M0 done; M1 and M2 built; PT-reUSD loops and EIP-7702 mode built (M3/M4 parts); awaiting a real-Ledger mainnet run) · **Owner:** fish · **Date:** 2026-10-30

Covenant is a web app for building DeFi transactions out of reusable **blocks**
and executing the whole chain **atomically, in one Ledger signature**. The first
use case is entering and exiting leveraged Pendle PT loops: PT-USD3 (3Jane) and
PT-reUSD (Re Protocol), with USDC borrowed on Morpho Blue.

---

## 1. Goals and non-goals

### Goals
1. **One signature, one transaction.** A full loop unwind (or entry) runs as one
   atomic transaction signed on a Ledger. Either every step succeeds or nothing
   happens.
2. **Composable blocks.** A palette of small steps ("withdraw collateral",
   "redeem PT+YT", "redeem USD3", "repay", ...) that you can wire together in
   seconds, plus saved templates for flows you repeat.
3. **Know what you sign before you sign it.** Every bundle is simulated against
   live chain state before signing. You see balance diffs, the final health
   factor and the slippage bounds, and the hash to check on the Ledger screen.
4. **Self-custody throughout.** Funds never rest in any contract except the one
   you own. There's no backend custody and no relayer that can move funds.

### Non-goals (v1)
- Automation or keepers (bots that unwind on a trigger).
- Multi-chain. v1 is Ethereum mainnet only. The registry is chain-keyed so other
  chains can be added later.
- Supporting every protocol. v1 covers Morpho Blue, Aave v3 Core and the Aave
  v4 Main Spoke (USDC/USDT), Pendle V2, 3Jane, Re Protocol and generic
  ERC-20/ERC-4626 and DEX-aggregator blocks.
- A public product. v1 is a personal tool. Hardening for strangers comes later.

---

## 2. The core problem

A Ledger controls a plain **EOA**, and an EOA can only make one call per
transaction. A loop unwind is 4–5 calls per round, repeated over many rounds:

```
withdraw PT-USD3  →  redeem PT+YT → USD3  →  redeem USD3 → USDC  →  repay USDC
        ↑_____________________________________________________________|  (repeat)
```

Done by hand that is dozens of signatures, and every intermediate state leaves
you exposed to price moves and liquidation risk.

### Solution: a personal Executor plus a flash loan

1. **Executor contract.** You deploy your own small contract, owned by your
   Ledger EOA. It runs an ordered list of calls in one transaction and can
   insert runtime amounts (for example "all USD3 I now hold") into later calls.
2. **Flash loan instead of looping.** You don't need N withdraw/repay rounds. The
   Executor borrows USDC equal to the whole debt from Morpho Blue's fee-free
   flash loan, repays everything, withdraws all collateral, converts it to USDC
   and repays the flash loan. That's **one pass** with no repetition, and the
   cost doesn't grow with leverage.
3. **Iterative mode as a fallback.** For cases where a flash loan doesn't fit, a
   `Repeat` block runs withdraw → convert → repay N times inside the same
   transaction, sizing each round to stay above a target health factor (see §6.3).

### Execution-model options considered

| Option | One sig? | Dynamic amounts | Ledger UX | Verdict |
|---|---|---|---|---|
| **Personal Executor (owner = EOA)** | Yes | Yes | Blind-sign (mitigated, §8) | **Chosen for v1** |
| Morpho Bundler3 + adapters | Yes | Partly | Blind-sign | Good reference design, but Morpho-centric; reuse its adapter ideas |
| Safe{Wallet} + MultiSend, Ledger as signer | Yes | No (static amounts) | Safe UI | Amounts are fixed at signing, so redemptions with variable output break it |
| EIP-7702 (EOA delegates to Executor code) | Yes | Yes | Ledger limits 7702 to vetted contracts | **Built as an option (§5.4):** the same engine as the Executor; a sideloaded Ledger app whitelists the delegate for the one-time authorization |
| Weiroll VM | Yes | Yes | Blind-sign | Powerful but harder to audit and decode; overkill for v1 |

---

## 3. System architecture

```
┌──────────────────── Browser · http://127.0.0.1 (local only) ──────────────┐
│  Block Builder UI ──► Plan (JSON) ──► Compiler ──► Executor calldata      │
│        ▲                   │                            │                 │
│   Templates           Quote engine               Simulator (fork)          │
│   (local + git)   (Pendle API, 1inch/0x,        balance diffs, HF, gas     │
│                    on-chain previews)                   │                 │
│                                                         ▼                 │
│                                         Rabby (EIP-1193) ──► Ledger        │
│                                                                           │
└───────────────────────────────────────────────────────────┬───────────────┘
                                                            ▼
                    Ethereum: CovenantExecutor ──► Morpho / Pendle / 3Jane / Re / DEX
```

- **Frontend:** Vite + React + TypeScript and `viem`, in `app/`. There's no backend,
  no wagmi and no state library, which keeps the dependency list short (React,
  viem). Drag and drop arrives with the builder (M2).
  - Aggregator APIs and Flashbots' status API go through the local Vite proxy
    (`/api/0x`, `/api/kyber`, `/api/flashbots`). The 0x key stays in the Node
    process and never reaches the browser bundle, and the CSP stays at
    `connect-src 'self' <RPC>`.
- **Hosting: local only.**
  - **Running it:** clone the repo, then `pnpm install && pnpm start`. That
    builds the app and serves it with `vite preview`, bound to `127.0.0.1` only
    (never `0.0.0.0`). It's never deployed to a public URL or IPFS.
  - **Dependencies:** pinned by the lockfile. `pnpm install --frozen-lockfile`
    is the only supported install.
  - **Local storage:** settings (RPC URL, simulation API key) live in
    `.env.local`, which is gitignored. Templates are JSON files in `templates/`
    in the repo, plus browser local storage for drafts.
  - **Outbound connections:** only to your RPC, the simulation provider and quote
    APIs. A strict Content-Security-Policy limits `connect-src` to those hosts.
- **Wallet connection: Rabby, with the Ledger attached as a hardware wallet.**
  - **Connecting:** Covenant finds Rabby through EIP-6963 (`wagmi` injected
    connector) and sends transactions via `eth_sendTransaction`. Rabby forwards
    them to the Ledger to sign.
  - **No other connectors:** no WalletConnect, Ledger Live or direct WebHID
    connection. That keeps the code and the attack surface small.
  - **Network check:** Covenant checks that Rabby is on Ethereum mainnet (chain 1)
    and that the account is the Executor's owner before enabling Sign.
  - **Rabby's own pre-sign simulation** is a second, independent check. It
    should show the same balance changes as Covenant's review screen.
- **RPC:** a user-supplied RPC URL (stored locally) plus a fallback. Simulation
  uses `eth_simulateV1` where the RPC supports it, otherwise a Tenderly or
  Alchemy simulation API key the user supplies.
- **Contracts:** Solidity 0.8.28 (Cancun). It builds and tests with Hardhat 3 or Foundry from the same files. `CovenantExecutor` plus protocol adapters (§5).

---

## 4. Concepts

| Term | Meaning |
|---|---|
| **Block** | One typed step (`app/src/lib/builder/types.ts`) that compiles to one or more Executor `Call`s, with approvals added automatically. |
| **Flow** | An ordered list of blocks. A flash loan is a container whose children run inside the loan. It's serializable JSON, so it can be saved, exported or shared. |
| **Amount** | `fixed` (a decimal in the block's token), `balance` (the Executor's balance at execution), `debt` (a market's live debt + bps), `collateral` (all collateral), `allShares` (repay all by shares), `aaveDebt` (your live Aave variable debt in a token + bps), `allDebt` (Aave repay: exactly your live debt) or `supplied` (Aave withdraw: all your aTokens). Everything except `fixed` is resolved **on-chain at execution time** through the Executor's patch sources (Aave amounts are aToken / variable debt token balances, read with `BALANCE`). |
| **Guard** | A block that reverts the whole transaction if it fails: minimum received, no debt, minimum health factor (Morpho market or Aave account), no Aave debt in a token. Swaps add their own output guard. |
| **Template** | A flow generated from your position: unwind, deleverage, partial, max unwind, enter, or move between markets. |

### Flow JSON (as implemented)

```jsonc
{
  "version": 1,
  "name": "Unwind PT-USD3 / USDC · A",
  "blocks": [
    { "id": "b1", "type": "accrueInterest", "market": "PT-USD3-17DEC2026/USDC (A)" },
    { "id": "b2", "type": "pull", "token": "<YT-USD3>", "amount": { "kind": "fixed", "value": "597246.159092" } },
    { "id": "b3", "type": "flashLoan", "token": "<USDC>",
      "amount": { "kind": "debt", "market": "PT-USD3-17DEC2026/USDC (A)", "bps": 10001 },
      "children": [
        { "id": "b4", "type": "repay", "market": "…(A)", "amount": { "kind": "allShares" } },
        { "id": "b5", "type": "withdrawCollateral", "market": "…(A)", "amount": { "kind": "collateral" } },
        { "id": "b6", "type": "redeemPY", "series": "PT-USD3-17DEC2026", "amount": { "kind": "balance" } },
        { "id": "b7", "type": "redeemSY", "series": "PT-USD3-17DEC2026", "tokenOut": "<USDC>", "minOut": { "kind": "fixed", "value": "0" } }
      ] },
    { "id": "b8", "type": "guardNoDebt", "market": "…(A)" }
  ]
}
```

The builder's templates compile **byte-for-byte** to the same transaction as the
tested template compiler. A unit test checks this for unwind, deleverage,
partial and enter.

---

## 5. Smart contracts

### 5.1 `CovenantExecutor`

A personal, non-upgradeable contract with a single owner. It's implemented in
[`contracts/CovenantExecutor.sol`](../contracts/CovenantExecutor.sol), about 300
lines.

```solidity
enum Source { BALANCE, MORPHO_COLLATERAL, MORPHO_BORROW_SHARES, MORPHO_DEBT_ASSETS, AAVE_V4_DEBT }

struct Patch {
    uint32 offset;   // byte offset in `data` of the uint256 word to overwrite (>= 4)
    Source source;   // value read on-chain at execution time
    bytes  args;     // (token, account), (marketId, user) or (spoke, reserveId, user)
    uint32 bps;      // scale, 10_000 = 100% (e.g. 10_001 = debt + 0.01% buffer)
}

struct Call { address target; bytes data; Patch[] patches; }

function execute(Call[] calldata calls, address[] calldata sweep, bytes32 planHash) external; // onlyOwner
function onMorphoFlashLoan(uint256 assets, bytes calldata data) external; // data = abi.encode(token, Call[])

// Guards, callable from plans, revert on failure
function assertMinBalance(address token, address account, uint256 min) external view;
function assertMaxBalance(address token, address account, uint256 max) external view; // e.g. no Aave debt: (variableDebtToken, owner, 0)
function assertNoDebt(bytes32 id, address user) external view;
function assertMinHealth(bytes32 id, address user, uint256 minHealthWad) external view;
function assertMinAaveHealth(address user, uint256 minHealthWad) external view; // Pool.getUserAccountData
function assertMinAaveV4Health(address spoke, address user, uint256 minHealthWad) external view; // Spoke.getUserAccountData
function assertNoAaveV4Debt(address spoke, uint256 reserveId, address user) external view; // Spoke.getUserTotalDebt == 0
```

**Allowlist encoding:** one `uint256` rule per (target, selector).
- Bit 0: the call is allowed.
- Bit `i+1`: argument word `i` must be the owner or the Executor. This is how
  receivers and `onBehalf` are pinned.
- Bit 255: argument word 0 (the ERC-20 `transfer`/`approve` recipient) must be
  on that token's recipient allowlist.

The mainnet rules live in
[`contracts/config/MainnetConfig.sol`](../contracts/config/MainnetConfig.sol) and
are passed to the constructor, so deploying is a single transaction. The
constructor also takes the Morpho Blue and Aave v3 Pool addresses (immutables the
app checks when it verifies an Executor). Executors deployed before Aave support
have different bytecode, fail verification, and must be replaced (deploy a new
one, revoke the old one in Access).

**Rules:**
- `onlyOwner` on `execute`. The owner is the Ledger EOA, fixed at deployment.
- **Callback gating:** `onMorphoFlashLoan` (and any other callbacks) are only
  accepted when `msg.sender` is the expected protocol **and** a transient-storage
  (EIP-1153) "executing" flag set by `execute` is on. Inner calls for the
  callback are passed in the flash loan `data` and run through the same
  interpreter.
- **Target allowlist:** each `Call.target` must be in an owner-managed allowlist
  (Morpho, Pendle YT/SY contracts, the USD3 vault, Re contracts, Permit2, known
  tokens, the aggregator router). Changing the allowlist is its own owner
  transaction.
- **No Pendle trading, enforced on-chain.** The Executor never buys or sells
  Pendle assets (PT, YT, SY, LP). It can only redeem them (and mint them; see
  §6.3).
  - **No Pendle router or market.** The Pendle Router and Pendle market (AMM)
    contracts are **never** on the allowlist. Pendle calls go straight to the
    core contracts: `YT.redeemPY` / `YT.mintPY` and `SY.redeem` / `SY.deposit`.
  - **Selector allowlist** for every Pendle target: only those functions, plus
    ERC-20 `transfer`/`approve`.
  - **Recipient check:** a PT, YT or SY `transfer`/`approve` is only allowed to
    the market's own YT/SY contract, Morpho Blue (collateral) or the owner
    (sweep).
  - **Aggregator swaps:** the compiler rejects any swap whose input or output is
    a Pendle asset. Because of the recipient check, the Executor can't hand a
    PT or YT to an aggregator anyway.
  - **Aave:** only USDC and USDT can be approved to the Aave Pool, so Pendle
    assets never reach it (§6.6). The same holds for the Aave v4 Giver (§6.7).
- **Ends empty:** `execute` sends the full balance of every `sweep` token to the
  owner at the end. The compiler always lists every token the plan touches, and
  the fork tests assert that the Executor ends with a zero balance.
- **Approvals are consumed:** each approval the Executor gives is sized to what
  the next call pulls, so templates end with zero allowances. The Executor
  holds no funds between transactions anyway.
- `planHash` is emitted in an event so on-chain history maps back to the plan
  JSON.
- Holds no admin keys besides `owner`. `rescue(token)` is owner-only.

### 5.2 Position ownership on Morpho

**Decision: positions stay under your EOA, with a one-time standing authorization.**

- **One-time setup:** a single transaction from the Ledger,
  `morpho.setAuthorization(executor, true)`. After that, every unwind, entry or
  roll is **exactly one transaction and one signature**.
- Anyone can `repay` on your behalf. The authorization is what lets the Executor
  `withdrawCollateral` and `borrow` on your behalf.
- **No migration:** existing loops keep working as they are and stay visible in
  the Morpho app.
- **Why the standing authorization is acceptable:** the Executor only does what
  its owner (your Ledger) signs, so this is the same trust as the Executor
  owning the positions outright. It covers all your Morpho Blue markets, so the
  Executor's owner and callback gating (§5.1) are what protect them.
- **Revoke any time:** a **Revoke** control is always visible in the app
  (§9.3). Deploying a new Executor version means revoking the old one and
  authorizing the new one.

Alternatives rejected for being more complex:
- Authorizing and revoking inside every transaction (`setAuthorizationWithSig`)
  costs 2 extra typed-data signatures each time.
- Moving positions to be owned by the Executor needs a migration, and the
  positions disappear from the Morpho app.

### 5.3 Adapters vs. raw calls

v1 compiles most blocks to **raw protocol calls** with patches, with no adapter
contracts, which keeps the audit surface small. Adapters are only added where a
protocol needs something special (for example a callback, or a two-step
redemption).

### 5.4 EIP-7702 mode (built, optional)

Your EOA delegates (EIP-7702) to one shared deployment of
[`CovenantDelegateMainnet`](../contracts/CovenantDelegateMainnet.sol) and runs
plans itself: a plan is a transaction to your own address calling `execute`. No
Executor, token approvals, Morpho authorization or Aave credit delegation, and
protocols see your address as the caller (e.g. Re's KYC check is on
`msg.sender`). The engine is shared with the Executor
([`CovenantCore`](../contracts/CovenantCore.sol)): same calls, patches, flash
loan, guards and allowlist rules.

Code at a delegated EOA runs in its context and anyone can call it, so the
delegate adds:
- **Self-only:** `execute`, `initialize`, `setRule`/`setRecipient` and `allot`
  require `msg.sender == address(this)`; Morpho's flash callback is accepted
  only while a plan runs. The shared implementation can't be driven directly.
- **Allowlist in your storage** under the ERC-7201 namespace
  `covenant.delegate.v1`, written by `initialize()` (in the same type-4
  transaction as the delegation) and versioned (`configVersion` vs
  `CONFIG_VERSION`; Setup offers an update when they differ).
- **A plan only spends what it allots.** `execute(calls, tracked, hash)`
  snapshots your balance of every tracked token (all plan tokens plus Aave
  aTokens); `allot(token, amount)` replaces the Executor's pulls;
  `Source.OWNED` / `assertMinOwned` see allotted plus received funds only; at the
  end every tracked balance must be ≥ snapshot − allotted, or everything
  reverts (`Overspent`).
- **No lingering allowances:** each (token, spender) a plan approves (and the
  flash repayment) is put back to its previous value at the end; an existing
  allowance is cleared first, so USDT-style tokens work.
- **Still a wallet:** accepts ETH and ERC-721/1155 safe transfers, and answers
  ERC-1271 for signatures made by your own key (low-s, 65 bytes).

**Deployment and signing.** The delegate is deployed once, by anyone, through
the deterministic deployment proxy (`0x4e59…956C`, salt 0), so its address
follows from the bytecode (no metadata hash: comments don't move it; code
changes do, and need a new authorization). Ledger's Ethereum app only signs 7702
authorizations for whitelisted delegates (at 1.23.0: just Simple7702Account), so:
1. Setup → **Deploy** the delegate (if nobody has).
2. [`ledger/build-app.sh --load`](../ledger/build-app.sh): app-ethereum 1.23.0
   with the delegate added to the whitelist (chain id 1 only), built in Ledger's
   Docker builder and sideloaded to a **Nano S Plus** as "Covenant 7702" (Nano X
   can't sideload; the device warns it isn't genuine). The official app stays.
3. In that app, enable *EIP-7702* and *Blind signing*; close Rabby / Ledger Live.
4. [`app/scripts/ledger7702.mjs delegate`](../app/scripts/ledger7702.mjs):
   signs the authorization (APDU `0x34`, nonce = tx nonce + 1) and one type-4
   transaction to yourself calling `initialize()`, verifies both signatures by
   recovery, broadcasts, then checks the designator and `configVersion`. Use a
   private RPC (`--rpc https://rpc.flashbots.net`): if someone else included the
   authorization first, the account ends up delegated but not initialized, and
   Setup's "update the allowlist" step finishes it.
5. Remove the sideloaded app. Plans, allowlist updates and `ledger7702.mjs
   revoke` (authorization to address 0) work with the official app.

**Risk:** your whole account runs this code, so a bug can reach all your funds,
not just approved tokens, until you revoke. Fork tests: a real 597k PT / 447k
USDC position unwound from the delegated EOA for 149.7k USDC; a 3× entry and
exit kept 5k USDC of unrelated savings untouched; a plan repaying from
unallotted savings reverts.

---

## 6. Block catalog (v1)

Each block has inputs, outputs, the calls it compiles to, preflight checks and a
simulation preview.

### 6.1 Wallet and generic

| Block | Does | Notes |
|---|---|---|
| `wallet.pull` | Move tokens from the EOA into the Executor | Default: `transferFrom` using a one-time approval given during setup (YT, PT, USDC, USD3, reUSD), so no extra signature per transaction. Optional: Permit2 typed-data signature for tokens you haven't approved |
| `wallet.sweep` | Send all balances of listed tokens back to the EOA | Always added automatically as the final block |
| `erc20.approve` | Exact-amount approval from the Executor | Inserted automatically by the compiler before blocks that need it |
| `erc4626.deposit` / `redeem` | Generic vault in/out | Covers many yield tokens. Uses `previewRedeem` for minOut |
| `swap.aggregator` | Swap USDC ↔ USDT or USDC ↔ reUSD via **0x** (default; Swap API v2, AllowanceHolder) or **KyberSwap** (keyless fallback) | Route quoted at build time for a **fixed sell amount**, with the Executor as taker and recipient, and re-quoted if stale. The Executor checks the output with `assertMinBalance` whatever the route data says. Only USDC, USDT and reUSD can be approved to an aggregator, so **Pendle assets can never be routed** (§5.1) |
| `guard.minBalance` | Revert if the Executor's balance of a token < min | |
| `guard.healthFactor` | Revert if a Morpho position's HF < target after the step | Reads the oracle and LLTV on-chain |
| `guard.maxDebt` / `guard.zeroDebt` | Assert debt bounds | Used by unwind templates |
| `guard.maxPriceImpact` | Revert if an aggregator swap loses more than `bps` against its oracle or quoted price | Default 50 bps. Only applies to non-Pendle swaps |

### 6.2 Morpho Blue

| Block | Call | Notes |
|---|---|---|
| `morpho.supplyCollateral` | `supplyCollateral(params, assets, onBehalf, "")` | |
| `morpho.withdrawCollateral` | `withdrawCollateral(params, assets, onBehalf, receiver)` | `amount: "all"` resolves to on-chain collateral |
| `morpho.borrow` | `borrow(params, assets, 0, onBehalf, receiver)` | |
| `morpho.repay` | `repay(params, 0, shares, onBehalf, "")` | `"all"` repays **by shares** so no dust is left behind |
| `morpho.flashLoan` | `flashLoan(token, assets, data)` | Container block: child blocks run inside the callback and repayment is checked |
| `morpho.authorize` | `setAuthorization(executor, bool)` | Sent from the EOA as a one-time setup or revoke transaction. Not part of normal plans |

Markets are identified by `MarketParams` (loan token, collateral token, oracle,
IRM, LLTV), resolved from the market id in the registry.

### 6.3 Pendle V2

| Block | Does | Notes |
|---|---|---|
| `pendle.redeemPY` | PT + YT (equal amounts) → SY | Transfer PT and YT to the YT contract, then `YT.redeemPY(executor)`. **Pre-maturity it needs YT ≥ PT.** Post-maturity it's PT-only |
| `pendle.redeemSY` | SY → underlying (USD3 / reUSD, or USDC if the SY supports it) | `SY.redeem(receiver, shares, tokenOut, minOut, false)` |
| `pendle.mintPY` | underlying → SY → PT + YT | `SY.deposit` then `YT.mintPY(ptReceiver, ytReceiver)`. Entry only. Not buying: you get both PT and YT at par |

**Pendle rule: redeem only, never buy or sell.** There are no swap blocks for
PT, YT, SY or LP, and the Pendle router and markets are excluded on-chain
(§5.1). Interfaces are to be verified against Pendle's core contracts during M0.

**PT/YT shortfall handling.** Before maturity, PT can only be redeemed with an
equal amount of YT. When your YT doesn't cover all the PT collateral, the
template does a **matched unwind** and never sells the extra PT:

1. **Withdraw only matched PT:** `W = min(collateral, YT held)`. Redeem it, then
   repay as much debt as the proceeds cover.
2. **Choose a variant:**
   - **Full deleverage:** if the proceeds from `W` cover the whole debt, the
     template repays it all and then withdraws the rest of the PT, **unlevered**,
     to your wallet. You hold it to maturity, or until you add YT outside
     Covenant, and then redeem it.
   - **Partial unwind:** otherwise, the template repays what it can and leaves a
     smaller loop open.
3. **The remaining position gets safer.** Equal value comes out of collateral
   and debt, so the loan-to-value of what's left goes **down** (for example 100
   collateral / 80 debt → 50 / 30, LTV 80% → 60%). A `guard.healthFactor` still
   checks it.
4. **Shown before signing:** the matched amount, the stranded PT and the
   resulting position.
5. **Acting on stranded PT later:** the Positions page shows how much YT you'd
   need to exit fully. It also shows the date after which the remaining PT
   redeems on its own.

**Tip:** loops entered through Covenant use `mintPY`, which sends the YT to your
wallet, so you always hold enough YT to fully exit later. That holds as long as
you don't sell the YT elsewhere.

**Maturity awareness:** the registry stores maturity. After maturity,
`redeemPY` becomes PT-only redemption automatically.

### 6.4 3Jane

| Block | Does | Notes |
|---|---|---|
| `threejane.depositUSD3` | USDC → USD3 (senior tranche, ERC-4626) | **Capped and whitelisted.** On 2026-10-30 capacity went from 70.8k to 0.81 USDC within hours. Only whitelisted addresses (such as SY-USD3) can deposit. Preflight reads `maxDeposit(SY-USD3)` |
| `threejane.redeemUSD3` | USD3 → USDC | No cooldown on USD3, **but redemptions depend on available liquidity**. Preflight reads `maxRedeem`/`maxWithdraw` and the UI warns if the plan exceeds it |
| `threejane.stakeSUSD3` / `requestUnstake` | USD3 ↔ sUSD3 (junior) | sUSD3 has about a 1-month cooldown, so it can't be used inside an atomic exit. Shown as a two-transaction flow |

**Measured (2026-10-30):** USD3 is a Yearn V3 tokenized strategy. You can
redeem about **4.53M USDC** at once (`availableWithdrawLimit`). SY-USD3 redeems
**straight to USDC** (`getTokensOut` = USDC, USD3), so an exit needs no separate
3Jane step.

**Entry is limited by 3Jane's deposit cap.** Entering with USDC via
`SY.deposit(USDC)` only works while USD3 has deposit capacity. When it's full,
the entry template (§7.4) is disabled and the reason is shown. Entering with
USD3 you already hold (`SY.deposit(USD3)`) isn't capped.

**Liquidity fallback:** if `maxRedeem(executor) < needed`, the template offers
(a) a partial unwind sized to the available liquidity, or (b) swapping the
remaining **USD3** (not PT) to USDC via an aggregator, with `minOut`.

**Max unwind (built; Positions → Review, and a Builder template):** redeems the most PT that can be
redeemed right now: the PT your YT covers, capped by what 3Jane pays SY-USD3
out of its reserve, `USD3.maxRedeem(SY)` × Pendle's current index
(`max(pyIndexStored, SY.exchangeRate())`). That PT never asks for more than
`maxRedeem`, and a couple of PT units more would, so when the reserve is the smaller
limit the flow **drains it** (to a few wei). With the capped amount, the flow takes
the usual shape: a deleverage if the proceeds repay the whole debt, otherwise a
partial unwind that repays 99% of them. The reserve is read when the Review
screen (or the Builder template) is built, and both re-simulate every block, so a
reserve that shrank shows up as a failed simulation before signing. Fork test: reserve cut to ~500k USDC under a
1.26M PT position; the max unwind redeemed 502.7k PT and left the reserve at
dust.

### 6.5 Re Protocol (reUSD / reUSDe)

**Answered (2026-10-29):** minting and redeeming with Re is **KYC-gated** (the
Insurance Capital Layer takes KYC-approved deposits; redemptions go through
Re's RedemptionGateway), and instant redemptions currently pay **sUSDe** from a
~$9M vault before falling back to a quarterly queue. A per-user Executor can't
use either, so there are no `re.mint` / `re.redeem` blocks. PT-reUSD loops
convert with `swap.aggregator` instead, **reUSD only, never PT-reUSD**:

| Step | How |
|---|---|
| Exit | `pendle.redeemSY` → reUSD (SY-reUSD only pays reUSD), then sell just enough reUSD for the USDC debt + 0.10% (guard: debt + 0.02%, same re-quote ladder as USDT, §7.1). **The rest comes back as reUSD**, so only the debt portion pays DEX costs |
| Enter | equity in reUSD; flash USDC = equity at Re's NAV (`SY.exchangeRate`) × (L − 1), swapped exact-in to reUSD (min out = quote − 0.3%), then `SY.deposit(reUSD)` → `mintPY` |
| Matched / partial unwind | valued in USDC at Re's NAV less 1% for the sale (§6.3 decisions compare this against the USDC debt) |

**Measured (2026-10-29):** reUSD NAV ≈ 1.1103 USDC (`SY-reUSD.exchangeRate`).
KyberSwap: 1M reUSD → 1.106M USDC (−0.36% vs NAV), 5M → 5.527M (−0.45%);
1M USDC → 903k reUSD. PT-reUSD and YT-reUSD have 6 decimals (SY asset USDC),
SY-reUSD and reUSD 18. SY-reUSD deposits are uncapped and wrap reUSD 1:1. Fork
tests: a real 3.02M PT / 2.69M USDC position closed for 285.1k reUSD (316.6k
USDC at NAV) plus 2.8k USDC; a 531k PT / 456k USDC one for 66.2k reUSD (73.5k
at NAV) plus 0.7k USDC; a 10k-reUSD 3× entry then exit lost 0.04–0.08% at NAV.

**Known limitation (2026-10-30):** KyberSwap's route for ~2.4M+ reUSD → USDC
passes through a Uniswap v4 hook pool that reverts on mainnet itself
(`Call failed`; routes for 0.1–1M execute, and the same 2.43M route without
`uniswap-v4` executes for $27 less). The pre-sign simulation catches it and the
re-quote ladder returns the same route, so such exits stop at "aggregator
route kept failing" (nothing is sent). Workarounds: set `ZEROX_API_KEY` (0x
routes), or exit in parts with fixed amounts from the Builder.

Executors deployed before reUSD support lack the two reUSD aggregator
recipients; Setup shows them as one-time `setRecipient` transactions.

**DEX vs. official redemption (shown under every reUSD sale on Review and in
the Builder):** the swap's cost against Re's NAV (Re's own redemption price
router), quoted and at the guard's worst case, next to Re's live
`InstantRedemption.feeBps` on the same reUSD (6 bps on 2026-10-30), and the
difference. It also states whether official redemption is open, its payout
token, and its per-call cap, read live from the RedemptionGateway
(`0x8aEb…E31e`, in `registry.re`; read-only, not allowlisted). Example on
2026-10-30: 412.5k reUSD → 456.5k USDC quoted, 0.34% ($1,548) under NAV vs a
$275 official fee, +$1,273.

> **Risk note (shown on Review and Enter for PT-reUSD):** reUSD/reUSDe carry
> reinsurance underwriting risk. A payout event can produce negative yield,
> which matters for a leveraged loop near its LLTV.

### 6.6 Aave v3 Core (USDC / USDT)

| Block | Calls | Notes |
|---|---|---|
| `aave.supply` | `approve(Pool)` → `Pool.supply(asset, amount, owner, 0)` | Supplies from the Executor **for you** (`onBehalfOf` pinned to the owner/Executor). `all` = the Executor's balance |
| `aave.withdraw` | `aToken.transferFrom(owner, executor, amount)` → `Pool.withdraw(asset, max, executor)` | Aave only withdraws `msg.sender`'s aTokens, so your supply is pulled first. `all` = your live aToken balance. Needs the one-time aToken approval |
| `aave.borrow` | `Pool.borrow(asset, amount, 2, 0, owner)` | Variable rate, debt on your account, funds to the Executor (then swept to you or used in the plan). Needs credit delegation (`approveDelegation` on the variable debt token) |
| `aave.repay` | `approve(Pool)` → `Pool.repay(asset, amount, 2, owner)` | `all` patches the amount to your **live variable debt token balance**: Aave rejects `type(uint256).max` on behalf of someone else, and the balance is exact at execution. `balance` repays up to the Executor's balance (Aave caps at the debt; the rest is swept back) |
| `guard.aaveHealth` | `assertMinAaveHealth(owner, min)` | Whole Aave account (`getUserAccountData`) |
| `guard.aaveNoDebt` | `assertMaxBalance(variableDebtToken, owner, 0)` | |

A Morpho flash loan or a swap's minimum output can be sized to `aaveDebt`, so an
Aave position closes in one transaction: flash-borrow the debt from Morpho,
repay all, pull and withdraw all aTokens, Morpho takes its loan back.

**Allowlist:** `Pool.supply` (word 2 pinned), `withdraw` (word 2), `borrow`
(word 4), `repay` (word 3); aEthUSDC/aEthUSDT `transferFrom` (owner ↔ Executor)
and `transfer` (owner only). Debt tokens have **no** rule: a plan can never
re-delegate your credit. USDC and USDT are the only tokens approvable to the Pool.

**Status (2026-10-29):** Aave governance has frozen every v3 Ethereum reserve
with LTV 0 (Core and Prime). Repay and withdraw work; supply and borrow revert
with `ReserveFrozen` until Aave unfreezes. The Positions page reads the freeze
flag live, and the simulation explains Aave reverts (frozen reserve, missing
delegation or aToken approval).

### 6.7 Aave v4 Main Spoke (USDC / USDT)

Aave v4 (Hub & Spoke, live on Ethereum since 2026-03-30) only lets
`onBehalfOf` itself, or a **governance-activated** position manager the user
approved, act on a position: `supply`, `withdraw`, `borrow` and `repay` all
check it.

- **EIP-7702 mode (§5.4):** your account is the caller, so plans call the Spoke
  directly — `Spoke.supply / withdraw / borrow / repay(reserveId, amount, you)`
  — with no position managers or allowances. Supply and repay spend only what
  the plan allots or brings in; the Spoke allowance is reset at the end.
- **Executor:** it can't be activated, so it uses Aave's own managers: the
  Giver (supply / repay for anyone, pulls from the caller) and the Taker
  (withdraw / borrow within allowances you grant the Executor).

| Block | EIP-7702 | Executor | Notes |
|---|---|---|---|
| `aaveV4.supply` | `approve(Spoke)` → `Spoke.supply` | `approve(Giver)` → `Giver.supplyOnBehalfOf(spoke, …)` | `all` = what the plan holds (allotted + received / the Executor's balance) |
| `aaveV4.withdraw` | `Spoke.withdraw` | `Taker.withdrawOnBehalfOf(spoke, …)` | Funds go to the caller. `all` = `type(uint256).max`, which the Spoke caps at your supply |
| `aaveV4.borrow` | `Spoke.borrow` | `Taker.borrowOnBehalfOf(spoke, …)` | Debt on your position, funds to the caller |
| `aaveV4.repay` | `approve(Spoke)` → `Spoke.repay` | `approve(Giver)` → `Giver.repayOnBehalfOf(spoke, …)` | `all` patches the amount to your live debt (`AAVE_V4_DEBT` source: `Spoke.getUserTotalDebt`, drawn + premium; the Giver rejects `type(uint256).max`). `balance` repays up to what the plan holds (capped at the debt) |
| `guard.aaveV4Health` | `assertMinAaveV4Health(spoke, owner, min)` | same | `Spoke.getUserAccountData(owner).healthFactor` |
| `guard.aaveV4NoDebt` | `assertNoAaveV4Debt(spoke, reserveId, owner)` | same | |

A Morpho flash loan or a swap's minimum output can be sized to `aaveV4Debt`
(the same source), so a v4 position closes in one transaction like a v3 one.
v4 has no aTokens or debt tokens: the simulation reports your v4 supply, debt
and health factor after the plan.

**Setup (optional card, all from your wallet):**
`Spoke.setUsingAsCollateral(reserveId, true, you)` per reserve you borrow
against — the only step under EIP-7702. With an Executor, also
`Spoke.setUserPositionManager(Giver | Taker, true)` once and
`Taker.approveBorrow / approveWithdraw(spoke, reserveId, executor, max)` per
reserve; Access lists and revokes those allowances (`… , 0)`). The Giver lets
anyone supply or repay for you, which can't hurt you.

**Allowlist:** `Spoke.supply / withdraw / borrow / repay` with `onBehalfOf`
(word 2) pinned, and Giver `supplyOnBehalfOf` / `repayOnBehalfOf` and Taker
`withdrawOnBehalfOf` / `borrowOnBehalfOf` with `onBehalfOf` (word 3) pinned (the
Spoke must be one Aave registered with the manager). Taker `approve*`, Spoke
`setUserPositionManager` / `setUsingAsCollateral` have **no** rule: a plan can
never grant v4 access. Only USDC and USDT can be approved to the Spoke or the
Giver. Adding v4 changed `MainnetConfig`, so `CONFIG_VERSION` is 2 and the
delegate's address moved (a new Ledger app build and authorization; no real
device had delegated yet).

**Status (2026-10-30):** every reserve on the Main Spoke (and on the Bluechip,
USDG Pendle and Ethena Correlated Spokes) is frozen: repay and withdraw work,
supply, borrow and enabling a new collateral revert with `ReserveFrozen`. The
Positions page reads the flags live.

---

## 7. Templates (v1)

### 7.1 Flash-unwind PT loop (primary)

**Every unwind uses a Morpho flash loan** (§2). One fee-free loan covers the
whole debt, so the position closes in a single pass. That's no repeated
withdraw/repay rounds, the gas cost doesn't grow with leverage, and nothing is
left at a worse health factor midway. The partial and YT-shortfall unwinds
(§6.3, §7.3) and USDT-debt loops use the same flash structure.

Parameters: `market` (PT-USD3/USDC A or B, PT-USD3/USDT, PT-reUSD/USDC), `yt`
amount, `minOut`, and the swap route for USDT and PT-reUSD markets.

```
morpho.accrueInterest(market)
wallet.pull(YT, = collateral)                      [one-time approval, no extra signature]
morpho.flashLoan(loanToken, amount = debt(market) × 1.0001)
  ├─ loanToken.approve(Morpho, all)
  ├─ morpho.repay(market, shares = all, onBehalf = EOA)
  ├─ morpho.withdrawCollateral(market, all, onBehalf = EOA, receiver = executor)
  ├─ pendle.redeemPY(PT, YT) → SY-USD3             [needs YT ≥ PT pre-maturity]
  ├─ pendle.redeemSY(all SY) → USDC                [SY-USD3 redeems via 3Jane]
  ├─ (USDT market only) swap.aggregator(USDC → USDT, quoted to buy ≈ debt × 1.0010)
  │     guard.minBalance(USDT, ≥ debt × 1.0002)
  └─ (flash loan repaid from the executor's loanToken)
guard.zeroDebt(market)
wallet.sweep([USDC, USDT, PT, YT, SY, USD3])
```

**USDT-debt markets:** SY-USD3 only pays out USDC or USD3, so the template sells
just enough USDC to repay the USDT flash loan. Everything else comes back as
USDC, plus about 0.1% of the debt as leftover USDT.
- **Sizing the swap:** the quote targets debt + 0.10%, while the on-chain guard
  only requires debt + 0.02%. That leaves room for the route to drift between
  quote and execution.
- **If the pre-sign simulation trips the guard,** the app re-quotes with more
  headroom (0.10% → 0.30% → 0.60%) before asking you to sign.
- **Fork test:** a real 688k-USDT position returned about 105.5k USDC and about
  680 USDT.

**Result:** one transaction leaves you with pure USDC (equity = collateral value
− debt − slippage) and zero debt, with the YT burned.

**If YT is short:** the template switches to the matched unwind in §6.3. The
flash loan and withdrawal are sized to the YT held, and the result is either
USDC plus unlevered PT in your wallet, or a smaller, safer loop.

### 7.2 Iterative unwind (fallback only)

This is only used if a flash loan is ever unavailable for the loan asset. Morpho
currently holds about 135M USDC and 27.7M USDT for flash loans, so it isn't
built in v1. It would repeat withdraw → redeem → repay `k` times inside one
transaction, each time staying above a target health factor. That costs much
more gas than §7.1 and grows with leverage.

### 7.3 Partial deleverage

Like 7.1, but the flash amount is `pct(debt, bps)` and the collateral withdrawn is
sized to a target leverage or HF.

### 7.4 Enter / re-lever PT loop

```
wallet.pull(USDC equity)
morpho.flashLoan(USDC, amount = equity × (L − 1))
  ├─ (USDT market) swap.aggregator(USDT → USDC, all flash)  + guard.minBalance
  ├─ pendle.SY.deposit(all USDC) → SY-USD3        (deposits into USD3; subject to 3Jane's cap)
  ├─ pendle.mintPY(all SY) → PT + YT              (YT to EOA; no AMM buy)
  ├─ morpho.supplyCollateral(all PT, onBehalf)
  └─ morpho.borrow(flashAmount, onBehalf, receiver = executor)
guard.healthFactor(market, ≥ targetHF)
wallet.sweep
```

### 7.5 Roll PT maturity / Migrate market

**Move between markets (built, M2):** for two markets with the same collateral
and loan token, for example PT-USD3/USDC A → B, a flash loan repays all debt on
the source market and withdraws all collateral. It then supplies the collateral
to the destination, borrows there to repay the flash loan, and checks there's no
debt left on the source and the destination's health factor. There's no Pendle
step. The destination needs enough lender liquidity: A and B are both about 100%
borrowed today, so simulation will show when a move can't fit.

**Roll (M3):** a flash loan closes market A and opens market B (for example
PT-USD3-DEC → PT-USD3-MAR, or PT-USD3 → PT-reUSD) in one transaction. The old PT+YT are
**redeemed** and the new PT+YT are **minted**. Nothing is traded on Pendle, so a
roll also needs YT ≥ PT for the old maturity.

---

## 8. Ledger signing UX and safety

The Executor's `execute(Call[])` calldata is dynamic, so the Ledger **will
blind-sign** it (Ethereum app → enable Blind signing). Mitigations:

1. **Two independent previews:** Covenant's decoded review screen (below) and
   Rabby's own pre-sign simulation, both before the Ledger prompt. If they
   disagree, don't sign.
   **Covenant's decoded review screen**: each block in plain English, the
   resolved addresses (with labels from the registry), the min/max bounds, and
   the simulated balance diff for the EOA ("−0 PT-USD3, −0 YT-USD3, +412,331.22
   USDC, debt 389,004.10 → 0").
2. **What to check on the Ledger and in Rabby:** the transaction goes to *your*
   Executor (the address is shown on the Review screen) and calls `execute`.
   - Covenant can't predict the final transaction hash, because Rabby sets the
     nonce and gas.
   - Instead it shows the plan hash (emitted on-chain in `Executed`) and the
     calldata hash, and asks you to compare Rabby's simulation with its own.
   - The Executor address is verified against the compiled bytecode (immutables
     masked) and must be owned by your account, so a look-alike contract is
     rejected before any plan is built.
3. **ERC-7730 clear-signing descriptor** for `CovenantExecutor` (v1.1): it can at
   least clearly display the function, the `planHash` and the value. The one-time
   setup transactions (`setAuthorization`, ERC-20 `approve`) are simple calls
   that the Ledger can show clearly.
4. **Simulation is mandatory:** the Sign button is disabled until a simulation
   passes against the latest block.
   - **On mainnet** it uses `eth_simulateV1`; **on the local fork** it uses
     snapshot, send and revert.
   - **While Review is open,** it re-simulates every block, and Sign is disabled
     when the last result is more than 3 blocks old.
   - **Minimum received:** the final plan is rebuilt with the *same* aggregator
     route plus a guard that you receive at least 99.5% of the simulated amount.
   - **If the aggregator leg fails** (the route reverted or delivered too little),
     the app re-quotes with more headroom (0.1% → 0.3% → 0.6%).
5. **On-chain guards everywhere:** every value-moving block has a `minOut` or
   guard. Even a mis-simulated transaction can't settle at bad prices.
6. **MEV protection is required for every transaction.** Rabby broadcasts, so
   the protected RPC is set in Rabby (Settings → Custom RPC → Ethereum):
   - **Flashbots Protect** (`https://rpc.flashbots.net`), recommended.
   - **MEV Blocker** (`https://rpc.mevblocker.io/noreverts`).

   Both drop failing transactions instead of charging gas for them. Setup asks
   you to confirm this, and every Sign and Send button stays disabled until you
   do. Revokes are the only exception: they always work.

   After each transaction, the app asks Flashbots Protect's public status API
   (`protect.flashbots.net/tx/<hash>`) how it was routed. It shows **"Sent
   privately"**, or a red warning if the transaction was seen in the public
   mempool. MEV Blocker has no such API, so it's shown as unchecked.

---

## 9. UI spec

### 9.1 Screens
1. **Positions:** auto-detected Morpho positions for the EOA and the Executor:
   collateral, debt, HF, LTV/LLTV, PT maturity, YT balance, the underlying's
   redeemable liquidity. Each row has one-click actions: **Unwind**, **Partial**,
   **Re-lever**, **Roll**. Below them, your Aave v3 and Aave v4 (Main Spoke)
   USDC/USDT supply and debt, each health factor, and which reserves Aave has
   frozen.
2. **Builder** (`#/builder`, built in M2):
   - **Left: the block palette.** 26 blocks grouped as Wallet, Morpho, Aave v3,
     Aave v4, Pendle, Swap and Guard.
     - **Search:** `/` focuses search, and Enter adds the top match. Title
       matches rank first, so "redeem sy" adds *Redeem SY*.
     - **Adding:** click a block to append it, or drag it to an exact spot.
   - **Center: the chain.**
     - **Arranging:** drag to reorder or into a flash loan (native HTML5
       drag-and-drop, no library). ↑ ↓ ⧉ ✕ buttons give the same moves without
       dragging.
     - **Flash loans:** selecting one makes new blocks go inside it.
     - **Editing:** each block has its own editors. Amount kinds are limited to
       what that block supports.
     - **Validation:** checks run instantly and show on each block:
       - an empty or nested flash loan;
       - an attempt to swap a Pendle asset;
       - redeeming PT before maturity with no YT reaching the Executor;
       - invalid amounts.
   - **Right side:**
     - **Start from:** templates built from your open positions, plus Enter.
     - **Check & simulate:** the same `eth_simulateV1` path and re-quote ladder
       as Review, re-simulated every block. A one-click "receive at least 99.5%"
       adds guards from the simulation.
     - **Sign:** the same Sign panel and gates as Review.
   - **Flows:** saved in this browser, exported or imported as JSON, or shared
     as a URL fragment (it only opens on your own local Covenant).
3. **Review & Sign:** the decoded plan, the diff, the hash, then the sequential
   Ledger prompt: normally a single transaction.
4. **Templates:** saved plans with parameters. Import/export as JSON, and share
   by URL fragment (no server).
5. **Settings:** RPC, simulation provider key, private RPC toggle, the Executor
   address and allowlist, deploying the Executor.
   - **One-time setup wizard:** deploy the Executor, call
     `setAuthorization(executor, true)` on Morpho, and approve the loop tokens
     to the Executor. That's roughly 3–6 Ledger transactions, done once.
     Optional Aave steps: credit delegation (for the Aave Borrow block) and
     aEthUSDC/aEthUSDT approvals (for Withdraw), one per reserve. Optional Aave
     v4 steps (§6.7): approve the Giver and Taker on the Main Spoke, use a
     supply as collateral, and Taker borrow / withdraw allowances per reserve.
   - **Revoke:** see §9.3. It's also on every screen, not just in Settings.

### 9.3 Executor access and revoke (always visible)

You can see at a glance whether the Executor can act for you, and turn that off
in one click.

- **Access badge on every screen,** in the header. It reads live on-chain state
  every block:
  - `Morpho.isAuthorized(you, executor)`.
  - `allowance(you, executor)` for every loop token (USDC, USD3, reUSD, PT and YT
    for each market), and for aEthUSDC / aEthUSDT.
  - Aave credit delegation: `borrowAllowance(you, executor)` on each variable
    debt token.
  - Aave v4: `Taker.borrowAllowance / withdrawAllowance(spoke, reserveId, you,
    executor)` per reserve.
  - It shows **"Executor access: ON"** (amber) with a count, or **"OFF"** (grey).
  - Clicking it opens the Access panel.
- **Access panel:**
  - A list of each permission with its current value (authorized yes/no, the
    allowance amount or "unlimited") and its own **Revoke** button.
  - **Revoke all:** a big red button. It queues
    `Morpho.setAuthorization(executor, false)`, `approveDelegation(executor, 0)`
    on each Aave debt token with a delegation, plus `approve(executor, 0)` for
    each non-zero allowance, then walks through the Ledger prompts one by one
    with a checklist. Each row turns green once it's mined and the badge
    re-reads the chain.
- **Revoke goes directly from your wallet** to Morpho and the token contracts.
  It never goes through the Executor, so it works even if the Executor is buggy
  or paused. These are simple calls that Rabby and the Ledger display clearly,
  with no blind signing.
- **Revoke has no dependencies.** It doesn't need simulation, quotes or the
  plan compiler, only Rabby and an RPC.
  - It has its own route, `/#/revoke`.
  - It also stays reachable from the app's error screen, so it works when the
    rest of the app fails.
- **Fallback without Covenant:** the Access panel shows the exact contract,
  function and arguments, so you can revoke from Etherscan's "Write contract"
  tab.
  - Morpho authorization: `0xBBBB…FFCb` → `setAuthorization(<executor>, false)`.
    Rabby's own Approvals page and revoke.cash list ERC-20 approvals, but **not**
    the Morpho authorization.
  - Aave credit delegation: each variable debt token →
    `approveDelegation(<executor>, 0)`. Not listed by Rabby or revoke.cash either.
  - Aave v4 Taker allowances: Taker → `approveBorrow / approveWithdraw(spoke,
    reserveId, <executor>, 0)`. Not listed by Rabby or revoke.cash either.
  - Token approvals: also listed in Rabby's Approvals page.
- **After revoking,** templates show "Executor access is off" and offer
  **Re-enable** (the setup wizard's authorize and approve steps).
- **Optional "session" mode** (a setting): after each executed plan, the app
  immediately offers to revoke.

### 9.2 Speed features (the "swiftly" requirement)
- **Unwind:** from the Positions page, **Unwind → Review → Sign** takes 3 clicks.
  The same flow opens in the Builder from "Start from".
- **Keyboard:** in the Builder, `/` searches blocks, Enter adds the top match,
  and `⌘↵` / `Ctrl↵` simulates. Signing always takes an explicit click.
- **Measured:** a full unwind assembled block by block from the palette (9
  blocks, 4 market selections, 1 amount), then simulated, takes about **8–9 s**
  in the automated E2E test. That leaves plenty of room against the 60 s goal for
  a person.
- **Background:** Review and Builder re-simulate every new block.

### 9.4 Performance (measured, `app/e2e/perf.spec.ts`)

| Positions page (warm local fork) | Before | After | Budget (test fails above) |
|---|---|---|---|
| Time until positions show | 958 ms | ~180–250 ms | 2,000 ms |
| RPC requests during load | 24 | 5 | 8 |
| RPC requests per minute, idle | 84 | 12 (0 in a background tab) | 20 |
| JavaScript on first load | 598 KB | 505 KB | 560 KB |

How:
- **Batching:** concurrent contract reads are merged into one Multicall3 call,
  and other concurrent RPC calls go out as JSON-RPC batches.
- **Positions in two rounds:** all markets are read together in two rounds,
  sharing one block and one Pendle-index read, instead of 3–4 sequential round
  trips per market.
- **Wallet discovery:** Rabby discovery resolves the moment Rabby announces
  itself, instead of always waiting 400 ms.
- **Background tabs:** polling pauses while the tab is hidden and catches up the
  moment it's visible again.
- **Lazy loading:** Builder, Review, Setup and Access load on first visit. The
  Executor bytecode (44 KB) loads only to deploy or verify.
- **Review:** reuses one position snapshot for the draft and final plan.

What remains in the main bundle is viem plus its crypto dependencies and React,
about 160 KB gzipped.

---

## 10. Data and registry

[`registry/mainnet.json`](../registry/mainnet.json) is versioned in git and
reviewed manually. **No address is trusted from an API.**
- **Verified on-chain (2026-10-30):**
  - For Pendle: `YT.PT()`, `YT.SY()`, `expiry()` and SY `getTokensIn`/`getTokensOut`.
  - For Morpho: market parameters via `idToMarketParams`.
- **Contents:** USDC, USDT, USD3, reUSD; Morpho Blue; PT-USD3-17DEC2026 and
  PT-reUSD-10DEC2026 (PT, YT, SY); their Morpho markets; the Aave v3 Core Pool
  with the USDC and USDT aTokens and variable debt tokens (checked with
  `PoolAddressesProvider.getPool`, `Pool.getReserveAToken` /
  `getReserveVariableDebtToken` and each token's `UNDERLYING_ASSET_ADDRESS`); the
  Aave v4 Main Spoke, Giver and Taker (from bgd-labs/aave-address-book, checked
  with `Spoke.getReserve(id).underlying`, `Spoke.isPositionManagerActive` and
  `Giver/Taker.isSpokeRegistered`). **All are supported:**
  - PT-USD3/USDC **A** (`0xf8c5…`) and **B** (`0xecab…`): both 86% LLTV, with
    different oracles.
  - PT-USD3/**USDT** (`0x37a5…`): 91.5% LLTV.
  - PT-reUSD/USDC (`0x1e9d…`): 91.5% LLTV.
- **Aggregators:** the 0x AllowanceHolder (`0x0000…2734`) and the KyberSwap
  MetaAggregationRouterV2 (`0x6131…37b5`). Routes come from
  [`scripts/quote.mjs`](../scripts/quote.mjs): 0x when `ZEROX_API_KEY` is set
  (free tier at dashboard.0x.org), otherwise KyberSwap. The frontend uses the
  same logic.
- **Excluded on purpose:** the Pendle router and market addresses are listed
  under `neverAllowlisted`.
- **Sync:** `contracts/config/MainnetConfig.sol` holds the same addresses for
  the contract allowlist. The two must be kept in sync; M1 adds a test that
  checks this.

Off-chain data sources: Morpho API / subgraph (positions), the Pendle API
(quotes, market data), 3Jane vault `maxRedeem`/`previewRedeem` on-chain, and
aggregator quote APIs. All of them are advisory. The chain is the source of
truth during simulation.

---

## 11. Security model

| Threat | Mitigation |
|---|---|
| Someone else calls the Executor | `onlyOwner`. Callbacks are gated by sender **and** a transient "executing" flag |
| Malicious callback re-enters mid-plan | Transient reentrancy lock. Callbacks only run inner calls passed in by `execute` |
| The standing Morpho authorization gets abused | Only the Executor holds it, and only the owner can drive the Executor. Callbacks are gated (§5.1). There's a one-click Revoke. The Executor is immutable, so new versions mean revoke-then-reauthorize |
| The standing Aave credit delegation / aToken approval gets abused | Same as Morpho: only the owner drives the Executor; borrow `onBehalfOf` and withdraw `to` are pinned to the owner/Executor, debt tokens have no allowlist rule (no re-delegation), aTokens can only go back to the owner; optional, per reserve, revocable in Access |
| The standing Aave v4 Taker allowances get abused | Same model: only the owner drives the Executor, `onBehalfOf` is pinned, the Executor can't grant or change v4 permissions (no rule for Taker `approve*` or Spoke `setUserPositionManager`); optional, per reserve, revocable in Access |
| Funds left in the Executor | Final sweep plus an "ends empty" invariant |
| Leftover approvals | Exact amounts, reset at the end. Permit2 with short expiry |
| Bad quote or sandwich | On-chain `minOut` per swap or redeem. Private RPC. Simulation at the latest block |
| Pendle assets get traded by mistake | No Pendle router or market on the allowlist. Selector and recipient checks on PT/YT/SY (§5.1) |
| A compromised frontend builds a malicious plan | Local-only build from your own clone, bound to 127.0.0.1, lockfile-pinned dependencies, strict CSP; target allowlist on-chain; decoded review + hash match; `rescue` is owner-only |
| Registry typo | Allowlist changes are separate owner transactions, shown in a diff |
| Protocol risk (3Jane liquidity, reUSD underwriting losses, PT stranded by a YT shortfall) | Surfaced as preflight warnings with live numbers |

**Audit plan:** Executor < ~300 SLOC. Unit tests, fork tests for every
template against mainnet state, invariant fuzzing (ends empty, only owner, flash
loan always repaid), then an external review before moving significant size.

---

## 12. Testing

- **Tooling:** the contracts and Solidity tests run under **Hardhat 3** (`pnpm
  test`) and **Foundry** (`forge test`). Both use the same files and
  `remappings.txt`. Fork tests need `MAINNET_RPC_URL`.
- **Unit tests** (`test/CovenantExecutor.t.sol`, no fork): owner-only access,
  flash-callback gating, Pendle router rejected, PT/YT recipients restricted,
  `transferFrom` limited to the owner, Morpho receivers and `onBehalf` pinned,
  `setAuthorization` blocked from plans, patch bounds checked, Aave
  `onBehalfOf`/`to` pinned, aTokens only back to the owner, no credit
  re-delegation, only USDC/USDT approvable to the Pool; Aave v4 `onBehalfOf`
  pinned on the Giver and Taker, Taker allowances and Spoke position managers
  never grantable from a plan, only USDC/USDT approvable to the Giver.
- **Fork tests** (latest mainnet block, real positions impersonated):
  - `test/fork/PtUsd3Usdc.t.sol` (`pnpm test:fork`):
    - **Market A real position:** 597k PT, 447k USDC debt, HF 1.10. Fully
      unwound in one transaction, with **149.8k USDC** returned.
    - **Market B real position:** 1.26M PT, 1.03M USDC debt, HF 1.02. Fully
      unwound, with **229.2k USDC** returned.
    - **Enter then exit, A and B:** a 3x loop from 10k USDC, unwound a day later,
      returned 9,982 and 9,989 USDC.
    - **YT shortfall:** a matched unwind with 40% of the YT missing. Debt is
      reduced, HF goes up, and nothing is sold.
  - `test/fork/PtUsd3Usdt.t.sol` (`pnpm test:fork:aggregator`, live
    aggregator routes via `vm.ffi`; ffi is enabled only in this test profile):
    - **USDT real position:** 793k PT, 688k USDT debt. It sold about 688k USDC
      for USDT through KyberSwap inside the flash loan, and returned **about
      105.5k USDC** plus about 680 USDT.
    - These tests use the simulate-then-re-quote loop from §8. 8 consecutive
      runs passed. Runs can still fail on the free public RPC ("block not
      found"); use your own RPC endpoint.
    - **Enter then exit, USDT:** USDT is flash-loaned and swapped to USDC on
      entry, then swapped back on exit. The round trip lost less than 0.01%.
  - In every test: debt and collateral end at 0, the YT is consumed exactly,
    and the Executor ends empty.
  - The entry tests mock USD3's deposit limit when the live cap is full, and log
    when they do.
  - `test/fork/AaveV3.t.sol` (`pnpm test:fork`; USDC/USDT unfrozen on the fork
    to open positions): supply 100k USDC + borrow 60k USDC, then — re-frozen
    as on mainnet — close in one transaction with a Morpho flash loan of exactly
    the Aave debt (repay all, pull + withdraw all aUSDC); USDT debt against USDC
    collateral repaid in part and then in full from the wallet; both Aave guards.
    The Executor ends with no aTokens (they aren't swept).
  - `test/fork/AaveV4.t.sol` (`pnpm test:fork`; Main Spoke USDC unfrozen on the
    fork through the SpokeConfigurator): Setup from the wallet (Giver + Taker,
    collateral, Taker allowances), supply 100k + borrow 60k USDC via the
    Giver/Taker, both v4 guards, then — re-frozen — a 30-day-old position closed
    in one transaction with a Morpho flash loan of exactly the v4 debt (repay all
    via the `AAVE_V4_DEBT` patch, withdraw all). Borrowing without a Taker
    allowance reverts with `InsufficientBorrowAllowance`. EIP-7702: the
    delegated account supplies 100k / borrows 60k on the Spoke itself (only the
    allotted USDC spent, no position managers), then closes the same way; no
    Spoke allowance is left behind.
- **Compiler (M1):** golden tests from Plan JSON to calldata, checked against
  the Solidity `test/utils/Plans.sol` prototype.
- **App unit tests** (`app/test/unit`, 15 tests, no network): patch offsets
  point at the right argument words, flash data round-trips, deleverage redeems
  only matched PT, USDT plans carry the swap guard, unwind-mode selection,
  nested revert decoding, and swap sizing against a mocked aggregator.
- **App integration tests** (`app/test/integration`): the TypeScript-compiled
  plans run on a Hardhat mainnet fork.
  - **Covered:** deploy → bytecode verification → setup; full unwind of a real
    market A position; deleverage (90% YT); USDT market with a live aggregator
    route; partial unwind (40% YT); look-alike Executor rejection; Revoke all.
  - **Production path:** an `eth_simulateV1` test runs against live mainnet,
    read-only, with the Executor placed via state overrides.
- **Builder tests:**
  - **Unit:** templates compile byte-for-byte to the plan compiler's output;
    validation; search ranking; share-link round trip; the flash-repayment
    error hint.
  - **Integration (fork):** a real 597k-PT loop moved from market A to B in one
    transaction, then unwound on B with a flow assembled block by block. Aave
    (`aave.test.ts`): Setup incl. the Aave steps, open via Builder blocks, a
    frozen-reserve supply explained by the simulation, close via a flash loan
    sized to the Aave debt, Access lists and revokes the delegations. Aave v4
    (`aaveV4.test.ts`): the same end to end on the Main Spoke for both the
    Executor (Giver / Taker, Taker allowances in Access) and EIP-7702 (Spoke
    directly, collateral-only setup), with the v4 simulation readout.
  - **E2E:** builds the unwind from the palette, simulates, signs, and checks
    the position closed.
- **Dev-fork lock:** dev-fork simulation runs snapshot, send and revert. Every
  simulation and every send in a tab share one lock, so a background
  re-simulation can't revert your signed transaction. Two Covenant tabs on the
  same fork can still interfere, so use one tab (or run E2E with `workers: 1`).
  This doesn't apply on mainnet, where `eth_simulateV1` is stateless.
- **E2E** (`app/e2e`, Playwright): the built app against a local fork, with a
  mock Rabby announced over EIP-6963. It connects, confirms the MEV RPC,
  deploys and verifies the Executor, authorizes and approves, unwinds a real
  597k-PT loop in one transaction, and revokes everything. Screenshots are in
  `app/e2e/screenshots/`.
- **Real Ledger + Rabby dry run** (recommended before the first mainnet run):
  1. Run `pnpm fork` (a Hardhat mainnet fork on `127.0.0.1:8545`, chain id 31337).
  2. Start the app with `VITE_DEV_FORK=1 VITE_RPC_URL=http://127.0.0.1:8545`.
  3. In Rabby, add a custom network: chain id 31337, RPC `http://127.0.0.1:8545`.
     Never add the fork as "Ethereum" on chain 1: a transaction signed for a
     chain-1 fork could be replayed on mainnet.
  4. Your real account and positions exist on the fork. Run setup, an unwind and
     a revoke with the real Ledger.

---

## 13. Milestones

| # | Scope | Exit criteria |
|---|---|---|
| M0 ✅ | Registry + verified addresses; Executor with patches, flash callback, guards | Fork test: flash-unwind of a real PT-USD3 Morpho loop passes |
| M1 (built) | Compiler + simulation; UI (Positions, Review/Sign, Setup with deploy + verify, **Access/Revoke**); Rabby + Ledger signing; MEV-protected RPC; local `pnpm start` | ⏳ Real unwind of a small position on mainnet from a Ledger (needs you) |
| M2 (built) | Builder UI (palette, drag-drop, amounts, validation), templates 7.1–7.4 + move A→B, save/export/share | ✅ Custom unwind built and simulated in ~9 s (automated E2E) |
| M3 (part: reUSD built) | PT-reUSD templates via aggregator swaps (✅; Re's own mint/redeem is KYC-gated, §6.5), roll/migrate | ✅ reUSD loop entry and exit on a fork; then mainnet |
| M4 (part: 7702 built) | EIP-7702 mode (✅ §5.4: delegate, Ledger app build, CLI, app support), ERC-7730 descriptor | ✅ 7702 unwind/enter on forks; ⏳ first delegation from a real Nano S Plus |

---

## 14. Decisions and open questions

### Decided (2026-10-30)
1. **Lending venue:** Morpho Blue for the PT loops. Aave v3 Core and the Aave
   v4 Main Spoke (USDC/USDT) are further venues for Builder blocks; PT-USD3 and
   PT-reUSD aren't listed on Aave.
2. **Position ownership:** the simpler option. Positions stay under the EOA,
   with a one-time standing authorization for the Executor (§5.2).
3. **YT coverage:** YT may not always cover the PT, so shortfall handling is a
   default part of every unwind (§6.3).
4. **Chain:** Ethereum mainnet only, including for the reUSD loops.
5. **Pendle:** redeem only. The contract never buys or sells PT, YT, SY or LP,
   and this is enforced on-chain (§5.1). A YT shortfall means a matched or
   partial unwind, never a PT sale (§6.3). **Minting and redeeming PT+YT is
   allowed** (for entry, exit and rolls).
6. **Wallet:** Rabby, with the Ledger attached. No other connectors (§3).
7. **Hosting:** local only, served on 127.0.0.1 from your own clone. No public
   or IPFS deploy (§3).
8. **Markets:** PT-USD3/USDC A and B, PT-USD3/USDT and PT-reUSD/USDC are all
   supported. The Positions page detects which ones you're in.
9. **Stablecoin swaps:** a major aggregator (0x by default, KyberSwap as the
   keyless fallback) instead of a single DEX pool. Only USDC, USDT and reUSD
   are swapped, never Pendle assets.
10. **Unwinds use flash loans** (a single pass) in every template.
11. **MEV protection:** every transaction goes through Flashbots Protect or MEV
    Blocker, set as Rabby's Ethereum RPC. Signing is blocked until you confirm
    it, and routing is checked through Flashbots' status API (§8).

### Answered during M0
- **SY-USD3 → USDC directly:** yes. `redeemSY(tokenOut = USDC)` replaces the
  separate USD3 redemption step.
- **3Jane liquidity:** about 4.53M USDC redeemable at once (2026-10-30). Deposits
  are capped and whitelisted, and capacity was ~0 at the time of writing, so
  entering with USDC can be blocked (§6.4).

### Still open
1. **First real run (M1 exit):** deploy your Executor from your Ledger and unwind
   a small position on mainnet. Everything up to the real device has been
   tested on forks and with a mock wallet.
2. ~~**reUSD mint/redeem on Ethereum:** permissioned? Instant or queued?~~
   Answered: KYC-gated, and instant redemptions pay sUSDe. Exits and entries
   swap reUSD ↔ USDC through the aggregator (§6.5).
3. **0x API key:** the fork tests used KyberSwap because there's no key in this
   environment. Set `ZEROX_API_KEY` to make 0x the default, and to run the USDT
   tests against 0x routes.
4. **First 7702 delegation from the Nano S Plus (§5.4):** the Docker build,
   sideload and device APDUs (`0x02`, `0x34`, `0x04`) are untested on hardware;
   everything else ran on forks with a key signer. The delegate isn't deployed
   on mainnet yet (Setup → Deploy). Freeze the contracts before signing: any code
   change moves the delegate's address and needs a new app build and authorization.
