import { erc20Abi, type PublicClient } from "viem";
import { reGatewayAbi, reInstantRedemptionAbi, rePayoutRegistryAbi, rePriceRouterAbi } from "./abis";
import type { Swap } from "./compiler/types";
import { RE_REDEMPTION_GATEWAY, TOKENS } from "./registry";

/** Re's official instant redemption, as its contracts quote it right now. */
export type ReRedemption = {
  /** USD per reUSD (WAD) from Re's redemption price router: the NAV redemptions pay out at. */
  navWad: bigint;
  feeBps: bigint;
  /** Largest single redemption, USD (WAD). */
  maxUsdWad: bigint;
  /** The gateway's currentMode() is INSTANT (not paused, no quarterly window). */
  instant: boolean;
  /** Symbol of the token redemptions currently pay out (sUSDe on 2026-10-30). */
  payoutSymbol: string;
};

const INSTANT_MODE = 1;

export async function readReRedemption(client: PublicClient): Promise<ReRedemption> {
  const [module, mode] = await Promise.all([
    client.readContract({ address: RE_REDEMPTION_GATEWAY, abi: reGatewayAbi, functionName: "instantRedemption" }),
    client.readContract({ address: RE_REDEMPTION_GATEWAY, abi: reGatewayAbi, functionName: "currentMode" }),
  ]);
  const [feeBps, maxUsdWad, router, payoutRegistry] = await Promise.all([
    client.readContract({ address: module, abi: reInstantRedemptionAbi, functionName: "feeBps" }),
    client.readContract({ address: module, abi: reInstantRedemptionAbi, functionName: "maxRedemption" }),
    client.readContract({ address: module, abi: reInstantRedemptionAbi, functionName: "redemptionPriceRouter" }),
    client.readContract({ address: module, abi: reInstantRedemptionAbi, functionName: "payoutTokenRegistry" }),
  ]);
  const [navWad, payoutToken] = await Promise.all([
    client.readContract({ address: router, abi: rePriceRouterAbi, functionName: "getPrice", args: [TOKENS.reUSD.address] }),
    client.readContract({ address: payoutRegistry, abi: rePayoutRegistryAbi, functionName: "activePayoutToken" }),
  ]);
  const payoutSymbol = await client.readContract({ address: payoutToken, abi: erc20Abi, functionName: "symbol" });
  return { navWad, feeBps: BigInt(feeBps), maxUsdWad, instant: mode === INSTANT_MODE, payoutSymbol };
}

/**
 * What a reUSD → stablecoin aggregator swap costs against Re's NAV, next to what Re's official
 * redemption fee would be on the same reUSD. All amounts in the 6-decimal stablecoin, valued 1:1
 * with USD. `difference` > 0: the DEX sale costs that much more than the official fee.
 */
export function compareReUsdSale(swap: Swap, re: ReRedemption) {
  const navValue = (swap.amountIn * re.navWad) / 10n ** 30n; // 18dp reUSD × WAD price → 6dp
  const dexCost = navValue - swap.quotedOut;
  const dexWorstCost = navValue - swap.minOut;
  const officialFee = (navValue * re.feeBps) / 10_000n;
  return { navValue, dexCost, dexWorstCost, officialFee, difference: dexCost - officialFee };
}
