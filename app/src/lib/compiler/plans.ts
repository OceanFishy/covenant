import { encodeFunctionData, formatUnits, type Address } from "viem";
import { erc20Abi, executorAbi, morphoAbi, syAbi, ytAbi } from "../abis";
import { MORPHO, SWEEP_TOKENS, label, tokenInfo, type Market } from "../registry";
import { arg, balancePatch, call, encodeExecute, encodeFlashData, hashCalls, morphoPatch } from "./encode";
import { Source, type Call, type Plan, type PlanKind, type Step, type Swap } from "./types";

/** Flash = live debt + 0.01%; leftovers are swept back to the owner. */
export const FLASH_DEBT_BPS = 10_001;

export function fmt(amount: bigint, token: Address): string {
  const { symbol, decimals } = tokenInfo(token);
  const n = Number(formatUnits(amount, decimals));
  return `${n.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${symbol}`;
}

type Ctx = { market: Market; owner: Address; executor: Address };

function params(m: Market) {
  return { loanToken: m.loanToken, collateralToken: m.collateralToken, oracle: m.oracle, irm: m.irm, lltv: m.lltv };
}

function needsSwap(m: Market): boolean {
  return m.loanToken.toLowerCase() !== m.series.tokenOut.toLowerCase();
}

class Builder {
  calls: Call[] = [];
  steps: Step[] = [];
  constructor(private depth: 0 | 1) {}
  add(c: Call, text: string) {
    this.calls.push(c);
    this.steps.push({ text, depth: this.depth });
  }
}

function approve(token: Address, spender: Address, amount: bigint): Call {
  return call(token, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }));
}

function guardMinBalance(x: Ctx, token: Address, min: bigint): Call {
  return call(
    x.executor,
    encodeFunctionData({ abi: executorAbi, functionName: "assertMinBalance", args: [token, x.executor, min] }),
  );
}

/** Matched PT+YT redemption of `amount` PT (or the executor's whole PT balance) into tokenOut. */
function redeem(b: Builder, x: Ctx, amount: bigint | "all", syMinOut: bigint) {
  const s = x.market.series;
  const ptTransfer = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [s.yt, amount === "all" ? 0n : amount] });
  const ytTransfer = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [s.yt, amount === "all" ? 0n : amount] });
  const what = amount === "all" ? "all" : fmt(amount, s.pt);
  if (amount === "all") {
    b.add(call(s.pt, ptTransfer, balancePatch(arg(1), s.pt, x.executor)), `Send ${what} PT to the Pendle YT contract`);
    b.add(call(s.yt, ytTransfer, balancePatch(arg(1), s.yt, x.executor)), `Send the matching YT to the Pendle YT contract`);
  } else {
    b.add(call(s.pt, ptTransfer), `Send ${what} to the Pendle YT contract`);
    b.add(call(s.yt, ytTransfer), `Send the matching ${fmt(amount, s.yt)} to the Pendle YT contract`);
  }
  b.add(
    call(s.yt, encodeFunctionData({ abi: ytAbi, functionName: "redeemPY", args: [x.executor] })),
    "Redeem PT + YT → SY (Pendle redeemPY; no trading)",
  );
  b.add(
    call(
      s.sy,
      encodeFunctionData({ abi: syAbi, functionName: "redeem", args: [x.executor, 0n, s.tokenOut, syMinOut, false] }),
      balancePatch(arg(1), s.sy, x.executor),
    ),
    `Redeem all SY → ${label(s.tokenOut)}${syMinOut > 0n ? ` (min ${fmt(syMinOut, s.tokenOut)})` : ""}`,
  );
}

function swapCalls(b: Builder, x: Ctx, swap: Swap) {
  b.add(approve(swap.sellToken, swap.spender, swap.amountIn), `Approve ${fmt(swap.amountIn, swap.sellToken)} to ${label(swap.spender)}`);
  b.add(
    call(swap.target, swap.data),
    `Swap ${fmt(swap.amountIn, swap.sellToken)} → ~${fmt(swap.quotedOut, swap.buyToken)} via ${swap.aggregator === "0x" ? "0x" : "KyberSwap"}`,
  );
  b.add(guardMinBalance(x, swap.buyToken, swap.minOut), `Check: received at least ${fmt(swap.minOut, swap.buyToken)}`);
}

function finish(kind: PlanKind, x: Ctx, top: Builder, swap?: Swap): Plan {
  const sweep = SWEEP_TOKENS;
  top.steps.push({ text: `Send every leftover token back to your wallet`, depth: 0 });
  const planHash = hashCalls(top.calls);
  return { kind, ...x, calls: top.calls, sweep, steps: top.steps, planHash, data: encodeExecute(top.calls, sweep, planHash), swap };
}

export type UnwindInput = Ctx & {
  collateral: bigint;
  /** YT pulled from the owner and redeemed with the same amount of PT. */
  matched: bigint;
  syMinOut: bigint;
  /** Minimum tokenOut the owner must receive (checked before the sweep). */
  minReceive: bigint;
  swap?: Swap;
};

/**
 * §7.1 Flash-unwind. Repays all debt with a flash loan and withdraws all collateral.
 * - matched == collateral: redeem everything → pure tokenOut.
 * - matched <  collateral ("deleverage", §6.3): redeem only the matched PT; the rest of the PT
 *   comes back to the wallet unlevered. Only valid when the matched proceeds cover the debt.
 */
export function flashUnwind(input: UnwindInput): Plan {
  const { market: m, owner, executor, collateral, matched } = input;
  const x: Ctx = { market: m, owner, executor };
  if (matched > collateral) throw new Error("matched > collateral");
  if (needsSwap(m) && !input.swap) throw new Error("this market needs a swap route");
  const full = matched === collateral;

  const inner = new Builder(1);
  inner.add(approve(m.loanToken, MORPHO, 0n), `Approve ${label(m.loanToken)} to Morpho for the repayment`);
  inner.calls[0].patches.push(balancePatch(arg(1), m.loanToken, executor));
  inner.add(
    call(
      MORPHO,
      encodeFunctionData({ abi: morphoAbi, functionName: "repay", args: [params(m), 0n, 0n, owner, "0x"] }),
      morphoPatch(arg(6), Source.MORPHO_BORROW_SHARES, m.id, owner),
    ),
    "Repay all debt on Morpho (by shares, no dust)",
  );
  inner.add(
    call(
      MORPHO,
      encodeFunctionData({ abi: morphoAbi, functionName: "withdrawCollateral", args: [params(m), 0n, owner, executor] }),
      morphoPatch(arg(5), Source.MORPHO_COLLATERAL, m.id, owner),
    ),
    `Withdraw all ${fmt(collateral, m.series.pt)} collateral`,
  );
  redeem(inner, x, full ? "all" : matched, input.syMinOut);
  if (input.swap) swapCalls(inner, x, input.swap);
  inner.steps.push({ text: `Morpho takes the flash loan back`, depth: 1 });

  const top = new Builder(0);
  top.add(
    call(MORPHO, encodeFunctionData({ abi: morphoAbi, functionName: "accrueInterest", args: [params(m)] })),
    "Accrue interest so the debt is exact",
  );
  top.add(
    call(m.series.yt, encodeFunctionData({ abi: erc20Abi, functionName: "transferFrom", args: [owner, executor, matched] })),
    `Pull ${fmt(matched, m.series.yt)} from your wallet`,
  );
  top.add(
    call(
      MORPHO,
      encodeFunctionData({
        abi: morphoAbi,
        functionName: "flashLoan",
        args: [m.loanToken, 0n, encodeFlashData(m.loanToken, inner.calls)],
      }),
      morphoPatch(arg(1), Source.MORPHO_DEBT_ASSETS, m.id, owner, FLASH_DEBT_BPS),
    ),
    `Flash-borrow the whole debt in ${label(m.loanToken)} from Morpho (fee-free)`,
  );
  top.steps.push(...inner.steps);
  top.add(
    call(executor, encodeFunctionData({ abi: executorAbi, functionName: "assertNoDebt", args: [m.id, owner] })),
    "Check: no debt left",
  );
  if (input.minReceive > 0n) {
    top.add(guardMinBalance(x, m.series.tokenOut, input.minReceive), `Check: you receive at least ${fmt(input.minReceive, m.series.tokenOut)}`);
  }
  if (!full) top.steps.push({ text: `${fmt(collateral - matched, m.series.pt)} (no YT to match) returns to your wallet, unlevered`, depth: 0 });
  return finish(full ? "unwind" : "deleverage", x, top, input.swap);
}

export type PartialInput = Ctx & {
  matched: bigint;
  repayAssets: bigint;
  minHealth: bigint;
  swap?: Swap;
};

/** §6.3 Matched partial unwind: repay `repayAssets`, withdraw only `matched` PT, keep a smaller loop. */
export function partialUnwind(input: PartialInput): Plan {
  const { market: m, owner, executor, matched, repayAssets } = input;
  const x: Ctx = { market: m, owner, executor };
  if (needsSwap(m) && !input.swap) throw new Error("this market needs a swap route");

  const inner = new Builder(1);
  inner.add(approve(m.loanToken, MORPHO, repayAssets), `Approve ${fmt(repayAssets, m.loanToken)} to Morpho`);
  inner.add(
    call(MORPHO, encodeFunctionData({ abi: morphoAbi, functionName: "repay", args: [params(m), repayAssets, 0n, owner, "0x"] })),
    `Repay ${fmt(repayAssets, m.loanToken)} of debt`,
  );
  inner.add(
    call(MORPHO, encodeFunctionData({ abi: morphoAbi, functionName: "withdrawCollateral", args: [params(m), matched, owner, executor] })),
    `Withdraw ${fmt(matched, m.series.pt)} (only what your YT covers)`,
  );
  redeem(inner, x, "all", 0n);
  if (input.swap) swapCalls(inner, x, input.swap);
  inner.steps.push({ text: `Morpho takes the flash loan back`, depth: 1 });

  const top = new Builder(0);
  top.add(call(MORPHO, encodeFunctionData({ abi: morphoAbi, functionName: "accrueInterest", args: [params(m)] })), "Accrue interest");
  top.add(
    call(m.series.yt, encodeFunctionData({ abi: erc20Abi, functionName: "transferFrom", args: [owner, executor, matched] })),
    `Pull ${fmt(matched, m.series.yt)} from your wallet`,
  );
  top.add(
    call(
      MORPHO,
      encodeFunctionData({ abi: morphoAbi, functionName: "flashLoan", args: [m.loanToken, repayAssets, encodeFlashData(m.loanToken, inner.calls)] }),
    ),
    `Flash-borrow ${fmt(repayAssets, m.loanToken)} from Morpho (fee-free)`,
  );
  top.steps.push(...inner.steps);
  top.add(
    call(executor, encodeFunctionData({ abi: executorAbi, functionName: "assertMinHealth", args: [m.id, owner, input.minHealth] })),
    `Check: remaining loop health factor ≥ ${Number(formatUnits(input.minHealth, 18)).toFixed(2)}`,
  );
  return finish("partial", x, top, input.swap);
}

export type EnterInput = Ctx & {
  equity: bigint; // tokenOut pulled from the owner
  flash: bigint; // loanToken flash-borrowed and then borrowed on Morpho
  minHealth: bigint;
  swap?: Swap; // loanToken -> tokenOut, when they differ
};

/** §7.4 Enter: flash, (swap), mint PT+YT at par (YT to wallet), supply PT, borrow to repay the flash. */
export function enter(input: EnterInput): Plan {
  const { market: m, owner, executor, equity, flash } = input;
  const s = m.series;
  const x: Ctx = { market: m, owner, executor };
  if (needsSwap(m) && !input.swap) throw new Error("this market needs a swap route");

  const inner = new Builder(1);
  if (input.swap) swapCalls(inner, x, input.swap);
  inner.add(
    call(s.tokenOut, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [s.sy, 0n] }), balancePatch(arg(1), s.tokenOut, executor)),
    `Approve all ${label(s.tokenOut)} to SY`,
  );
  inner.add(
    call(
      s.sy,
      encodeFunctionData({ abi: syAbi, functionName: "deposit", args: [executor, s.tokenOut, 0n, 0n] }),
      balancePatch(arg(2), s.tokenOut, executor),
    ),
    `Deposit all ${label(s.tokenOut)} into SY (via 3Jane USD3)`,
  );
  inner.add(
    call(s.sy, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [s.yt, 0n] }), balancePatch(arg(1), s.sy, executor)),
    "Send all SY to the Pendle YT contract",
  );
  inner.add(
    call(s.yt, encodeFunctionData({ abi: ytAbi, functionName: "mintPY", args: [executor, owner] })),
    "Mint PT + YT at par (Pendle mintPY; YT goes to your wallet)",
  );
  inner.add(
    call(s.pt, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [MORPHO, 0n] }), balancePatch(arg(1), s.pt, executor)),
    "Approve all PT to Morpho",
  );
  inner.add(
    call(
      MORPHO,
      encodeFunctionData({ abi: morphoAbi, functionName: "supplyCollateral", args: [params(m), 0n, owner, "0x"] }),
      balancePatch(arg(5), s.pt, executor),
    ),
    "Supply all PT as collateral",
  );
  inner.add(
    call(MORPHO, encodeFunctionData({ abi: morphoAbi, functionName: "borrow", args: [params(m), flash, 0n, owner, executor] })),
    `Borrow ${fmt(flash, m.loanToken)} on Morpho`,
  );
  inner.steps.push({ text: `Morpho takes the flash loan back`, depth: 1 });

  const top = new Builder(0);
  top.add(
    call(s.tokenOut, encodeFunctionData({ abi: erc20Abi, functionName: "transferFrom", args: [owner, executor, equity] })),
    `Pull ${fmt(equity, s.tokenOut)} from your wallet`,
  );
  top.add(
    call(MORPHO, encodeFunctionData({ abi: morphoAbi, functionName: "flashLoan", args: [m.loanToken, flash, encodeFlashData(m.loanToken, inner.calls)] })),
    `Flash-borrow ${fmt(flash, m.loanToken)} from Morpho (fee-free)`,
  );
  top.steps.push(...inner.steps);
  top.add(
    call(executor, encodeFunctionData({ abi: executorAbi, functionName: "assertMinHealth", args: [m.id, owner, input.minHealth] })),
    `Check: health factor ≥ ${Number(formatUnits(input.minHealth, 18)).toFixed(2)}`,
  );
  return finish("enter", x, top, input.swap);
}
