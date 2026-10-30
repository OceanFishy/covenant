import type { Address, Hex } from "viem";
import type { AaveV4Reserve, Market } from "../registry";

/** Mirrors CovenantCore.Source. */
export enum Source {
  BALANCE = 0,
  MORPHO_COLLATERAL = 1,
  MORPHO_BORROW_SHARES = 2,
  MORPHO_DEBT_ASSETS = 3,
  /** What the plan itself holds of a token (the Executor's balance; under 7702, allotted + received). */
  OWNED = 4,
  /** The owner's live Aave v4 debt on a Spoke reserve (drawn + premium). */
  AAVE_V4_DEBT = 5,
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
  /** Enforced on-chain by the executor's balance guard. */
  minOut: bigint;
};

export type PlanKind = "unwind" | "deleverage" | "partial" | "enter" | "custom";

export type Plan = {
  kind: PlanKind;
  market: Market;
  owner: Address;
  executor: Address;
  calls: Call[];
  /** Tokens swept back to the owner (Executor) or tracked by the delegate (7702). */
  sweep: Address[];
  steps: Step[];
  planHash: Hex;
  /** Calldata for executor.execute(calls, sweep, planHash). */
  data: Hex;
  /** Aggregator leg, if any (reused when rebuilding the same plan with a tighter guard). */
  swap?: Swap;
  /** Every market the plan touches (simulation reports each); defaults to [market]. */
  markets?: Market[];
  /** Wallet tokens the simulation reports; defaults to the market's tokens. */
  tokens?: Address[];
  /** The plan touches the owner's Aave account: simulation reports the Aave health factor after. */
  aave?: boolean;
  /**
   * Aave v4 Main Spoke reserves the plan touches (empty when only the account health is checked):
   * simulation reports their supply, debt and the v4 health factor after. Absent: no v4.
   */
  aaveV4?: AaveV4Reserve[];
};
