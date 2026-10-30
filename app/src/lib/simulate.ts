import {
  decodeErrorResult,
  decodeFunctionResult,
  encodeFunctionData,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { aaveErrorsAbi, aavePoolAbi, erc20Abi, executorAbi, morphoAbi } from "./abis";
import type { Plan } from "./compiler/types";
import { withChainLock } from "./chain";
import { AAVE_POOL, MORPHO, label, tokenInfo, type Market } from "./registry";

export type BalanceChange = { token: Address; symbol: string; decimals: number; before: bigint; after: bigint };

export type PositionAfter = { market: Market; collateral: bigint; borrowShares: bigint; health: bigint };

export type SimulationResult =
  | {
      ok: true;
      block: bigint;
      gasUsed: bigint;
      changes: BalanceChange[];
      /** The plan's primary market (plan.market); absent for a custom flow that touches no Morpho market. */
      collateralAfter?: bigint;
      borrowSharesAfter?: bigint;
      healthAfter?: bigint;
      /** Every market in plan.markets. */
      positions: PositionAfter[];
      /** The owner's Aave health factor after (WAD; max = no debt), when the plan touches Aave. */
      aaveHealthAfter?: bigint;
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
        // Morpho pulls the flash loan back with transferFrom after the callback.
        const hint =
          target.toLowerCase() === MORPHO.toLowerCase() && /^transferFrom (reverted|returned false)$/.test(inner)
            ? " (the Executor couldn't repay the flash loan: the blocks inside it must end with at least the borrowed amount of the loan token)"
            : "";
        return `call #${index} to ${label(target)} failed: ${inner}${hint}`;
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
    return decodeAaveRevert(data) ?? `revert ${data.slice(0, 10)}`;
  }
}

const AAVE_HINTS: Record<string, string> = {
  ReserveFrozen: " (Aave governance has frozen this reserve: supply and borrow are disabled, repay and withdraw still work)",
  InsufficientBorrowAllowance: " (the Executor can't borrow for you yet: Setup → Aave → allow it to borrow)",
  ERC20InsufficientAllowance: " (the Executor can't pull your aToken yet: Setup → Aave → approve the aToken)",
  UserHasAssetWithZeroLtv: " (Aave set an LTV of 0 on one of your collaterals: withdraw that asset or repay first)",
};

/** Aave v3 Pool / token custom errors, with a hint for the ones a plan can fix. */
function decodeAaveRevert(data: Hex): string | undefined {
  try {
    const e = decodeErrorResult({ abi: aaveErrorsAbi, data });
    const a = (e.args ?? []) as readonly unknown[];
    return `Aave: ${e.errorName}${a.length ? `(${a.map(String).join(", ")})` : ""}${AAVE_HINTS[e.errorName] ?? ""}`;
  } catch {
    return undefined;
  }
}

function tokensFor(plan: Plan): Address[] {
  const m = plan.market;
  const list = plan.tokens ?? [m.series.tokenOut, m.loanToken, m.series.pt, m.series.yt];
  return list.filter((a, i) => list.findIndex((b) => b.toLowerCase() === a.toLowerCase()) === i);
}

type RawCall = { to: Address; data: Hex };

function readCalls(plan: Plan, tokens: Address[]): RawCall[] {
  return tokens.map((t) => ({ to: t, data: encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [plan.owner] }) }));
}

/** Templates report their own market; a custom flow reports exactly the markets its blocks use (maybe none). */
function marketsFor(plan: Plan): Market[] {
  return plan.markets ?? [plan.market];
}

/** Position + health reads for every market, two calls each, then the Aave account if used. */
function stateCalls(plan: Plan): RawCall[] {
  return [
    ...marketsFor(plan).flatMap((m) => [
      { to: MORPHO, data: encodeFunctionData({ abi: morphoAbi, functionName: "position", args: [m.id, plan.owner] }) },
      { to: plan.executor, data: encodeFunctionData({ abi: executorAbi, functionName: "healthFactor", args: [m.id, plan.owner] }) },
    ]),
    ...(plan.aave
      ? [{ to: AAVE_POOL, data: encodeFunctionData({ abi: aavePoolAbi, functionName: "getUserAccountData", args: [plan.owner] }) }]
      : []),
  ];
}

function decodeState(plan: Plan, results: Hex[]) {
  const positions = marketsFor(plan).map((market, i): PositionAfter => {
    const [, borrowShares, collateral] = decodeFunctionResult({
      abi: morphoAbi,
      functionName: "position",
      data: results[2 * i],
    }) as readonly [bigint, bigint, bigint];
    const health = decodeFunctionResult({ abi: executorAbi, functionName: "healthFactor", data: results[2 * i + 1] }) as bigint;
    return { market, collateral, borrowShares, health };
  });
  const primary = positions.find((p) => p.market.id === plan.market.id) ?? positions[0];
  const aave = plan.aave
    ? decodeFunctionResult({ abi: aavePoolAbi, functionName: "getUserAccountData", data: results[2 * positions.length] })
    : undefined;
  return {
    positions,
    borrowSharesAfter: primary?.borrowShares,
    collateralAfter: primary?.collateral,
    healthAfter: primary?.health,
    aaveHealthAfter: aave?.[5],
  };
}

function changes(tokens: Address[], before: Hex[], after: Hex[]): BalanceChange[] {
  return tokens.map((t, i) => {
    const info = tokenInfo(t);
    return { token: t, symbol: info.symbol, decimals: info.decimals, before: BigInt(before[i]), after: BigInt(after[i]) };
  });
}

type SimV1Call = { status: Hex; returnData: Hex; gasUsed: Hex; error?: { message: string; data?: Hex } };

/** eth_simulateV1 state overrides, keyed by address (tests use them; the app passes none). */
export type StateOverrides = Record<Address, { code?: Hex; stateDiff?: Record<Hex, Hex> }>;

async function simulateV1(
  client: PublicClient,
  plan: Plan,
  tokens: Address[],
  stateOverrides?: StateOverrides,
): Promise<SimulationResult> {
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
    params: [{ blockStateCalls: [{ calls, ...(stateOverrides && { stateOverrides }) }], validation: false }, "latest"] as never,
  })) as { calls: SimV1Call[] }[];
  const out = res[0].calls;
  const tx = out[reads.length];
  if (tx.status !== "0x1") {
    return { ok: false, block, error: decodeRevert(tx.error?.data ?? tx.returnData), revertData: tx.error?.data ?? tx.returnData, method: "eth_simulateV1" };
  }
  const before = out.slice(0, reads.length).map((c) => c.returnData);
  const after = out.slice(reads.length + 1, reads.length * 2 + 1).map((c) => c.returnData);
  const st = decodeState(plan, out.slice(reads.length * 2 + 1).map((c) => c.returnData));
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
    const st = decodeState(plan, await readAll(stateCalls(plan)));
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

export async function simulatePlan(client: PublicClient, plan: Plan, stateOverrides?: StateOverrides): Promise<SimulationResult> {
  const tokens = tokensFor(plan);
  const chainId = await client.getChainId();
  return chainId === 31337
    ? withChainLock(() => simulateDevFork(client, plan, tokens))
    : simulateV1(client, plan, tokens, stateOverrides);
}

/**
 * True when a failed simulation came from the aggregator leg: the route reverted (stale) or
 * delivered less than the guard requires. A fresh quote with more headroom may fix it.
 */
export function isSwapFailure(sim: SimulationResult): boolean {
  return !sim.ok && /guard: (USDC|USDT|reUSD) balance|to (KyberSwap router|0x AllowanceHolder) failed/.test(sim.error);
}
