import { getAddress, type Address, type Hex } from "viem";
import type { Swap } from "./compiler/types";
import { tokenInfo } from "./registry";

/** Where aggregator APIs are reached. The app uses the local Vite proxy (which adds the 0x key). */
export type QuoteConfig = {
  aggregator: "0x" | "kyber";
  zeroXBase: string;
  kyberBase: string;
  headers?: Record<string, string>;
};

export const defaultQuoteConfig: QuoteConfig = {
  aggregator: typeof __ZEROX_ENABLED__ !== "undefined" && __ZEROX_ENABLED__ ? "0x" : "kyber",
  zeroXBase: "/api/0x",
  kyberBase: "/api/kyber",
};

const SLIPPAGE_BPS = 30;

async function getJson(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`quote failed (${res.status}): ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}

/** One aggregator quote for a fixed sell amount, taker and recipient = executor. */
export async function quote(
  cfg: QuoteConfig,
  sellToken: Address,
  buyToken: Address,
  amountIn: bigint,
  taker: Address,
): Promise<Omit<Swap, "minOut">> {
  if (cfg.aggregator === "0x") {
    const q = new URLSearchParams({
      chainId: "1",
      sellToken,
      buyToken,
      sellAmount: amountIn.toString(),
      taker,
      slippageBps: String(SLIPPAGE_BPS),
    });
    const d = await getJson(`${cfg.zeroXBase}/swap/allowance-holder/quote?${q}`, { headers: cfg.headers });
    if (!d.transaction) throw new Error("0x returned no route");
    const to = getAddress(d.transaction.to);
    return { aggregator: "0x", sellToken, buyToken, spender: to, target: to, data: d.transaction.data as Hex, amountIn, quotedOut: BigInt(d.buyAmount) };
  }
  const q = new URLSearchParams({ tokenIn: sellToken, tokenOut: buyToken, amountIn: amountIn.toString() });
  const route = (await getJson(`${cfg.kyberBase}/ethereum/api/v1/routes?${q}`, { headers: cfg.headers })).data;
  const built = (
    await getJson(`${cfg.kyberBase}/ethereum/api/v1/route/build`, {
      method: "POST",
      headers: { ...cfg.headers, "content-type": "application/json" },
      body: JSON.stringify({ routeSummary: route.routeSummary, sender: taker, recipient: taker, slippageTolerance: SLIPPAGE_BPS }),
    })
  ).data;
  const router = getAddress(built.routerAddress);
  return { aggregator: "kyber", sellToken, buyToken, spender: router, target: router, data: built.data as Hex, amountIn, quotedOut: BigInt(built.amountOut) };
}

/**
 * Buys at least `minOut` of buyToken while selling as little as possible. Quotes target minOut +
 * `headroomBps` so the route has room to drift before execution. The first quote probes the rate
 * by selling minOut's face value in sellToken units (USDC → USDT, or reUSD → USDC: 18 vs 6
 * decimals); routes differ between sizes, so a short quote is scaled up and re-quoted (max 3).
 */
export async function quoteForMinOut(
  cfg: QuoteConfig,
  sellToken: Address,
  buyToken: Address,
  minOut: bigint,
  taker: Address,
  headroomBps: number,
): Promise<Swap> {
  const target = (minOut * BigInt(10_000 + headroomBps)) / 10_000n;
  const probeIn = (minOut * 10n ** BigInt(tokenInfo(sellToken).decimals)) / 10n ** BigInt(tokenInfo(buyToken).decimals);
  const probe = await quote(cfg, sellToken, buyToken, probeIn, taker);
  let sell = (probeIn * target) / probe.quotedOut;
  for (let i = 0; i < 3; i++) {
    const q = await quote(cfg, sellToken, buyToken, sell, taker);
    if (q.quotedOut >= target) return { ...q, minOut };
    sell = (((sell * target) / q.quotedOut) * 10_002n) / 10_000n;
  }
  throw new Error("aggregator could not quote enough output after 3 tries");
}

/** Sells exactly `amountIn` (e.g. a flash-loaned amount on entry), min out = quote − 0.3%. */
export async function quoteExactIn(cfg: QuoteConfig, sellToken: Address, buyToken: Address, amountIn: bigint, taker: Address): Promise<Swap> {
  const q = await quote(cfg, sellToken, buyToken, amountIn, taker);
  return { ...q, minOut: (q.quotedOut * 997n) / 1000n };
}

/** Re-quote headroom ladder used when a pre-sign simulation trips the swap guard (§7.1). */
export const HEADROOM_LADDER_BPS = [10, 30, 60];
