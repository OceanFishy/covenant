import { encodeFunctionData, getAddress, maxUint256, parseUnits, type Address, type PublicClient } from "viem";
import { aavePoolAbi, aaveV4GiverAbi, aaveV4SpokeAbi, aaveV4TakerAbi, erc20Abi, executorAbi, morphoAbi, syAbi, ytAbi } from "../abis";
import { aaveV4DebtPatch, arg, balancePatch, call, encodeExecute, encodeFlashData, hashCalls, heldPatch, is7702, minHeldCall, morphoPatch, pullCall } from "../compiler/encode";
import { fmt } from "../compiler/plans";
import { Source, type Call, type Patch, type Plan, type Step, type Swap } from "../compiler/types";
import { expectedDebt } from "../positions";
import { quoteExactIn, quoteForMinOut, type QuoteConfig } from "../quotes";
import {
  AAVE_POOL,
  AAVE_RESERVES,
  AAVE_V4,
  AAVE_V4_RESERVES,
  MARKETS,
  MORPHO,
  SERIES,
  SWEEP_TOKENS,
  TRACKED_TOKENS,
  label,
  reserveOf,
  reserveV4Of,
  tokenInfo,
  type AaveReserve,
  type AaveV4Reserve,
  type Market,
  type PendleSeries,
} from "../registry";
import { SWAP_TOKENS } from "./catalog";
import type { AaveDebt, AaveV4Debt, Amount, Block, Debt, Fixed, Issue } from "./types";

/** Aave v3 variable rate (stable rate is gone from v3). */
const VARIABLE = 2n;

const WAD = 10n ** 18n;

export function marketByKey(key: string): Market {
  const m = MARKETS.find((x) => x.key === key);
  if (!m) throw new Error(`unknown market ${key}`);
  return m;
}

export function seriesByKey(key: string): PendleSeries {
  const s = SERIES[key as keyof typeof SERIES];
  if (!s) throw new Error(`unknown Pendle series ${key}`);
  return s;
}

export function toUnits(f: Fixed, token: Address): bigint {
  return parseUnits(f.value.trim() || "0", tokenInfo(token).decimals);
}

function eq(a: Address, b: Address) {
  return a.toLowerCase() === b.toLowerCase();
}

function params(m: Market) {
  return { loanToken: m.loanToken, collateralToken: m.collateralToken, oracle: m.oracle, irm: m.irm, lltv: m.lltv };
}

/** A health factor typed by the user ("1.05") as WAD. */
function healthWad(min: string): bigint {
  return (BigInt(Math.round(Number(min) * 10_000)) * WAD) / 10_000n;
}

function* walk(blocks: Block[]): Generator<Block> {
  for (const b of blocks) {
    yield b;
    if (b.type === "flashLoan") yield* walk(b.children);
  }
}

// ---------------------------------------------------------------- validation

/** Instant, static checks shown while building; simulation catches everything else. */
export function validate(blocks: Block[]): Issue[] {
  const issues: Issue[] = [];
  const err = (b: Block | undefined, message: string) => issues.push({ blockId: b?.id, level: "error", message });
  const warn = (b: Block, message: string) => issues.push({ blockId: b.id, level: "warning", message });

  if (!blocks.length) err(undefined, "Add blocks from the palette, or start from a template.");
  const checkFixed = (b: Block, f: Fixed, token: Address, mustBePositive = true) => {
    try {
      const v = toUnits(f, token);
      if (mustBePositive && v <= 0n) err(b, "amount must be greater than 0");
    } catch {
      err(b, `"${f.value}" is not a valid amount`);
    }
  };
  const checkReserve = (b: Block, asset: Address) => {
    if (!AAVE_RESERVES.some((r) => eq(r.asset, asset))) err(b, "only USDC and USDT are supported on Aave v3");
  };
  const checkReserveV4 = (b: Block, asset: Address) => {
    if (!AAVE_V4_RESERVES.some((r) => eq(r.asset, asset))) err(b, "only USDC and USDT are supported on Aave v4");
  };

  const ytIn = new Set<string>(); // series whose YT reaches the executor before redeemPY
  const visit = (list: Block[], inFlash: boolean) => {
    for (const b of list) {
      switch (b.type) {
        case "flashLoan":
          if (inFlash) err(b, "flash loans can't be nested");
          if (!b.children.length) err(b, "drop the blocks that use the loan inside the flash loan");
          if (b.amount.kind === "fixed") checkFixed(b, b.amount, b.token);
          if (b.amount.kind === "aaveDebt") checkReserve(b, b.amount.asset);
          if (b.amount.kind === "aaveV4Debt") checkReserveV4(b, b.amount.asset);
          visit(b.children, true);
          break;
        case "pull":
          checkFixed(b, b.amount, b.token);
          for (const s of Object.entries(SERIES)) if (eq(s[1].yt, b.token)) ytIn.add(s[0]);
          break;
        case "repay":
        case "supplyCollateral":
          if (b.amount.kind === "fixed") checkFixed(b, b.amount, b.type === "repay" ? marketByKey(b.market).loanToken : marketByKey(b.market).collateralToken);
          break;
        case "withdrawCollateral":
          if (b.amount.kind === "fixed") checkFixed(b, b.amount, marketByKey(b.market).collateralToken);
          break;
        case "borrow":
          checkFixed(b, b.amount, marketByKey(b.market).loanToken);
          if (!inFlash) warn(b, "borrowing outside a flash loan sends the loan to the Executor, then to your wallet");
          break;
        case "redeemPY": {
          const s = seriesByKey(b.series);
          if (b.amount.kind === "fixed") checkFixed(b, b.amount, s.pt);
          const expired = Date.now() / 1000 >= s.expiry;
          if (!expired && !ytIn.has(b.series)) {
            warn(b, "before maturity PT redeems only with equal YT: add “Pull from wallet” (YT) or “Mint PT + YT” (YT to Executor) earlier");
          }
          break;
        }
        case "redeemSY":
          checkFixed(b, b.minOut, b.tokenOut, false);
          break;
        case "mintPY":
          if (b.amount.kind === "fixed") checkFixed(b, b.amount, b.tokenIn);
          if (b.ytTo === "executor") ytIn.add(b.series);
          break;
        case "swap":
          if (!SWAP_TOKENS.some((t) => eq(t, b.sell)) || !SWAP_TOKENS.some((t) => eq(t, b.buy))) {
            err(b, "only USDC, USDT and reUSD can be swapped (Pendle assets are never traded)");
          }
          if (eq(b.sell, b.buy)) err(b, "sell and buy tokens are the same");
          if (b.amount.kind === "fixed") checkFixed(b, b.amount, b.mode === "exactIn" ? b.sell : b.buy);
          if (b.amount.kind === "aaveDebt") checkReserve(b, b.amount.asset);
          if (b.amount.kind === "aaveV4Debt") checkReserveV4(b, b.amount.asset);
          break;
        case "guardMinBalance":
          checkFixed(b, b.min, b.token, false);
          break;
        case "guardMinHealth":
          if (!(Number(b.min) > 0)) err(b, "enter a health factor like 1.05");
          break;
        case "aaveSupply":
        case "aaveWithdraw":
        case "aaveRepay":
          checkReserve(b, b.asset);
          if (b.amount.kind === "fixed") checkFixed(b, b.amount, b.asset);
          break;
        case "aaveBorrow":
          checkReserve(b, b.asset);
          checkFixed(b, b.amount, b.asset);
          break;
        case "guardAaveNoDebt":
          checkReserve(b, b.asset);
          break;
        case "guardAaveHealth":
        case "guardAaveV4Health":
          if (!(Number(b.min) > 0)) err(b, "enter a health factor like 1.05");
          break;
        case "aaveV4Supply":
        case "aaveV4Withdraw":
        case "aaveV4Repay":
          checkReserveV4(b, b.asset);
          if (b.amount.kind === "fixed") checkFixed(b, b.amount, b.asset);
          break;
        case "aaveV4Borrow":
          checkReserveV4(b, b.asset);
          checkFixed(b, b.amount, b.asset);
          break;
        case "guardAaveV4NoDebt":
          checkReserveV4(b, b.asset);
          break;
        default:
          break;
      }
    }
  };
  visit(blocks, false);
  return issues;
}

// ---------------------------------------------------------------- compilation

export type CompileContext = {
  owner: Address;
  executor: Address;
  client: PublicClient;
  quotes: QuoteConfig;
  headroomBps: number;
  /** Routes from a previous successful simulation, reused instead of re-quoting (by block id). */
  reuseSwaps?: Record<string, Swap>;
};

class Out {
  calls: Call[] = [];
  steps: Step[] = [];
  constructor(readonly depth: 0 | 1) {}
  add(c: Call, text: string) {
    this.calls.push(c);
    this.steps.push({ text, depth: this.depth });
  }
}

function approve(token: Address, spender: Address, amount: bigint, patch?: Patch): Call {
  return call(token, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }), ...(patch ? [patch] : []));
}

function minBalance(x: CompileContext, token: Address, min: bigint): Call {
  return minHeldCall(x, token, min);
}

function amountText(a: Amount, token: Address): string {
  switch (a.kind) {
    case "fixed":
      return fmt(toUnits(a, token), token);
    case "balance":
      return `all ${label(token)}`;
    case "debt":
      return `the whole debt${a.bps !== 10_000 ? ` + ${((a.bps - 10_000) / 100).toFixed(2)}%` : ""}`;
    case "collateral":
      return `all ${label(token)} collateral`;
    case "allShares":
      return "all debt (by shares, no dust)";
    case "aaveDebt":
      return `the whole Aave v3 ${label(a.asset)} debt${a.bps !== 10_000 ? ` + ${((a.bps - 10_000) / 100).toFixed(2)}%` : ""}`;
    case "aaveV4Debt":
      return `the whole Aave v4 ${label(a.asset)} debt${a.bps !== 10_000 ? ` + ${((a.bps - 10_000) / 100).toFixed(2)}%` : ""}`;
    case "allDebt":
      return `all Aave ${label(token)} debt (exact, read at execution)`;
    case "supplied":
      return `all your ${label(token)} on Aave`;
  }
}

/** Live amount for a Debt / AaveDebt / AaveV4Debt (+bps), to size an aggregator quote. */
async function debtNow(x: CompileContext, d: Debt | AaveDebt | AaveV4Debt): Promise<bigint> {
  if (d.kind === "aaveDebt") {
    const debt = await x.client.readContract({ address: reserveOf(d.asset).debtToken.address, abi: erc20Abi, functionName: "balanceOf", args: [x.owner] });
    return (debt * BigInt(d.bps)) / 10_000n;
  }
  if (d.kind === "aaveV4Debt") {
    const r = reserveV4Of(d.asset);
    const debt = await x.client.readContract({ address: AAVE_V4.spoke, abi: aaveV4SpokeAbi, functionName: "getUserTotalDebt", args: [r.reserveId, x.owner] });
    return (debt * BigInt(d.bps)) / 10_000n;
  }
  const m = marketByKey(d.market);
  const [, shares] = await x.client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "position", args: [m.id, x.owner] });
  const block = await x.client.getBlock();
  return ((await expectedDebt(x.client, m, shares, block.timestamp + 24n)) * BigInt(d.bps)) / 10_000n;
}

async function compileBlock(
  b: Block,
  x: CompileContext,
  out: Out,
  swaps: Record<string, Swap>,
  used: Set<string>,
  aave: Set<AaveReserve>,
  aaveV4: Set<AaveV4Reserve>,
) {
  const me = x.executor;
  switch (b.type) {
    case "accrueInterest": {
      const m = marketByKey(b.market);
      used.add(m.key);
      out.add(call(MORPHO, encodeFunctionData({ abi: morphoAbi, functionName: "accrueInterest", args: [params(m)] })), `Accrue interest on ${m.label}`);
      return;
    }
    case "pull": {
      const v = toUnits(b.amount, b.token);
      out.add(pullCall(x, b.token, v), is7702(x) ? `Use ${fmt(v, b.token)} from your wallet (allot)` : `Pull ${fmt(v, b.token)} from your wallet`);
      return;
    }
    case "flashLoan": {
      const inner = new Out(1);
      for (const c of b.children) await compileBlock(c, x, inner, swaps, used, aave, aaveV4);
      inner.steps.push({ text: "Morpho takes the flash loan back", depth: 1 });
      const data = (assets: bigint) =>
        encodeFunctionData({ abi: morphoAbi, functionName: "flashLoan", args: [b.token, assets, encodeFlashData(b.token, inner.calls)] });
      if (b.amount.kind === "debt") {
        const m = marketByKey(b.amount.market);
        used.add(m.key);
        out.add(
          call(MORPHO, data(0n), morphoPatch(arg(1), Source.MORPHO_DEBT_ASSETS, m.id, x.owner, b.amount.bps)),
          `Flash-borrow ${amountText(b.amount, b.token)} on ${m.label} in ${label(b.token)} from Morpho (fee-free)`,
        );
      } else if (b.amount.kind === "aaveDebt") {
        const r = reserveOf(b.amount.asset);
        aave.add(r);
        out.add(
          call(MORPHO, data(0n), balancePatch(arg(1), r.debtToken.address, x.owner, b.amount.bps)),
          `Flash-borrow ${amountText(b.amount, b.token)} in ${label(b.token)} from Morpho (fee-free)`,
        );
      } else if (b.amount.kind === "aaveV4Debt") {
        const r = reserveV4Of(b.amount.asset);
        aaveV4.add(r);
        out.add(
          call(MORPHO, data(0n), aaveV4DebtPatch(arg(1), AAVE_V4.spoke, r.reserveId, x.owner, b.amount.bps)),
          `Flash-borrow ${amountText(b.amount, b.token)} in ${label(b.token)} from Morpho (fee-free)`,
        );
      } else {
        const v = toUnits(b.amount, b.token);
        out.add(call(MORPHO, data(v)), `Flash-borrow ${fmt(v, b.token)} from Morpho (fee-free)`);
      }
      out.steps.push(...inner.steps);
      return;
    }
    case "repay": {
      const m = marketByKey(b.market);
      used.add(m.key);
      const t = m.loanToken;
      if (b.amount.kind === "allShares") {
        out.add(approve(t, MORPHO, 0n, heldPatch(x, arg(1), t)), `Approve ${label(t)} to Morpho for the repayment`);
        out.add(
          call(
            MORPHO,
            encodeFunctionData({ abi: morphoAbi, functionName: "repay", args: [params(m), 0n, 0n, x.owner, "0x"] }),
            morphoPatch(arg(6), Source.MORPHO_BORROW_SHARES, m.id, x.owner),
          ),
          `Repay all debt on ${m.label} (by shares, no dust)`,
        );
      } else if (b.amount.kind === "balance") {
        out.add(approve(t, MORPHO, 0n, heldPatch(x, arg(1), t)), `Approve ${label(t)} to Morpho`);
        out.add(
          call(MORPHO, encodeFunctionData({ abi: morphoAbi, functionName: "repay", args: [params(m), 0n, 0n, x.owner, "0x"] }), heldPatch(x, arg(5), t)),
          `Repay ${amountText(b.amount, t)} on ${m.label}`,
        );
      } else {
        const v = toUnits(b.amount, t);
        out.add(approve(t, MORPHO, v), `Approve ${fmt(v, t)} to Morpho`);
        out.add(call(MORPHO, encodeFunctionData({ abi: morphoAbi, functionName: "repay", args: [params(m), v, 0n, x.owner, "0x"] })), `Repay ${fmt(v, t)} on ${m.label}`);
      }
      return;
    }
    case "withdrawCollateral": {
      const m = marketByKey(b.market);
      used.add(m.key);
      const data = (v: bigint) => encodeFunctionData({ abi: morphoAbi, functionName: "withdrawCollateral", args: [params(m), v, x.owner, me] });
      if (b.amount.kind === "collateral") {
        out.add(call(MORPHO, data(0n), morphoPatch(arg(5), Source.MORPHO_COLLATERAL, m.id, x.owner)), `Withdraw all collateral from ${m.label}`);
      } else {
        const v = toUnits(b.amount, m.collateralToken);
        out.add(call(MORPHO, data(v)), `Withdraw ${fmt(v, m.collateralToken)} from ${m.label}`);
      }
      return;
    }
    case "supplyCollateral": {
      const m = marketByKey(b.market);
      used.add(m.key);
      const t = m.collateralToken;
      const data = (v: bigint) => encodeFunctionData({ abi: morphoAbi, functionName: "supplyCollateral", args: [params(m), v, x.owner, "0x"] });
      if (b.amount.kind === "balance") {
        out.add(approve(t, MORPHO, 0n, heldPatch(x, arg(1), t)), `Approve all ${label(t)} to Morpho`);
        out.add(call(MORPHO, data(0n), heldPatch(x, arg(5), t)), `Supply all ${label(t)} as collateral on ${m.label}`);
      } else {
        const v = toUnits(b.amount, t);
        out.add(approve(t, MORPHO, v), `Approve ${fmt(v, t)} to Morpho`);
        out.add(call(MORPHO, data(v)), `Supply ${fmt(v, t)} as collateral on ${m.label}`);
      }
      return;
    }
    case "borrow": {
      const m = marketByKey(b.market);
      used.add(m.key);
      const v = toUnits(b.amount, m.loanToken);
      out.add(call(MORPHO, encodeFunctionData({ abi: morphoAbi, functionName: "borrow", args: [params(m), v, 0n, x.owner, me] })), `Borrow ${fmt(v, m.loanToken)} on ${m.label}`);
      return;
    }
    case "redeemPY": {
      const s = seriesByKey(b.series);
      if (b.amount.kind === "balance") {
        out.add(call(s.pt, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [s.yt, 0n] }), heldPatch(x, arg(1), s.pt)), "Send all PT to the Pendle YT contract");
        out.add(call(s.yt, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [s.yt, 0n] }), heldPatch(x, arg(1), s.yt)), "Send the matching YT to the Pendle YT contract");
      } else {
        const v = toUnits(b.amount, s.pt);
        out.add(call(s.pt, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [s.yt, v] })), `Send ${fmt(v, s.pt)} to the Pendle YT contract`);
        out.add(call(s.yt, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [s.yt, v] })), `Send the matching ${fmt(v, s.yt)} to the Pendle YT contract`);
      }
      out.add(call(s.yt, encodeFunctionData({ abi: ytAbi, functionName: "redeemPY", args: [me] })), "Redeem PT + YT → SY (Pendle redeemPY; no trading)");
      return;
    }
    case "redeemSY": {
      const s = seriesByKey(b.series);
      const min = toUnits(b.minOut, b.tokenOut);
      out.add(
        call(s.sy, encodeFunctionData({ abi: syAbi, functionName: "redeem", args: [me, 0n, b.tokenOut, min, false] }), heldPatch(x, arg(1), s.sy)),
        `Redeem all SY → ${label(b.tokenOut)}${min > 0n ? ` (min ${fmt(min, b.tokenOut)})` : ""}`,
      );
      return;
    }
    case "mintPY": {
      const s = seriesByKey(b.series);
      const t = b.tokenIn;
      if (b.amount.kind === "balance") {
        out.add(approve(t, s.sy, 0n, heldPatch(x, arg(1), t)), `Approve all ${label(t)} to SY`);
        out.add(
          call(s.sy, encodeFunctionData({ abi: syAbi, functionName: "deposit", args: [me, t, 0n, 0n] }), heldPatch(x, arg(2), t)),
          `Deposit all ${label(t)} into SY`,
        );
      } else {
        const v = toUnits(b.amount, t);
        out.add(approve(t, s.sy, v), `Approve ${fmt(v, t)} to SY`);
        out.add(call(s.sy, encodeFunctionData({ abi: syAbi, functionName: "deposit", args: [me, t, v, 0n] })), `Deposit ${fmt(v, t)} into SY`);
      }
      out.add(call(s.sy, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [s.yt, 0n] }), heldPatch(x, arg(1), s.sy)), "Send all SY to the Pendle YT contract");
      const ytTo = b.ytTo === "wallet" ? x.owner : me;
      out.add(
        call(s.yt, encodeFunctionData({ abi: ytAbi, functionName: "mintPY", args: [me, ytTo] })),
        `Mint PT + YT at par (Pendle mintPY; YT to ${b.ytTo === "wallet" ? "your wallet" : "the Executor"})`,
      );
      return;
    }
    case "swap": {
      let swap = x.reuseSwaps?.[b.id];
      if (!swap) {
        const target = b.amount.kind === "fixed" ? toUnits(b.amount, b.mode === "exactIn" ? b.sell : b.buy) : await debtNow(x, b.amount);
        swap =
          b.mode === "exactIn"
            ? await quoteExactIn(x.quotes, b.sell, b.buy, target, me)
            : await quoteForMinOut(x.quotes, b.sell, b.buy, target, me, x.headroomBps);
      }
      swaps[b.id] = swap;
      out.add(approve(swap.sellToken, swap.spender, swap.amountIn), `Approve ${fmt(swap.amountIn, swap.sellToken)} to ${label(swap.spender)}`);
      out.add(call(swap.target, swap.data), `Swap ${fmt(swap.amountIn, swap.sellToken)} → ~${fmt(swap.quotedOut, swap.buyToken)} via ${swap.aggregator === "0x" ? "0x" : "KyberSwap"}`);
      out.add(minBalance(x, swap.buyToken, swap.minOut), `Check: received at least ${fmt(swap.minOut, swap.buyToken)}`);
      return;
    }
    case "guardMinBalance": {
      const v = toUnits(b.min, b.token);
      out.add(minBalance(x, b.token, v), `Check: you receive at least ${fmt(v, b.token)}`);
      return;
    }
    case "guardNoDebt": {
      const m = marketByKey(b.market);
      used.add(m.key);
      out.add(call(me, encodeFunctionData({ abi: executorAbi, functionName: "assertNoDebt", args: [m.id, x.owner] })), `Check: no debt left on ${m.label}`);
      return;
    }
    case "guardMinHealth": {
      const m = marketByKey(b.market);
      used.add(m.key);
      const min = healthWad(b.min);
      out.add(
        call(me, encodeFunctionData({ abi: executorAbi, functionName: "assertMinHealth", args: [m.id, x.owner, min] })),
        `Check: ${m.label} health factor ≥ ${b.min}`,
      );
      return;
    }
    case "aaveSupply": {
      const r = reserveOf(b.asset);
      aave.add(r);
      const t = r.asset;
      const data = (v: bigint) => encodeFunctionData({ abi: aavePoolAbi, functionName: "supply", args: [t, v, x.owner, 0] });
      if (b.amount.kind === "balance") {
        out.add(approve(t, AAVE_POOL, 0n, heldPatch(x, arg(1), t)), `Approve all ${label(t)} to Aave v3`);
        out.add(call(AAVE_POOL, data(0n), heldPatch(x, arg(1), t)), `Supply all ${label(t)} to Aave v3 for you`);
      } else {
        const v = toUnits(b.amount, t);
        out.add(approve(t, AAVE_POOL, v), `Approve ${fmt(v, t)} to Aave v3`);
        out.add(call(AAVE_POOL, data(v)), `Supply ${fmt(v, t)} to Aave v3 for you`);
      }
      return;
    }
    case "aaveWithdraw": {
      const r = reserveOf(b.asset);
      aave.add(r);
      const a = r.aToken.address;
      // Executor: pull the aTokens, then withdraw all it holds. 7702: they are already in your
      // wallet, so allot them and withdraw only that much (withdraw-max would take your whole
      // supply). Aave may burn 1 wei more than the amount (rounding), hence the +2 wei allotment.
      const self = is7702(x);
      let amount = maxUint256;
      if (b.amount.kind === "supplied") {
        out.add(pullCall(x, a, 0n, (o) => balancePatch(o, a, x.owner)), `${self ? "Use" : "Pull"} all your ${r.aToken.symbol}${self ? " (allot)" : " into the Executor"}`);
      } else {
        const v = toUnits(b.amount, r.asset);
        if (self) amount = v;
        out.add(pullCall(x, a, self ? v + 2n : v), self ? `Use ${fmt(v, a)} of your Aave supply (allot)` : `Pull ${fmt(v, a)} into the Executor`);
      }
      out.add(
        call(AAVE_POOL, encodeFunctionData({ abi: aavePoolAbi, functionName: "withdraw", args: [r.asset, amount, me] })),
        `Withdraw ${amount === maxUint256 ? "it" : fmt(amount, r.asset)} from Aave v3 as ${label(r.asset)}`,
      );
      return;
    }
    case "aaveBorrow": {
      const r = reserveOf(b.asset);
      aave.add(r);
      const v = toUnits(b.amount, r.asset);
      out.add(
        call(AAVE_POOL, encodeFunctionData({ abi: aavePoolAbi, functionName: "borrow", args: [r.asset, v, VARIABLE, 0, x.owner] })),
        `Borrow ${fmt(v, r.asset)} on Aave v3 for you (variable rate)`,
      );
      return;
    }
    case "aaveRepay": {
      const r = reserveOf(b.asset);
      aave.add(r);
      const t = r.asset;
      const data = (v: bigint) => encodeFunctionData({ abi: aavePoolAbi, functionName: "repay", args: [t, v, VARIABLE, x.owner] });
      if (b.amount.kind === "fixed") {
        const v = toUnits(b.amount, t);
        out.add(approve(t, AAVE_POOL, v), `Approve ${fmt(v, t)} to Aave v3`);
        out.add(call(AAVE_POOL, data(v)), `Repay ${fmt(v, t)} of your Aave v3 debt`);
        return;
      }
      out.add(approve(t, AAVE_POOL, 0n, heldPatch(x, arg(1), t)), `Approve all ${label(t)} to Aave v3 for the repayment`);
      if (b.amount.kind === "allDebt") {
        // Aave rejects type(uint256).max on behalf of someone else: repay all = the live debt token balance.
        out.add(call(AAVE_POOL, data(0n), balancePatch(arg(1), r.debtToken.address, x.owner)), `Repay all your Aave v3 ${label(t)} debt (exact, read at execution)`);
      } else {
        out.add(call(AAVE_POOL, data(0n), heldPatch(x, arg(1), t)), `Repay up to all ${label(t)} of your Aave v3 debt`);
      }
      return;
    }
    case "guardAaveNoDebt": {
      const r = reserveOf(b.asset);
      aave.add(r);
      out.add(
        call(me, encodeFunctionData({ abi: executorAbi, functionName: "assertMaxBalance", args: [r.debtToken.address, x.owner, 0n] })),
        `Check: no ${label(r.asset)} debt left on Aave v3`,
      );
      return;
    }
    case "guardAaveHealth": {
      out.add(
        call(me, encodeFunctionData({ abi: executorAbi, functionName: "assertMinAaveHealth", args: [x.owner, healthWad(b.min)] })),
        `Check: Aave v3 health factor ≥ ${b.min}`,
      );
      return;
    }
    case "aaveV4Supply": {
      const r = reserveV4Of(b.asset);
      aaveV4.add(r);
      const t = r.asset;
      const { target, data, amountAt } = v4Call(x, "supply", r);
      if (b.amount.kind === "balance") {
        out.add(approve(t, target, 0n, heldPatch(x, arg(1), t)), `Approve all ${label(t)} to the ${label(target)}`);
        out.add(call(target, data(0n), heldPatch(x, amountAt, t)), `Supply all ${label(t)} to Aave v4 for you`);
      } else {
        const v = toUnits(b.amount, t);
        out.add(approve(t, target, v), `Approve ${fmt(v, t)} to the ${label(target)}`);
        out.add(call(target, data(v)), `Supply ${fmt(v, t)} to Aave v4 for you`);
      }
      return;
    }
    case "aaveV4Withdraw": {
      const r = reserveV4Of(b.asset);
      aaveV4.add(r);
      // An amount above the supply withdraws all of it (the Spoke caps it).
      const v = b.amount.kind === "supplied" ? maxUint256 : toUnits(b.amount, r.asset);
      const { target, data } = v4Call(x, "withdraw", r);
      const into = is7702(x) ? "your wallet" : "the Executor";
      out.add(
        call(target, data(v)),
        b.amount.kind === "supplied" ? `Withdraw all your ${label(r.asset)} from Aave v4 into ${into}` : `Withdraw ${fmt(v, r.asset)} from Aave v4 into ${into}`,
      );
      return;
    }
    case "aaveV4Borrow": {
      const r = reserveV4Of(b.asset);
      aaveV4.add(r);
      const v = toUnits(b.amount, r.asset);
      out.add(call(v4Call(x, "borrow", r).target, v4Call(x, "borrow", r).data(v)), `Borrow ${fmt(v, r.asset)} on Aave v4 for you`);
      return;
    }
    case "aaveV4Repay": {
      const r = reserveV4Of(b.asset);
      aaveV4.add(r);
      const t = r.asset;
      const { target, data, amountAt } = v4Call(x, "repay", r);
      if (b.amount.kind === "fixed") {
        const v = toUnits(b.amount, t);
        out.add(approve(t, target, v), `Approve ${fmt(v, t)} to the ${label(target)}`);
        out.add(call(target, data(v)), `Repay ${fmt(v, t)} of your Aave v4 debt`);
        return;
      }
      out.add(approve(t, target, 0n, heldPatch(x, arg(1), t)), `Approve all ${label(t)} to the ${label(target)} for the repayment`);
      if (b.amount.kind === "allDebt") {
        // Exactly the live debt, read at execution (the Giver also rejects type(uint256).max).
        out.add(call(target, data(0n), aaveV4DebtPatch(amountAt, AAVE_V4.spoke, r.reserveId, x.owner)), `Repay all your Aave v4 ${label(t)} debt (exact, read at execution)`);
      } else {
        // Capped at the debt; the rest stays with the plan.
        out.add(call(target, data(0n), heldPatch(x, amountAt, t)), `Repay up to all ${label(t)} of your Aave v4 debt`);
      }
      return;
    }
    case "guardAaveV4NoDebt": {
      const r = reserveV4Of(b.asset);
      aaveV4.add(r);
      out.add(
        call(me, encodeFunctionData({ abi: executorAbi, functionName: "assertNoAaveV4Debt", args: [AAVE_V4.spoke, r.reserveId, x.owner] })),
        `Check: no ${label(r.asset)} debt left on Aave v4`,
      );
      return;
    }
    case "guardAaveV4Health": {
      out.add(
        call(me, encodeFunctionData({ abi: executorAbi, functionName: "assertMinAaveV4Health", args: [AAVE_V4.spoke, x.owner, healthWad(b.min)] })),
        `Check: Aave v4 health factor ≥ ${b.min}`,
      );
      return;
    }
  }
}

/**
 * An Aave v4 action on the owner's Main Spoke position. Under EIP-7702 your account is the caller,
 * so it is the Spoke's own f(reserveId, amount, you). A deployed Executor can't be a Spoke
 * position manager, so it goes through Aave's Giver (supply / repay) or Taker (withdraw / borrow):
 * f(spoke, reserveId, amount, you). `amountAt` is the amount word's byte offset, for patches.
 */
function v4Call(x: CompileContext, fn: "supply" | "withdraw" | "borrow" | "repay", r: AaveV4Reserve) {
  if (is7702(x)) {
    return {
      target: AAVE_V4.spoke,
      amountAt: arg(1),
      data: (v: bigint) => encodeFunctionData({ abi: aaveV4SpokeAbi, functionName: fn, args: [r.reserveId, v, x.owner] }),
    };
  }
  const viaGiver = fn === "supply" || fn === "repay";
  const managerFn = `${fn}OnBehalfOf` as const;
  return {
    target: viaGiver ? AAVE_V4.giver : AAVE_V4.taker,
    amountAt: arg(2),
    data: (v: bigint) =>
      viaGiver
        ? encodeFunctionData({ abi: aaveV4GiverAbi, functionName: managerFn as "supplyOnBehalfOf" | "repayOnBehalfOf", args: [AAVE_V4.spoke, r.reserveId, v, x.owner] })
        : encodeFunctionData({ abi: aaveV4TakerAbi, functionName: managerFn as "withdrawOnBehalfOf" | "borrowOnBehalfOf", args: [AAVE_V4.spoke, r.reserveId, v, x.owner] }),
  };
}

/** Compiles a flow into an Executor plan. Throws on validation errors. */
export async function compileFlow(blocks: Block[], x: CompileContext): Promise<Plan & { swaps: Record<string, Swap> }> {
  const errors = validate(blocks).filter((i) => i.level === "error");
  if (errors.length) throw new Error(errors.map((e) => e.message).join("; "));
  const top = new Out(0);
  const swaps: Record<string, Swap> = {};
  const used = new Set<string>();
  const aave = new Set<AaveReserve>();
  const aaveV4 = new Set<AaveV4Reserve>();
  for (const b of blocks) await compileBlock(b, x, top, swaps, used, aave, aaveV4);
  top.steps.push({ text: is7702(x) ? "Leftovers stay in your wallet" : "Send every leftover token back to your wallet", depth: 0 });
  // 7702: the delegate tracks these so the plan can't spend more of them than it allots.
  const sweep = is7702(x) ? TRACKED_TOKENS : SWEEP_TOKENS;

  const markets = MARKETS.filter((m) => used.has(m.key));
  const market = markets[0] ?? MARKETS[0];
  const tokens = new Set<string>();
  for (const m of markets) [m.loanToken, m.series.tokenOut, m.series.pt, m.series.yt].forEach((t) => tokens.add(getAddress(t)));
  const reserves = AAVE_RESERVES.filter((r) => aave.has(r));
  for (const r of reserves) [r.asset, r.aToken.address, r.debtToken.address].forEach((t) => tokens.add(t));
  for (const r of aaveV4) tokens.add(r.asset); // v4 has no position tokens: supply/debt are reported separately
  for (const b of walk(blocks)) {
    if (b.type === "pull") tokens.add(getAddress(b.token));
    if (b.type === "swap") [b.sell, b.buy].forEach((t) => tokens.add(getAddress(t)));
    if (b.type === "redeemSY") tokens.add(getAddress(b.tokenOut));
    if (b.type === "mintPY") [b.tokenIn, seriesByKey(b.series).pt, seriesByKey(b.series).yt].forEach((t) => tokens.add(getAddress(t)));
  }

  const planHash = hashCalls(top.calls);
  const swapList = Object.values(swaps);
  return {
    kind: "custom",
    market,
    markets,
    tokens: [...tokens] as Address[],
    aave: reserves.length > 0 || allBlocks(blocks).some((b) => b.type === "guardAaveHealth"),
    ...((aaveV4.size > 0 || allBlocks(blocks).some((b) => b.type === "guardAaveV4Health")) && {
      aaveV4: AAVE_V4_RESERVES.filter((r) => aaveV4.has(r)),
    }),
    owner: x.owner,
    executor: x.executor,
    calls: top.calls,
    sweep,
    steps: top.steps,
    planHash,
    data: encodeExecute(top.calls, sweep, planHash),
    swap: swapList[0],
    swaps,
  };
}

/** Every block in a flow (flash-loan children included), in order. */
export function allBlocks(blocks: Block[]): Block[] {
  return [...walk(blocks)];
}
