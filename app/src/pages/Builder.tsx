import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { formatUnits } from "viem";
import { Card, Notice } from "../components/common";
import { BlockEditor } from "../components/builder/BlockEditor";
import { MAX_SIM_AGE_BLOCKS, PlanSteps, SignPanel } from "../components/PlanPanels";
import { SimSummary } from "../components/SimSummary";
import { usePoll } from "../hooks";
import { CATALOG, def, newId, searchCatalog, type BlockDef, type Group } from "../lib/builder/catalog";
import { compileFlow, validate } from "../lib/builder/compile";
import { deleteFlow, flowFromParam, flowToHash, loadDraft, parseFlow, saveDraft, saveFlow, savedFlows } from "../lib/builder/storage";
import { enterFlow, moveFlow, partialFlow, unwindFlow } from "../lib/builder/templates";
import { findBlock, insertBlock, locate, moveBlock, removeBlock, updateBlock } from "../lib/builder/tree";
import type { Block, Flow } from "../lib/builder/types";
import { publicClient } from "../lib/chain";
import type { Plan, Swap } from "../lib/compiler/types";
import { unwindMode } from "../lib/planner";
import { readPositions, type PositionView } from "../lib/positions";
import { defaultQuoteConfig, HEADROOM_LADDER_BPS } from "../lib/quotes";
import { MARKETS, TOKENS } from "../lib/registry";
import { isSwapFailure, simulatePlan, type SimulationResult } from "../lib/simulate";
import { useApp } from "../state";

type Sim = { plan: Plan; sim: Extract<SimulationResult, { ok: true }>; swaps: Record<string, Swap> };

const GROUPS: Group[] = ["Wallet", "Morpho", "Pendle", "Swap", "Guard"];
const EMPTY: Flow = { version: 1, name: "Untitled flow", blocks: [] };

type DragData = { kind: "new"; type: Block["type"] } | { kind: "move"; id: string };

function cloneWithNewIds(b: Block): Block {
  return b.type === "flashLoan" ? { ...b, id: newId(), children: b.children.map(cloneWithNewIds) } : { ...b, id: newId() };
}

export function BuilderPage({ params }: { params: URLSearchParams }) {
  const app = useApp();
  const owner = app.conn?.account;
  const executor = app.executor;

  const [flow, setFlow] = useState<Flow>(() => {
    const shared = params.get("flow");
    if (shared) {
      try {
        return flowFromParam(shared);
      } catch {
        /* fall through to the draft */
      }
    }
    return loadDraft() ?? EMPTY;
  });
  const [selected, setSelected] = useState<string | null>(null); // flash loan that receives new blocks
  const [query, setQuery] = useState("");
  const [sim, setSim] = useState<Sim>();
  const [simError, setSimError] = useState<string>();
  const [simulating, setSimulating] = useState(false);
  const [block, setBlock] = useState<bigint>();
  const [notice, setNotice] = useState<string>();
  const search = useRef<HTMLInputElement>(null);

  const blocks = flow.blocks;
  const setBlocks = useCallback((fn: (b: Block[]) => Block[]) => {
    setFlow((f) => ({ ...f, blocks: fn(f.blocks) }));
    setSim(undefined);
    setSimError(undefined);
  }, []);
  useEffect(() => saveDraft(flow), [flow]);

  const issues = useMemo(() => validate(blocks), [blocks]);
  const errors = issues.filter((i) => i.level === "error");
  const issuesFor = (id: string) => issues.filter((i) => i.blockId === id);

  // ------------------------------------------------------------ editing

  const add = useCallback(
    (d: BlockDef, parentId: string | null = selected, index?: number) => {
      const b = d.create(newId());
      setBlocks((list) => {
        const parent = parentId ? findBlock(list, parentId) : undefined;
        const into = parent?.type === "flashLoan" && b.type !== "flashLoan" ? parentId : null;
        const len = into ? (parent as Extract<Block, { type: "flashLoan" }>).children.length : list.length;
        return insertBlock(list, into, index ?? len, b);
      });
      if (b.type === "flashLoan") setSelected(b.id);
    },
    [selected, setBlocks],
  );

  const onDrop = (e: DragEvent, parentId: string | null, index: number) => {
    e.preventDefault();
    e.stopPropagation();
    const raw = e.dataTransfer.getData("application/x-covenant-block");
    if (!raw) return;
    const data = JSON.parse(raw) as DragData;
    if (data.kind === "new") add(def(data.type), parentId, index);
    else setBlocks((list) => moveBlock(list, data.id, parentId, index));
  };

  const nudge = (id: string, delta: number) =>
    setBlocks((list) => {
      const l = locate(list, id);
      if (!l) return list;
      return moveBlock(list, id, l.parentId, Math.max(0, l.index + (delta > 0 ? 2 : -1)));
    });

  // ------------------------------------------------------------ templates (from your positions)

  const { data: positions } = usePoll(owner ? () => readPositions(publicClient, owner) : undefined, [owner, app.version], 60_000);
  const open = positions?.filter((p) => p.borrowShares > 0n) ?? [];
  const [enterMarket, setEnterMarket] = useState(MARKETS[0].key);
  const [enterEquity, setEnterEquity] = useState("1000");
  const [enterLev, setEnterLev] = useState("3");

  const useTemplate = (f: Flow) => {
    setFlow(f);
    setSelected(null);
    setSim(undefined);
    setSimError(undefined);
  };
  const templateFor = (p: PositionView): Flow => {
    const mode = unwindMode(p);
    if (mode !== "partial") return unwindFlow(p);
    const repay = (p.proceedsMatched * 9_900n) / 10_000n;
    return partialFlow(p, repay, (Number(p.healthFactor / 10n ** 14n) / 10_000).toFixed(3));
  };

  // ------------------------------------------------------------ simulate (re-quote ladder) + re-sim every block

  const simulate = useCallback(async () => {
    if (!owner || !executor || errors.length) return;
    setSimulating(true);
    setSimError(undefined);
    try {
      for (const headroomBps of HEADROOM_LADDER_BPS) {
        const plan = await compileFlow(blocks, { owner, executor, client: publicClient, quotes: defaultQuoteConfig, headroomBps });
        const r = await simulatePlan(publicClient, plan);
        if (r.ok) {
          setSim({ plan, sim: r, swaps: plan.swaps });
          return;
        }
        if (!isSwapFailure(r) || !Object.keys(plan.swaps).length) {
          setSimError(r.error);
          return;
        }
      }
      setSimError("The aggregator route kept failing after 3 fresh quotes. Try again in a minute.");
    } catch (e) {
      setSimError(e instanceof Error ? e.message : String(e));
    } finally {
      setSimulating(false);
    }
  }, [owner, executor, blocks, errors.length]);

  useEffect(() => {
    if (!sim) return;
    const t = setInterval(async () => {
      setBlock(await publicClient.getBlockNumber());
      const r = await simulatePlan(publicClient, sim.plan);
      if (r.ok) setSim((s) => (s ? { ...s, sim: r } : s));
      else if (isSwapFailure(r)) void simulate();
      else {
        setSim(undefined);
        setSimError(r.error);
      }
    }, 12_000);
    return () => clearInterval(t);
  }, [sim, simulate]);

  /** Adds "you receive at least 99.5% of the simulated amount" for each stablecoin you gain. */
  const addGuardsFromSim = () => {
    if (!sim) return;
    const gains = sim.sim.changes.filter((c) => c.after > c.before && [TOKENS.USDC.address, TOKENS.USDT.address].includes(c.token));
    setBlocks((list) => [
      ...list,
      ...gains.map(
        (c): Block => ({
          id: newId(),
          type: "guardMinBalance",
          token: c.token,
          min: { kind: "fixed", value: formatUnits(((c.after - c.before) * 995n) / 1000n, c.decimals) },
        }),
      ),
    ]);
  };

  // ------------------------------------------------------------ keyboard: "/" search · ⌘↵ simulate

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;
      if (e.key === "/" && !typing) {
        e.preventDefault();
        search.current?.focus();
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
        e.preventDefault();
        void simulate();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [simulate]);

  // ------------------------------------------------------------ render

  const matches = searchCatalog(query);
  const stale = !!sim && block !== undefined && block - sim.sim.block > MAX_SIM_AGE_BLOCKS;

  const renderList = (list: Block[], parentId: string | null, depth: number) => (
    <ol className={`chain ${depth ? "nested" : ""}`}>
      {list.map((b, i) => (
        <li key={b.id}>
          <DropZone onDrop={(e) => onDrop(e, parentId, i)} />
          <BlockCard
            block={b}
            index={i}
            selected={selected === b.id}
            issues={issuesFor(b.id)}
            onSelect={() => setSelected(b.type === "flashLoan" ? (selected === b.id ? null : b.id) : selected)}
            onChange={(nb) => setBlocks((l) => updateBlock(l, b.id, () => nb))}
            onRemove={() => {
              setBlocks((l) => removeBlock(l, b.id)[0]);
              if (selected === b.id) setSelected(null);
            }}
            onDuplicate={() => setBlocks((l) => insertBlock(l, parentId, i + 1, cloneWithNewIds(b)))}
            onUp={() => nudge(b.id, -1)}
            onDown={() => nudge(b.id, 1)}
          >
            {b.type === "flashLoan" && (
              <div className="container" onDragOver={(e) => e.preventDefault()} onDrop={(e) => onDrop(e, b.id, b.children.length)}>
                {renderList(b.children, b.id, depth + 1)}
                {!b.children.length && <p className="muted small">Drop blocks here, or select this flash loan and click blocks in the palette.</p>}
              </div>
            )}
          </BlockCard>
        </li>
      ))}
      <li>
        <DropZone last onDrop={(e) => onDrop(e, parentId, list.length)} />
      </li>
    </ol>
  );

  return (
    <div className="builder">
      <aside className="palette card">
        <input
          ref={search}
          placeholder="Search blocks  ( / )"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && matches[0]) {
              add(matches[0]);
              setQuery("");
            }
          }}
          data-testid="palette-search"
        />
        {GROUPS.map((g) => {
          const items = matches.filter((d) => d.group === g);
          if (!items.length) return null;
          return (
            <div key={g}>
              <h4>{g}</h4>
              {items.map((d) => (
                <button
                  key={d.type}
                  className={`palette-item g-${g.toLowerCase()}`}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData("application/x-covenant-block", JSON.stringify({ kind: "new", type: d.type } satisfies DragData))}
                  onClick={() => add(d)}
                  title={d.hint}
                  data-testid={`palette-${d.type}`}
                >
                  <b>{d.title}</b>
                  <span className="small muted">{d.hint}</span>
                </button>
              ))}
            </div>
          );
        })}
        <p className="small muted">
          Click to add{selected ? " inside the selected flash loan" : ""}, or drag into place. {CATALOG.length} blocks.
        </p>
      </aside>

      <section className="canvas">
        <Card
          title={<input className="title-input" value={flow.name} onChange={(e) => setFlow((f) => ({ ...f, name: e.target.value }))} aria-label="flow name" />}
          actions={
            <>
              <button onClick={() => useTemplate({ ...EMPTY, blocks: [] })}>Clear</button>
              <FlowMenu flow={flow} onLoad={useTemplate} onNotice={setNotice} />
            </>
          }
        >
          {notice && <Notice tone="ok">{notice}</Notice>}
          {blocks.length === 0 ? (
            <div className="container" onDragOver={(e) => e.preventDefault()} onDrop={(e) => onDrop(e, null, 0)}>
              <p className="muted">Start from a template on the right, or click / drag blocks from the palette.</p>
            </div>
          ) : (
            renderList(blocks, null, 0)
          )}
        </Card>
        {sim && <PlanSteps plan={sim.plan} />}
      </section>

      <aside className="side">
        <Card title="Start from">
          {!owner && <p className="small muted">Connect Rabby to start from your positions.</p>}
          {open.map((p) => {
            const other = MARKETS.find(
              (m) => m.key !== p.market.key && m.loanToken === p.market.loanToken && m.collateralToken === p.market.collateralToken,
            );
            return (
              <div key={p.market.key} className="template">
                <b className="small">{p.market.label}</b>
                <div className="row tight">
                  <button onClick={() => useTemplate(templateFor(p))} data-testid={`template-unwind-${p.market.key}`}>
                    {unwindMode(p) === "partial" ? "Partial unwind" : unwindMode(p) === "deleverage" ? "Deleverage" : "Unwind"}
                  </button>
                  {other && (
                    <button onClick={() => useTemplate(moveFlow(p, other))} data-testid={`template-move-${p.market.key}`}>
                      Move → {other.label.split("·").pop()?.trim()}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          <div className="template">
            <b className="small">Enter a loop</b>
            <div className="row tight">
              <select value={enterMarket} onChange={(e) => setEnterMarket(e.target.value)} aria-label="enter market">
                {MARKETS.map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.label}
                  </option>
                ))}
              </select>
              <input className="num" value={enterEquity} onChange={(e) => setEnterEquity(e.target.value)} aria-label="equity" />
              <span className="small muted">USDC ×</span>
              <input className="num short" value={enterLev} onChange={(e) => setEnterLev(e.target.value)} aria-label="leverage" />
              <button
                onClick={() =>
                  useTemplate(enterFlow(MARKETS.find((m) => m.key === enterMarket)!, BigInt(Math.round(Number(enterEquity) * 1e6)), Number(enterLev)))
                }
                disabled={!(Number(enterEquity) > 0 && Number(enterLev) > 1)}
              >
                Use
              </button>
            </div>
          </div>
        </Card>

        <Card title="Check & simulate">
          {issues.length > 0 && (
            <ul className="issues small" data-testid="issues">
              {issues.map((i, k) => (
                <li key={k} className={i.level === "error" ? "danger-text" : "warn-text"}>
                  {i.level === "error" ? "✕" : "!"} {i.message}
                </li>
              ))}
            </ul>
          )}
          {!owner || !executor ? (
            <Notice tone="warn">Connect Rabby and finish Setup to simulate.</Notice>
          ) : (
            <button className="primary" disabled={!!errors.length || simulating} onClick={() => void simulate()} data-testid="simulate">
              {simulating ? "Simulating…" : "Simulate  (⌘↵)"}
            </button>
          )}
          {simError && <Notice tone="danger">Simulation failed: {simError}</Notice>}
          {sim && (
            <>
              <SimSummary plan={sim.plan} sim={sim.sim} compact />
              <button className="link small" onClick={addGuardsFromSim}>
                + Add “receive at least 99.5%” guards from this simulation
              </button>
            </>
          )}
        </Card>
        {sim && <SignPanel plan={sim.plan} stale={stale} onDone={app.bump} />}
      </aside>
    </div>
  );
}

function DropZone({ onDrop, last }: { onDrop: (e: DragEvent) => void; last?: boolean }) {
  const [over, setOver] = useState(false);
  return (
    <div
      className={`dropzone ${over ? "over" : ""} ${last ? "last" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        onDrop(e);
      }}
    />
  );
}

function BlockCard(props: {
  block: Block;
  index: number;
  selected: boolean;
  issues: { level: string; message: string }[];
  onSelect: () => void;
  onChange: (b: Block) => void;
  onRemove: () => void;
  onDuplicate: () => void;
  onUp: () => void;
  onDown: () => void;
  children?: ReactNode;
}) {
  const { block: b } = props;
  const d = def(b.type);
  return (
    <div
      className={`block g-${d.group.toLowerCase()} ${props.selected ? "selected" : ""}`}
      draggable
      onDragStart={(e) => {
        e.stopPropagation();
        e.dataTransfer.setData("application/x-covenant-block", JSON.stringify({ kind: "move", id: b.id } satisfies DragData));
      }}
      data-testid={`block-${b.type}`}
    >
      <div className="block-head" onClick={props.onSelect}>
        <span className="drag" title="Drag to move">
          ⋮⋮
        </span>
        <b>{d.title}</b>
        {b.type === "flashLoan" && <span className="small muted">{props.selected ? "· new blocks go inside" : "· click to add blocks inside"}</span>}
        <span className="grow" />
        <button className="icon" onClick={(e) => (e.stopPropagation(), props.onUp())} title="Move up" aria-label="move up">
          ↑
        </button>
        <button className="icon" onClick={(e) => (e.stopPropagation(), props.onDown())} title="Move down" aria-label="move down">
          ↓
        </button>
        <button className="icon" onClick={(e) => (e.stopPropagation(), props.onDuplicate())} title="Duplicate" aria-label="duplicate">
          ⧉
        </button>
        <button className="icon" onClick={(e) => (e.stopPropagation(), props.onRemove())} title="Remove" aria-label="remove">
          ✕
        </button>
      </div>
      <div className="block-body">
        <BlockEditor block={b} onChange={props.onChange} />
        {props.issues.map((i, k) => (
          <div key={k} className={`small ${i.level === "error" ? "danger-text" : "warn-text"}`}>
            {i.message}
          </div>
        ))}
      </div>
      {props.children}
    </div>
  );
}

function FlowMenu({ flow, onLoad, onNotice }: { flow: Flow; onLoad: (f: Flow) => void; onNotice: (s: string) => void }) {
  const [saved, setSaved] = useState(savedFlows);
  const file = useRef<HTMLInputElement>(null);
  return (
    <>
      <select
        value=""
        onChange={(e) => {
          const f = saved.find((x) => x.name === e.target.value);
          if (f) onLoad(f);
        }}
        aria-label="saved flows"
      >
        <option value="">Saved flows ({saved.length})</option>
        {saved.map((f) => (
          <option key={f.name}>{f.name}</option>
        ))}
      </select>
      <button
        onClick={() => {
          saveFlow(flow);
          setSaved(savedFlows());
          onNotice(`Saved “${flow.name}” in this browser.`);
        }}
      >
        Save
      </button>
      {saved.some((f) => f.name === flow.name) && (
        <button
          onClick={() => {
            deleteFlow(flow.name);
            setSaved(savedFlows());
          }}
        >
          Delete
        </button>
      )}
      <button
        onClick={() => {
          const url = new Blob([JSON.stringify(flow, null, 2)], { type: "application/json" });
          const a = document.createElement("a");
          a.href = URL.createObjectURL(url);
          a.download = `${flow.name.replace(/[^\w-]+/g, "_")}.covenant.json`;
          a.click();
        }}
      >
        Export
      </button>
      <button onClick={() => file.current?.click()}>Import</button>
      <input
        ref={file}
        type="file"
        accept="application/json"
        hidden
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          try {
            onLoad(parseFlow(await f.text()));
          } catch (err) {
            onNotice(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }}
      />
      <button
        onClick={() => {
          const link = `${location.origin}${location.pathname}${flowToHash(flow)}`;
          void navigator.clipboard?.writeText(link);
          onNotice("Share link copied. It only works on your own local Covenant.");
        }}
      >
        Share
      </button>
    </>
  );
}
