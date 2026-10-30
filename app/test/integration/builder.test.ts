// Builder flows on a mainnet fork: the "move loop A → B" template (no Pendle step), a flow
// assembled block by block, and a max unwind that drains 3Jane's USDC reserve.
// Run from app/: MAINNET_RPC_URL=... pnpm test:integration
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeFunctionData, getAddress, maxUint256, parseAbi, type Address, type PublicClient, type WalletClient } from "viem";
import { erc20Abi, morphoAbi, usd3Abi } from "../../src/lib/abis";
import { newId } from "../../src/lib/builder/catalog";
import { compileFlow } from "../../src/lib/builder/compile";
import { maxUnwindFlow, moveFlow } from "../../src/lib/builder/templates";
import type { Block } from "../../src/lib/builder/types";
import { deployData, setupSteps } from "../../src/lib/executor";
import { capToReserve, unwindMode } from "../../src/lib/planner";
import { readPosition } from "../../src/lib/positions";
import { MARKETS, MORPHO, SERIES, TOKENS } from "../../src/lib/registry";
import { simulatePlan } from "../../src/lib/simulate";
import { clients, impersonate, setTokenBalance, startForkNode } from "./forkNode";

const [A, B] = MARKETS;
const BORROWER = getAddress("0xa95d6286853320487cB0897304ad8A210F8D12c4");
const BIG_BORROWER = getAddress("0x7A27F9586d0895F045b80B3Fb1D9D6eF4D54e9Bc"); // ~1.26M PT on market B
const LENDER = getAddress("0x000000000000000000000000000000000000beef");
const quotes = { aggregator: "kyber" as const, zeroXBase: "", kyberBase: "https://aggregator-api.kyberswap.com", headers: { "x-client-id": "covenant" } };

let node: { url: string; stop: () => void };
let client: PublicClient;
let walletFor: (a: Address) => WalletClient;

beforeAll(async () => {
  node = await startForkNode(8550);
  ({ client, walletFor } = clients(node.url));
}, 180_000);
afterAll(() => node?.stop());

async function sendAs(from: Address, tx: { to?: Address; data: `0x${string}` }) {
  const hash = await walletFor(from).sendTransaction({ account: from, chain: null, to: tx.to, data: tx.data });
  const receipt = await client.waitForTransactionReceipt({ hash });
  expect(receipt.status).toBe("success");
  return receipt;
}

async function setup(owner: Address): Promise<Address> {
  await impersonate(client, owner);
  const executor = getAddress((await sendAs(owner, { data: await deployData(owner) })).contractAddress!);
  for (const s of setupSteps(executor)) if (!(await s.isDone(client, owner, executor))) await sendAs(owner, s.tx);
  return executor;
}

const supplyAbi = parseAbi([
  "function supply((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams, uint256 assets, uint256 shares, address onBehalf, bytes data) returns (uint256, uint256)",
]);
const params = (m: (typeof MARKETS)[number]) => ({ loanToken: m.loanToken, collateralToken: m.collateralToken, oracle: m.oracle, irm: m.irm, lltv: m.lltv });

describe("builder flows on a mainnet fork", () => {
  it("moves a real loop from market A to market B in one transaction", async () => {
    const before = await readPosition(client, A, BORROWER);
    expect(before.borrowShares).toBeGreaterThan(0n);

    // Market B is ~100% utilized on mainnet: add lender liquidity on the fork so the borrow fits.
    await impersonate(client, LENDER);
    const liquidity = before.debt * 2n;
    await setTokenBalance(client, A.loanToken, LENDER, liquidity);
    await sendAs(LENDER, { to: A.loanToken, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [MORPHO, maxUint256] }) });
    await sendAs(LENDER, {
      to: MORPHO,
      data: encodeFunctionData({ abi: supplyAbi, functionName: "supply", args: [params(B), liquidity, 0n, LENDER, "0x"] }),
    });

    const executor = await setup(BORROWER);
    const flow = moveFlow(before, B);
    const plan = await compileFlow(flow.blocks, { owner: BORROWER, executor, client, quotes, headroomBps: 10 });
    expect(plan.markets!.map((m) => m.key)).toEqual([A.key, B.key]);
    const sim = await simulatePlan(client, plan);
    if (!sim.ok) throw new Error(sim.error);
    expect(sim.positions.find((p) => p.market.key === A.key)!.borrowShares).toBe(0n);

    await sendAs(BORROWER, { to: executor, data: plan.data });
    const a = await readPosition(client, A, BORROWER);
    const b = await readPosition(client, B, BORROWER);
    expect(a.collateral).toBe(0n);
    expect(a.borrowShares).toBe(0n);
    expect(b.collateral).toBe(before.collateral);
    // Debt on B = borrowed amount (debt + 0.05% buffer); the unused buffer came back as USDC.
    expect(b.debt).toBeGreaterThanOrEqual(before.debt);
    expect(b.debt).toBeLessThan((before.debt * 10_010n) / 10_000n);
    expect(await client.readContract({ address: A.loanToken, abi: erc20Abi, functionName: "balanceOf", args: [executor] })).toBe(0n);
  }, 300_000);

  it("runs a flow assembled block by block (unwind on market B)", async () => {
    const pos = await readPosition(client, B, BORROWER); // the loop moved above
    expect(pos.collateral).toBeGreaterThan(0n);
    await setTokenBalance(client, SERIES["PT-USD3-17DEC2026"].yt, BORROWER, pos.collateral);
    const executor = await setup(BORROWER);
    const s = "PT-USD3-17DEC2026";
    const ytAmount = (Number(pos.collateral) / 1e6).toFixed(6);
    const blocks: Block[] = [
      { id: newId(), type: "accrueInterest", market: B.key },
      { id: newId(), type: "pull", token: SERIES[s].yt, amount: { kind: "fixed", value: ytAmount } },
      {
        id: newId(),
        type: "flashLoan",
        token: B.loanToken,
        amount: { kind: "debt", market: B.key, bps: 10_001 },
        children: [
          { id: newId(), type: "repay", market: B.key, amount: { kind: "allShares" } },
          { id: newId(), type: "withdrawCollateral", market: B.key, amount: { kind: "collateral" } },
          { id: newId(), type: "redeemPY", series: s, amount: { kind: "balance" } },
          { id: newId(), type: "redeemSY", series: s, tokenOut: B.loanToken, minOut: { kind: "fixed", value: "0" } },
        ],
      },
      { id: newId(), type: "guardNoDebt", market: B.key },
    ];
    const plan = await compileFlow(blocks, { owner: BORROWER, executor, client, quotes, headroomBps: 10 });
    const sim = await simulatePlan(client, plan);
    if (!sim.ok) throw new Error(sim.error);
    await sendAs(BORROWER, { to: executor, data: plan.data });
    const [, borrowShares, collateral] = await client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "position", args: [B.id, BORROWER] });
    expect({ borrowShares, collateral }).toEqual({ borrowShares: 0n, collateral: 0n });
  }, 300_000);

  // Last: it leaves the fork's 3Jane reserve empty.
  it("max unwind redeems as much PT as 3Jane's USDC reserve pays out, draining it", async () => {
    const s = SERIES["PT-USD3-17DEC2026"];
    const pos0 = await readPosition(client, B, BIG_BORROWER);
    expect(pos0.borrowShares).toBeGreaterThan(0n);
    await setTokenBalance(client, s.yt, BIG_BORROWER, pos0.collateral); // YT is not the limit here

    // Shrink the reserve to ~40% of the collateral: SY-USD3 redeems the rest of its USD3 liquidity.
    const usd3 = TOKENS.USD3.address;
    const redeemAbi = parseAbi([
      "function redeem(uint256 shares, address receiver, address owner) returns (uint256)",
      "function convertToShares(uint256 assets) view returns (uint256)",
    ]);
    const maxRedeem = () => client.readContract({ address: usd3, abi: usd3Abi, functionName: "maxRedeem", args: [s.sy] });
    const keep = await client.readContract({ address: usd3, abi: redeemAbi, functionName: "convertToShares", args: [(pos0.collateral * 4n) / 10n] });
    await impersonate(client, s.sy);
    await sendAs(s.sy, { to: usd3, data: encodeFunctionData({ abi: redeemAbi, functionName: "redeem", args: [(await maxRedeem()) - keep, LENDER, s.sy] }) });

    const pos = await readPosition(client, B, BIG_BORROWER);
    const capped = await capToReserve(client, pos);
    expect(capped.matched).toBeLessThan(pos.matched);
    expect(unwindMode(capped)).toBe("partial"); // ~40% of the PT can't repay ~80% LTV of debt

    const executor = await setup(BIG_BORROWER);
    const plan = await compileFlow(maxUnwindFlow(capped).blocks, { owner: BIG_BORROWER, executor, client, quotes, headroomBps: 10 });
    const sim = await simulatePlan(client, plan);
    if (!sim.ok) throw new Error(sim.error);
    await sendAs(BIG_BORROWER, { to: executor, data: plan.data });

    // Reserve drained (from ~420k USD3 to dust: rounding plus interest accrued since sizing) and
    // exactly the capped PT left the position.
    expect(await maxRedeem()).toBeLessThan(1_000n);
    const after = await readPosition(client, B, BIG_BORROWER);
    expect(after.collateral).toBe(pos.collateral - capped.matched);
    expect(after.debt).toBeLessThan((pos.debt * 7n) / 10n);
    expect(after.healthFactor).toBeGreaterThan(pos.healthFactor);
  }, 300_000);
});
