# Covenant: Transaction Composer for Ledger

**Status:** v0.7 (M0 done, M1 built; awaiting a real-Ledger mainnet run) · **Owner:** fish · **Date:** 2026-10-30

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
- Supporting every protocol. v1 covers Morpho Blue, Pendle V2, 3Jane, Re Protocol
  and generic ERC-20/ERC-4626 and DEX-aggregator blocks.
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
| EIP-7702 (EOA delegates to Executor code) | Yes | Yes | Ledger limits 7702 to vetted contracts | **v2 path.** Same Executor code, so it's a drop-in later |
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
| **Block** | One typed step with inputs, outputs and a compile function that emits one or more `Call`s. |
| **Plan** | An ordered list of blocks with wired amounts. Serializable JSON that can be shared, diffed and saved as a template. |
| **Amount ref** | How a block gets its amount: `fixed(x)`, `balance(token)`, `output(blockId)`, `pct(ref, bps)`, `debt(market)`, `collateral(market)`. Resolved **on-chain at execution time**, not at signing. |
| **Guard** | An assertion block that reverts the whole transaction if it fails (min out, min health factor, the Executor ends with a zero balance, ...). |
| **Template** | A saved plan with parameters (for example "Flash-unwind PT loop" with `market`, `pt`, `yt`, `redeemPath`). |

### Plan JSON (sketch)

```jsonc
{
  "version": 1,
  "chainId": 1,
  "blocks": [
    { "id": "fl",  "type": "morpho.flashLoan", "token": "USDC", "amount": { "debt": "mkt:PT-USD3/USDC" },
      "inner": ["rp", "wc", "rpy", "rsy", "r3"] },
    { "id": "rp",  "type": "morpho.repay",     "market": "mkt:PT-USD3/USDC", "amount": "all" },
    { "id": "wc",  "type": "morpho.withdrawCollateral", "market": "mkt:PT-USD3/USDC", "amount": "all" },
    { "id": "rpy", "type": "pendle.redeemPY",  "yt": "YT-USD3", "amount": { "output": "wc" } },
    { "id": "rsy", "type": "pendle.redeemSY",  "sy": "SY-USD3", "amount": { "output": "rpy" }, "tokenOut": "USD3" },
    { "id": "r3",  "type": "threejane.redeemUSD3", "amount": { "output": "rsy" }, "minOut": { "pctOfPreview": 9990 } },
    { "id": "g1",  "type": "guard.minBalance", "token": "USDC", "min": "1000e6" },
    { "id": "sw",  "type": "wallet.sweep",     "tokens": ["USDC", "USD3", "PT-USD3", "YT-USD3"] }
  ]
}
```

---

## 5. Smart contracts

### 5.1 `CovenantExecutor`

A personal, non-upgradeable contract with a single owner. It's implemented in
[`contracts/CovenantExecutor.sol`](../contracts/CovenantExecutor.sol), about 300
lines.

```solidity
enum Source { BALANCE, MORPHO_COLLATERAL, MORPHO_BORROW_SHARES, MORPHO_DEBT_ASSETS }

struct Patch {
    uint32 offset;   // byte offset in `data` of the uint256 word to overwrite (>= 4)
    Source source;   // value read on-chain at execution time
    bytes  args;     // (token, account) or (marketId, user)
    uint32 bps;      // scale, 10_000 = 100% (e.g. 10_001 = debt + 0.01% buffer)
}

struct Call { address target; bytes data; Patch[] patches; }

function execute(Call[] calldata calls, address[] calldata sweep, bytes32 planHash) external; // onlyOwner
function onMorphoFlashLoan(uint256 assets, bytes calldata data) external; // data = abi.encode(token, Call[])

// Guards, callable from plans, revert on failure
function assertMinBalance(address token, address account, uint256 min) external view;
function assertNoDebt(bytes32 id, address user) external view;
function assertMinHealth(bytes32 id, address user, uint256 minHealthWad) external view;
```

**Allowlist encoding:** one `uint256` rule per (target, selector).
- Bit 0: the call is allowed.
- Bit `i+1`: argument word `i` must be the owner or the Executor. This is how
  receivers and `onBehalf` are pinned.
- Bit 255: argument word 0 (the ERC-20 `transfer`/`approve` recipient) must be
  on that token's recipient allowlist.

The mainnet rules live in
[`contracts/config/MainnetConfig.sol`](../contracts/config/MainnetConfig.sol) and
are passed to the constructor, so deploying is a single transaction.

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
| `swap.aggregator` | Swap stablecoins (USDC ↔ USDT) via **0x** (default; Swap API v2, AllowanceHolder) or **KyberSwap** (keyless fallback) | Route quoted at build time for a **fixed sell amount**, with the Executor as taker and recipient, and re-quoted if stale. The Executor checks the output with `assertMinBalance` whatever the route data says. Only USDC/USDT can be approved to an aggregator, so **Pendle assets can never be routed** (§5.1) |
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

### 6.5 Re Protocol (reUSD / reUSDe)

| Block | Does | Notes |
|---|---|---|
| `re.mint` | Approved stablecoin → reUSD | Through Re's Insurance Capital Layer contracts. **Verify whether minting is permissioned or KYC-gated for your address** |
| `re.redeem` | reUSD → stablecoin | **Verify whether redemption is instant or queued.** If queued, it can't be used atomically. Use `swap.aggregator` / a Curve pool for **reUSD** (never PT-reUSD) instead |
| `re.junior*` | reUSDe in/out | Junior tranche with underwriting (insurance-loss) risk. Not used in v1 templates |

PT-reUSD loops on Morpho use the same templates as PT-USD3, with the conversion
step swapped (`re.redeem` or `swap.aggregator` instead of
`threejane.redeemUSD3`).

> **Risk note to surface in the UI:** reUSD/reUSDe carry reinsurance
> underwriting risk. A payout event can produce negative yield, which matters
> for a leveraged loop near its LLTV.

---

## 7. Templates (v1)

### 7.1 Flash-unwind PT loop (primary)

**Every unwind uses a Morpho flash loan** (§2). One fee-free loan covers the
whole debt, so the position closes in a single pass. That's no repeated
withdraw/repay rounds, the gas cost doesn't grow with leverage, and nothing is
left at a worse health factor midway. The partial and YT-shortfall unwinds
(§6.3, §7.3) and USDT-debt loops use the same flash structure.

Parameters: `market` (PT-USD3/USDC A or B, PT-USD3/USDT, PT-reUSD/USDC), `yt`
amount, `minOut`, and the swap route for USDT markets.

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

A flash loan closes market A and opens market B (for example PT-USD3-DEC →
PT-USD3-MAR, or PT-USD3 → PT-reUSD) in one transaction. The old PT+YT are
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
   **Re-lever**, **Roll**.
2. **Builder:**
   - Left: the **block palette**, grouped by protocol and searchable (`/`
     shortcut).
   - Center: a **vertical chain** of block cards. Drag to reorder. Container
     blocks (flash loan, repeat) show nested children. Amount inputs offer a
     dropdown: *Fixed · All balance · Output of ▸ block · % of · Debt · Collateral*.
   - Right: a **live simulation panel**: per-step token flow, final balances,
     HF, gas, warnings.
   - Validation inline: an unwired input, a missing approval (auto-fixed),
     flash loan not repaid, PT/YT mismatch, insufficient 3Jane liquidity.
3. **Review & Sign:** the decoded plan, the diff, the hash, then the sequential
   Ledger prompt: normally a single transaction.
4. **Templates:** saved plans with parameters. Import/export as JSON, and share
   by URL fragment (no server).
5. **Settings:** RPC, simulation provider key, private RPC toggle, the Executor
   address and allowlist, deploying the Executor.
   - **One-time setup wizard:** deploy the Executor, call
     `setAuthorization(executor, true)` on Morpho, and approve the loop tokens
     to the Executor. That's roughly 3–6 Ledger transactions, done once.
   - **Revoke:** see §9.3. It's also on every screen, not just in Settings.

### 9.3 Executor access and revoke (always visible)

You can see at a glance whether the Executor can act for you, and turn that off
in one click.

- **Access badge on every screen,** in the header. It reads live on-chain state
  every block:
  - `Morpho.isAuthorized(you, executor)`.
  - `allowance(you, executor)` for every loop token (USDC, USD3, reUSD, PT and YT
    for each market).
  - It shows **"Executor access: ON"** (amber) with a count, or **"OFF"** (grey).
  - Clicking it opens the Access panel.
- **Access panel:**
  - A list of each permission with its current value (authorized yes/no, the
    allowance amount or "unlimited") and its own **Revoke** button.
  - **Revoke all:** a big red button. It queues
    `Morpho.setAuthorization(executor, false)` plus `approve(executor, 0)` for
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
  - Token approvals: also listed in Rabby's Approvals page.
- **After revoking,** templates show "Executor access is off" and offer
  **Re-enable** (the setup wizard's authorize and approve steps).
- **Optional "session" mode** (a setting): after each executed plan, the app
  immediately offers to revoke.

### 9.2 Speed features (the "swiftly" requirement)
- From the Positions page, **Unwind → Review → Sign** takes 3 clicks.
- Keyboard: `/` search blocks, `⌘↵` simulate, `⌘⇧↵` sign.
- Templates prefilled from position data (market, amounts, YT balance).
- Quotes refresh in the background. Simulation reruns every new block while the
  Review screen is open.

---

## 10. Data and registry

[`registry/mainnet.json`](../registry/mainnet.json) is versioned in git and
reviewed manually. **No address is trusted from an API.**
- **Verified on-chain (2026-10-30):**
  - For Pendle: `YT.PT()`, `YT.SY()`, `expiry()` and SY `getTokensIn`/`getTokensOut`.
  - For Morpho: market parameters via `idToMarketParams`.
- **Contents:** USDC, USDT, USD3, reUSD; Morpho Blue; PT-USD3-17DEC2026 and
  PT-reUSD-10DEC2026 (PT, YT, SY); and their Morpho markets. **All are supported:**
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
  `setAuthorization` blocked from plans, patch bounds checked.
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
| M2 | Full Builder UI (palette, drag-drop, amount wiring), templates 7.1–7.4 | Build a new custom flow in < 60s |
| M3 | Re Protocol blocks, PT-reUSD templates, aggregator swaps, roll/migrate | reUSD loop entry and exit on a fork, then mainnet |
| M4 | ERC-7730 descriptor, EIP-7702 mode | Optional: sign with no Executor deployment, via 7702 |

---

## 14. Decisions and open questions

### Decided (2026-10-30)
1. **Lending venue:** Morpho Blue.
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
8. **Markets:** PT-USD3/USDC A and B, plus PT-USD3/USDT, are all supported.
   The Positions page detects which ones you're in.
9. **Stablecoin swaps:** a major aggregator (0x by default, KyberSwap as the
   keyless fallback) instead of a single DEX pool. Only USDC/USDT are swapped,
   never Pendle assets.
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
2. **reUSD mint/redeem on Ethereum:** permissioned? Instant or queued? This
   decides whether exits use `re.redeem` or a swap (M3).
3. **0x API key:** the fork tests used KyberSwap because there's no key in this
   environment. Set `ZEROX_API_KEY` to make 0x the default, and to run the USDT
   tests against 0x routes.
