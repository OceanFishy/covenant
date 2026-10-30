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
/** The owner's live Aave variable debt in `asset` (+bps), at execution time. */
export type AaveDebt = { kind: "aaveDebt"; asset: Address; bps: number };
/** The owner's live Aave v4 debt (Main Spoke) in `asset` (+bps), at execution time. */
export type AaveV4Debt = { kind: "aaveV4Debt"; asset: Address; bps: number };
/** Aave repay (v3 or v4): exactly the owner's live debt in the block's asset. */
export type AllDebt = { kind: "allDebt" };
/** Aave withdraw (v3 or v4): all of the owner's supply of the block's asset. */
export type Supplied = { kind: "supplied" };

export type Amount = Fixed | Balance | Debt | Collateral | AllShares | AaveDebt | AaveV4Debt | AllDebt | Supplied;

type Base = { id: string };

export type Block =
  | (Base & { type: "accrueInterest"; market: string })
  | (Base & { type: "pull"; token: Address; amount: Fixed })
  | (Base & { type: "flashLoan"; token: Address; amount: Fixed | Debt | AaveDebt | AaveV4Debt; children: Block[] })
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
      /** exactIn: sell `amount`; minOut: buy at least `amount` (fixed, or a Morpho / Aave debt). */
      mode: "exactIn" | "minOut";
      amount: Fixed | Debt | AaveDebt | AaveV4Debt;
    })
  | (Base & { type: "guardMinBalance"; token: Address; min: Fixed })
  | (Base & { type: "guardNoDebt"; market: string })
  | (Base & { type: "guardMinHealth"; market: string; min: string })
  // Aave v3 Core. `asset` is the reserve's underlying (USDC / USDT); positions are the owner's.
  | (Base & { type: "aaveSupply"; asset: Address; amount: Balance | Fixed })
  | (Base & { type: "aaveWithdraw"; asset: Address; amount: Supplied | Fixed })
  | (Base & { type: "aaveBorrow"; asset: Address; amount: Fixed })
  | (Base & { type: "aaveRepay"; asset: Address; amount: AllDebt | Balance | Fixed })
  | (Base & { type: "guardAaveNoDebt"; asset: Address })
  | (Base & { type: "guardAaveHealth"; min: string })
  // Aave v4 Main Spoke, through Aave's Giver (supply / repay) and Taker (withdraw / borrow).
  | (Base & { type: "aaveV4Supply"; asset: Address; amount: Balance | Fixed })
  | (Base & { type: "aaveV4Withdraw"; asset: Address; amount: Supplied | Fixed })
  | (Base & { type: "aaveV4Borrow"; asset: Address; amount: Fixed })
  | (Base & { type: "aaveV4Repay"; asset: Address; amount: AllDebt | Balance | Fixed })
  | (Base & { type: "guardAaveV4NoDebt"; asset: Address })
  | (Base & { type: "guardAaveV4Health"; min: string });

export type BlockType = Block["type"];

/** A saved / shared flow. */
export type Flow = { version: 1; name: string; blocks: Block[] };

export type Issue = { blockId?: string; level: "error" | "warning"; message: string };
