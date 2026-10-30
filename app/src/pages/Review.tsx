import { useCallback, useEffect, useState } from "react";
import { decodeFunctionData, keccak256, type Abi, type Address } from "viem";
import { AddressLink, Card, Notice, SentLine, useSendTx } from "../components/common";
import { health, signed, withSymbol } from "../format";
import { erc20Abi, executorAbi, morphoAbi, syAbi, ytAbi } from "../lib/abis";
import { publicClient } from "../lib/chain";
import type { Plan } from "../lib/compiler/types";
import { buildEnter, buildUnwind } from "../lib/planner";
import { readPosition } from "../lib/positions";
import { defaultQuoteConfig, HEADROOM_LADDER_BPS } from "../lib/quotes";
import { MARKETS, label } from "../lib/registry";
import { isSwapFailure, simulatePlan, type SimulationResult } from "../lib/simulate";
import { useApp } from "../state";

const MAX_SIM_AGE_BLOCKS = 3n;

type Prepared = { plan: Plan; sim: Extract<SimulationResult, { ok: true }> };

const KNOWN_ABIS: Abi[] = [executorAbi, morphoAbi, erc20Abi, ytAbi, syAbi];

function fnName(data: `0x${string}`): string {
  for (const abi of KNOWN_ABIS) {
    try {
      return decodeFunctionData({ abi, data }).functionName;
    } catch {
      /* try next */
    }
  }
  return data.slice(0, 10);
}

export function ReviewPage({ params }: { params: URLSearchParams }) {
  const app = useApp();
  const owner = app.conn?.account;
  const executor = app.executor;
  const market = MARKETS.find((m) => m.key === params.get("market"));
  const kind = params.get("kind") === "enter" ? "enter" : "unwind";

  const [prepared, setPrepared] = useState<Prepared>();
  const [status, setStatus] = useState<string>("Preparing…");
  const [failure, setFailure] = useState<string>();
  const [block, setBlock] = useState<bigint>();
  const tx = useSendTx();
  const [done, setDone] = useState(false);

  const prepare = useCallback(async () => {
    if (!owner || !executor || !market) return;
    setFailure(undefined);
    const base = { owner, executor, quotes: defaultQuoteConfig };
    for (const headroomBps of HEADROOM_LADDER_BPS) {
      setStatus(`Building plan and simulating${headroomBps > HEADROOM_LADDER_BPS[0] ? ` (re-quote, ${headroomBps / 100}% headroom)` : ""}…`);
      let draft: Plan;
      if (kind === "enter") {
        draft = await buildEnter(market, {
          ...base,
          headroomBps,
          minReceive: 0n,
          equity: BigInt(params.get("equity") ?? "0"),
          leverageBps: BigInt(params.get("leverage") ?? "30000"),
          minHealth: 102n * 10n ** 16n,
        });
      } else {
        const pos = await readPosition(publicClient, market, owner);
        draft = await buildUnwind(publicClient, pos, { ...base, headroomBps, minReceive: 0n });
      }
      const sim = await simulatePlan(publicClient, draft);
      if (!sim.ok) {
        if (isSwapFailure(sim)) continue;
        setFailure(sim.error);
        setPrepared(undefined);
        return;
      }
      let plan = draft;
      let final: SimulationResult = sim;
      if (kind === "unwind" && draft.kind !== "partial") {
        // Tighten: you must receive at least 99.5% of what the simulation returned.
        const got = sim.changes.find((c) => c.token === market.series.tokenOut)!;
        const minReceive = ((got.after - got.before) * 995n) / 1000n;
        const pos = await readPosition(publicClient, market, owner);
        plan = await buildUnwind(publicClient, pos, { ...base, headroomBps, minReceive, reuseSwap: draft.swap });
        final = await simulatePlan(publicClient, plan);
      }
      if (final.ok) {
        setPrepared({ plan, sim: final });
        setStatus("");
        return;
      }
      if (!isSwapFailure(final)) {
        setFailure(final.error);
        setPrepared(undefined);
        return;
      }
    }
    setFailure("The aggregator route kept failing in simulation after 3 fresh quotes. Try again in a minute.");
  }, [owner, executor, market, kind, params]);

  useEffect(() => {
    void prepare().catch((e) => setFailure(e instanceof Error ? e.message : String(e)));
  }, [prepare]);

  // Re-simulate the same plan every block while this screen is open.
  useEffect(() => {
    if (!prepared || done) return;
    const t = setInterval(async () => {
      setBlock(await publicClient.getBlockNumber());
      const sim = await simulatePlan(publicClient, prepared.plan);
      if (sim.ok) setPrepared({ plan: prepared.plan, sim });
      else if (isSwapFailure(sim)) void prepare();
      else {
        setFailure(sim.error);
        setPrepared(undefined);
      }
    }, 12_000);
    return () => clearInterval(t);
  }, [prepared, done, prepare]);

  if (!market) return <Notice tone="danger">Unknown market.</Notice>;
  if (!owner || !executor) return <Notice tone="warn">Connect Rabby and finish Setup first.</Notice>;

  const stale = prepared && block !== undefined && block - prepared.sim.block > MAX_SIM_AGE_BLOCKS;
  const blocker = app.signBlockedReason ?? (!app.executorCheck?.ok ? "Executor not verified." : undefined);

  async function sign() {
    if (!prepared) return;
    await tx.run({ to: executor!, data: prepared.plan.data });
    setDone(true);
  }

  return (
    <>
      <Card title={`Review · ${market.label}`} actions={<a href="#/">← Positions</a>}>
        {status && !failure && <p className="muted">{status}</p>}
        {failure && (
          <Notice tone="danger">
            Simulation failed: {failure}{" "}
            <button className="link" onClick={() => void prepare()}>
              Retry
            </button>
          </Notice>
        )}
        {prepared && <Summary p={prepared} />}
      </Card>
      {prepared && (
        <>
          <Card title="What this transaction does">
            <ol className="plan" data-testid="plan-steps">
              {prepared.plan.steps.map((s, i) => (
                <li key={i} className={s.depth ? "nested" : ""}>
                  {s.text}
                </li>
              ))}
            </ol>
            <details>
              <summary>Raw calls ({prepared.plan.calls.length} top-level)</summary>
              <ul className="mono small">
                {prepared.plan.calls.map((c, i) => (
                  <li key={i}>
                    #{i} {label(c.target)}.{fnName(c.data)} {c.patches.length > 0 && `(+${c.patches.length} runtime amount)`}
                  </li>
                ))}
              </ul>
            </details>
          </Card>
          <Card title="Sign">
            <ul className="small">
              <li>
                Rabby will show a transaction to your Executor <AddressLink address={executor} /> calling{" "}
                <code>execute</code>. Check that the address matches.
              </li>
              <li>Rabby's own simulation should show the same balance changes as above. If it doesn't, reject.</li>
              <li>
                Your Ledger will ask to <b>blind sign</b> (Ethereum app → Settings → Blind signing). Plan hash{" "}
                <code className="mono">{prepared.plan.planHash.slice(0, 18)}…</code> · calldata hash{" "}
                <code className="mono">{keccak256(prepared.plan.data).slice(0, 18)}…</code>
              </li>
              <li>Broadcast goes through the MEV-protected RPC you set in Rabby.</li>
            </ul>
            {stale && <Notice tone="warn">Simulation is more than {String(MAX_SIM_AGE_BLOCKS)} blocks old; re-simulating…</Notice>}
            {blocker && <Notice tone="warn">{blocker}</Notice>}
            {tx.error && <Notice tone="danger">{tx.error}</Notice>}
            {done ? (
              <Notice tone="ok">
                Done. <a href="#/">Back to positions</a>
              </Notice>
            ) : (
              <button className="primary big" disabled={!!blocker || !!stale || tx.busy} onClick={() => void sign()} data-testid="sign">
                {tx.busy ? "Waiting for Rabby / Ledger…" : "Sign with Ledger"}
              </button>
            )}
            <SentLine tx={tx.last} />
          </Card>
        </>
      )}
    </>
  );
}

function Summary({ p }: { p: Prepared }) {
  const { plan, sim } = p;
  const m = plan.market;
  const titles = {
    unwind: "Full unwind: all debt repaid, all collateral redeemed",
    deleverage: "Repay all debt; PT without matching YT returns to your wallet",
    partial: "Partial unwind: only the PT your YT covers",
    enter: "Enter: open a leveraged PT loop",
  };
  return (
    <>
      <h3>{titles[plan.kind]}</h3>
      <table data-testid="balance-changes">
        <thead>
          <tr>
            <th>Your wallet</th>
            <th>Before</th>
            <th>After</th>
            <th>Change</th>
          </tr>
        </thead>
        <tbody>
          {sim.changes.map((c) => (
            <tr key={c.token}>
              <td>{c.symbol}</td>
              <td>{withSymbol(c.before, c.token)}</td>
              <td>{withSymbol(c.after, c.token)}</td>
              <td className={c.after > c.before ? "ok-text" : c.after < c.before ? "danger-text" : ""}>{signed(c.after - c.before, c.token)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="row small">
        <span>Position after: {withSymbol(sim.collateralAfter, m.series.pt, 0)} collateral, {sim.borrowSharesAfter === 0n ? "no debt" : "debt remains"}</span>
        <span>· health after {health(sim.healthAfter)}</span>
        <span>· gas {sim.gasUsed.toLocaleString()}</span>
        <span>· simulated at block {String(sim.block)} ({sim.method})</span>
      </p>
      {plan.swap && (
        <p className="small">
          Swap leg: {withSymbol(plan.swap.amountIn, plan.swap.sellToken)} → ≥ {withSymbol(plan.swap.minOut, plan.swap.buyToken)} via{" "}
          {plan.swap.aggregator === "0x" ? "0x" : "KyberSwap"} (stablecoins only; checked on-chain).
        </p>
      )}
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
