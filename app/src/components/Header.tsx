import { publicClient, DEV_FORK, chain } from "../lib/chain";
import { readAccess } from "../lib/access";
import { short } from "../lib/registry";
import { switchNetwork } from "../lib/wallet";
import { usePoll } from "../hooks";
import { useApp } from "../state";

/** Always-visible "Executor access: ON/OFF" (docs/SPEC.md §9.3). Click → Access panel. */
export function AccessBadge() {
  const app = useApp();
  const owner = app.conn?.account;
  const { data } = usePoll(
    owner && app.executors.length ? () => readAccess(publicClient, owner, app.executors) : undefined,
    [owner, app.executors.join(), app.version],
  );
  if (!owner) return null;
  const on = (data?.length ?? 0) > 0;
  return (
    <a href="#/access" className={`badge ${on ? "on" : "off"}`} data-testid="access-badge">
      Executor access: {data === undefined && app.executors.length ? "…" : on ? `ON (${data!.length})` : "OFF"}
    </a>
  );
}

export function Header() {
  const app = useApp();
  return (
    <header className="top">
      <a href="#/" className="brand">
        Covenant
      </a>
      <nav className="row">
        <a href="#/">Positions</a>
        <a href="#/builder">Builder</a>
        <a href="#/setup">Setup</a>
        <a href="#/access">Access</a>
      </nav>
      <div className="row grow-end">
        {DEV_FORK && <span className="pill warn">Local fork · chain {chain.id}</span>}
        {app.conn && (
          <a href="#/setup" className={`pill ${app.mevRpc ? "ok" : "warn"}`}>
            {app.mevRpc ? `MEV-protected RPC: ${app.mevRpc === "flashbots" ? "Flashbots" : "MEV Blocker"}` : "MEV RPC not set"}
          </a>
        )}
        <AccessBadge />
        {app.conn ? (
          app.wrongNetwork ? (
            <button className="danger" onClick={() => void switchNetwork(app.conn!).then(app.connectWallet)}>
              Switch Rabby to {chain.name}
            </button>
          ) : (
            <span className="pill mono" title={app.conn.account}>
              {short(app.conn.account)}
            </span>
          )
        ) : app.rabby ? (
          <button onClick={() => void app.connectWallet()}>Connect Rabby</button>
        ) : (
          <span className="pill warn">{app.rabby === null ? "Rabby not found" : "Looking for Rabby…"}</span>
        )}
      </div>
    </header>
  );
}
