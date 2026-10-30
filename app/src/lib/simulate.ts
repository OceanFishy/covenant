import {
  decodeErrorResult,
  decodeFunctionResult,
  encodeFunctionData,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { erc20Abi, executorAbi, morphoAbi } from "./abis";
import type { Plan } from "./compiler/types";
import { MORPHO, label, tokenInfo } from "./registry";

export type BalanceChange = { token: Address; symbol: string; decimals: number; before: bigint; after: bigint };

export type SimulationResult =
  | {
      ok: true;
      block: bigint;
      gasUsed: bigint;
      changes: BalanceChange[];
      collateralAfter: bigint;
      borrowSharesAfter: bigint;
      healthAfter: bigint;
      method: "eth_simulateV1" | "dev-fork";
    }
  | { ok: false; block: bigint; error: string; revertData?: Hex; method: "eth_simulateV1" | "dev-fork" };

/** Turns (possibly nested) Executor revert data into a readable reason. */
export function decodeRevert(data: Hex | undefined, depth = 0): string {
  if (!data || data === "0x") return "reverted without a reason";
  try {
    const e = decodeErrorResult({ abi: executorAbi, data });
    const a = (e.args ?? []) as readonly unknown[];
    switch (e.errorName) {
      case "CallFailed": {
        const [index, target, reason] = a as [bigint, Address, Hex];
        const inner = depth < 4 ? decodeRevert(reason, depth + 1) : "…";
        return `call #${index} to ${label(target)} failed: ${inner}`;
      }
      case "BalanceTooLow": {
        const [token, bal, min] = a as [Address, bigint, bigint];
        const t = tokenInfo(token);
        return `guard: ${t.symbol} balance ${bal} below required ${min}`;
      }
      case "Error":
        return String(a[0]);
      default:
        return `${e.errorName}(${a.map(String).join(", ")})`;
    }
  } catch {
    // Morpho's flash loan re-throws the callback's revert data unchanged, so try once more as
    // a nested blob, else give up with the selector.
    return `revert ${data.slice(0, 10)}`;
  }
}

function tokensFor(plan: Plan): Address[] {
  const m = plan.market;
  const list = [m.series.tokenOut, m.loanToken, m.series.pt, m.series.yt];
  return list.filter((a, i) => list.findIndex((b) => b.toLowerCase() === a.toLowerCase()) === i);
}

type RawCall = { to: Address; data: Hex };

function readCalls(plan: Plan, tokens: Address[]): RawCall[] {
  return tokens.map((t) => ({ to: t, data: encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [plan.owner] }) }));
}

function stateCalls(plan: Plan): RawCall[] {
  return [
    { to: MORPHO, data: encodeFunctionData({ abi: morphoAbi, functionName: "position", args: [plan.market.id, plan.owner] }) },
    {
      to: plan.executor,
      data: encodeFunctionData({ abi: executorAbi, functionName: "healthFactor", args: [plan.market.id, plan.owner] }),
    },
  ];
}

function decodeState(results: Hex[]) {
  const [, borrowSharesAfter, collateralAfter] = decodeFunctionResult({
    abi: morphoAbi,
    functionName: "position",
    data: results[0],
  }) as readonly [bigint, bigint, bigint];
  const healthAfter = decodeFunctionResult({ abi: executorAbi, functionName: "healthFactor", data: results[1] }) as bigint;
  return { borrowSharesAfter, collateralAfter, healthAfter };
}

function changes(tokens: Address[], before: Hex[], after: Hex[]): BalanceChange[] {
  return tokens.map((t, i) => {
    const info = tokenInfo(t);
    return { token: t, symbol: info.symbol, decimals: info.decimals, before: BigInt(before[i]), after: BigInt(after[i]) };
  });
}

type SimV1Call = { status: Hex; returnData: Hex; gasUsed: Hex; error?: { message: string; data?: Hex } };

async function simulateV1(client: PublicClient, plan: Plan, tokens: Address[]): Promise<SimulationResult> {
  const reads = readCalls(plan, tokens);
  const state = stateCalls(plan);
  const calls = [
    ...reads,
    { from: plan.owner, to: plan.executor, data: plan.data },
    ...reads,
    ...state,
  ];
  const block = await client.getBlockNumber();
  const res = (await client.request({
    method: "eth_simulateV1" as never,
    params: [{ blockStateCalls: [{ calls }], validation: false }, "latest"] as never,
  })) as { calls: SimV1Call[] }[];
  const out = res[0].calls;
  const tx = out[reads.length];
  if (tx.status !== "0x1") {
    return { ok: false, block, error: decodeRevert(tx.error?.data ?? tx.returnData), revertData: tx.error?.data ?? tx.returnData, method: "eth_simulateV1" };
  }
  const before = out.slice(0, reads.length).map((c) => c.returnData);
  const after = out.slice(reads.length + 1, reads.length * 2 + 1).map((c) => c.returnData);
  const st = decodeState(out.slice(reads.length * 2 + 1).map((c) => c.returnData));
  return { ok: true, block, gasUsed: BigInt(tx.gasUsed), changes: changes(tokens, before, after), ...st, method: "eth_simulateV1" };
}

/** Local Hardhat fork (chain 31337): snapshot, send as the owner, read, revert. */
async function simulateDevFork(client: PublicClient, plan: Plan, tokens: Address[]): Promise<SimulationResult> {
  const req = client.request as (a: { method: string; params?: unknown[] }) => Promise<unknown>;
  const readAll = (calls: RawCall[]) => Promise.all(calls.map((c) => client.call(c).then((r) => r.data ?? "0x")));
  const block = await client.getBlockNumber();
  const snap = (await req({ method: "evm_snapshot" })) as Hex;
  try {
    await req({ method: "hardhat_impersonateAccount", params: [plan.owner] });
    const before = await readAll(readCalls(plan, tokens));
    let hash: Hex;
    try {
      hash = (await req({ method: "eth_sendTransaction", params: [{ from: plan.owner, to: plan.executor, data: plan.data }] })) as Hex;
    } catch (e) {
      const data = findRevertData(e);
      return { ok: false, block, error: decodeRevert(data), revertData: data, method: "dev-fork" };
    }
    const receipt = await client.waitForTransactionReceipt({ hash });
    const after = await readAll(readCalls(plan, tokens));
    const st = decodeState(await readAll(stateCalls(plan)));
    return { ok: true, block, gasUsed: receipt.gasUsed, changes: changes(tokens, before, after), ...st, method: "dev-fork" };
  } finally {
    await req({ method: "evm_revert", params: [snap] });
  }
}

function findRevertData(e: unknown): Hex | undefined {
  let cur: unknown = e;
  for (let i = 0; i < 6 && cur; i++) {
    const c = cur as { data?: unknown; cause?: unknown };
    if (typeof c.data === "string" && c.data.startsWith("0x")) return c.data as Hex;
    if (c.data && typeof (c.data as { data?: unknown }).data === "string") return (c.data as { data: Hex }).data;
    cur = c.cause;
  }
  return undefined;
}

export async function simulatePlan(client: PublicClient, plan: Plan): Promise<SimulationResult> {
  const tokens = tokensFor(plan);
  const chainId = await client.getChainId();
  return chainId === 31337 ? simulateDevFork(client, plan, tokens) : simulateV1(client, plan, tokens);
}

/**
 * True when a failed simulation came from the aggregator leg: the route reverted (stale) or
 * delivered less than the guard requires. A fresh quote with more headroom may fix it.
 */
export function isSwapFailure(sim: SimulationResult): boolean {
  return !sim.ok && /guard: USD[CT] balance|to (KyberSwap router|0x AllowanceHolder) failed/.test(sim.error);
}
