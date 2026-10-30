import { encodeFunctionData, formatUnits, type Address } from "viem";
import { erc20Abi, executorAbi, morphoAbi, syAbi, ytAbi } from "../abis";
import { MORPHO, SWEEP_TOKENS, TRACKED_TOKENS, label, tokenInfo, type Market } from "../registry";
import { arg, call, encodeExecute, encodeFlashData, hashCalls, heldPatch, is7702, minHeldCall, morphoPatch, pullCall, type Runner } from "./encode";
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

/** Step text for bringing wallet funds into the plan (pulled to the Executor, or allotted under 7702). */
function pullStep(x: Runner, amount: bigint, token: Address): string {
  return is7702(x) ? `Use ${fmt(amount, token)} from your wallet (allot)` : `Pull ${fmt(amount, token)} from your wallet`;
}

/** Matched PT+YT redemption of `amount` PT (or the executor's whole PT balance) into tokenOut. */
function redeem(b: Builder, x: Ctx, amount: bigint | "all", syMinOut: bigint) {
  const s = x.market.series;
  const ptTransfer = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [s.yt, amount === "all" ? 0n : amount] });
  const ytTransfer = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [s.yt, amount === "all" ? 0n : amount] });
  const what = amount === "all" ? "all" : fmt(amount, s.pt);
  if (amount === "all") {
    b.add(call(s.pt, ptTransfer, heldPatch(x, arg(1), s.pt)), `Send ${what} PT to the Pendle YT contract`);
    b.add(call(s.yt, ytTransfer, heldPatch(x, arg(1), s.yt)), `Send the matching YT to the Pendle YT contract`);
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
      heldPatch(x, arg(1), s.sy),
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
  b.add(minHeldCall(x, swap.buyToken, swap.minOut), `Check: received at least ${fmt(swap.minOut, swap.buyToken)}`);
}

function finish(kind: PlanKind, x: Ctx, top: Builder, swap?: Swap): Plan {
  // Executor: leftovers are swept to the owner. 7702: they are already in the wallet; the list is
  // what the delegate tracks so the plan can't spend more than it allots.
  const sweep = is7702(x) ? TRACKED_TOKENS : SWEEP_TOKENS;
  top.steps.push({ text: is7702(x) ? "Leftovers stay in your wallet" : "Send every leftover token back to your wallet", depth: 0 });
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
  inner.calls[0].patches.push(heldPatch(x, arg(1), m.loanToken));
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
  top.add(pullCall(x, m.series.yt, matched), pullStep(x, matched, m.series.yt));
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
    top.add(minHeldCall(x, m.series.tokenOut, input.minReceive), `Check: you receive at least ${fmt(input.minReceive, m.series.tokenOut)}`);
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
    `Withdraw ${fmt(matched, m.series.pt)} to redeem (the rest stays as collateral)`,
  );
  redeem(inner, x, "all", 0n);
  if (input.swap) swapCalls(inner, x, input.swap);
  inner.steps.push({ text: `Morpho takes the flash loan back`, depth: 1 });

  const top = new Builder(0);
  top.add(call(MORPHO, encodeFunctionData({ abi: morphoAbi, functionName: "accrueInterest", args: [params(m)] })), "Accrue interest");
  top.add(pullCall(x, m.series.yt, matched), pullStep(x, matched, m.series.yt));
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
    call(s.tokenOut, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [s.sy, 0n] }), heldPatch(x, arg(1), s.tokenOut)),
    `Approve all ${label(s.tokenOut)} to SY`,
  );
  inner.add(
    call(
      s.sy,
      encodeFunctionData({ abi: syAbi, functionName: "deposit", args: [executor, s.tokenOut, 0n, 0n] }),
      heldPatch(x, arg(2), s.tokenOut),
    ),
    `Deposit all ${label(s.tokenOut)} into SY${s.viaUsd3 ? " (via 3Jane USD3)" : ""}`,
  );
  inner.add(
    call(s.sy, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [s.yt, 0n] }), heldPatch(x, arg(1), s.sy)),
    "Send all SY to the Pendle YT contract",
  );
  inner.add(
    call(s.yt, encodeFunctionData({ abi: ytAbi, functionName: "mintPY", args: [executor, owner] })),
    "Mint PT + YT at par (Pendle mintPY; YT goes to your wallet)",
  );
  inner.add(
    call(s.pt, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [MORPHO, 0n] }), heldPatch(x, arg(1), s.pt)),
    "Approve all PT to Morpho",
  );
  inner.add(
    call(
      MORPHO,
      encodeFunctionData({ abi: morphoAbi, functionName: "supplyCollateral", args: [params(m), 0n, owner, "0x"] }),
      heldPatch(x, arg(5), s.pt),
    ),
    "Supply all PT as collateral",
  );
  inner.add(
    call(MORPHO, encodeFunctionData({ abi: morphoAbi, functionName: "borrow", args: [params(m), flash, 0n, owner, executor] })),
    `Borrow ${fmt(flash, m.loanToken)} on Morpho`,
  );
  inner.steps.push({ text: `Morpho takes the flash loan back`, depth: 1 });

  const top = new Builder(0);
  top.add(pullCall(x, s.tokenOut, equity), pullStep(x, equity, s.tokenOut));
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
