import { useState } from "react";
import { getAddress, isAddress } from "viem";
import { AddressLink, Card, Notice, SentLine, useSendTx } from "../components/common";
import { usePoll } from "../hooks";
import { DEV_FORK, publicClient } from "../lib/chain";
import { deployData, setupSteps } from "../lib/executor";
import { PROTECTED_RPCS } from "../lib/mev";
import { useApp } from "../state";

export function SetupPage() {
  const app = useApp();
  return (
    <>
      <MevStep />
      {app.conn ? <ExecutorStep /> : <Card title="2. Your Executor">Connect Rabby to continue.</Card>}
      {app.conn && app.executor && app.executorCheck?.ok && <PermissionSteps />}
    </>
  );
}

function MevStep() {
  const app = useApp();
  return (
    <Card title="1. Send every transaction through an MEV-protected RPC">
      <p>
        Rabby broadcasts your transactions, so the protection is set in Rabby itself. It then covers every Covenant
        transaction (deploy, setup, unwinds, revokes):
      </p>
      <ol className="small">
        <li>Rabby → Settings → <b>Custom RPC</b> → Ethereum → Add RPC.</li>
        <li>Paste one of the URLs below, save, and make sure it's enabled.</li>
      </ol>
      <div className="grid2">
        {PROTECTED_RPCS.map((r) => (
          <div key={r.id} className={`option ${app.mevRpc === r.id ? "selected" : ""}`}>
            <h3>{r.name}</h3>
            <code className="mono">{r.url}</code>
            <p className="small muted">{r.notes}</p>
            <button onClick={() => app.setMevRpc(r.id)} data-testid={`mev-${r.id}`}>
              {app.mevRpc === r.id ? "✓ Set in Rabby" : `I've set ${r.name} in Rabby`}
            </button>
          </div>
        ))}
      </div>
      {app.mevRpc ? (
        <p className="small">
          Signing is enabled. {app.mevRpc === "flashbots" && "After each transaction Covenant asks Flashbots Protect whether it went through privately."}{" "}
          <button className="link" onClick={() => app.setMevRpc(undefined)}>
            Reset
          </button>
        </p>
      ) : (
        <Notice tone="warn">Plans can't be signed until you confirm this. Revokes always work.</Notice>
      )}
    </Card>
  );
}

function ExecutorStep() {
  const app = useApp();
  const tx = useSendTx();
  const [input, setInput] = useState("");
  const [checkError, setCheckError] = useState<string>();
  const owner = app.conn!.account;

  async function deploy() {
    const { receipt } = await tx.run({ data: await deployData(owner) });
    if (!receipt.contractAddress) throw new Error("no contract address in receipt");
    await app.useExecutor(getAddress(receipt.contractAddress));
  }

  async function useExisting() {
    const v = await app.useExecutor(getAddress(input));
    setCheckError(v.ok ? undefined : v.reason);
  }

  return (
    <Card title="2. Your Executor">
      {app.executor ? (
        <p className="row">
          Executor <AddressLink address={app.executor} />{" "}
          {app.executorCheck === undefined ? (
            <span className="pill">verifying…</span>
          ) : app.executorCheck.ok ? (
            <span className="pill ok">verified: CovenantExecutorMainnet, owned by you</span>
          ) : (
            <span className="pill danger">not trusted: {app.executorCheck.reason}</span>
          )}
        </p>
      ) : (
        <p>
          Deploy your own Executor: a small non-upgradeable contract only your account can use. One transaction; the
          mainnet allowlist is built in.
        </p>
      )}
      <div className="row">
        <button disabled={tx.busy || !!app.signBlockedReason} onClick={() => void deploy()} data-testid="deploy">
          {app.executor ? "Deploy a new Executor" : "Deploy Executor"}
        </button>
        <input placeholder="…or use an existing Executor 0x…" value={input} onChange={(e) => setInput(e.target.value)} />
        <button disabled={!isAddress(input)} onClick={() => void useExisting()}>
          Verify & use
        </button>
      </div>
      {app.signBlockedReason && <p className="small muted">{app.signBlockedReason}</p>}
      {checkError && <Notice tone="danger">{checkError}</Notice>}
      {tx.error && <Notice tone="danger">{tx.error}</Notice>}
      <SentLine tx={tx.last} />
      {DEV_FORK && <p className="small muted">Local fork: contracts deployed here exist only on this fork.</p>}
    </Card>
  );
}

function PermissionSteps() {
  const app = useApp();
  const owner = app.conn!.account;
  const executor = app.executor!;
  const steps = setupSteps(executor);
  const tx = useSendTx();
  const { data: done, refresh } = usePoll(
    () => Promise.all(steps.map((s) => s.isDone(publicClient, owner, executor))),
    [owner, executor, app.version],
  );
  return (
    <Card title="3. Permissions for your Executor">
      <p className="small muted">
        One-time. After this every unwind is a single transaction. You can revoke all of it at any time (Access).
      </p>
      <ul className="steps">
        {steps.map((s, i) => (
          <li key={s.id} className="row">
            <span className={`pill ${done?.[i] ? "ok" : ""}`}>{done?.[i] ? "done" : "to do"}</span>
            <span className="grow">{s.title}</span>
            {!done?.[i] && (
              <button
                disabled={tx.busy || !!app.signBlockedReason}
                onClick={() => void tx.run(s.tx).then(refresh)}
                data-testid={`setup-${s.id}`}
              >
                Send
              </button>
            )}
          </li>
        ))}
      </ul>
      {tx.error && <Notice tone="danger">{tx.error}</Notice>}
      <SentLine tx={tx.last} />
    </Card>
  );
}
