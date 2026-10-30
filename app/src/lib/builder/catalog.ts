import type { Address } from "viem";
import { MARKETS, SERIES, TOKENS } from "../registry";
import type { Block, BlockType } from "./types";

export type Group = "Wallet" | "Morpho" | "Pendle" | "Swap" | "Guard";

export type BlockDef = {
  type: BlockType;
  title: string;
  group: Group;
  /** One line shown in the palette. */
  hint: string;
  /** Extra words the palette search matches. */
  keywords: string;
  create: (id: string) => Block;
};

const M0 = MARKETS[0].key;
const S0 = "PT-USD3-17DEC2026";
const USDC: Address = TOKENS.USDC.address;

export const CATALOG: BlockDef[] = [
  {
    type: "pull",
    title: "Pull from wallet",
    group: "Wallet",
    hint: "Move a token from your wallet into the Executor (uses your one-time approval)",
    keywords: "transferFrom yt usdc equity",
    create: (id) => ({ id, type: "pull", token: SERIES[S0].yt, amount: { kind: "fixed", value: "0" } }),
  },
  {
    type: "flashLoan",
    title: "Flash loan",
    group: "Morpho",
    hint: "Fee-free Morpho flash loan; blocks inside it run before it is repaid",
    keywords: "flash borrow container",
    create: (id) => ({ id, type: "flashLoan", token: USDC, amount: { kind: "debt", market: M0, bps: 10_001 }, children: [] }),
  },
  {
    type: "accrueInterest",
    title: "Accrue interest",
    group: "Morpho",
    hint: "Bring the market's debt up to date so 'debt' amounts are exact",
    keywords: "accrue",
    create: (id) => ({ id, type: "accrueInterest", market: M0 }),
  },
  {
    type: "repay",
    title: "Repay debt",
    group: "Morpho",
    hint: "Repay your debt on a market (all by shares, or an amount)",
    keywords: "repay loan",
    create: (id) => ({ id, type: "repay", market: M0, amount: { kind: "allShares" } }),
  },
  {
    type: "withdrawCollateral",
    title: "Withdraw collateral",
    group: "Morpho",
    hint: "Withdraw PT collateral into the Executor",
    keywords: "withdraw collateral pt",
    create: (id) => ({ id, type: "withdrawCollateral", market: M0, amount: { kind: "collateral" } }),
  },
  {
    type: "supplyCollateral",
    title: "Supply collateral",
    group: "Morpho",
    hint: "Supply PT from the Executor as collateral for you",
    keywords: "supply deposit collateral pt",
    create: (id) => ({ id, type: "supplyCollateral", market: M0, amount: { kind: "balance" } }),
  },
  {
    type: "borrow",
    title: "Borrow",
    group: "Morpho",
    hint: "Borrow on a market, into the Executor",
    keywords: "borrow loan",
    create: (id) => ({ id, type: "borrow", market: M0, amount: { kind: "fixed", value: "0" } }),
  },
  {
    type: "redeemPY",
    title: "Redeem PT + YT",
    group: "Pendle",
    hint: "PT + equal YT → SY (Pendle core; never trades)",
    keywords: "redeem pendle pt yt redeempy",
    create: (id) => ({ id, type: "redeemPY", series: S0, amount: { kind: "balance" } }),
  },
  {
    type: "redeemSY",
    title: "Redeem SY",
    group: "Pendle",
    hint: "All SY → USDC / USD3 (SY-USD3 redeems through 3Jane)",
    keywords: "redeem sy usd3 3jane",
    create: (id) => ({ id, type: "redeemSY", series: S0, tokenOut: USDC, minOut: { kind: "fixed", value: "0" } }),
  },
  {
    type: "mintPY",
    title: "Mint PT + YT",
    group: "Pendle",
    hint: "USDC / USD3 → SY → PT + YT at par (no trading)",
    keywords: "mint pendle deposit enter",
    create: (id) => ({ id, type: "mintPY", series: S0, tokenIn: USDC, amount: { kind: "balance" }, ytTo: "wallet" }),
  },
  {
    type: "swap",
    title: "Swap stablecoins",
    group: "Swap",
    hint: "USDC ↔ USDT via 0x / KyberSwap, output checked on-chain",
    keywords: "swap aggregator usdt usdc 0x kyber",
    create: (id) => ({ id, type: "swap", sell: USDC, buy: TOKENS.USDT.address, mode: "minOut", amount: { kind: "fixed", value: "0" } }),
  },
  {
    type: "guardNoDebt",
    title: "Check: no debt",
    group: "Guard",
    hint: "Revert everything if any debt is left on a market",
    keywords: "guard assert debt",
    create: (id) => ({ id, type: "guardNoDebt", market: M0 }),
  },
  {
    type: "guardMinHealth",
    title: "Check: health factor",
    group: "Guard",
    hint: "Revert everything if the health factor ends below a minimum",
    keywords: "guard assert health hf",
    create: (id) => ({ id, type: "guardMinHealth", market: M0, min: "1.05" }),
  },
  {
    type: "guardMinBalance",
    title: "Check: minimum received",
    group: "Guard",
    hint: "Revert everything if the Executor holds less than a minimum (before it sends it to you)",
    keywords: "guard assert min out slippage receive",
    create: (id) => ({ id, type: "guardMinBalance", token: USDC, min: { kind: "fixed", value: "0" } }),
  },
];

export function def(type: BlockType): BlockDef {
  return CATALOG.find((d) => d.type === type)!;
}

/** Blocks matching every word; title matches rank first (so Enter adds the obvious one). */
export function searchCatalog(q: string): BlockDef[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return CATALOG;
  const score = (d: BlockDef) => {
    const title = d.title.toLowerCase();
    const hay = `${title} ${d.group} ${d.hint} ${d.keywords}`.toLowerCase();
    if (!words.every((w) => hay.includes(w))) return 0;
    return words.filter((w) => title.split(/[^a-z0-9]+/).some((t) => t.startsWith(w))).length + 1;
  };
  return CATALOG.map((d) => [d, score(d)] as const)
    .filter(([, s]) => s > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([d]) => d);
}

let counter = 0;
export function newId(): string {
  counter += 1;
  return `b${Date.now().toString(36)}${counter}`;
}

/** Tokens a swap block may use: stablecoins only, never Pendle assets (docs/SPEC.md §5.1). */
export const SWAP_TOKENS: Address[] = [TOKENS.USDC.address, TOKENS.USDT.address];

/** Tokens a pull block may use. */
export const PULL_TOKENS: Address[] = [
  TOKENS.USDC.address,
  TOKENS.USDT.address,
  TOKENS.USD3.address,
  ...Object.values(SERIES).flatMap((s) => [s.pt, s.yt]),
];
