import type { Address, PublicClient } from "viem";
import { erc20Abi, irmAbi, morphoAbi, oracleAbi, syAbi, usd3Abi, ytAbi } from "./abis";
import { MARKETS, MORPHO, TOKENS, type Market } from "./registry";

const WAD = 10n ** 18n;
const ORACLE_SCALE = 10n ** 36n;
const VIRTUAL_SHARES = 10n ** 6n;
const VIRTUAL_ASSETS = 1n;

export type MarketState = {
  totalBorrowAssets: bigint;
  totalBorrowShares: bigint;
  lastUpdate: bigint;
};

export type PositionView = {
  market: Market;
  collateral: bigint;
  borrowShares: bigint;
  /** Debt including interest accrued since the market's last update (rounded up). */
  debt: bigint;
  price: bigint;
  /** 1e18 = liquidation; max uint when there is no debt. */
  healthFactor: bigint;
  /** Debt / collateral value, 1e18 = 100%. */
  ltv: bigint;
  ytBalance: bigint;
  /** PT that can be redeemed now (pre-expiry: limited by YT). */
  matched: bigint;
  /** Estimated tokenOut from redeeming `matched` PT, and from all PT with enough YT. */
  proceedsMatched: bigint;
  proceedsAll: bigint;
  expired: boolean;
};

function mulDivUp(a: bigint, b: bigint, d: bigint): bigint {
  return (a * b + d - 1n) / d;
}

/** Morpho's wTaylorCompounded: e^(rate * elapsed) - 1, in WAD. */
function taylor(rate: bigint, elapsed: bigint): bigint {
  const first = rate * elapsed;
  const second = (first * first) / (2n * WAD);
  const third = (second * first) / (3n * WAD);
  return first + second + third;
}

export function healthFactor(collateral: bigint, price: bigint, lltv: bigint, debt: bigint): bigint {
  if (debt === 0n) return 2n ** 256n - 1n;
  const maxBorrow = (((collateral * price) / ORACLE_SCALE) * lltv) / WAD;
  return (maxBorrow * WAD) / debt;
}

function params(m: Market) {
  return { loanToken: m.loanToken, collateralToken: m.collateralToken, oracle: m.oracle, irm: m.irm, lltv: m.lltv };
}

/** Debt with interest accrued up to `now`, exactly as Morpho will compute it on accrueInterest. */
export async function expectedDebt(client: PublicClient, m: Market, borrowShares: bigint, now: bigint): Promise<bigint> {
  if (borrowShares === 0n) return 0n;
  const raw = await client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "market", args: [m.id] });
  const [totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee] = raw;
  let borrowAssets = totalBorrowAssets;
  const elapsed = now - lastUpdate;
  if (elapsed > 0n && totalBorrowAssets > 0n) {
    const rate = await client.readContract({
      address: m.irm,
      abi: irmAbi,
      functionName: "borrowRateView",
      args: [params(m), { totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee }],
    });
    borrowAssets += (totalBorrowAssets * taylor(rate, elapsed)) / WAD;
  }
  return mulDivUp(borrowShares, borrowAssets + VIRTUAL_ASSETS, totalBorrowShares + VIRTUAL_SHARES);
}

/** Estimated tokenOut from redeeming `pt` PT (+ equal YT): SY = PT / pyIndex, then SY.previewRedeem. */
export async function previewRedeemPt(client: PublicClient, m: Market, pt: bigint): Promise<bigint> {
  if (pt === 0n) return 0n;
  const s = m.series;
  const pyIndex = await client.readContract({ address: s.yt, abi: ytAbi, functionName: "pyIndexStored" });
  const sy = (pt * WAD) / pyIndex;
  return client.readContract({ address: s.sy, abi: syAbi, functionName: "previewRedeem", args: [s.tokenOut, sy] });
}

export async function readPosition(client: PublicClient, m: Market, owner: Address): Promise<PositionView> {
  const [pos, price, ytBalance, block, expired] = await Promise.all([
    client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "position", args: [m.id, owner] }),
    client.readContract({ address: m.oracle, abi: oracleAbi, functionName: "price" }),
    client.readContract({ address: m.series.yt, abi: erc20Abi, functionName: "balanceOf", args: [owner] }),
    client.getBlock(),
    client.readContract({ address: m.series.yt, abi: ytAbi, functionName: "isExpired" }),
  ]);
  const [, borrowShares, collateral] = pos;
  // Allow ~2 blocks between reading and the transaction landing.
  const debt = await expectedDebt(client, m, borrowShares, block.timestamp + 24n);
  const matched = expired ? collateral : collateral < ytBalance ? collateral : ytBalance;
  const [proceedsMatched, proceedsAll] = await Promise.all([
    previewRedeemPt(client, m, matched),
    previewRedeemPt(client, m, collateral),
  ]);
  const collateralValue = (collateral * price) / ORACLE_SCALE;
  return {
    market: m,
    collateral,
    borrowShares,
    debt,
    price,
    healthFactor: healthFactor(collateral, price, m.lltv, debt),
    ltv: collateralValue === 0n ? 0n : (debt * WAD) / collateralValue,
    ytBalance,
    matched,
    proceedsMatched,
    proceedsAll,
    expired,
  };
}

export async function readPositions(client: PublicClient, owner: Address): Promise<PositionView[]> {
  return Promise.all(MARKETS.map((m) => readPosition(client, m, owner)));
}

/** 3Jane liquidity: how much USD3 SY-USD3 can redeem / deposit right now. */
export async function usd3Limits(client: PublicClient, sy: Address) {
  const [withdraw, deposit] = await Promise.all([
    client.readContract({ address: TOKENS.USD3.address, abi: usd3Abi, functionName: "availableWithdrawLimit", args: [sy] }),
    client.readContract({ address: TOKENS.USD3.address, abi: usd3Abi, functionName: "maxDeposit", args: [sy] }),
  ]);
  return { withdraw, deposit };
}
