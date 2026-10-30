import type { Address } from "viem";

/**
 * Builder blocks (docs/SPEC.md §4, §6). Every block compiles to calls the Executor already
 * allows; amounts are either fixed (human decimal strings, in the block's token) or read on-chain
 * at execution time through the Executor's patch sources.
 */

export type Fixed = { kind: "fixed"; value: string };
/** The Executor's whole balance of the block's input token, at execution time. */
export type Balance = { kind: "balance" };
/** The market's live debt (+bps), at execution time. */
export type Debt = { kind: "debt"; market: string; bps: number };
/** All of the owner's collateral in the block's market, at execution time. */
export type Collateral = { kind: "collateral" };
/** Repay by shares: all of the owner's debt, no dust. */
export type AllShares = { kind: "allShares" };

export type Amount = Fixed | Balance | Debt | Collateral | AllShares;

type Base = { id: string };

export type Block =
  | (Base & { type: "accrueInterest"; market: string })
  | (Base & { type: "pull"; token: Address; amount: Fixed })
  | (Base & { type: "flashLoan"; token: Address; amount: Fixed | Debt; children: Block[] })
  | (Base & { type: "repay"; market: string; amount: AllShares | Fixed | Balance })
  | (Base & { type: "withdrawCollateral"; market: string; amount: Collateral | Fixed })
  | (Base & { type: "supplyCollateral"; market: string; amount: Balance | Fixed })
  | (Base & { type: "borrow"; market: string; amount: Fixed })
  | (Base & { type: "redeemPY"; series: string; amount: Balance | Fixed })
  | (Base & { type: "redeemSY"; series: string; tokenOut: Address; minOut: Fixed })
  | (Base & { type: "mintPY"; series: string; tokenIn: Address; amount: Balance | Fixed; ytTo: "wallet" | "executor" })
  | (Base & {
      type: "swap";
      sell: Address;
      buy: Address;
      /** exactIn: sell `amount`; minOut: buy at least `amount` (fixed, or a market's debt). */
      mode: "exactIn" | "minOut";
      amount: Fixed | Debt;
    })
  | (Base & { type: "guardMinBalance"; token: Address; min: Fixed })
  | (Base & { type: "guardNoDebt"; market: string })
  | (Base & { type: "guardMinHealth"; market: string; min: string });

export type BlockType = Block["type"];

/** A saved / shared flow. */
export type Flow = { version: 1; name: string; blocks: Block[] };

export type Issue = { blockId?: string; level: "error" | "warning"; message: string };
