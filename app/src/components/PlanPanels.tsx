import { useState } from "react";
import { decodeFunctionData, keccak256, type Abi } from "viem";
import { aaveDebtTokenAbi, aavePoolAbi, erc20Abi, executorAbi, morphoAbi, syAbi, ytAbi } from "../lib/abis";
import type { Plan } from "../lib/compiler/types";
import { label } from "../lib/registry";
import { useApp } from "../state";
import { AddressLink, Card, Notice, SentLine, useSendTx } from "./common";

export const MAX_SIM_AGE_BLOCKS = 3n;

const KNOWN_ABIS: Abi[] = [executorAbi, morphoAbi, aavePoolAbi, aaveDebtTokenAbi, erc20Abi, ytAbi, syAbi];

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

/** Plain-English steps + the decoded top-level calls. */
export function PlanSteps({ plan }: { plan: Plan }) {
  return (
    <Card title="What this transaction does">
      <ol className="plan" data-testid="plan-steps">
        {plan.steps.map((s, i) => (
          <li key={i} className={s.depth ? "nested" : ""}>
            {s.text}
          </li>
        ))}
      </ol>
      <details>
        <summary>Raw calls ({plan.calls.length} top-level)</summary>
        <ul className="mono small">
          {plan.calls.map((c, i) => (
            <li key={i}>
              #{i} {label(c.target)}.{fnName(c.data)} {c.patches.length > 0 && `(+${c.patches.length} runtime amount)`}
            </li>
          ))}
        </ul>
      </details>
    </Card>
  );
}

/**
 * Sign panel shared by Review and Builder: enabled only with a fresh passing simulation, a
 * verified Executor and a confirmed MEV-protected RPC. `onSigning(true)` fires before the
 * wallet prompt and `onSigning(false)` if it fails, so the page can pause its per-block
 * re-simulation (which would otherwise fail on the already-executed plan before the receipt).
 */
export function SignPanel({
  plan,
  stale,
  onDone,
  onSigning,
}: {
  plan: Plan;
  stale: boolean;
  onDone?: () => void;
  onSigning?: (busy: boolean) => void;
}) {
  const app = useApp();
  const tx = useSendTx();
  const [done, setDone] = useState(false);
  const blocker = app.signBlockedReason ?? (!app.executorCheck?.ok ? "Executor not verified." : undefined);

  async function sign() {
    onSigning?.(true);
    try {
      await tx.run({ to: plan.executor, data: plan.data });
    } catch (e) {
      onSigning?.(false);
      throw e;
    }
    setDone(true);
    onDone?.();
  }

  return (
    <Card title="Sign">
      <ul className="small">
        <li>
          {plan.executor.toLowerCase() === plan.owner.toLowerCase() ? (
            <>
              Rabby will show a transaction to <b>your own address</b> <AddressLink address={plan.executor} /> calling{" "}
              <code>execute</code> (EIP-7702: your account runs the plan).
            </>
          ) : (
            <>
              Rabby will show a transaction to your Executor <AddressLink address={plan.executor} /> calling <code>execute</code>.
            </>
          )}{" "}
          Check that the address matches.
        </li>
        <li>Rabby's own simulation should show the same balance changes as above. If it doesn't, reject.</li>
        <li>
          Your Ledger will ask to <b>blind sign</b> (Ethereum app → Settings → Blind signing). Plan hash{" "}
          <code className="mono">{plan.planHash.slice(0, 18)}…</code> · calldata hash{" "}
          <code className="mono">{keccak256(plan.data).slice(0, 18)}…</code>
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
        <button className="primary big" disabled={!!blocker || stale || tx.busy} onClick={() => void sign()} data-testid="sign">
          {tx.busy ? "Waiting for Rabby / Ledger…" : "Sign with Ledger"}
        </button>
      )}
      <SentLine tx={tx.last} />
    </Card>
  );
}
