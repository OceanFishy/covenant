import { useState } from "react";
import { getAddress, isAddress, type Address } from "viem";
import { AddressLink, Card, Notice, SentLine, useSendTx } from "../components/common";
import { allowance } from "../format";
import { usePoll } from "../hooks";
import { readAccess, type Permission } from "../lib/access";
import { publicClient } from "../lib/chain";
import { MORPHO } from "../lib/registry";
import { useApp } from "../state";

/**
 * Executor access and revoke (docs/SPEC.md §9.3). Depends only on Rabby + an RPC: no simulation,
 * quotes or Executor calls, so it keeps working when everything else is broken.
 */
export function AccessPage() {
  const app = useApp();
  const owner = app.conn?.account;
  const [extra, setExtra] = useState<Address[]>([]);
  const [input, setInput] = useState("");
  const executors = [...new Set([...app.executors, ...extra])];
  const { data: perms, error, refresh } = usePoll(
    owner && executors.length ? () => readAccess(publicClient, owner, executors) : undefined,
    [owner, executors.join(), app.version],
  );
  const tx = useSendTx();
  const [progress, setProgress] = useState<{ done: number; total: number }>();

  if (!owner) {
    return (
      <Card title="Executor access">
        <p>Connect Rabby to see and revoke what your Executors can do.</p>
        <Fallback />
      </Card>
    );
  }

  async function revokeAll(list: Permission[]) {
    setProgress({ done: 0, total: list.length });
    for (let i = 0; i < list.length; i++) {
      await tx.run(list[i].revoke);
      setProgress({ done: i + 1, total: list.length });
    }
    await refresh();
  }

  const add = () => {
    if (isAddress(input)) setExtra((x) => [...x, getAddress(input)]);
    setInput("");
  };

  return (
    <>
      <Card
        title="Executor access"
        actions={
          perms && perms.length > 0 ? (
            <button className="danger big" disabled={tx.busy} onClick={() => void revokeAll(perms)} data-testid="revoke-all">
              Revoke all ({perms.length})
            </button>
          ) : undefined
        }
      >
        <p className="muted">
          Revokes go straight from your wallet to Morpho and the token contracts, never through the Executor. They are
          plain calls that Rabby and your Ledger display clearly.
        </p>
        {error && <Notice tone="danger">Could not read permissions: {error}</Notice>}
        {executors.length === 0 && <Notice>No Executor known in this browser. Add an address below to check it.</Notice>}
        {perms && perms.length === 0 && executors.length > 0 && (
          <Notice tone="ok">Executor access is OFF: no Executor can act for you.</Notice>
        )}
        {progress && (
          <Notice tone={progress.done === progress.total ? "ok" : "info"}>
            Revoking: {progress.done} / {progress.total} confirmed
          </Notice>
        )}
        {tx.error && <Notice tone="danger">{tx.error}</Notice>}
        <SentLine tx={tx.last} />
        {perms && perms.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Executor</th>
                <th>Permission</th>
                <th>Amount</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {perms.map((p) => (
                <tr key={`${p.executor}-${p.kind}-${p.token ?? ""}`}>
                  <td>
                    <AddressLink address={p.executor} />
                  </td>
                  <td>{p.label}</td>
                  <td>{p.kind === "morpho" ? "authorized" : allowance(p.amount!, p.token!)}</td>
                  <td>
                    <button className="danger" disabled={tx.busy} onClick={() => void tx.run(p.revoke).then(refresh)}>
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="row">
          <input placeholder="Check another Executor address 0x…" value={input} onChange={(e) => setInput(e.target.value)} />
          <button onClick={add} disabled={!isAddress(input)}>
            Check
          </button>
        </div>
        {app.executor && (
          <p className="small muted">
            Re-enable later from <a href="#/setup">Setup</a> (authorize + approve steps).
          </p>
        )}
      </Card>
      <Card title="Revoke without Covenant">
        <Fallback perms={perms} />
      </Card>
    </>
  );
}

function Fallback({ perms }: { perms?: Permission[] }) {
  return (
    <div className="small">
      <p>
        If this app is unavailable, use Etherscan's “Write contract” tab with Rabby connected. The Morpho authorization
        does <b>not</b> show in Rabby's Approvals page or revoke.cash, so revoke it here:
      </p>
      <ul>
        <li className="mono">Morpho Blue {MORPHO} → setAuthorization(&lt;executor&gt;, false)</li>
        <li>Token approvals: Rabby → Approvals, or each token's approve(&lt;executor&gt;, 0).</li>
        {perms?.map((p) => (
          <li className="mono" key={`m-${p.executor}-${p.kind}-${p.token ?? ""}`}>
            {p.manual}
          </li>
        ))}
      </ul>
    </div>
  );
}
