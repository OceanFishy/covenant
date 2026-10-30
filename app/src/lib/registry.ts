import { getAddress, type Address, type Hex } from "viem";
import registry from "../generated/registry.json";

export type Token = { symbol: string; address: Address; decimals: number };

export type PendleSeries = {
  name: string;
  pt: Address;
  yt: Address;
  sy: Address;
  expiry: number; // unix seconds
  /** PT and YT decimals (the SY asset's, USDC for both series) and SY decimals. */
  ptDecimals: number;
  syDecimals: number;
  /** Token SY redeems to and deposits from. */
  tokenOut: Address;
  /** SY redeems and deposits through 3Jane's USD3 (its USDC reserve and deposit cap apply). */
  viaUsd3: boolean;
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
/** Re's official reUSD redemption entry point (read-only: fee and status for comparisons). */
export const RE_REDEMPTION_GATEWAY: Address = getAddress(registry.re.redemptionGateway);

/** Aave v3 Core: the Pool and, per supported reserve, its aToken and variable debt token. */
export const AAVE_POOL: Address = getAddress(registry.aave.pool);

export type AaveReserve = { symbol: string; asset: Address; aToken: Token; debtToken: Token };

function aaveReserve(symbol: keyof typeof registry.aave.reserves): AaveReserve {
  const r = registry.aave.reserves[symbol];
  const asset = TOKENS[symbol];
  return {
    symbol,
    asset: asset.address,
    aToken: { symbol: r.aTokenSymbol, address: getAddress(r.aToken), decimals: asset.decimals },
    debtToken: { symbol: r.variableDebtTokenSymbol, address: getAddress(r.variableDebtToken), decimals: asset.decimals },
  };
}

export const AAVE_RESERVES: AaveReserve[] = [aaveReserve("USDC"), aaveReserve("USDT")];

/** The Aave reserve for an underlying asset (USDC / USDT). */
export function reserveOf(asset: Address): AaveReserve {
  const r = AAVE_RESERVES.find((x) => x.asset.toLowerCase() === asset.toLowerCase());
  if (!r) throw new Error(`${asset} is not a supported Aave reserve`);
  return r;
}

const AAVE_TOKENS: Token[] = AAVE_RESERVES.flatMap((r) => [r.aToken, r.debtToken]);

/**
 * Aave v4 Main Spoke. Your positions live on the Spoke; the Executor reaches them only through
 * Aave's Giver (supply / repay) and Taker (withdraw / borrow) position managers.
 */
export const AAVE_V4 = {
  spoke: getAddress(registry.aaveV4.mainSpoke),
  giver: getAddress(registry.aaveV4.giver),
  taker: getAddress(registry.aaveV4.taker),
};

export type AaveV4Reserve = { symbol: string; asset: Address; reserveId: bigint };

export const AAVE_V4_RESERVES: AaveV4Reserve[] = (["USDC", "USDT"] as const).map((symbol) => ({
  symbol,
  asset: TOKENS[symbol].address,
  reserveId: BigInt(registry.aaveV4.reserves[symbol].reserveId),
}));

/** The Aave v4 Main Spoke reserve for an underlying asset (USDC / USDT). */
export function reserveV4Of(asset: Address): AaveV4Reserve {
  const r = AAVE_V4_RESERVES.find((x) => x.asset.toLowerCase() === asset.toLowerCase());
  if (!r) throw new Error(`${asset} is not a supported Aave v4 reserve`);
  return r;
}

function series(name: keyof typeof registry.pendle, tokenOut: Address): PendleSeries {
  const s = registry.pendle[name];
  return {
    name,
    pt: getAddress(s.pt),
    yt: getAddress(s.yt),
    sy: getAddress(s.sy),
    expiry: Math.floor(Date.parse(s.expiry) / 1000),
    ptDecimals: s.ptDecimals,
    syDecimals: s.syDecimals,
    tokenOut,
    viaUsd3: s.syTokensOut.includes("USD3"),
  };
}

export const SERIES = {
  "PT-USD3-17DEC2026": series("PT-USD3-17DEC2026", TOKENS.USDC.address),
  // SY-reUSD only takes and returns reUSD: loops swap reUSD <-> USDC through an aggregator.
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

export const MARKETS: Market[] = [
  market("PT-USD3-17DEC2026/USDC (A)", "PT-USD3 / USDC · A", SERIES["PT-USD3-17DEC2026"]),
  market("PT-USD3-17DEC2026/USDC (B)", "PT-USD3 / USDC · B", SERIES["PT-USD3-17DEC2026"]),
  market("PT-USD3-17DEC2026/USDT", "PT-USD3 / USDT", SERIES["PT-USD3-17DEC2026"]),
  market("PT-reUSD-10DEC2026/USDC", "PT-reUSD / USDC", SERIES["PT-reUSD-10DEC2026"]),
];

const LABELS = new Map<string, string>([
  [MORPHO.toLowerCase(), "Morpho Blue"],
  [AAVE_POOL.toLowerCase(), "Aave v3 Pool"],
  [AAVE_V4.spoke.toLowerCase(), "Aave v4 Main Spoke"],
  [AAVE_V4.giver.toLowerCase(), "Aave v4 Giver"],
  [AAVE_V4.taker.toLowerCase(), "Aave v4 Taker"],
  [ZEROX_ALLOWANCE_HOLDER.toLowerCase(), "0x AllowanceHolder"],
  [KYBER_ROUTER.toLowerCase(), "KyberSwap router"],
  ...[...Object.values(TOKENS), ...AAVE_TOKENS].map((tk) => [tk.address.toLowerCase(), tk.symbol] as [string, string]),
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
  const known = [...Object.values(TOKENS), ...AAVE_TOKENS].find((tk) => tk.address.toLowerCase() === address.toLowerCase());
  if (known) return known;
  for (const s of Object.values(SERIES)) {
    const a = address.toLowerCase();
    if (a === s.pt.toLowerCase() || a === s.yt.toLowerCase()) return { symbol: label(address), address, decimals: s.ptDecimals };
    if (a === s.sy.toLowerCase()) return { symbol: label(address), address, decimals: s.syDecimals };
  }
  return { symbol: short(address), address, decimals: 18 };
}

/** Every token a plan may touch: swept back to the owner at the end of each plan. */
export const SWEEP_TOKENS: Address[] = [
  TOKENS.USDC.address,
  TOKENS.USDT.address,
  TOKENS.USD3.address,
  TOKENS.reUSD.address,
  ...MARKETS.flatMap((m) => [m.series.pt, m.series.yt, m.series.sy]),
].filter((a, i, all) => all.findIndex((b) => b.toLowerCase() === a.toLowerCase()) === i);

/**
 * Under EIP-7702 the delegate snapshots these at the start of a plan, and the plan may only
 * spend what it allots of them. Aave aTokens are included: a withdrawal burns them.
 */
export const TRACKED_TOKENS: Address[] = [...SWEEP_TOKENS, ...AAVE_RESERVES.map((r) => r.aToken.address)];

/** Tokens the Access panel checks for approvals to an Executor. */
export const APPROVAL_TOKENS: Address[] = [
  TOKENS.USDC.address,
  TOKENS.USDT.address,
  TOKENS.USD3.address,
  TOKENS.reUSD.address,
  ...Object.values(SERIES).flatMap((s) => [s.pt, s.yt, s.sy]),
  ...AAVE_RESERVES.map((r) => r.aToken.address),
];
