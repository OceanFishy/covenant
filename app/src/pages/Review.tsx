import { useCallback, useEffect, useState } from "react";
import { Card, Notice } from "../components/common";
import { MAX_SIM_AGE_BLOCKS, PlanSteps, SignPanel } from "../components/PlanPanels";
import { SimSummary } from "../components/SimSummary";
import { publicClient } from "../lib/chain";
import type { Plan } from "../lib/compiler/types";
import { buildEnter, buildUnwind } from "../lib/planner";
import { readPosition, type PositionView } from "../lib/positions";
import { defaultQuoteConfig, HEADROOM_LADDER_BPS } from "../lib/quotes";
import { MARKETS } from "../lib/registry";
import { isSwapFailure, simulatePlan, type SimulationResult } from "../lib/simulate";
import { useApp } from "../state";

type Prepared = { plan: Plan; sim: Extract<SimulationResult, { ok: true }> };

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
  const [done, setDone] = useState(false);

  const prepare = useCallback(async () => {
    if (!owner || !executor || !market) return;
    setFailure(undefined);
    const base = { owner, executor, quotes: defaultQuoteConfig };
    for (const headroomBps of HEADROOM_LADDER_BPS) {
      setStatus(`Building plan and simulating${headroomBps > HEADROOM_LADDER_BPS[0] ? ` (re-quote, ${headroomBps / 100}% headroom)` : ""}…`);
      let draft: Plan;
      let pos: PositionView | undefined;
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
        pos = await readPosition(publicClient, market, owner);
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
      if (pos && draft.kind !== "partial") {
        // Tighten: you must receive at least 99.5% of what the simulation returned.
        const got = sim.changes.find((c) => c.token === market.series.tokenOut)!;
        const minReceive = ((got.after - got.before) * 995n) / 1000n;
        // Same position snapshot and route as the draft; only the guard changes.
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
        {prepared && <SimSummary plan={prepared.plan} sim={prepared.sim} />}
      </Card>
      {prepared && (
        <>
          <PlanSteps plan={prepared.plan} />
          <SignPanel plan={prepared.plan} stale={!!stale} onDone={() => setDone(true)} />
        </>
      )}
    </>
  );
}
