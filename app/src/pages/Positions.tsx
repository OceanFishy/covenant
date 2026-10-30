import { useState } from "react";
import { parseUnits } from "viem";
import { Card, Notice } from "../components/common";
import { health, pct, withSymbol } from "../format";
import { go, usePoll } from "../hooks";
import { publicClient } from "../lib/chain";
import { unwindMode, type UnwindMode } from "../lib/planner";
import { readPositions, usd3Limits, type PositionView } from "../lib/positions";
import { MARKETS, SERIES, TOKENS } from "../lib/registry";
import { useApp } from "../state";

const MODE_LABEL: Record<UnwindMode, string> = {
  unwind: "Unwind fully → USDC",
  deleverage: "Repay all debt (some PT stays, unlevered)",
  partial: "Partial unwind (YT covers part)",
};

export function PositionsPage() {
  const app = useApp();
  const owner = app.conn?.account;
  const { data, error, loading } = usePoll(owner ? () => readPositions(publicClient, owner) : undefined, [owner, app.version]);
  const sy = SERIES["PT-USD3-17DEC2026"].sy;
  const { data: limits } = usePoll(() => usd3Limits(publicClient, sy), [app.version], 60_000);

  if (!owner) {
    return (
      <Card title="Positions">
        <p>Connect Rabby (with your Ledger) to see your Morpho PT loops.</p>
        {app.rabby === null && (
          <Notice tone="warn">
            Rabby wasn't found. Covenant only works with the Rabby extension, with your Ledger connected in Rabby.
          </Notice>
        )}
      </Card>
    );
  }

  const open = data?.filter((p) => p.borrowShares > 0n || p.collateral > 0n) ?? [];
  const ready = app.executor && app.executorCheck?.ok;

  return (
    <>
      {!ready && (
        <Notice tone="warn">
          Finish <a href="#/setup">Setup</a> first: deploy your Executor and grant it access (one time).
        </Notice>
      )}
      <Card title="Your loops" actions={loading ? <span className="muted small">refreshing…</span> : undefined}>
        {error && <Notice tone="danger">{error}</Notice>}
        {data && open.length === 0 && <p className="muted">No open PT-USD3 positions on Morpho for this account.</p>}
        {open.length > 0 && (
          <table data-testid="positions">
            <thead>
              <tr>
                <th>Market</th>
                <th>Collateral</th>
                <th>Debt</th>
                <th>Health</th>
                <th>LTV / LLTV</th>
                <th>YT in wallet</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {open.map((p) => (
                <Row key={p.market.key} p={p} ready={!!ready} />
              ))}
            </tbody>
          </table>
        )}
        {limits && (
          <p className="small muted">
            3Jane right now: {withSymbol(limits.withdraw, TOKENS.USDC.address, 0)} redeemable from USD3 at once ·{" "}
            {withSymbol(limits.deposit, TOKENS.USDC.address, 0)} deposit capacity.
          </p>
        )}
      </Card>
      <EnterCard ready={!!ready} depositCap={limits?.deposit} />
    </>
  );
}

function Row({ p, ready }: { p: PositionView; ready: boolean }) {
  const mode = unwindMode(p);
  const short = p.collateral - p.matched;
  return (
    <tr>
      <td>{p.market.label}</td>
      <td>{withSymbol(p.collateral, p.market.series.pt, 0)}</td>
      <td>{withSymbol(p.debt, p.market.loanToken, 0)}</td>
      <td className={p.healthFactor < 105n * 10n ** 16n ? "danger-text" : ""}>{health(p.healthFactor)}</td>
      <td>
        {pct(p.ltv)} / {pct(p.market.lltv)}
      </td>
      <td>
        {withSymbol(p.ytBalance, p.market.series.yt, 0)}
        {short > 0n && !p.expired && <div className="small warn-text">covers {pct((p.matched * 10n ** 18n) / p.collateral)} of PT</div>}
      </td>
      <td>
        <button disabled={!ready || p.borrowShares === 0n} onClick={() => go(`#/review?kind=unwind&market=${encodeURIComponent(p.market.key)}`)} data-testid={`unwind-${p.market.key}`}>
          {MODE_LABEL[mode]}
        </button>
      </td>
    </tr>
  );
}

function EnterCard({ ready, depositCap }: { ready: boolean; depositCap?: bigint }) {
  const [market, setMarket] = useState(MARKETS[0].key);
  const [equity, setEquity] = useState("1000");
  const [leverage, setLeverage] = useState("3");
  let equityUnits = 0n;
  try {
    equityUnits = parseUnits(equity || "0", 6);
  } catch {
    /* invalid input */
  }
  const lev = Number(leverage);
  const total = (equityUnits * BigInt(Math.round(lev * 100))) / 100n;
  const capped = depositCap !== undefined && depositCap < total;
  return (
    <Card title="Enter a loop">
      <p className="small muted">
        Flash-borrow, mint PT + YT at par (no Pendle trading), supply PT, borrow to repay. Your YT is sent to your wallet
        so you can always fully exit.
      </p>
      <div className="row">
        <select value={market} onChange={(e) => setMarket(e.target.value)}>
          {MARKETS.map((m) => (
            <option key={m.key} value={m.key}>
              {m.label}
            </option>
          ))}
        </select>
        <label>
          Equity (USDC) <input value={equity} onChange={(e) => setEquity(e.target.value)} inputMode="decimal" />
        </label>
        <label>
          Leverage <input value={leverage} onChange={(e) => setLeverage(e.target.value)} inputMode="decimal" />×
        </label>
        <button
          disabled={!ready || equityUnits === 0n || !(lev > 1 && lev <= 8) || capped}
          onClick={() => go(`#/review?kind=enter&market=${encodeURIComponent(market)}&equity=${equityUnits}&leverage=${Math.round(lev * 10_000)}`)}
        >
          Review entry
        </button>
      </div>
      {capped && (
        <Notice tone="warn">
          3Jane's USD3 deposit capacity ({withSymbol(depositCap!, TOKENS.USDC.address, 0)}) is below the{" "}
          {withSymbol(total, TOKENS.USDC.address, 0)} this entry deposits. Entry is disabled until capacity frees up.
        </Notice>
      )}
    </Card>
  );
}
