# Covenant: Transaction Composer for Ledger

**Status:** Draft v0.3 · **Owner:** fish · **Date:** 2026-10-30

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
┌────────────────────────── Browser (static SPA) ───────────────────────────┐
│  Block Builder UI ──► Plan (JSON) ──► Compiler ──► Executor calldata      │
│        ▲                   │                            │                 │
│   Templates           Quote engine               Simulator (fork)          │
│   (local + git)   (Pendle API, 1inch/0x,        balance diffs, HF, gas     │
│                    on-chain previews)                   │                 │
│                                                         ▼                 │
│                                         Ledger (WebHID / Ledger Live /     │
│                                         Rabby or Frame with Ledger)       │
└───────────────────────────────────────────────────────────┬───────────────┘
                                                            ▼
                    Ethereum: CovenantExecutor ──► Morpho / Pendle / 3Jane / Re / DEX
```

- **Frontend:** Vite + React + TypeScript, `viem` + `wagmi`, `dnd-kit` for drag
  and drop, Zustand for state. It's a static site that can be pinned to IPFS or
  run on `localhost`, with no server needed.
- **Wallet connection:** in order of preference,
  1. Direct Ledger over **WebHID** (`@ledgerhq/hw-app-eth`): the shortest path
     and fewest intermediaries.
  2. Rabby or Frame with the Ledger attached.
  3. WalletConnect to Ledger Live.
- **RPC:** a user-supplied RPC URL (stored locally) plus a fallback. Simulation
  uses `eth_simulateV1` where the RPC supports it, otherwise a Tenderly or
  Alchemy simulation API key the user supplies.
- **Contracts:** Foundry. `CovenantExecutor` plus protocol adapters (§5).

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

A personal, non-upgradeable contract with a single owner.

```solidity
struct Call {
    address target;
    uint256 value;
    bytes   data;
    Patch[] patches;   // runtime amount injection
    bool    captureReturn;
}

struct Patch {
    uint16  offset;    // byte offset in `data` to overwrite (a uint256 slot)
    uint8   source;    // BALANCE_OF | RETURN_OF | DEBT_OF | COLLATERAL_OF | CONST
    bytes   args;      // e.g. abi.encode(token) or abi.encode(callIndex, wordIndex)
    uint16  bps;       // scale factor, 10_000 = 100%
}

function execute(Call[] calldata calls, bytes32 planHash) external payable onlyOwner;
```

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
- **Ends empty:** after `execute` the Executor must hold zero of every token it
  touched. Leftovers are swept to the owner in the final step, and an invariant
  check reverts otherwise.
- **No persistent approvals:** approvals the Executor gives are exact-amount and
  reset to 0 at the end of the call (or go through Permit2 with a short expiry).
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
- **Revoke any time:** Settings has a **Revoke** button
  (`setAuthorization(executor, false)`). Deploying a new Executor version means
  revoking the old one and authorizing the new one.

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
| `swap.aggregator` | Swap non-Pendle tokens via 1inch / 0x / Odos | Quote fetched at build time. `minOut` enforced on-chain. Re-quoted if stale > N blocks. **Pendle assets are never allowed as input or output** (§5.1) |
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
| `threejane.depositUSD3` | USDC → USD3 (senior tranche, ERC-4626) | |
| `threejane.redeemUSD3` | USD3 → USDC | No cooldown on USD3, **but redemptions depend on available liquidity**. Preflight reads `maxRedeem`/`maxWithdraw` and the UI warns if the plan exceeds it |
| `threejane.stakeSUSD3` / `requestUnstake` | USD3 ↔ sUSD3 (junior) | sUSD3 has about a 1-month cooldown, so it can't be used inside an atomic exit. Shown as a two-transaction flow |

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

Parameters: `market`, `pt`, `yt`, `underlying` (USD3 | reUSD), `redeemRoute`.

```
morpho.flashLoan(USDC, amount = debt(market) × 1.0005 buffer)
  ├─ morpho.repay(market, shares = all, onBehalf = EOA)
  ├─ morpho.withdrawCollateral(market, all, onBehalf = EOA, receiver = executor)
  ├─ pendle.redeemPY(PT, YT) → SY-USD3         [needs YT ≥ PT pre-maturity]
  ├─ pendle.redeemSY(all SY) → USD3
  ├─ threejane.redeemUSD3(all USD3) → USDC     [minOut = previewRedeem × 0.999]
  └─ (flash loan repaid automatically from executor USDC)
guard.zeroDebt(market)
guard.minBalance(USDC, userMinOut)
wallet.sweep([USDC, USD3, PT, YT])
```

Pulling YT: if there's YT in the EOA, `wallet.pull(YT, full balance)` is added
before the flash loan. It uses the one-time approval from setup, so there's no
extra signature.

**Result:** one transaction leaves you with pure USDC (equity = collateral value
− debt − slippage) and zero debt, with the YT burned.

**If YT is short:** the template switches to the matched unwind in §6.3. The
flash loan and withdrawal are sized to the YT held, and the result is either
USDC plus unlevered PT in your wallet, or a smaller, safer loop.

### 7.2 Iterative unwind (no flash loan)

This mirrors your manual process inside one transaction:

```
repeat k times:
  morpho.withdrawCollateral(amount = maxWithdrawable(market, targetHF))
  pendle.redeemPY → pendle.redeemSY → threejane.redeemUSD3   [withdrawal capped at YT held]
  morpho.repay(all USDC held)
final: withdraw remaining collateral, convert, sweep
```

`k` is computed off-chain from the LTV: each round frees about `(1 − LTV/LLTV_target)`
of the remaining position, so high-leverage loops need many rounds and much more
gas. The UI shows the gas comparison with the flash variant. Use this mode only
if a flash loan isn't available for the loan asset.

### 7.3 Partial deleverage

Like 7.1, but the flash amount is `pct(debt, bps)` and the collateral withdrawn is
sized to a target leverage or HF.

### 7.4 Enter / re-lever PT loop

```
wallet.pull(USDC equity)
morpho.flashLoan(USDC, amount = equity × (L − 1))
  ├─ threejane.depositUSD3(all USDC) → USD3       (or re.mint / swap for reUSD)
  ├─ pendle.mintPY(all USD3) → PT + YT            (YT swept to EOA; no AMM buy)
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

1. **Decoded review screen** before signing: each block in plain English, the
   resolved addresses (with labels from the registry), the min/max bounds, and
   the simulated balance diff for the EOA ("−0 PT-USD3, −0 YT-USD3, +412,331.22
   USDC, debt 389,004.10 → 0").
2. **Hash match:** the UI shows the transaction hash it expects. The Ledger shows
   the same hash on screen in blind-signing mode. You confirm they match.
3. **ERC-7730 clear-signing descriptor** for `CovenantExecutor` (v1.1): it can at
   least clearly display the function, the `planHash` and the value. The one-time
   setup transactions (`setAuthorization`, ERC-20 `approve`) are simple calls
   that the Ledger can show clearly.
4. **Simulation is mandatory:** the Sign button is disabled until a simulation
   passes against the latest block. Re-simulation runs automatically if more
   than ~3 blocks pass or the inputs change.
5. **On-chain guards everywhere:** every value-moving block has a `minOut` or
   guard. Even a mis-simulated transaction can't settle at bad prices.
6. **Private submission (optional):** send through Flashbots Protect / MEV Blocker
   RPC so the unwind can't be sandwiched.

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
   - **Revoke:** one-click buttons to remove the Morpho authorization and
     the token approvals.

### 9.2 Speed features (the "swiftly" requirement)
- From the Positions page, **Unwind → Review → Sign** takes 3 clicks.
- Keyboard: `/` search blocks, `⌘↵` simulate, `⌘⇧↵` sign.
- Templates prefilled from position data (market, amounts, YT balance).
- Quotes refresh in the background. Simulation reruns every new block while the
  Review screen is open.

---

## 10. Data and registry

`registry/mainnet.json` (versioned in git, reviewed manually; **no addresses
are trusted from APIs**):

```jsonc
{
  "tokens":   { "USDC": { "address": "0x…", "decimals": 6 }, "USD3": {…}, "reUSD": {…} },
  "pendle":   { "markets": { "PT-USD3-<MATURITY>": { "pt": "0x…", "yt": "0x…", "sy": "0x…", "maturity": 0 } } },
  "morpho":   { "blue": "0x…", "markets": { "PT-USD3/USDC": { "id": "0x…", "lltv": "…" } } },
  "threejane":{ "usd3": "0x…", "susd3": "0x…" },
  "re":       { "reUSD": "0x…", "mintRedeem": "0x…" },
  "aggregators": { "...": "0x…" }
}
```

All addresses are **TBD and must be verified** against official docs or
explorers before first use. The Executor allowlist is built from this file.

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
| A compromised frontend builds a malicious plan | Static, self-hosted or IPFS build with pinned dependencies; target allowlist on-chain; decoded review + hash match; `rescue` is owner-only |
| Registry typo | Allowlist changes are separate owner transactions, shown in a diff |
| Protocol risk (3Jane liquidity, reUSD underwriting losses, PT stranded by a YT shortfall) | Surfaced as preflight warnings with live numbers |

**Audit plan:** Executor < ~300 SLOC. Foundry unit tests, fork tests for every
template against mainnet state, invariant fuzzing (ends empty, only owner, flash
loan always repaid), then an external review before moving significant size.

---

## 12. Testing

- **Contracts:** Foundry fork tests that replay each template on a mainnet fork
  with real positions (impersonate a whale, open a loop, unwind it).
- **Compiler:** golden tests from Plan JSON to calldata, and property tests that
  every compiled plan passes the static validator.
- **E2E:** Playwright against an anvil fork, with the Ledger mocked by a
  `viem` local account. Run manually on a real Ledger with Speculos (the Ledger
  emulator) in CI for the signing path.

---

## 13. Milestones

| # | Scope | Exit criteria |
|---|---|---|
| M0 | Registry + verified addresses; Foundry Executor with patches, flash callback, guards | Fork test: flash-unwind of a PT-USD3 Morpho loop passes |
| M1 | Compiler + Plan JSON + simulation; minimal UI (Positions + Review/Sign); Ledger WebHID | Real unwind of a small position on mainnet from a Ledger |
| M2 | Full Builder UI (palette, drag-drop, amount wiring), templates 7.1–7.4 | Build a new custom flow in < 60s |
| M3 | Re Protocol blocks, PT-reUSD templates, aggregator swaps, roll/migrate | reUSD loop entry and exit on a fork, then mainnet |
| M4 | ERC-7730 descriptor, EIP-7702 mode, private RPC, Speculos CI | Optional: sign with no Executor deployment, via 7702 |

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
   partial unwind, never a PT sale (§6.3).

### Still open
1. **Does Pendle's SY-USD3 support USDC as `tokenOut` directly?** If so,
   `redeemSY` + `redeemUSD3` collapse into one call. Check on-chain during M0.
2. **Is `mintPY` OK for entering loops?** It isn't a trade (you receive PT and
   YT at par), but if you want Covenant to be exit-only, entry templates
   (§7.4) get dropped.
3. **3Jane USD3 liquidity:** typical `maxRedeem` versus your position size. Is a
   partial unwind needed?
4. **reUSD mint/redeem on Ethereum:** permissioned? Instant or queued? This
   decides whether exits use `re.redeem` or a swap.
5. **Wallet path:** WebHID direct, Rabby + Ledger, or Ledger Live?
6. **Hosting:** localhost only, or an IPFS deploy?
