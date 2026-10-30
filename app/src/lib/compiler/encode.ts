import { encodeAbiParameters, encodeFunctionData, keccak256, type Address, type Hex } from "viem";
import { delegateAbi, erc20Abi, executorAbi } from "../abis";
import { Source, type Call, type Patch } from "./types";

const FULL = 10_000;

const patchType = {
  type: "tuple[]",
  components: [
    { name: "offset", type: "uint32" },
    { name: "source", type: "uint8" },
    { name: "args", type: "bytes" },
    { name: "bps", type: "uint32" },
  ],
} as const;

export const callsType = {
  type: "tuple[]",
  components: [
    { name: "target", type: "address" },
    { name: "data", type: "bytes" },
    { name: "patches", ...patchType },
  ],
} as const;

/** Byte offset of argument word `i` in calldata (after the 4-byte selector). */
export function arg(i: number): number {
  return 4 + 32 * i;
}

export function call(target: Address, data: Hex, ...patches: Patch[]): Call {
  return { target, data, patches };
}

/** `bps` scales the balance (e.g. an Aave variable debt token balance + a buffer). */
export function balancePatch(offset: number, token: Address, account: Address, bps = FULL): Patch {
  return {
    offset,
    source: Source.BALANCE,
    args: encodeAbiParameters([{ type: "address" }, { type: "address" }], [token, account]),
    bps,
  };
}

export function morphoPatch(offset: number, source: Source, id: Hex, user: Address, bps = FULL): Patch {
  return { offset, source, args: encodeAbiParameters([{ type: "bytes32" }, { type: "address" }], [id, user]), bps };
}

/**
 * Who runs a plan: a deployed Executor (`executor` ≠ `owner`), or the owner's EOA itself under
 * EIP-7702 (`executor` = `owner`, see contracts/CovenantDelegate.sol). The helpers below emit
 * the right calls for either, so templates are written once.
 */
export type Runner = { owner: Address; executor: Address };

export function is7702(x: Runner): boolean {
  return x.owner.toLowerCase() === x.executor.toLowerCase();
}

/** The plan's own balance of `token` at `offset`: the Executor's balance, or Source.OWNED under 7702. */
export function heldPatch(x: Runner, offset: number, token: Address, bps = FULL): Patch {
  if (!is7702(x)) return balancePatch(offset, token, x.executor, bps);
  return { offset, source: Source.OWNED, args: encodeAbiParameters([{ type: "address" }], [token]), bps };
}

/**
 * Brings `amount` of the owner's `token` into the plan: transferFrom (one-time approval to the
 * Executor), or `allot` under 7702 (the wallet already holds it; the delegate only lets the plan
 * use what is allotted). Extra patches fill the amount word (argument 2 / 1 respectively) — pass
 * a builder so the offset matches the call.
 */
export function pullCall(x: Runner, token: Address, amount: bigint, amountPatch?: (offset: number) => Patch): Call {
  if (is7702(x)) {
    const data = encodeFunctionData({ abi: delegateAbi, functionName: "allot", args: [token, amount] });
    return amountPatch ? call(x.executor, data, amountPatch(arg(1))) : call(x.executor, data);
  }
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "transferFrom", args: [x.owner, x.executor, amount] });
  return amountPatch ? call(token, data, amountPatch(arg(2))) : call(token, data);
}

/** Reverts unless the plan holds at least `min` of `token` (a swap's output, what you receive). */
export function minHeldCall(x: Runner, token: Address, min: bigint): Call {
  return is7702(x)
    ? call(x.executor, encodeFunctionData({ abi: executorAbi, functionName: "assertMinOwned", args: [token, min] }))
    : call(x.executor, encodeFunctionData({ abi: executorAbi, functionName: "assertMinBalance", args: [token, x.executor, min] }));
}

/** The owner's live Aave v4 debt (drawn + premium) on `spoke`'s reserve, scaled by `bps`. */
export function aaveV4DebtPatch(offset: number, spoke: Address, reserveId: bigint, user: Address, bps = FULL): Patch {
  return {
    offset,
    source: Source.AAVE_V4_DEBT,
    args: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "address" }], [spoke, reserveId, user]),
    bps,
  };
}

/** `data` for Morpho.flashLoan: abi.encode(token, Call[]) consumed by onMorphoFlashLoan. */
export function encodeFlashData(token: Address, inner: Call[]): Hex {
  return encodeAbiParameters([{ type: "address" }, callsType], [token, inner]);
}

export function hashCalls(calls: Call[]): Hex {
  return keccak256(encodeAbiParameters([callsType], [calls]));
}

export function encodeExecute(calls: Call[], sweep: Address[], planHash: Hex): Hex {
  return encodeFunctionData({ abi: executorAbi, functionName: "execute", args: [calls, sweep, planHash] });
}
