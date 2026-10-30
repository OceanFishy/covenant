import { describe, expect, it } from "vitest";
import { getAddress, type PublicClient } from "viem";
import { newId } from "../../src/lib/builder/catalog";
import { compileFlow, validate } from "../../src/lib/builder/compile";
import { flowFromParam, flowToHash } from "../../src/lib/builder/storage";
import { enterFlow, partialFlow, unwindFlow } from "../../src/lib/builder/templates";
import type { Block } from "../../src/lib/builder/types";
import { enter, flashUnwind, partialUnwind } from "../../src/lib/compiler/plans";
import type { PositionView } from "../../src/lib/positions";
import { MARKETS, SERIES, TOKENS } from "../../src/lib/registry";

const [A] = MARKETS;
const owner = getAddress("0x00000000000000000000000000000000000000aa");
const executor = getAddress("0x00000000000000000000000000000000000000ee");
// Templates without swaps or debt-based swap amounts never touch the client.
const ctx = { owner, executor, client: {} as PublicClient, quotes: { aggregator: "kyber" as const, zeroXBase: "", kyberBase: "" }, headroomBps: 10 };

const collateral = 597_246_159_092n;
const pos = (matched: bigint): PositionView =>
  ({ market: A, collateral, matched, debt: 447_000_000_000n, ytBalance: matched }) as PositionView;

describe("builder templates compile to the same transaction as the tested plan compiler", () => {
  it("full unwind", async () => {
    const built = await compileFlow(unwindFlow(pos(collateral), { syMinOut: 590_000_000_000n, minReceive: 149_000_000_000n }).blocks, ctx);
    const reference = flashUnwind({ market: A, owner, executor, collateral, matched: collateral, syMinOut: 590_000_000_000n, minReceive: 149_000_000_000n });
    expect(built.data).toBe(reference.data);
    expect(built.planHash).toBe(reference.planHash);
  });

  it("deleverage (YT covers 90%)", async () => {
    const matched = (collateral * 9n) / 10n;
    const built = await compileFlow(unwindFlow(pos(matched)).blocks, ctx);
    const reference = flashUnwind({ market: A, owner, executor, collateral, matched, syMinOut: 0n, minReceive: 0n });
    expect(built.data).toBe(reference.data);
  });

  it("partial unwind", async () => {
    const matched = (collateral * 4n) / 10n;
    const built = await compileFlow(partialFlow(pos(matched), 230_000_000_000n, "1.1").blocks, ctx);
    const reference = partialUnwind({ market: A, owner, executor, matched, repayAssets: 230_000_000_000n, minHealth: 11n * 10n ** 17n });
    expect(built.data).toBe(reference.data);
  });

  it("enter", async () => {
    const built = await compileFlow(enterFlow(A, 10_000_000_000n, 3).blocks, ctx);
    const reference = enter({ market: A, owner, executor, equity: 10_000_000_000n, flash: 20_000_000_000n, minHealth: 102n * 10n ** 16n });
    expect(built.data).toBe(reference.data);
  });
});

describe("validate", () => {
  type NoId = Block extends infer B ? (B extends Block ? Omit<B, "id"> : never) : never;
  const b = (x: NoId) => ({ ...x, id: newId() }) as Block;

  it("requires blocks inside a flash loan and forbids nesting", () => {
    const empty = b({ type: "flashLoan", token: TOKENS.USDC.address, amount: { kind: "fixed", value: "1" }, children: [] });
    expect(validate([empty]).map((i) => i.message)).toContain("drop the blocks that use the loan inside the flash loan");
    const nested = b({ type: "flashLoan", token: TOKENS.USDC.address, amount: { kind: "fixed", value: "1" }, children: [empty] });
    expect(validate([nested]).some((i) => i.message === "flash loans can't be nested")).toBe(true);
  });

  it("rejects swapping Pendle assets", () => {
    const s = b({ type: "swap", sell: SERIES["PT-USD3-17DEC2026"].pt, buy: TOKENS.USDC.address, mode: "exactIn", amount: { kind: "fixed", value: "1" } });
    expect(validate([s])[0]).toMatchObject({ level: "error", message: expect.stringContaining("Pendle assets are never traded") });
  });

  it("warns when PT is redeemed without YT reaching the Executor first", () => {
    const r = b({ type: "redeemPY", series: "PT-USD3-17DEC2026", amount: { kind: "balance" } });
    expect(validate([r])[0].level).toBe("warning");
    const pull = b({ type: "pull", token: SERIES["PT-USD3-17DEC2026"].yt, amount: { kind: "fixed", value: "10" } });
    expect(validate([pull, r])).toEqual([]);
  });

  it("flags bad amounts", () => {
    const pull = b({ type: "pull", token: TOKENS.USDC.address, amount: { kind: "fixed", value: "abc" } });
    expect(validate([pull])[0].message).toContain("not a valid amount");
  });
});

it("share links round-trip a flow", () => {
  const flow = unwindFlow(pos(collateral));
  const hash = flowToHash(flow);
  expect(hash.startsWith("#/builder?flow=")).toBe(true);
  expect(flowFromParam(new URLSearchParams(hash.split("?")[1]).get("flow")!)).toEqual(flow);
});

it("palette search ranks title matches first", async () => {
  const { searchCatalog } = await import("../../src/lib/builder/catalog");
  expect(searchCatalog("redeem sy")[0].type).toBe("redeemSY");
  expect(searchCatalog("redeem pt")[0].type).toBe("redeemPY");
  expect(searchCatalog("no debt")[0].type).toBe("guardNoDebt");
  expect(searchCatalog("withdraw collateral")[0].type).toBe("withdrawCollateral");
  expect(searchCatalog("accrue")[0].type).toBe("accrueInterest");
  expect(searchCatalog("pull")[0].type).toBe("pull");
  expect(searchCatalog("repay")[0].type).toBe("repay");
});

it("explains a flash loan the plan couldn't repay", async () => {
  const { encodeErrorResult } = await import("viem");
  const { executorAbi } = await import("../../src/lib/abis");
  const { MORPHO } = await import("../../src/lib/registry");
  const { decodeRevert } = await import("../../src/lib/simulate");
  const reason = encodeErrorResult({ abi: [{ type: "error", name: "Error", inputs: [{ type: "string" }] }], errorName: "Error", args: ["transferFrom reverted"] });
  const err = encodeErrorResult({ abi: executorAbi, errorName: "CallFailed", args: [2n, MORPHO, reason] });
  expect(decodeRevert(err)).toContain("couldn't repay the flash loan");
});
