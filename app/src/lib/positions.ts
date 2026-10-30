import type { Address, PublicClient } from "viem";
import { erc20Abi, irmAbi, morphoAbi, oracleAbi, syAbi, usd3Abi, ytAbi } from "./abis";
import { MARKETS, MORPHO, TOKENS, type Market, type PendleSeries } from "./registry";

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
  /** Loan tokens `proceedsMatched` is expected to repay (see loanValue). */
  valueMatched: bigint;
  expired: boolean;
};

/**
 * What selling a non-USDC tokenOut (reUSD) for USDC costs at size, below its NAV. KyberSwap on
 * 2026-10-29: 0.36% for 1M reUSD, 0.45% for 5M.
 */
const SALE_HAIRCUT_BPS = 100n;

/**
 * Loan tokens that `proceeds` tokenOut, redeemed from `sy` SY, are expected to repay. USDC counts
 * 1:1 (for USDT debt too). Any other tokenOut (reUSD) is valued at the SY's asset value (USDC:
 * SY × exchangeRate, i.e. Re's NAV) less SALE_HAIRCUT_BPS for selling it.
 */
function loanValue(s: PendleSeries, proceeds: bigint, sy: bigint, rate: bigint): bigint {
  if (s.tokenOut === TOKENS.USDC.address) return proceeds;
  return (((sy * rate) / WAD) * (10_000n - SALE_HAIRCUT_BPS)) / 10_000n;
}

/** USDC value of `amount` tokenOut: USDC itself, or another token (reUSD) at its SY's asset value (NAV). */
export async function tokenOutValue(client: PublicClient, s: PendleSeries, amount: bigint): Promise<bigint> {
  if (s.tokenOut === TOKENS.USDC.address || amount === 0n) return amount;
  const [sy, rate] = await Promise.all([
    client.readContract({ address: s.sy, abi: syAbi, functionName: "previewDeposit", args: [s.tokenOut, amount] }),
    client.readContract({ address: s.sy, abi: syAbi, functionName: "exchangeRate" }),
  ]);
  return (sy * rate) / WAD;
}

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

type RawMarket = readonly [bigint, bigint, bigint, bigint, bigint, bigint];

/** Debt with interest accrued for `elapsed` seconds at `rate` (Morpho's own math). */
function accruedDebt(raw: RawMarket, rate: bigint, elapsed: bigint, borrowShares: bigint): bigint {
  const [, , totalBorrowAssets, totalBorrowShares] = raw;
  const borrowAssets = elapsed > 0n && totalBorrowAssets > 0n ? totalBorrowAssets + (totalBorrowAssets * taylor(rate, elapsed)) / WAD : totalBorrowAssets;
  return borrowShares === 0n ? 0n : mulDivUp(borrowShares, borrowAssets + VIRTUAL_ASSETS, totalBorrowShares + VIRTUAL_SHARES);
}

/**
 * Reads positions for several markets in two batched rounds (concurrent reads are merged into one
 * Multicall3 call by the client): round 1 = positions, market totals, prices, YT balances, expiry,
 * Pendle index + the latest block; round 2 = interest rates and redemption previews.
 */
export async function readPositionsFor(client: PublicClient, markets: Market[], owner: Address): Promise<PositionView[]> {
  const seriesList = [...new Set(markets.map((m) => m.series))];
  const [block, perMarket, perSeries] = await Promise.all([
    client.getBlock(),
    Promise.all(
      markets.map((m) =>
        Promise.all([
          client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "position", args: [m.id, owner] }),
          client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "market", args: [m.id] }),
          client.readContract({ address: m.oracle, abi: oracleAbi, functionName: "price" }),
        ]),
      ),
    ),
    Promise.all(
      seriesList.map((s) =>
        Promise.all([
          client.readContract({ address: s.yt, abi: erc20Abi, functionName: "balanceOf", args: [owner] }),
          client.readContract({ address: s.yt, abi: ytAbi, functionName: "isExpired" }),
          client.readContract({ address: s.yt, abi: ytAbi, functionName: "pyIndexStored" }),
          client.readContract({ address: s.sy, abi: syAbi, functionName: "exchangeRate" }),
        ]),
      ),
    ),
  ]);
  // Allow ~2 blocks between reading and the transaction landing.
  const now = block.timestamp + 24n;

  const rows = markets.map((m, i) => {
    const [[, borrowShares, collateral], raw, price] = perMarket[i];
    const [ytBalance, expired, pyIndex, syRate] = perSeries[seriesList.indexOf(m.series)];
    const matched = expired ? collateral : collateral < ytBalance ? collateral : ytBalance;
    return { m, borrowShares, collateral, raw, price, ytBalance, expired, pyIndex, syRate, matched };
  });

  const previews = (r: (typeof rows)[number], pt: bigint) =>
    pt === 0n
      ? Promise.resolve(0n)
      : client.readContract({ address: r.m.series.sy, abi: syAbi, functionName: "previewRedeem", args: [r.m.series.tokenOut, (pt * WAD) / r.pyIndex] });
  const round2 = await Promise.all(
    rows.map((r) => {
      const [totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee] = r.raw;
      const needsRate = r.borrowShares > 0n && totalBorrowAssets > 0n && now > lastUpdate;
      return Promise.all([
        needsRate
          ? client.readContract({
              address: r.m.irm,
              abi: irmAbi,
              functionName: "borrowRateView",
              args: [params(r.m), { totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee }],
            })
          : Promise.resolve(0n),
        previews(r, r.matched),
        r.matched === r.collateral ? Promise.resolve(undefined) : previews(r, r.collateral),
      ]);
    }),
  );

  return rows.map((r, i): PositionView => {
    const [rate, proceedsMatched, proceedsAllMaybe] = round2[i];
    const debt = accruedDebt(r.raw, rate, now - r.raw[4], r.borrowShares);
    const collateralValue = (r.collateral * r.price) / ORACLE_SCALE;
    return {
      market: r.m,
      collateral: r.collateral,
      borrowShares: r.borrowShares,
      debt,
      price: r.price,
      healthFactor: healthFactor(r.collateral, r.price, r.m.lltv, debt),
      ltv: collateralValue === 0n ? 0n : (debt * WAD) / collateralValue,
      ytBalance: r.ytBalance,
      matched: r.matched,
      proceedsMatched,
      valueMatched: loanValue(r.m.series, proceedsMatched, (r.matched * WAD) / r.pyIndex, r.syRate),
      proceedsAll: proceedsAllMaybe ?? proceedsMatched,
      expired: r.expired,
    };
  });
}

export async function readPosition(client: PublicClient, m: Market, owner: Address): Promise<PositionView> {
  return (await readPositionsFor(client, [m], owner))[0];
}

export async function readPositions(client: PublicClient, owner: Address): Promise<PositionView[]> {
  return readPositionsFor(client, MARKETS, owner);
}

/** 3Jane liquidity: how much USD3 SY-USD3 can redeem / deposit right now. */
export async function usd3Limits(client: PublicClient, sy: Address) {
  const [withdraw, deposit] = await Promise.all([
    client.readContract({ address: TOKENS.USD3.address, abi: usd3Abi, functionName: "availableWithdrawLimit", args: [sy] }),
    client.readContract({ address: TOKENS.USD3.address, abi: usd3Abi, functionName: "maxDeposit", args: [sy] }),
  ]);
  return { withdraw, deposit };
}

/**
 * The most PT (with equal YT) of a USD3 series that can be redeemed to USDC right now, i.e. what
 * 3Jane's USDC reserve can pay out. SY-USD3 holds USD3 1:1 and USD3 lets it redeem at most
 * `maxRedeem(SY)` shares (its idle + withdrawable liquidity, after 3Jane's floors). redeemPY gives
 * floor(PT × 1e18 / index) SY at the index it computes on execution, max(stored, SY.exchangeRate()),
 * so floor(maxRedeem × index / 1e18) PT never asks for more than `maxRedeem` and drains it to
 * within a share.
 */
export async function usd3RedeemablePt(client: PublicClient, s: PendleSeries): Promise<bigint> {
  const [maxSy, stored, rate] = await Promise.all([
    client.readContract({ address: TOKENS.USD3.address, abi: usd3Abi, functionName: "maxRedeem", args: [s.sy] }),
    client.readContract({ address: s.yt, abi: ytAbi, functionName: "pyIndexStored" }),
    client.readContract({ address: s.sy, abi: syAbi, functionName: "exchangeRate" }),
  ]);
  const index = rate > stored ? rate : stored;
  return (maxSy * index) / WAD;
}
