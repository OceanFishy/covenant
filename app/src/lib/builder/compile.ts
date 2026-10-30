import { encodeFunctionData, getAddress, parseUnits, type Address, type PublicClient } from "viem";
import { erc20Abi, executorAbi, morphoAbi, syAbi, ytAbi } from "../abis";
import { arg, balancePatch, call, encodeExecute, encodeFlashData, hashCalls, morphoPatch } from "../compiler/encode";
import { fmt } from "../compiler/plans";
import { Source, type Call, type Patch, type Plan, type Step, type Swap } from "../compiler/types";
import { expectedDebt } from "../positions";
import { quoteExactIn, quoteForMinOut, type QuoteConfig } from "../quotes";
import { MARKETS, MORPHO, SERIES, SWEEP_TOKENS, label, tokenInfo, type Market, type PendleSeries } from "../registry";
import { SWAP_TOKENS } from "./catalog";
import type { Amount, Block, Debt, Fixed, Issue } from "./types";

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

  const ytIn = new Set<string>(); // series whose YT reaches the executor before redeemPY
  const visit = (list: Block[], inFlash: boolean) => {
    for (const b of list) {
      switch (b.type) {
        case "flashLoan":
          if (inFlash) err(b, "flash loans can't be nested");
          if (!b.children.length) err(b, "drop the blocks that use the loan inside the flash loan");
          if (b.amount.kind === "fixed") checkFixed(b, b.amount, b.token);
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
            err(b, "only USDC ↔ USDT can be swapped (Pendle assets are never traded)");
          }
          if (eq(b.sell, b.buy)) err(b, "sell and buy tokens are the same");
          if (b.amount.kind === "fixed") checkFixed(b, b.amount, b.mode === "exactIn" ? b.sell : b.buy);
          break;
        case "guardMinBalance":
          checkFixed(b, b.min, b.token, false);
          break;
        case "guardMinHealth":
          if (!(Number(b.min) > 0)) err(b, "enter a health factor like 1.05");
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
  return call(x.executor, encodeFunctionData({ abi: executorAbi, functionName: "assertMinBalance", args: [token, x.executor, min] }));
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
  }
}

async function debtNow(x: CompileContext, d: Debt): Promise<bigint> {
  const m = marketByKey(d.market);
  const [, shares] = await x.client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "position", args: [m.id, x.owner] });
  const block = await x.client.getBlock();
  return ((await expectedDebt(x.client, m, shares, block.timestamp + 24n)) * BigInt(d.bps)) / 10_000n;
}

async function compileBlock(b: Block, x: CompileContext, out: Out, swaps: Record<string, Swap>, used: Set<string>) {
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
      out.add(
        call(b.token, encodeFunctionData({ abi: erc20Abi, functionName: "transferFrom", args: [x.owner, me, v] })),
        `Pull ${fmt(v, b.token)} from your wallet`,
      );
      return;
    }
    case "flashLoan": {
      const inner = new Out(1);
      for (const c of b.children) await compileBlock(c, x, inner, swaps, used);
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
        out.add(approve(t, MORPHO, 0n, balancePatch(arg(1), t, me)), `Approve ${label(t)} to Morpho for the repayment`);
        out.add(
          call(
            MORPHO,
            encodeFunctionData({ abi: morphoAbi, functionName: "repay", args: [params(m), 0n, 0n, x.owner, "0x"] }),
            morphoPatch(arg(6), Source.MORPHO_BORROW_SHARES, m.id, x.owner),
          ),
          `Repay all debt on ${m.label} (by shares, no dust)`,
        );
      } else if (b.amount.kind === "balance") {
        out.add(approve(t, MORPHO, 0n, balancePatch(arg(1), t, me)), `Approve ${label(t)} to Morpho`);
        out.add(
          call(MORPHO, encodeFunctionData({ abi: morphoAbi, functionName: "repay", args: [params(m), 0n, 0n, x.owner, "0x"] }), balancePatch(arg(5), t, me)),
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
        out.add(approve(t, MORPHO, 0n, balancePatch(arg(1), t, me)), `Approve all ${label(t)} to Morpho`);
        out.add(call(MORPHO, data(0n), balancePatch(arg(5), t, me)), `Supply all ${label(t)} as collateral on ${m.label}`);
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
        out.add(call(s.pt, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [s.yt, 0n] }), balancePatch(arg(1), s.pt, me)), "Send all PT to the Pendle YT contract");
        out.add(call(s.yt, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [s.yt, 0n] }), balancePatch(arg(1), s.yt, me)), "Send the matching YT to the Pendle YT contract");
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
        call(s.sy, encodeFunctionData({ abi: syAbi, functionName: "redeem", args: [me, 0n, b.tokenOut, min, false] }), balancePatch(arg(1), s.sy, me)),
        `Redeem all SY → ${label(b.tokenOut)}${min > 0n ? ` (min ${fmt(min, b.tokenOut)})` : ""}`,
      );
      return;
    }
    case "mintPY": {
      const s = seriesByKey(b.series);
      const t = b.tokenIn;
      if (b.amount.kind === "balance") {
        out.add(approve(t, s.sy, 0n, balancePatch(arg(1), t, me)), `Approve all ${label(t)} to SY`);
        out.add(
          call(s.sy, encodeFunctionData({ abi: syAbi, functionName: "deposit", args: [me, t, 0n, 0n] }), balancePatch(arg(2), t, me)),
          `Deposit all ${label(t)} into SY`,
        );
      } else {
        const v = toUnits(b.amount, t);
        out.add(approve(t, s.sy, v), `Approve ${fmt(v, t)} to SY`);
        out.add(call(s.sy, encodeFunctionData({ abi: syAbi, functionName: "deposit", args: [me, t, v, 0n] })), `Deposit ${fmt(v, t)} into SY`);
      }
      out.add(call(s.sy, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [s.yt, 0n] }), balancePatch(arg(1), s.sy, me)), "Send all SY to the Pendle YT contract");
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
        const target = b.amount.kind === "debt" ? await debtNow(x, b.amount) : toUnits(b.amount, b.mode === "exactIn" ? b.sell : b.buy);
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
      const min = (BigInt(Math.round(Number(b.min) * 10_000)) * WAD) / 10_000n;
      out.add(
        call(me, encodeFunctionData({ abi: executorAbi, functionName: "assertMinHealth", args: [m.id, x.owner, min] })),
        `Check: ${m.label} health factor ≥ ${b.min}`,
      );
      return;
    }
  }
}

/** Compiles a flow into an Executor plan. Throws on validation errors. */
export async function compileFlow(blocks: Block[], x: CompileContext): Promise<Plan & { swaps: Record<string, Swap> }> {
  const errors = validate(blocks).filter((i) => i.level === "error");
  if (errors.length) throw new Error(errors.map((e) => e.message).join("; "));
  const top = new Out(0);
  const swaps: Record<string, Swap> = {};
  const used = new Set<string>();
  for (const b of blocks) await compileBlock(b, x, top, swaps, used);
  top.steps.push({ text: "Send every leftover token back to your wallet", depth: 0 });

  const markets = MARKETS.filter((m) => used.has(m.key));
  const market = markets[0] ?? MARKETS[0];
  const tokens = new Set<string>();
  for (const m of markets) [m.loanToken, m.series.tokenOut, m.series.pt, m.series.yt].forEach((t) => tokens.add(getAddress(t)));
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
    owner: x.owner,
    executor: x.executor,
    calls: top.calls,
    sweep: SWEEP_TOKENS,
    steps: top.steps,
    planHash,
    data: encodeExecute(top.calls, SWEEP_TOKENS, planHash),
    swap: swapList[0],
    swaps,
  };
}

/** Every block in a flow (flash-loan children included), in order. */
export function allBlocks(blocks: Block[]): Block[] {
  return [...walk(blocks)];
}
