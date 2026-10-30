import { useState } from "react";
import { getAddress, isAddress } from "viem";
import { AddressLink, Card, Notice, SentLine, useSendTx } from "../components/common";
import { usePoll } from "../hooks";
import { DELEGATE } from "../lib/abis";
import { DEV_FORK, publicClient } from "../lib/chain";
import { aaveSetupSteps, aaveV4SetupSteps, deployData, deployDelegateTx, initializeTx, setupSteps, type SetupStep } from "../lib/executor";
import { PROTECTED_RPCS } from "../lib/mev";
import { useApp } from "../state";

export function SetupPage() {
  const app = useApp();
  // Delegated to the Covenant delegate: your account runs plans itself, no Executor or permissions.
  const self = app.delegation?.kind === "covenant";
  return (
    <>
      <MevStep />
      {!app.conn && <Card title="2. Your Executor">Connect Rabby to continue.</Card>}
      {app.conn && !self && <ExecutorStep />}
      {app.conn && !self && app.executor && app.executorCheck?.ok && (
        <>
          <PermissionSteps
            title="3. Permissions for your Executor"
            intro="One-time. After this every unwind is a single transaction. You can revoke all of it at any time (Access)."
            steps={setupSteps(app.executor)}
          />
          <PermissionSteps
            title="4. Aave v3 (optional)"
            intro="Only for the Aave Borrow and Withdraw blocks; supplying and repaying need nothing. Revocable at any time (Access)."
            steps={aaveSetupSteps(app.executor)}
          />
          <PermissionSteps
            title="5. Aave v4 (optional)"
            intro="Only for the Aave v4 blocks. Aave v4 lets only you or a position manager Aave governance activated act on your position, so the Executor goes through Aave's Giver (supply / repay) and Taker (withdraw / borrow, within the allowances you grant here). Revocable at any time (Access)."
            steps={aaveV4SetupSteps(app.conn!.account, app.executor)}
          />
        </>
      )}
      {app.conn && <DelegationStep />}
      {app.conn && self && app.executor && app.executorCheck?.ok && (
        <PermissionSteps
          title="3. Aave v4 (optional)"
          intro="Your account calls the Aave v4 Spoke itself, so no position managers or allowances are needed. Only a supply you want to borrow against must be enabled as collateral, once, from your wallet."
          steps={aaveV4SetupSteps(app.conn.account, app.executor)}
        />
      )}
    </>
  );
}

/**
 * EIP-7702 mode (docs/SPEC.md §5.4): your EOA delegates to the shared Covenant delegate and runs
 * plans itself. Signing the delegation needs a Ledger Ethereum app that whitelists the delegate,
 * so that step happens in a terminal (ledger/build-app.sh, app/scripts/ledger7702.mjs).
 */
function DelegationStep() {
  const app = useApp();
  const tx = useSendTx();
  const owner = app.conn!.account;
  const d = app.delegation;
  const { data: delegateCode, refresh } = usePoll(() => publicClient.getCode({ address: DELEGATE }), [app.version], 60_000);
  const deployed = !!delegateCode && delegateCode !== "0x";
  const run = (t: { to: `0x${string}`; data: `0x${string}` }) => void tx.run(t).then(() => (refresh(), app.bump()));

  if (d?.kind === "covenant") {
    return (
      <Card title="2. Your account runs plans itself (EIP-7702)">
        <p className="row">
          Delegated to <AddressLink address={DELEGATE} />{" "}
          {app.executorCheck === undefined ? (
            <span className="pill">verifying…</span>
          ) : app.executorCheck.ok ? (
            <span className="pill ok">verified: CovenantDelegateMainnet, allowlist v{String(d.configVersion)}</span>
          ) : (
            <span className="pill danger">not trusted: {app.executorCheck.reason}</span>
          )}
        </p>
        <p className="small muted">
          No Executor, approvals or Morpho authorization: plans are transactions to your own address. A plan can only
          use what it allots from your wallet, and allowances it grants are reset when it ends.
        </p>
        {d.configVersion !== d.expected && (
          <div className="row">
            <span className="grow">Update the allowlist stored in your account (v{String(d.configVersion)} → v{String(d.expected)})</span>
            <button disabled={tx.busy || !!app.signBlockedReason} onClick={() => run(initializeTx(owner))} data-testid="delegate-initialize">
              Send
            </button>
          </div>
        )}
        <p className="small">
          Undo at any time from a terminal, with the official Ethereum app: <code>cd app && node scripts/ledger7702.mjs revoke</code>
        </p>
        {tx.error && <Notice tone="danger">{tx.error}</Notice>}
        <SentLine tx={tx.last} />
      </Card>
    );
  }

  return (
    <Card title="EIP-7702 mode (optional · Ledger Nano S Plus)">
      <p className="small">
        Instead of an Executor, your account itself runs plans: no approvals, no Morpho authorization, and protocols see
        your address as the caller. <b>Your whole account runs the delegate's code</b>, so a bug there could reach all
        your funds, not just what you approved; undo it with one revoke.
      </p>
      {d?.kind === "other" && (
        <Notice tone="warn">
          Your account already delegates to <AddressLink address={d.delegate} />. Delegating to Covenant replaces it.
        </Notice>
      )}
      <ol className="small">
        <li>
          <div className="row">
            <span className="grow">
              The shared delegate <AddressLink address={DELEGATE} /> is {deployed ? "deployed" : "not deployed yet"} (once, by
              anyone; the address follows from the code).
            </span>
            {!deployed && (
              <button disabled={tx.busy || !!app.signBlockedReason} onClick={() => void deployDelegateTx().then(run)} data-testid="deploy-delegate">
                Deploy
              </button>
            )}
          </div>
        </li>
        <li>
          Build and sideload an Ethereum app that whitelists this delegate (Ledger only signs 7702 delegations to whitelisted
          contracts; needs Docker and <code>pip install ledgerblue</code>): <code>./ledger/build-app.sh --load</code>
        </li>
        <li>On the Ledger, open that app → Settings: enable <b>EIP-7702</b> and <b>Blind signing</b>.</li>
        <li>
          Close Rabby and Ledger Live (they hold the USB connection), then sign the delegation and the allowlist setup in one
          transaction: <code>cd app && node scripts/ledger7702.mjs delegate</code>
        </li>
        <li>Remove the sideloaded app and reinstall the official Ethereum app: plans and revoking work with it.</li>
      </ol>
      <button onClick={app.bump}>Check again</button>
      {tx.error && <Notice tone="danger">{tx.error}</Notice>}
      <SentLine tx={tx.last} />
    </Card>
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

function PermissionSteps({ title, intro, steps }: { title: string; intro: string; steps: SetupStep[] }) {
  const app = useApp();
  const owner = app.conn!.account;
  const executor = app.executor!;
  const tx = useSendTx();
  const { data: done, refresh } = usePoll(
    () => Promise.all(steps.map((s) => s.isDone(publicClient, owner, executor))),
    [owner, executor, app.version],
  );
  return (
    <Card title={title}>
      <p className="small muted">{intro}</p>
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
