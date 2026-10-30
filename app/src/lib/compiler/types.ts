import type { Address, Hex } from "viem";
import type { Market } from "../registry";

/** Mirrors CovenantExecutor.Source. */
export enum Source {
  BALANCE = 0,
  MORPHO_COLLATERAL = 1,
  MORPHO_BORROW_SHARES = 2,
  MORPHO_DEBT_ASSETS = 3,
}

/** Mirrors CovenantExecutor.Patch: overwrite the uint256 at `offset` in `data` at execution time. */
export type Patch = { offset: number; source: Source; args: Hex; bps: number };

/** Mirrors CovenantExecutor.Call. */
export type Call = { target: Address; data: Hex; patches: Patch[] };

/** One human-readable line on the Review screen. `depth` 1 = inside the flash loan. */
export type Step = { text: string; depth: 0 | 1 };

/** Aggregator route for a fixed sell amount, executor as taker and recipient. */
export type Swap = {
  aggregator: "0x" | "kyber";
  sellToken: Address;
  buyToken: Address;
  spender: Address;
  target: Address;
  data: Hex;
  amountIn: bigint;
  quotedOut: bigint;
  /** Enforced on-chain by assertMinBalance on the executor. */
  minOut: bigint;
};

export type PlanKind = "unwind" | "deleverage" | "partial" | "enter";

export type Plan = {
  kind: PlanKind;
  market: Market;
  owner: Address;
  executor: Address;
  calls: Call[];
  sweep: Address[];
  steps: Step[];
  planHash: Hex;
  /** Calldata for executor.execute(calls, sweep, planHash). */
  data: Hex;
  /** Aggregator leg, if any (reused when rebuilding the same plan with a tighter guard). */
  swap?: Swap;
};
