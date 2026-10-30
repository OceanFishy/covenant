import { describe, expect, it, vi } from "vitest";
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  getAddress,
  hexToBigInt,
  slice,
  type Address,
  type Hex,
} from "viem";
import { erc20Abi, executorAbi, morphoAbi, ytAbi } from "../../src/lib/abis";
import { callsType } from "../../src/lib/compiler/encode";
import { enter, flashUnwind, partialUnwind } from "../../src/lib/compiler/plans";
import { Source, type Call, type Swap } from "../../src/lib/compiler/types";
import { unwindMode } from "../../src/lib/planner";
import type { PositionView } from "../../src/lib/positions";
import { quoteForMinOut, type QuoteConfig } from "../../src/lib/quotes";
import { MARKETS, MORPHO, SWEEP_TOKENS, TOKENS } from "../../src/lib/registry";
import { decodeRevert, isSwapFailure } from "../../src/lib/simulate";

const [A, , USDT_MARKET] = MARKETS;
const owner = getAddress("0x00000000000000000000000000000000000000aa");
const executor = getAddress("0x00000000000000000000000000000000000000ee");
const ctx = { market: A, owner, executor };

/** The uint256 word a patch overwrites must be an amount argument we expect. */
function patchedArg(c: Call, i = 0): bigint {
  const p = c.patches[i];
  return hexToBigInt(slice(c.data, p.offset, p.offset + 32));
}

function innerOfFlash(c: Call): Call[] {
  const { args } = decodeFunctionData({ abi: morphoAbi, data: c.data });
  const [, inner] = decodeAbiParameters([{ type: "address" }, callsType], args![2] as Hex);
  return inner as Call[];
}

describe("flashUnwind", () => {
  const collateral = 1_000_000n * 10n ** 6n;
  const plan = flashUnwind({ ...ctx, collateral, matched: collateral, syMinOut: 1n, minReceive: 5n });

  it("calls in the documented order (§7.1)", () => {
    const top = plan.calls.map((c) => decodeFunctionData({ abi: [...morphoAbi, ...erc20Abi, ...executorAbi], data: c.data }).functionName);
    expect(top).toEqual(["accrueInterest", "transferFrom", "flashLoan", "assertNoDebt", "assertMinBalance"]);
    expect(plan.kind).toBe("unwind");
    expect(plan.sweep).toEqual(SWEEP_TOKENS);
  });

  it("flash amount is patched to live debt + 0.01%", () => {
    const flash = plan.calls[2];
    expect(flash.target).toBe(MORPHO);
    expect(flash.patches).toHaveLength(1);
    expect(flash.patches[0]).toMatchObject({ offset: 4 + 32, source: Source.MORPHO_DEBT_ASSETS, bps: 10_001 });
    expect(patchedArg(flash)).toBe(0n); // placeholder overwritten on-chain
  });

  it("repay patches the shares word and withdraw patches the assets word", () => {
    const inner = innerOfFlash(plan.calls[2]);
    const repay = inner[1];
    const { functionName, args } = decodeFunctionData({ abi: morphoAbi, data: repay.data });
    expect(functionName).toBe("repay");
    expect(args![3]).toBe(owner); // onBehalf
    expect(repay.patches[0]).toMatchObject({ offset: 4 + 32 * 6, source: Source.MORPHO_BORROW_SHARES });
    const withdraw = inner[2];
    expect(decodeFunctionData({ abi: morphoAbi, data: withdraw.data }).args!.slice(2)).toEqual([owner, executor]);
    expect(withdraw.patches[0]).toMatchObject({ offset: 4 + 32 * 5, source: Source.MORPHO_COLLATERAL });
  });

  it("never touches a Pendle router or market (redeem-only)", () => {
    const inner = innerOfFlash(plan.calls[2]);
    const targets = new Set([...plan.calls, ...inner].map((c) => c.target));
    const s = A.series;
    for (const t of targets) expect([MORPHO, executor, s.pt, s.yt, s.sy, A.loanToken]).toContain(t);
  });

  it("deleverage redeems only the matched amount and keeps the rest of the PT", () => {
    const matched = (collateral * 9n) / 10n;
    const d = flashUnwind({ ...ctx, collateral, matched, syMinOut: 0n, minReceive: 0n });
    expect(d.kind).toBe("deleverage");
    const inner = innerOfFlash(d.calls[2]);
    const ptSend = inner[3];
    expect(ptSend.target).toBe(A.series.pt);
    expect(ptSend.patches).toHaveLength(0);
    expect(decodeFunctionData({ abi: erc20Abi, data: ptSend.data }).args).toEqual([A.series.yt, matched]);
  });

  it("USDT market requires a swap and checks its output on-chain", () => {
    expect(() => flashUnwind({ ...ctx, market: USDT_MARKET, collateral, matched: collateral, syMinOut: 0n, minReceive: 0n })).toThrow();
    const swap: Swap = {
      aggregator: "kyber",
      sellToken: TOKENS.USDC.address,
      buyToken: TOKENS.USDT.address,
      spender: getAddress("0x6131B5fae19EA4f9D964eAc0408E4408b66337b5"),
      target: getAddress("0x6131B5fae19EA4f9D964eAc0408E4408b66337b5"),
      data: "0xe21fd0e9",
      amountIn: 100n,
      quotedOut: 101n,
      minOut: 99n,
    };
    const p = flashUnwind({ ...ctx, market: USDT_MARKET, collateral, matched: collateral, syMinOut: 0n, minReceive: 0n, swap });
    const inner = innerOfFlash(p.calls[2]);
    const guard = inner.at(-1)!;
    const g = decodeFunctionData({ abi: executorAbi, data: guard.data });
    expect(g.functionName).toBe("assertMinBalance");
    expect(g.args).toEqual([TOKENS.USDT.address, executor, 99n]);
    expect(p.swap).toBe(swap);
  });
});

describe("partial and enter", () => {
  it("partial unwind withdraws only matched PT and guards health", () => {
    const p = partialUnwind({ ...ctx, matched: 400n, repayAssets: 390n, minHealth: 11n * 10n ** 17n });
    expect(p.kind).toBe("partial");
    const last = decodeFunctionData({ abi: executorAbi, data: p.calls.at(-1)!.data });
    expect(last.functionName).toBe("assertMinHealth");
    const inner = innerOfFlash(p.calls[2]);
    expect(decodeFunctionData({ abi: morphoAbi, data: inner[2].data }).args![1]).toBe(400n);
  });

  it("enter mints PT+YT with YT to the owner", () => {
    const p = enter({ ...ctx, equity: 1000n, flash: 2000n, minHealth: 10n ** 18n });
    const inner = innerOfFlash(p.calls[1]);
    const mint = inner.find((c) => c.target === A.series.yt)!;
    const m = decodeFunctionData({ abi: ytAbi, data: mint.data });
    expect(m.functionName).toBe("mintPY");
    expect(m.args).toEqual([executor, owner]);
    const borrow = decodeFunctionData({ abi: morphoAbi, data: inner.at(-1)!.data });
    expect(borrow.functionName).toBe("borrow");
    expect(borrow.args!.slice(1)).toEqual([2000n, 0n, owner, executor]);
  });
});

describe("unwindMode", () => {
  const base = { collateral: 1000n, debt: 800n, proceedsAll: 1000n } as PositionView;
  it("unwind when YT covers all PT", () => expect(unwindMode({ ...base, matched: 1000n, proceedsMatched: 1000n })).toBe("unwind"));
  it("deleverage when matched proceeds repay the debt", () => expect(unwindMode({ ...base, matched: 900n, proceedsMatched: 900n })).toBe("deleverage"));
  it("partial otherwise", () => expect(unwindMode({ ...base, matched: 400n, proceedsMatched: 400n })).toBe("partial"));
});

describe("decodeRevert", () => {
  it("unwraps nested CallFailed down to the reason", () => {
    const reason = encodeErrorResult({ abi: [{ type: "error", name: "Error", inputs: [{ type: "string" }] }], errorName: "Error", args: ["ERC20: transfer amount exceeds balance"] });
    const inner = encodeErrorResult({ abi: executorAbi, errorName: "CallFailed", args: [1n, A.series.yt, reason] });
    const outer = encodeErrorResult({ abi: executorAbi, errorName: "CallFailed", args: [2n, MORPHO, inner] });
    expect(decodeRevert(outer)).toBe(
      "call #2 to Morpho Blue failed: call #1 to YT-USD3-17DEC2026 failed: ERC20: transfer amount exceeds balance",
    );
  });

  it("recognizes aggregator failures as re-quotable", () => {
    const guard = encodeErrorResult({ abi: executorAbi, errorName: "BalanceTooLow", args: [TOKENS.USDT.address, 1n, 2n] });
    const err = decodeRevert(encodeErrorResult({ abi: executorAbi, errorName: "CallFailed", args: [2n, MORPHO, guard] }));
    expect(isSwapFailure({ ok: false, block: 0n, error: err, method: "eth_simulateV1" })).toBe(true);
    expect(isSwapFailure({ ok: false, block: 0n, error: "call #1 to YT failed: x", method: "eth_simulateV1" })).toBe(false);
  });
});

describe("quoteForMinOut", () => {
  it("re-quotes with a larger sell amount until the target is met", async () => {
    // Fake Kyber: first quote at 1:1, then the route is 0.5% worse at larger sizes.
    let calls = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/routes?")) {
        const amountIn = BigInt(new URL(url, "http://x").searchParams.get("amountIn")!);
        calls++;
        const out = calls === 1 ? amountIn : (amountIn * 995n) / 1000n;
        return new Response(JSON.stringify({ data: { routeSummary: { amountIn: amountIn.toString(), amountOut: out.toString() } } }));
      }
      const body = JSON.parse(String(init!.body));
      return new Response(
        JSON.stringify({ data: { routerAddress: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5", data: "0xe21fd0e9", amountOut: body.routeSummary.amountOut } }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const cfg: QuoteConfig = { aggregator: "kyber", zeroXBase: "", kyberBase: "http://kyber" };
    const minOut = 1_000_000n;
    const s = await quoteForMinOut(cfg, TOKENS.USDC.address as Address, TOKENS.USDT.address as Address, minOut, executor, 10);
    expect(s.minOut).toBe(minOut);
    expect(s.quotedOut).toBeGreaterThanOrEqual((minOut * 10_010n) / 10_000n);
    expect(s.amountIn).toBeGreaterThan(minOut);
    vi.unstubAllGlobals();
  });
});

it("encodes calls exactly like the Solidity Call struct", () => {
  const c: Call = { target: executor, data: "0x12345678", patches: [{ offset: 4, source: Source.BALANCE, args: "0x", bps: 10_000 }] };
  const enc = encodeAbiParameters([callsType], [[c]]);
  const [dec] = decodeAbiParameters([callsType], enc);
  expect(dec[0]).toEqual(c);
});
