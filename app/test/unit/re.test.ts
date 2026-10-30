import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import type { Swap } from "../../src/lib/compiler/types";
import { compareReUsdSale } from "../../src/lib/re";
import { TOKENS } from "../../src/lib/registry";

describe("compareReUsdSale", () => {
  it("values 18dp reUSD at Re's WAD NAV in 6dp USDC and nets the official fee", () => {
    const router = getAddress("0x6131B5fae19EA4f9D964eAc0408E4408b66337b5");
    const swap: Swap = {
      aggregator: "kyber",
      sellToken: TOKENS.reUSD.address,
      buyToken: TOKENS.USDC.address,
      spender: router,
      target: router,
      data: "0x",
      amountIn: 1_000n * 10n ** 18n, // 1,000 reUSD
      quotedOut: 1_106_000_000n, // 1,106 USDC
      minOut: 1_100_000_000n,
    };
    const c = compareReUsdSale(swap, { navWad: 1_110_000_000_000_000_000n, feeBps: 6n, maxUsdWad: 0n, instant: true, payoutSymbol: "sUSDe" });
    expect(c.navValue).toBe(1_110_000_000n); // 1,110 USDC at NAV 1.11
    expect(c.dexCost).toBe(4_000_000n);
    expect(c.dexWorstCost).toBe(10_000_000n);
    expect(c.officialFee).toBe(666_000n); // 0.06% of 1,110
    expect(c.difference).toBe(3_334_000n);
  });
});
