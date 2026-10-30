import type { Address } from "viem";
import { health, signed, withSymbol } from "../format";
import type { Plan } from "../lib/compiler/types";
import { TOKENS } from "../lib/registry";
import type { SimulationResult } from "../lib/simulate";
import { AddressLink } from "./common";
import { ReUsdFeeComparison } from "./ReUsdFeeComparison";

const TITLES: Record<Plan["kind"], string> = {
  unwind: "Full unwind: all debt repaid, all collateral redeemed",
  deleverage: "Repay all debt; PT without matching YT returns to your wallet",
  partial: "Partial unwind: repays what the redeemed PT pays for; a smaller loop stays open",
  enter: "Enter: open a leveraged PT loop",
  custom: "Custom flow",
};

/** Simulated wallet balance changes and resulting positions (Review and Builder). */
export function SimSummary({ plan, sim, compact }: { plan: Plan; sim: Extract<SimulationResult, { ok: true }>; compact?: boolean }) {
  return (
    <>
      <h3>{TITLES[plan.kind]}</h3>
      <table data-testid="balance-changes">
        <thead>
          <tr>
            <th>Your wallet</th>
            {!compact && <th>Before</th>}
            {!compact && <th>After</th>}
            <th>Change</th>
          </tr>
        </thead>
        <tbody>
          {sim.changes.map((c) => (
            <tr key={c.token}>
              <td>{c.symbol}</td>
              {!compact && <td>{withSymbol(c.before, c.token)}</td>}
              {!compact && <td>{withSymbol(c.after, c.token)}</td>}
              <td className={c.after > c.before ? "ok-text" : c.after < c.before ? "danger-text" : ""}>{signed(c.after - c.before, c.token)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {sim.positions.map((p) => (
        <p className="row small" key={p.market.key}>
          <span>
            {p.market.label} after: {withSymbol(p.collateral, p.market.series.pt, 0)} collateral,{" "}
            {p.borrowShares === 0n ? "no debt" : "debt remains"}
          </span>
          <span>· health {health(p.health)}</span>
        </p>
      ))}
      {sim.aaveHealthAfter !== undefined && (
        <p className="row small" data-testid="aave-after">
          <span>Aave v3 after: health {health(sim.aaveHealthAfter)}</span>
        </p>
      )}
      <p className="row small muted">
        <span>gas {sim.gasUsed.toLocaleString()}</span>
        <span>· simulated at block {String(sim.block)} ({sim.method})</span>
      </p>
      {plan.swap && (
        <p className="small">
          Swap leg: {withSymbol(plan.swap.amountIn, plan.swap.sellToken)} → ≥ {withSymbol(plan.swap.minOut, plan.swap.buyToken)} via{" "}
          {plan.swap.aggregator === "0x" ? "0x" : "KyberSwap"} (USDC / USDT / reUSD only, never Pendle assets; checked on-chain).
        </p>
      )}
      {plan.swap?.sellToken === TOKENS.reUSD.address && <ReUsdFeeComparison swap={plan.swap} />}
      {plan.kind === "deleverage" && <OwnerAddress address={plan.owner} />}
    </>
  );
}

function OwnerAddress({ address }: { address: Address }) {
  return (
    <p className="small muted">
      Unlevered PT goes to <AddressLink address={address} />. It redeems on its own at maturity, or with matching YT.
    </p>
  );
}
