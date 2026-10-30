import type { Address, PublicClient } from "viem";
import { enter, flashUnwind, partialUnwind } from "./compiler/plans";
import type { Plan, Swap } from "./compiler/types";
import { healthFactor, previewRedeemPt, tokenOutValue, usd3RedeemablePt, type PositionView } from "./positions";
import { quoteExactIn, quoteForMinOut, type QuoteConfig } from "./quotes";
import type { Market } from "./registry";

const BPS = 10_000n;

export type UnwindMode = "unwind" | "deleverage" | "partial";

/**
 * Which unwind a position allows (§6.3):
 * - unwind:     YT covers all PT (or PT has matured) → everything comes back as tokenOut.
 * - deleverage: YT covers part of the PT, but redeeming that part repays the whole debt → debt 0,
 *               the unmatched PT comes back to the wallet unlevered.
 * - partial:    the matched part can't repay everything → repay what it can, keep a smaller loop.
 */
export function unwindMode(p: PositionView): UnwindMode {
  if (p.matched === p.collateral) return "unwind";
  // Keep 0.5% margin for redemption rounding and the swap on USDT / reUSD markets.
  if ((p.valueMatched * 9_950n) / BPS >= p.debt) return "deleverage";
  return "partial";
}

/**
 * The position as a max unwind sees it: `matched` (the PT your YT covers) capped at the PT that
 * 3Jane's USDC reserve can pay out right now, with the proceeds previewed for the capped amount.
 * When the reserve is the smaller limit, the unwind built from this drains it. USD3 series only.
 */
export async function capToReserve(client: PublicClient, p: PositionView): Promise<PositionView> {
  if (!p.market.series.viaUsd3) throw new Error(`Max unwind sizes to 3Jane's reserve; ${p.market.label} doesn't redeem through 3Jane.`);
  const reserve = await usd3RedeemablePt(client, p.market.series);
  if (reserve >= p.matched) return p;
  const proceeds = await previewRedeemPt(client, p.market, reserve);
  // SY-USD3 pays USDC, which counts 1:1 against the debt.
  return { ...p, matched: reserve, proceedsMatched: proceeds, valueMatched: proceeds };
}

function needsSwap(m: Market): boolean {
  return m.loanToken.toLowerCase() !== m.series.tokenOut.toLowerCase();
}

export type BuildOptions = {
  owner: Address;
  executor: Address;
  quotes: QuoteConfig;
  /** Swap headroom for this attempt (see HEADROOM_LADDER_BPS). */
  headroomBps: number;
  /** Minimum tokenOut you accept; 0 on the first (simulation) pass. */
  minReceive: bigint;
  /** Reuse this route instead of quoting (the final build after a passing simulation). */
  reuseSwap?: Swap;
};

export async function buildUnwind(client: PublicClient, p: PositionView, o: BuildOptions): Promise<Plan> {
  const m = p.market;
  const mode = unwindMode(p);
  const ctx = { market: m, owner: o.owner, executor: o.executor };

  if (mode === "partial") {
    // Repay 99% of what the matched PT redeems for; the loop that remains gets safer (§6.3).
    let repayAssets = (p.valueMatched * 9_900n) / BPS;
    let swap: Swap | undefined;
    if (needsSwap(m)) {
      // Proceeds are in tokenOut (USDC / reUSD); repay in loanToken (USDT / USDC). Size the
      // repayment to what the swap of most of the proceeds will buy.
      repayAssets = (p.valueMatched * 9_850n) / BPS;
      swap = o.reuseSwap ?? (await quoteForMinOut(o.quotes, m.series.tokenOut, m.loanToken, repayAssets, o.executor, o.headroomBps));
      repayAssets = swap.minOut;
    }
    const after = healthFactor(p.collateral - p.matched, p.price, m.lltv, p.debt - repayAssets);
    // Guard: the remaining loop must be at least as healthy as now (it should be healthier).
    const minHealth = after < p.healthFactor ? after : p.healthFactor;
    return partialUnwind({ ...ctx, matched: p.matched, repayAssets, minHealth, swap });
  }

  const matched = mode === "unwind" ? p.collateral : p.matched;
  const expectedOut = mode === "unwind" ? p.proceedsAll : await previewRedeemPt(client, m, matched);
  // SY → tokenOut minimum: 0.5% under the preview (the final minReceive guard is the real bound).
  const syMinOut = (expectedOut * 9_950n) / BPS;
  let swap: Swap | undefined;
  if (needsSwap(m)) {
    // Buy just enough loanToken to repay the flash loan (debt + 0.01%) — guard at debt + 0.02%.
    const minOut = (p.debt * 10_002n) / BPS;
    swap = o.reuseSwap ?? (await quoteForMinOut(o.quotes, m.series.tokenOut, m.loanToken, minOut, o.executor, o.headroomBps));
  }
  return flashUnwind({ ...ctx, collateral: p.collateral, matched, syMinOut, minReceive: o.minReceive, swap });
}

export type EnterOptions = BuildOptions & { equity: bigint; leverageBps: bigint; minHealth: bigint };

/** §7.4 Enter: equity in tokenOut, flash = its USDC value × (leverage − 1). */
export async function buildEnter(client: PublicClient, m: Market, o: EnterOptions): Promise<Plan> {
  const flash = ((await tokenOutValue(client, m.series, o.equity)) * (o.leverageBps - BPS)) / BPS;
  const swap = needsSwap(m) ? await quoteExactIn(o.quotes, m.loanToken, m.series.tokenOut, flash, o.executor) : undefined;
  return enter({ market: m, owner: o.owner, executor: o.executor, equity: o.equity, flash, minHealth: o.minHealth, swap });
}
