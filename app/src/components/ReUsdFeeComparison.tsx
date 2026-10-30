import { withSymbol } from "../format";
import { usePoll } from "../hooks";
import { publicClient } from "../lib/chain";
import type { Swap } from "../lib/compiler/types";
import { compareReUsdSale, readReRedemption } from "../lib/re";

/** Cost of selling reUSD on a DEX vs. Re's official instant-redemption fee on the same amount. */
export function ReUsdFeeComparison({ swap }: { swap: Swap }) {
  const { data: re, error } = usePoll(() => readReRedemption(publicClient), [], 60_000);
  if (error) return <p className="small muted">Re's official redemption fee couldn't be read: {error}</p>;
  if (!re) return null;
  const c = compareReUsdSale(swap, re);
  const usd = (v: bigint) => (v < 0n ? `−${withSymbol(-v, swap.buyToken)}` : withSymbol(v, swap.buyToken));
  const pctOf = (v: bigint) => `${(Number((v * 1_000_000n) / c.navValue) / 10_000).toFixed(2)}%`;
  return (
    <div className="small" data-testid="reusd-fee-comparison">
      <table>
        <thead>
          <tr>
            <th>Selling {withSymbol(swap.amountIn, swap.sellToken)} (Re NAV {usd(c.navValue)})</th>
            <th>Cost vs NAV</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>DEX sale via {swap.aggregator === "0x" ? "0x" : "KyberSwap"}, quoted</td>
            <td>
              {usd(c.dexCost)} ({pctOf(c.dexCost)})
            </td>
          </tr>
          <tr>
            <td>DEX sale, worst case the on-chain guard allows</td>
            <td>
              {usd(c.dexWorstCost)} ({pctOf(c.dexWorstCost)})
            </td>
          </tr>
          <tr>
            <td>Re official redemption fee ({(Number(re.feeBps) / 100).toFixed(2)}%)</td>
            <td>{usd(c.officialFee)}</td>
          </tr>
          <tr>
            <td>
              <b>Difference (DEX quote − official fee)</b>
            </td>
            <td className={c.difference > 0n ? "warn-text" : "ok-text"}>
              <b>
                {c.difference > 0n ? "+" : ""}
                {usd(c.difference)}
              </b>
            </td>
          </tr>
        </tbody>
      </table>
      <p className="muted">
        Official redemption is {re.instant ? "open" : "paused right now"}. It needs a KYC-approved caller (your Executor
        isn't one), pays {re.payoutSymbol} rather than USDC, and takes at most{" "}
        {withSymbol(re.maxUsdWad / 10n ** 12n, swap.buyToken, 0)} per call, so Covenant sells on a DEX instead.
      </p>
    </div>
  );
}
