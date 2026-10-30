import type { Address } from "viem";
import { health, withSymbol } from "../format";
import { usePoll } from "../hooks";
import { readAave } from "../lib/aave";
import { publicClient } from "../lib/chain";
import { useApp } from "../state";
import { Card, Notice } from "./common";

/** The owner's Aave v3 Core position (USDC / USDT), with each reserve's live status. */
export function AaveCard({ owner }: { owner: Address }) {
  const app = useApp();
  const { data, error, loading } = usePoll(() => readAave(publicClient, owner), [owner, app.version]);
  const open = data?.reserves.filter((r) => r.supplied > 0n || r.debt > 0n) ?? [];
  const frozen = data?.reserves.filter((r) => r.frozen) ?? [];
  return (
    <Card title="Aave v3" actions={loading ? <span className="muted small">refreshing…</span> : undefined}>
      {error && <Notice tone="danger">{error}</Notice>}
      {data && open.length === 0 && <p className="muted">No USDC / USDT supply or debt on Aave v3 Core for this account.</p>}
      {open.length > 0 && (
        <table data-testid="aave-positions">
          <thead>
            <tr>
              <th>Reserve</th>
              <th>Supplied</th>
              <th>Debt</th>
            </tr>
          </thead>
          <tbody>
            {open.map((r) => (
              <tr key={r.reserve.symbol}>
                <td>{r.reserve.symbol}</td>
                <td>{withSymbol(r.supplied, r.reserve.asset)}</td>
                <td>{withSymbol(r.debt, r.reserve.asset)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data && (data.totalDebtBase > 0n || open.length > 0) && (
        <p className="small">
          Health factor (whole Aave account) <b>{health(data.health)}</b>. Close or adjust it in the{" "}
          <a href="#/builder">Builder</a> (Aave blocks).
        </p>
      )}
      {frozen.length > 0 && (
        <p className="small muted" data-testid="aave-frozen">
          Frozen by Aave governance: {frozen.map((r) => r.reserve.symbol).join(", ")}. Repay and withdraw work; supply and borrow
          revert until Aave unfreezes them.
        </p>
      )}
    </Card>
  );
}
