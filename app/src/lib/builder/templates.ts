import { formatUnits, type Address } from "viem";
import { FLASH_DEBT_BPS } from "../compiler/plans";
import { unwindMode } from "../planner";
import type { PositionView } from "../positions";
import { tokenInfo, type Market } from "../registry";
import { newId } from "./catalog";
import type { Block, Fixed, Flow } from "./types";

/** Exact decimal string for a token amount (round-trips through parseUnits). */
export function fixed(value: bigint, token: Address): Fixed {
  return { kind: "fixed", value: formatUnits(value, tokenInfo(token).decimals) };
}

function needsSwap(m: Market) {
  return m.loanToken.toLowerCase() !== m.series.tokenOut.toLowerCase();
}

/**
 * §7.1 Flash-unwind (and §6.3 deleverage when `matched` < collateral): the same calls as
 * compiler/plans.ts flashUnwind, as editable blocks.
 */
export function unwindFlow(p: PositionView, opts: { syMinOut?: bigint; minReceive?: bigint } = {}): Flow {
  const m = p.market;
  const s = m.series;
  const full = p.matched === p.collateral;
  const inner: Block[] = [
    { id: newId(), type: "repay", market: m.key, amount: { kind: "allShares" } },
    { id: newId(), type: "withdrawCollateral", market: m.key, amount: { kind: "collateral" } },
    { id: newId(), type: "redeemPY", series: s.name, amount: full ? { kind: "balance" } : fixed(p.matched, s.pt) },
    { id: newId(), type: "redeemSY", series: s.name, tokenOut: s.tokenOut, minOut: fixed(opts.syMinOut ?? 0n, s.tokenOut) },
  ];
  if (needsSwap(m)) {
    inner.push({
      id: newId(),
      type: "swap",
      sell: s.tokenOut,
      buy: m.loanToken,
      mode: "minOut",
      amount: { kind: "debt", market: m.key, bps: 10_002 },
    });
  }
  const blocks: Block[] = [
    { id: newId(), type: "accrueInterest", market: m.key },
    { id: newId(), type: "pull", token: s.yt, amount: fixed(p.matched, s.yt) },
    { id: newId(), type: "flashLoan", token: m.loanToken, amount: { kind: "debt", market: m.key, bps: FLASH_DEBT_BPS }, children: inner },
    { id: newId(), type: "guardNoDebt", market: m.key },
  ];
  if (opts.minReceive) blocks.push({ id: newId(), type: "guardMinBalance", token: s.tokenOut, min: fixed(opts.minReceive, s.tokenOut) });
  return { version: 1, name: `${full ? "Unwind" : "Deleverage"} ${m.label}`, blocks };
}

/** §6.3 Partial unwind: repay what the matched PT redeems for, keep a smaller loop. */
export function partialFlow(p: PositionView, repayAssets: bigint, minHealth: string): Flow {
  const m = p.market;
  const s = m.series;
  const inner: Block[] = [
    { id: newId(), type: "repay", market: m.key, amount: fixed(repayAssets, m.loanToken) },
    { id: newId(), type: "withdrawCollateral", market: m.key, amount: fixed(p.matched, m.collateralToken) },
    { id: newId(), type: "redeemPY", series: s.name, amount: { kind: "balance" } },
    { id: newId(), type: "redeemSY", series: s.name, tokenOut: s.tokenOut, minOut: { kind: "fixed", value: "0" } },
  ];
  if (needsSwap(m)) {
    inner.push({ id: newId(), type: "swap", sell: s.tokenOut, buy: m.loanToken, mode: "minOut", amount: fixed(repayAssets, m.loanToken) });
  }
  return {
    version: 1,
    name: `Partial unwind ${m.label}`,
    blocks: [
      { id: newId(), type: "accrueInterest", market: m.key },
      { id: newId(), type: "pull", token: s.yt, amount: fixed(p.matched, s.yt) },
      { id: newId(), type: "flashLoan", token: m.loanToken, amount: fixed(repayAssets, m.loanToken), children: inner },
      { id: newId(), type: "guardMinHealth", market: m.key, min: minHealth },
    ],
  };
}

/** The exit `p` allows (planner.unwindMode): unwind, deleverage, or a partial repaying 99% of the proceeds' value. */
export function exitFlow(p: PositionView): Flow {
  if (unwindMode(p) !== "partial") return unwindFlow(p);
  const repay = (p.valueMatched * 9_900n) / 10_000n;
  return partialFlow(p, repay, (Number(p.healthFactor / 10n ** 14n) / 10_000).toFixed(3));
}

/**
 * Max unwind: the exit that redeems the most PT possible right now. `p` comes from
 * planner.capToReserve, so `matched` is the PT your YT covers, capped by 3Jane's USDC reserve; when
 * the reserve is the smaller limit the flow drains it and repays as much debt as that pays for.
 */
export function maxUnwindFlow(p: PositionView): Flow {
  if (p.matched === 0n) throw new Error("Nothing can be unwound right now: 3Jane's USDC reserve is empty or you hold no YT.");
  return { ...exitFlow(p), name: `Max unwind ${p.market.label}` };
}

/**
 * §7.4 Enter: flash, (swap), mint PT+YT at par (YT to wallet), supply PT, borrow to repay.
 * `equity` is in tokenOut; `equityValue` is its value in the loan token (positions.tokenOutValue),
 * which sizes the flash loan: equityValue × (leverage − 1).
 */
export function enterFlow(m: Market, equity: bigint, equityValue: bigint, leverage: number, minHealth = "1.02"): Flow {
  const s = m.series;
  const flash = (equityValue * BigInt(Math.round((leverage - 1) * 10_000))) / 10_000n;
  const inner: Block[] = [];
  if (needsSwap(m)) inner.push({ id: newId(), type: "swap", sell: m.loanToken, buy: s.tokenOut, mode: "exactIn", amount: fixed(flash, m.loanToken) });
  inner.push(
    { id: newId(), type: "mintPY", series: s.name, tokenIn: s.tokenOut, amount: { kind: "balance" }, ytTo: "wallet" },
    { id: newId(), type: "supplyCollateral", market: m.key, amount: { kind: "balance" } },
    { id: newId(), type: "borrow", market: m.key, amount: fixed(flash, m.loanToken) },
  );
  return {
    version: 1,
    name: `Enter ${m.label} ${leverage}×`,
    blocks: [
      { id: newId(), type: "pull", token: s.tokenOut, amount: fixed(equity, s.tokenOut) },
      { id: newId(), type: "flashLoan", token: m.loanToken, amount: fixed(flash, m.loanToken), children: inner },
      { id: newId(), type: "guardMinHealth", market: m.key, min: minHealth },
    ],
  };
}

/**
 * §7.5 Move a loop between markets with the same collateral and loan token (e.g. PT-USD3/USDC
 * A → B): flash the debt, close on `from`, reopen on `to`, borrow there to repay the flash.
 * No Pendle step at all. The destination market needs enough lender liquidity to borrow.
 */
export function moveFlow(p: PositionView, to: Market, minHealth = "1.02"): Flow {
  const from = p.market;
  if (from.loanToken.toLowerCase() !== to.loanToken.toLowerCase() || from.collateralToken.toLowerCase() !== to.collateralToken.toLowerCase()) {
    throw new Error("markets must share collateral and loan token");
  }
  // Borrow the flash amount (+ a little for interest until execution); extra returns to you.
  const borrow = (p.debt * 10_005n) / 10_000n;
  return {
    version: 1,
    name: `Move ${from.label} → ${to.label}`,
    blocks: [
      { id: newId(), type: "accrueInterest", market: from.key },
      {
        id: newId(),
        type: "flashLoan",
        token: from.loanToken,
        amount: { kind: "debt", market: from.key, bps: FLASH_DEBT_BPS },
        children: [
          { id: newId(), type: "repay", market: from.key, amount: { kind: "allShares" } },
          { id: newId(), type: "withdrawCollateral", market: from.key, amount: { kind: "collateral" } },
          { id: newId(), type: "supplyCollateral", market: to.key, amount: { kind: "balance" } },
          { id: newId(), type: "borrow", market: to.key, amount: fixed(borrow, to.loanToken) },
        ],
      },
      { id: newId(), type: "guardNoDebt", market: from.key },
      { id: newId(), type: "guardMinHealth", market: to.key, min: minHealth },
    ],
  };
}
