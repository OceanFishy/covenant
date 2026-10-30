import { encodeAbiParameters, encodeFunctionData, keccak256, type Address, type Hex } from "viem";
import { executorAbi } from "../abis";
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

export function balancePatch(offset: number, token: Address, account: Address): Patch {
  return {
    offset,
    source: Source.BALANCE,
    args: encodeAbiParameters([{ type: "address" }, { type: "address" }], [token, account]),
    bps: FULL,
  };
}

export function morphoPatch(offset: number, source: Source, id: Hex, user: Address, bps = FULL): Patch {
  return { offset, source, args: encodeAbiParameters([{ type: "bytes32" }, { type: "address" }], [id, user]), bps };
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
