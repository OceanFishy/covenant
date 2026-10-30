import { useState, type ReactNode } from "react";
import type { Address, Hex } from "viem";
import { DEV_FORK, EXPLORER } from "../lib/chain";
import { checkFlashbots, type ProtectStatus } from "../lib/mev";
import { short } from "../lib/registry";
import { send } from "../lib/wallet";
import { useApp } from "../state";

export function Card({ title, children, actions }: { title?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="card">
      {(title || actions) && (
        <header className="card-head">
          {title && <h2>{title}</h2>}
          {actions && <div className="row">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Notice({ tone = "info", children }: { tone?: "info" | "warn" | "danger" | "ok"; children: ReactNode }) {
  return <div className={`notice ${tone}`}>{children}</div>;
}

export function AddressLink({ address }: { address: Address }) {
  return (
    <a className="mono" href={`${EXPLORER}/address/${address}`} target="_blank" rel="noreferrer">
      {short(address)}
    </a>
  );
}

export function TxLink({ hash }: { hash: Hex }) {
  return DEV_FORK ? (
    <span className="mono">{short(hash)}</span>
  ) : (
    <a className="mono" href={`${EXPLORER}/tx/${hash}`} target="_blank" rel="noreferrer">
      {short(hash)}
    </a>
  );
}

export type SentTx = { hash: Hex; protect: ProtectStatus };

export function ProtectBadge({ status }: { status: ProtectStatus }) {
  switch (status.kind) {
    case "private":
      return <span className="pill ok">Sent privately via Flashbots Protect</span>;
    case "public":
      return <span className="pill danger">Seen in the public mempool: not MEV-protected</span>;
    case "unknown":
      return <span className="pill warn">Not seen by Flashbots Protect (expected with MEV Blocker; otherwise check Rabby's RPC)</span>;
    case "unchecked":
      return <span className="pill">MEV routing not checked: {status.reason}</span>;
  }
}

/** Sends a transaction through Rabby, then checks how it was routed (Flashbots status API). */
export function useSendTx() {
  const app = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [last, setLast] = useState<SentTx>();

  async function run(tx: { to?: Address; data: Hex }) {
    if (!app.conn) throw new Error("connect first");
    setBusy(true);
    setError(undefined);
    try {
      const receipt = await send(app.conn, tx);
      const protect: ProtectStatus = DEV_FORK
        ? { kind: "unchecked", reason: "local dev fork" }
        : app.mevRpc === "flashbots"
          ? await checkFlashbots(receipt.transactionHash)
          : { kind: "unchecked", reason: "MEV Blocker has no public status API" };
      const sent = { hash: receipt.transactionHash, protect };
      setLast(sent);
      app.bump();
      return { ...sent, receipt };
    } catch (e) {
      const msg = e instanceof Error ? (e as { shortMessage?: string }).shortMessage ?? e.message : String(e);
      setError(msg);
      throw e;
    } finally {
      setBusy(false);
    }
  }

  return { run, busy, error, last };
}

export function SentLine({ tx }: { tx?: SentTx }) {
  if (!tx) return null;
  return (
    <p className="row small">
      Mined <TxLink hash={tx.hash} /> <ProtectBadge status={tx.protect} />
    </p>
  );
}
