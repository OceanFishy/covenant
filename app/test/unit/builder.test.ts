import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeErrorResult, getAddress, maxUint256, type PublicClient } from "viem";
import { aaveErrorsAbi, aavePoolAbi, erc20Abi, executorAbi } from "../../src/lib/abis";
import { newId } from "../../src/lib/builder/catalog";
import { compileFlow, validate } from "../../src/lib/builder/compile";
import { flowFromParam, flowToHash } from "../../src/lib/builder/storage";
import { enterFlow, partialFlow, unwindFlow } from "../../src/lib/builder/templates";
import type { Block } from "../../src/lib/builder/types";
import { enter, flashUnwind, partialUnwind } from "../../src/lib/compiler/plans";
import { arg, balancePatch } from "../../src/lib/compiler/encode";
import type { PositionView } from "../../src/lib/positions";
import { decodeRevert } from "../../src/lib/simulate";
import { AAVE_POOL, AAVE_RESERVES, MARKETS, SERIES, TOKENS } from "../../src/lib/registry";

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
    const built = await compileFlow(enterFlow(A, 10_000_000_000n, 10_000_000_000n, 3).blocks, ctx);
    const reference = enter({ market: A, owner, executor, equity: 10_000_000_000n, flash: 20_000_000_000n, minHealth: 102n * 10n ** 16n });
    expect(built.data).toBe(reference.data);
  });

  it("EIP-7702 (executor = owner): full unwind and enter match the plan compiler", async () => {
    const self = { ...ctx, executor: owner };
    const unwind = await compileFlow(unwindFlow(pos(collateral), { minReceive: 149_000_000_000n }).blocks, self);
    expect(unwind.data).toBe(flashUnwind({ market: A, owner, executor: owner, collateral, matched: collateral, syMinOut: 0n, minReceive: 149_000_000_000n }).data);
    const entry = await compileFlow(enterFlow(A, 10_000_000_000n, 10_000_000_000n, 3).blocks, self);
    expect(entry.data).toBe(enter({ market: A, owner, executor: owner, equity: 10_000_000_000n, flash: 20_000_000_000n, minHealth: 102n * 10n ** 16n }).data);
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

describe("Aave blocks", () => {
  const r = AAVE_RESERVES[0]; // USDC
  type NoId = Block extends infer B ? (B extends Block ? Omit<B, "id"> : never) : never;
  const blocks = (...list: NoId[]) => list.map((x, i) => ({ ...x, id: `a${i}` }) as Block);

  it("repay all patches the owner's live variable debt, never max (Aave rejects max on behalf of others)", async () => {
    const plan = await compileFlow(blocks({ type: "aaveRepay", asset: r.asset, amount: { kind: "allDebt" } }), ctx);
    const repay = plan.calls[1];
    expect(repay.target).toBe(AAVE_POOL);
    expect(decodeFunctionData({ abi: aavePoolAbi, data: repay.data }).args).toEqual([r.asset, 0n, 2n, owner]);
    expect(repay.patches).toEqual([balancePatch(arg(1), r.debtToken.address, owner)]);
  });

  it("withdraw all pulls the owner's whole aToken balance, then withdraws all the Executor holds", async () => {
    const plan = await compileFlow(blocks({ type: "aaveWithdraw", asset: r.asset, amount: { kind: "supplied" } }), ctx);
    const [pull, withdraw] = plan.calls;
    expect(pull.target).toBe(r.aToken.address);
    expect(decodeFunctionData({ abi: erc20Abi, data: pull.data }).args).toEqual([owner, executor, 0n]);
    expect(pull.patches).toEqual([balancePatch(arg(2), r.aToken.address, owner)]);
    expect(decodeFunctionData({ abi: aavePoolAbi, data: withdraw.data }).args).toEqual([r.asset, maxUint256, executor]);
  });

  it("a Morpho flash loan can be sized to the Aave debt, and the plan reports the Aave account", async () => {
    const plan = await compileFlow(
      blocks({
        type: "flashLoan",
        token: r.asset,
        amount: { kind: "aaveDebt", asset: r.asset, bps: 10_010 },
        children: blocks({ type: "aaveRepay", asset: r.asset, amount: { kind: "allDebt" } }),
      }),
      ctx,
    );
    expect(plan.calls[0].patches).toEqual([balancePatch(arg(1), r.debtToken.address, owner, 10_010)]);
    expect(plan.aave).toBe(true);
    expect(plan.tokens).toEqual(expect.arrayContaining([r.aToken.address, r.debtToken.address]));
  });

  it("only USDC and USDT reserves are accepted", () => {
    const bad = blocks({ type: "aaveSupply", asset: TOKENS.USD3.address, amount: { kind: "balance" } });
    expect(validate(bad)[0]).toMatchObject({ level: "error", message: "only USDC and USDT are supported on Aave" });
  });
});

it("explains Aave reverts a plan can fix", () => {
  const reason = encodeErrorResult({ abi: aaveErrorsAbi, errorName: "InsufficientBorrowAllowance", args: [executor, 0n, 5n] });
  const err = encodeErrorResult({ abi: executorAbi, errorName: "CallFailed", args: [0n, AAVE_POOL, reason] });
  expect(decodeRevert(err)).toContain("Setup → Aave");
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
