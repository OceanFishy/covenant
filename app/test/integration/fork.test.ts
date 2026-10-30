// End-to-end check of the TypeScript plan compiler against a local mainnet fork:
// deploy + verify the Executor, one-time setup, simulate, execute, revoke.
// Run from app/: MAINNET_RPC_URL=... pnpm test:integration
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAddress, type Address, type PublicClient, type WalletClient } from "viem";
import { erc20Abi, morphoAbi } from "../../src/lib/abis";
import { readAccess } from "../../src/lib/access";
import type { Plan } from "../../src/lib/compiler/types";
import { deployData, setupSteps, verifyExecutor } from "../../src/lib/executor";
import { buildUnwind, unwindMode } from "../../src/lib/planner";
import { readPosition } from "../../src/lib/positions";
import { HEADROOM_LADDER_BPS, type QuoteConfig } from "../../src/lib/quotes";
import { MARKETS, MORPHO, type Market } from "../../src/lib/registry";
import { isSwapFailure, simulatePlan } from "../../src/lib/simulate";
import { clients, impersonate, setTokenBalance, startForkNode } from "./forkNode";

const [MARKET_A, MARKET_B, MARKET_USDT] = MARKETS;
const BORROWER_A = getAddress("0xa95d6286853320487cB0897304ad8A210F8D12c4");
const BORROWER_B = getAddress("0x7A27F9586d0895F045b80B3Fb1D9D6eF4D54e9Bc"); // also in the USDT market

const quotes: QuoteConfig = process.env.ZEROX_API_KEY
  ? { aggregator: "0x", zeroXBase: "https://api.0x.org", kyberBase: "", headers: { "0x-api-key": process.env.ZEROX_API_KEY, "0x-version": "v2" } }
  : { aggregator: "kyber", zeroXBase: "", kyberBase: "https://aggregator-api.kyberswap.com", headers: { "x-client-id": "covenant" } };

let node: { url: string; stop: () => void };
let client: PublicClient;
let walletFor: (a: Address) => WalletClient;

beforeAll(async () => {
  // FORK_URL reuses an already running `hardhat node --fork` (for debugging).
  node = process.env.FORK_URL ? { url: process.env.FORK_URL, stop: () => {} } : await startForkNode(8546);
  ({ client, walletFor } = clients(node.url));
}, 180_000);

afterAll(() => node?.stop());

async function sendAs(from: Address, tx: { to?: Address; data: `0x${string}` }) {
  const hash = await walletFor(from).sendTransaction({ account: from, chain: null, to: tx.to, data: tx.data });
  const receipt = await client.waitForTransactionReceipt({ hash });
  expect(receipt.status).toBe("success");
  return receipt;
}

/** What the app does on first use: deploy, verify, authorize Morpho, approve YT. */
async function setup(owner: Address): Promise<Address> {
  await impersonate(client, owner);
  const receipt = await sendAs(owner, { data: deployData(owner) });
  const executor = getAddress(receipt.contractAddress!);
  expect(await verifyExecutor(client, executor, owner)).toEqual({ ok: true });
  for (const step of setupSteps(executor)) {
    if (!(await step.isDone(client, owner, executor))) await sendAs(owner, step.tx);
    expect(await step.isDone(client, owner, executor)).toBe(true);
  }
  return executor;
}

async function giveYt(m: Market, owner: Address, amount: bigint) {
  await setTokenBalance(client, m.series.yt, owner, amount);
}

/**
 * What the Review screen does: build → simulate (re-quoting on an aggregator failure) → rebuild
 * with the same route plus a minReceive guard 0.5% under the simulated amount → simulate → send.
 */
async function unwindAndExecute(m: Market, owner: Address, executor: Address) {
  const pos = await readPosition(client, m, owner);
  let plan: Plan | undefined;
  for (const headroomBps of HEADROOM_LADDER_BPS) {
    const draft = await buildUnwind(client, pos, { owner, executor, quotes, headroomBps, minReceive: 0n });
    const sim = await simulatePlan(client, draft);
    if (!sim.ok) {
      if (isSwapFailure(sim)) continue;
      throw new Error(`simulation failed: ${sim.error}`);
    }
    const received = sim.changes.find((c) => c.token === m.series.tokenOut)!;
    const minReceive = ((received.after - received.before) * 995n) / 1000n;
    const final = await buildUnwind(client, pos, { owner, executor, quotes, headroomBps, minReceive, reuseSwap: draft.swap });
    const finalSim = await simulatePlan(client, final);
    if (finalSim.ok) {
      plan = final;
      break;
    }
    if (!isSwapFailure(finalSim)) throw new Error(`final simulation failed: ${finalSim.error}`);
  }
  expect(plan, "no plan simulated successfully").toBeDefined();
  await sendAs(owner, { to: executor, data: plan!.data });
  return { pos, plan: plan! };
}

async function position(m: Market, owner: Address) {
  const [, borrowShares, collateral] = await client.readContract({
    address: MORPHO,
    abi: morphoAbi,
    functionName: "position",
    args: [m.id, owner],
  });
  return { borrowShares, collateral };
}

describe("TS compiler on a mainnet fork", () => {
  it("full flash unwind of a real market A position", async () => {
    const pos = await readPosition(client, MARKET_A, BORROWER_A);
    expect(pos.borrowShares).toBeGreaterThan(0n);
    const executor = await setup(BORROWER_A);
    await giveYt(MARKET_A, BORROWER_A, pos.collateral);
    const usdc0 = await client.readContract({ address: MARKET_A.loanToken, abi: erc20Abi, functionName: "balanceOf", args: [BORROWER_A] });

    const { plan } = await unwindAndExecute(MARKET_A, BORROWER_A, executor);
    expect(plan.kind).toBe("unwind");

    expect(await position(MARKET_A, BORROWER_A)).toEqual({ borrowShares: 0n, collateral: 0n });
    const usdc1 = await client.readContract({ address: MARKET_A.loanToken, abi: erc20Abi, functionName: "balanceOf", args: [BORROWER_A] });
    expect(usdc1 - usdc0).toBeGreaterThan(100_000n * 10n ** 6n);
  }, 300_000);

  it("deleverage (YT covers 90% of the PT) leaves unlevered PT in the wallet", async () => {
    const executor = await setup(BORROWER_B);
    const pos0 = await readPosition(client, MARKET_B, BORROWER_B);
    await giveYt(MARKET_B, BORROWER_B, (pos0.collateral * 90n) / 100n);
    const pos = await readPosition(client, MARKET_B, BORROWER_B);
    expect(unwindMode(pos)).toBe("deleverage");
    const pt0 = await client.readContract({ address: MARKET_B.series.pt, abi: erc20Abi, functionName: "balanceOf", args: [BORROWER_B] });

    const { plan } = await unwindAndExecute(MARKET_B, BORROWER_B, executor);
    expect(plan.kind).toBe("deleverage");

    expect(await position(MARKET_B, BORROWER_B)).toEqual({ borrowShares: 0n, collateral: 0n });
    const pt1 = await client.readContract({ address: MARKET_B.series.pt, abi: erc20Abi, functionName: "balanceOf", args: [BORROWER_B] });
    expect(pt1 - pt0).toBe(pos.collateral - pos.matched);
  }, 300_000);

  it("USDT market: flash unwind with a live aggregator swap", async () => {
    // Live routes are priced on the latest mainnet state: use a fork started just now so the
    // pools match (Hardhat 3's node has no hardhat_reset).
    const fresh = await startForkNode(8549);
    const saved = { client, walletFor };
    ({ client, walletFor } = clients(fresh.url));
    try {
      const executor = await setup(BORROWER_B);
      const pos0 = await readPosition(client, MARKET_USDT, BORROWER_B);
      expect(pos0.borrowShares).toBeGreaterThan(0n);
      await giveYt(MARKET_USDT, BORROWER_B, pos0.collateral);

      const { plan } = await unwindAndExecute(MARKET_USDT, BORROWER_B, executor);
      expect(plan.kind).toBe("unwind");
      expect(await position(MARKET_USDT, BORROWER_B)).toEqual({ borrowShares: 0n, collateral: 0n });
    } finally {
      ({ client, walletFor } = saved);
      fresh.stop();
    }
  }, 300_000);

  it("partial unwind (YT covers 40%) reduces debt and raises health", async () => {
    // A different real market B borrower (B's first one was fully unwound above).
    const other = getAddress("0xc7b0B03D21b9d50FE2f21493d882CABb2B7C781e");
    const pos0 = await readPosition(client, MARKET_B, other);
    if (pos0.borrowShares === 0n) return; // reference position gone
    const executor = await setup(other);
    await giveYt(MARKET_B, other, (pos0.collateral * 40n) / 100n);
    const pos = await readPosition(client, MARKET_B, other);
    expect(unwindMode(pos)).toBe("partial");

    const { plan } = await unwindAndExecute(MARKET_B, other, executor);
    expect(plan.kind).toBe("partial");
    const after = await readPosition(client, MARKET_B, other);
    expect(after.collateral).toBe(pos.collateral - pos.matched);
    expect(after.debt).toBeLessThan(pos.debt);
    expect(after.healthFactor).toBeGreaterThan(pos.healthFactor);
  }, 300_000);

  it("refuses a look-alike Executor", async () => {
    const owner = BORROWER_A;
    const real = await setup(owner);
    expect((await verifyExecutor(client, MORPHO, owner)).ok).toBe(false); // wrong bytecode
    expect(await verifyExecutor(client, real, BORROWER_B)).toMatchObject({ ok: false }); // wrong owner
  }, 300_000);

  it("revoke removes every permission, sent straight from the wallet", async () => {
    const owner = BORROWER_A;
    const executor = await setup(owner);
    const perms = await readAccess(client, owner, [executor]);
    expect(perms.map((p) => p.kind).sort()).toEqual(["allowance", "allowance", "morpho"]);
    for (const p of perms) await sendAs(owner, p.revoke);
    expect(await readAccess(client, owner, [executor])).toEqual([]);
  }, 300_000);
});
