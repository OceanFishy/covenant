import { getAddress, type Address, type Hex } from "viem";
import registry from "../generated/registry.json";

export type Token = { symbol: string; address: Address; decimals: number };

export type PendleSeries = {
  name: string;
  pt: Address;
  yt: Address;
  sy: Address;
  expiry: number; // unix seconds
  /** Token SY redeems to and deposits from. */
  tokenOut: Address;
};

export type Market = {
  key: string;
  label: string;
  id: Hex;
  loanToken: Address;
  collateralToken: Address;
  oracle: Address;
  irm: Address;
  lltv: bigint;
  series: PendleSeries;
};

const t = registry.tokens;

export const TOKENS = {
  USDC: { symbol: "USDC", address: getAddress(t.USDC.address), decimals: 6 },
  USDT: { symbol: "USDT", address: getAddress(t.USDT.address), decimals: 6 },
  USD3: { symbol: "USD3", address: getAddress(t.USD3.address), decimals: 6 },
  reUSD: { symbol: "reUSD", address: getAddress(t.reUSD.address), decimals: 18 },
} satisfies Record<string, Token>;

export const MORPHO: Address = getAddress(registry.morpho.blue);
export const ZEROX_ALLOWANCE_HOLDER: Address = getAddress(registry.aggregators["0x"].allowanceHolder);
export const KYBER_ROUTER: Address = getAddress(registry.aggregators.kyberswap.router);

function series(name: keyof typeof registry.pendle, tokenOut: Address): PendleSeries {
  const s = registry.pendle[name];
  return {
    name,
    pt: getAddress(s.pt),
    yt: getAddress(s.yt),
    sy: getAddress(s.sy),
    expiry: Math.floor(Date.parse(s.expiry) / 1000),
    tokenOut,
  };
}

export const SERIES = {
  "PT-USD3-17DEC2026": series("PT-USD3-17DEC2026", TOKENS.USDC.address),
  "PT-reUSD-10DEC2026": series("PT-reUSD-10DEC2026", TOKENS.reUSD.address),
};

function market(key: keyof typeof registry.morpho.markets, label: string, s: PendleSeries): Market {
  const m = registry.morpho.markets[key];
  return {
    key,
    label,
    id: m.id as Hex,
    loanToken: getAddress(m.loanToken),
    collateralToken: getAddress(m.collateralToken),
    oracle: getAddress(m.oracle),
    irm: getAddress(m.irm),
    lltv: BigInt(m.lltv),
    series: s,
  };
}

/** Markets with full unwind support in v1. PT-reUSD exits need a reUSD route (M3). */
export const MARKETS: Market[] = [
  market("PT-USD3-17DEC2026/USDC (A)", "PT-USD3 / USDC · A", SERIES["PT-USD3-17DEC2026"]),
  market("PT-USD3-17DEC2026/USDC (B)", "PT-USD3 / USDC · B", SERIES["PT-USD3-17DEC2026"]),
  market("PT-USD3-17DEC2026/USDT", "PT-USD3 / USDT", SERIES["PT-USD3-17DEC2026"]),
];

const LABELS = new Map<string, string>([
  [MORPHO.toLowerCase(), "Morpho Blue"],
  [ZEROX_ALLOWANCE_HOLDER.toLowerCase(), "0x AllowanceHolder"],
  [KYBER_ROUTER.toLowerCase(), "KyberSwap router"],
  ...Object.values(TOKENS).map((tk) => [tk.address.toLowerCase(), tk.symbol] as [string, string]),
  ...Object.values(SERIES).flatMap((s) => [
    [s.pt.toLowerCase(), s.name] as [string, string],
    [s.yt.toLowerCase(), s.name.replace(/^PT/, "YT")] as [string, string],
    [s.sy.toLowerCase(), s.name.replace(/^PT-(\w+)-.*/, "SY-$1")] as [string, string],
  ]),
]);

/** Human label for a known address, else a shortened address. */
export function label(address: Address): string {
  return LABELS.get(address.toLowerCase()) ?? short(address);
}

export function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function tokenInfo(address: Address): Token {
  const known = Object.values(TOKENS).find((tk) => tk.address.toLowerCase() === address.toLowerCase());
  if (known) return known;
  // PT / YT / SY of the USD3 and reUSD series use their underlying's decimals.
  for (const s of Object.values(SERIES)) {
    if ([s.pt, s.yt, s.sy].some((a) => a.toLowerCase() === address.toLowerCase())) {
      const underlying = s.name.includes("reUSD") ? TOKENS.reUSD : TOKENS.USD3;
      return { symbol: label(address), address, decimals: underlying.decimals };
    }
  }
  return { symbol: short(address), address, decimals: 18 };
}

/** Every token a plan may touch: swept back to the owner at the end of each plan. */
export const SWEEP_TOKENS: Address[] = [
  TOKENS.USDC.address,
  TOKENS.USDT.address,
  TOKENS.USD3.address,
  ...MARKETS.flatMap((m) => [m.series.pt, m.series.yt, m.series.sy]),
].filter((a, i, all) => all.findIndex((b) => b.toLowerCase() === a.toLowerCase()) === i);

/** Tokens the Access panel checks for approvals to an Executor. */
export const APPROVAL_TOKENS: Address[] = [
  TOKENS.USDC.address,
  TOKENS.USDT.address,
  TOKENS.USD3.address,
  TOKENS.reUSD.address,
  ...Object.values(SERIES).flatMap((s) => [s.pt, s.yt, s.sy]),
];
