// End-to-end check of the TypeScript plan compiler against a local mainnet fork:
// deploy + verify the Executor, one-time setup, simulate, execute, revoke.
// Run from app/: MAINNET_RPC_URL=... pnpm test:integration
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { encodeFunctionData, getAddress, maxUint256, parseAbi, type Address, type PublicClient, type WalletClient } from "viem";
import { erc20Abi, morphoAbi } from "../../src/lib/abis";
import { readAccess } from "../../src/lib/access";
import type { Plan } from "../../src/lib/compiler/types";
import { DELEGATE } from "../../src/lib/abis";
import { deployData, deployDelegateTx, initializeTx, readDelegation, setupSteps, verifyExecutor } from "../../src/lib/executor";
import { buildEnter, buildUnwind, unwindMode } from "../../src/lib/planner";
import { readPosition } from "../../src/lib/positions";
import { HEADROOM_LADDER_BPS, type QuoteConfig } from "../../src/lib/quotes";
import { MARKETS, MORPHO, TOKENS, TRACKED_TOKENS, type Market } from "../../src/lib/registry";
import { isSwapFailure, simulatePlan } from "../../src/lib/simulate";
import { clients, impersonate, setTokenBalance, startForkNode } from "./forkNode";

const [MARKET_A, MARKET_B, MARKET_USDT, MARKET_REUSD] = MARKETS;
const BORROWER_A = getAddress("0xa95d6286853320487cB0897304ad8A210F8D12c4");
const BORROWER_B = getAddress("0x7A27F9586d0895F045b80B3Fb1D9D6eF4D54e9Bc"); // also in the USDT market
// PT-reUSD / USDC, 2026-10-29: ~531k PT / ~456k USDC and ~3.03M PT / ~2.60M USDC.
const REUSD_BORROWERS = [getAddress("0x0cA6CAdb6a8cA4199788b9a060C3285Fe7B897Fd"), getAddress("0xf991AcD672d5B344aFCB29931Af6401ed32e2691")];
const LENDER = getAddress("0x000000000000000000000000000000000000beef");
const supplyAbi = parseAbi([
  "function supply((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams, uint256 assets, uint256 shares, address onBehalf, bytes data) returns (uint256, uint256)",
]);

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
  const receipt = await sendAs(owner, { data: await deployData(owner) });
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
  let lastError = "";
  for (const headroomBps of HEADROOM_LADDER_BPS) {
    const draft = await buildUnwind(client, pos, { owner, executor, quotes, headroomBps, minReceive: 0n });
    const sim = await simulatePlan(client, draft);
    if (!sim.ok) {
      lastError = sim.error;
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
    lastError = finalSim.error;
    if (!isSwapFailure(finalSim)) throw new Error(`final simulation failed: ${finalSim.error}`);
  }
  expect(plan, `no plan simulated successfully; last: ${lastError}`).toBeDefined();
  await sendAs(owner, { to: executor, data: plan!.data });
  return { pos, plan: plan! };
}

async function balanceOf(token: Address, who: Address) {
  return client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] });
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
    // YT-USD3, USDC, YT-reUSD and reUSD approvals, plus Morpho authorization.
    expect(perms.map((p) => p.kind).sort()).toEqual(["allowance", "allowance", "allowance", "allowance", "morpho"]);
    for (const p of perms) await sendAs(owner, p.revoke);
    expect(await readAccess(client, owner, [executor])).toEqual([]);
  }, 300_000);
});

describe("PT-reUSD / USDC on a fresh mainnet fork per test (live aggregator routes)", () => {
  let fresh: { url: string; stop: () => void } | undefined;
  let saved: { client: PublicClient; walletFor: (a: Address) => WalletClient };
  let port = 8571; // a new port each time (the previous node may still hold its); 8552 is aave.test's
  // Routes are priced on the latest mainnet state, so each test forks it anew: a fork pinned a
  // minute earlier (or whose pools an earlier test moved) drifts from the quoted route.
  beforeEach(async () => {
    fresh = await startForkNode(port++);
    saved = { client, walletFor };
    ({ client, walletFor } = clients(fresh.url));
  }, 180_000);
  afterEach(() => {
    ({ client, walletFor } = saved);
    fresh?.stop();
  });

  it("enters 3× with reUSD equity: flash sized from its NAV, flash USDC swapped to reUSD", async () => {
    const owner = getAddress("0x00000000000000000000000000000000000ca5e1");
    const equity = 10_000n * 10n ** 18n;
    // The market is ~100% utilized on mainnet: add lender liquidity so the borrow fits.
    await impersonate(client, LENDER);
    const liquidity = 100_000n * 10n ** 6n;
    await setTokenBalance(client, TOKENS.USDC.address, LENDER, liquidity);
    await sendAs(LENDER, { to: TOKENS.USDC.address, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [MORPHO, maxUint256] }) });
    const m = MARKET_REUSD;
    const marketParams = { loanToken: m.loanToken, collateralToken: m.collateralToken, oracle: m.oracle, irm: m.irm, lltv: m.lltv };
    await sendAs(LENDER, { to: MORPHO, data: encodeFunctionData({ abi: supplyAbi, functionName: "supply", args: [marketParams, liquidity, 0n, LENDER, "0x"] }) });

    const executor = await setup(owner);
    await setTokenBalance(client, TOKENS.reUSD.address, owner, equity);
    // Like the Review screen: a fresh quote when the route fails in simulation (max 3).
    let plan: Plan | undefined;
    let lastError = "";
    for (let i = 0; i < 3 && !plan; i++) {
      const draft = await buildEnter(client, m, { owner, executor, quotes, headroomBps: 10, minReceive: 0n, equity, leverageBps: 30_000n, minHealth: 102n * 10n ** 16n });
      // 10k reUSD ≈ 11.1k USDC at NAV → flash ≈ 22.2k USDC, not 2e22 (18dp equity read as USDC).
      expect(draft.swap!.amountIn).toBeGreaterThan(21_000n * 10n ** 6n);
      expect(draft.swap!.amountIn).toBeLessThan(23_000n * 10n ** 6n);
      const sim = await simulatePlan(client, draft);
      if (sim.ok) plan = draft;
      else if (isSwapFailure(sim)) lastError = sim.error;
      else throw new Error(sim.error);
    }
    expect(plan, `no entry simulated successfully; last: ${lastError}`).toBeDefined();
    await sendAs(owner, { to: executor, data: plan!.data });

    const pos = await readPosition(client, m, owner);
    expect(pos.ytBalance).toBe(pos.collateral);
    expect(pos.healthFactor).toBeGreaterThanOrEqual(102n * 10n ** 16n);
    expect(await balanceOf(TOKENS.reUSD.address, owner)).toBe(0n);
  }, 300_000);

  it("full flash unwind sells just enough reUSD for the debt and returns the rest as reUSD", async () => {
    const owner = REUSD_BORROWERS[0];
    const pos0 = await readPosition(client, MARKET_REUSD, owner);
    if (pos0.borrowShares === 0n) return; // reference position gone
    const executor = await setup(owner);
    await giveYt(MARKET_REUSD, owner, pos0.collateral);
    // valueMatched is in USDC (6dp) although proceeds are reUSD (18dp): ~PT × NAV/index − 1%.
    const full = await readPosition(client, MARKET_REUSD, owner);
    expect(full.valueMatched).toBeLessThan(full.collateral);
    expect(full.valueMatched).toBeGreaterThan((full.collateral * 97n) / 100n);
    const reusd0 = await balanceOf(TOKENS.reUSD.address, owner);

    const { plan, pos } = await unwindAndExecute(MARKET_REUSD, owner, executor);
    expect(plan.kind).toBe("unwind");
    expect(plan.swap!.sellToken).toBe(TOKENS.reUSD.address);
    expect(await position(MARKET_REUSD, owner)).toEqual({ borrowShares: 0n, collateral: 0n });
    // Equity ≈ collateral − debt in USDC, paid in reUSD (~1.11 USDC each): fewer reUSD than USDC.
    const reusd = (await balanceOf(TOKENS.reUSD.address, owner)) - reusd0;
    const equityUsdc = pos.collateral - pos.debt;
    expect(reusd).toBeGreaterThan((equityUsdc * 10n ** 12n * 80n) / 100n);
    expect(reusd).toBeLessThan(equityUsdc * 10n ** 12n);
  }, 300_000);

  it("partial unwind (YT covers 40%) repays USDC from sold reUSD and raises health", async () => {
    const owner = REUSD_BORROWERS[1];
    const pos0 = await readPosition(client, MARKET_REUSD, owner);
    if (pos0.borrowShares === 0n) return; // reference position gone
    const executor = await setup(owner);
    await giveYt(MARKET_REUSD, owner, (pos0.collateral * 40n) / 100n);
    const pos = await readPosition(client, MARKET_REUSD, owner);
    expect(unwindMode(pos)).toBe("partial");

    const { plan } = await unwindAndExecute(MARKET_REUSD, owner, executor);
    expect(plan.kind).toBe("partial");
    const after = await readPosition(client, MARKET_REUSD, owner);
    expect(after.collateral).toBe(pos.collateral - pos.matched);
    // Repays ~98.5% of the matched PT's USDC value.
    expect(pos.debt - after.debt).toBeGreaterThan((pos.matched * 95n) / 100n);
    expect(after.healthFactor).toBeGreaterThan(pos.healthFactor);
  }, 300_000);
});

describe("EIP-7702 mode: the delegated EOA runs the TS-compiled plans itself", () => {
  let fresh: { url: string; stop: () => void };
  let saved: { client: PublicClient; walletFor: (a: Address) => WalletClient };
  beforeAll(async () => {
    fresh = await startForkNode(8581);
    saved = { client, walletFor };
    ({ client, walletFor } = clients(fresh.url));
  }, 180_000);
  afterAll(() => {
    ({ client, walletFor } = saved);
    fresh?.stop();
  });

  it("deploys the shared delegate at its CREATE2 address, delegates, initializes and unwinds a real loop", async () => {
    // Anyone deploys the delegate once (Setup → Deploy).
    await impersonate(client, LENDER);
    await sendAs(LENDER, await deployDelegateTx());
    expect((await client.getCode({ address: DELEGATE }))?.length).toBeGreaterThan(2);

    // The type-4 delegation (signed on the Ledger by app/scripts/ledger7702.mjs) leaves this code at the EOA.
    const owner = BORROWER_A;
    await impersonate(client, owner);
    const req = client.request as (a: { method: string; params: unknown[] }) => Promise<unknown>;
    await req({ method: "hardhat_setCode", params: [owner, `0xef0100${DELEGATE.slice(2).toLowerCase()}`] });
    expect(await verifyExecutor(client, owner, owner)).toMatchObject({ ok: false }); // allowlist not written yet
    await sendAs(owner, initializeTx(owner));
    expect(await readDelegation(client, owner)).toEqual({ kind: "covenant", configVersion: 2n, expected: 2n });
    expect(await verifyExecutor(client, owner, owner)).toEqual({ ok: true });

    const pos0 = await readPosition(client, MARKET_A, owner);
    expect(pos0.borrowShares).toBeGreaterThan(0n);
    await giveYt(MARKET_A, owner, pos0.collateral);
    // PT already in the wallet (not collateral) must stay untouched.
    await setTokenBalance(client, MARKET_A.series.pt, owner, 1_000n * 10n ** 6n);
    const usdc0 = await balanceOf(TOKENS.USDC.address, owner);

    const { plan } = await unwindAndExecute(MARKET_A, owner, owner);
    expect(plan.kind).toBe("unwind");
    expect(plan.sweep).toEqual(TRACKED_TOKENS);
    expect(plan.steps.at(-1)!.text).toBe("Leftovers stay in your wallet");

    expect(await position(MARKET_A, owner)).toEqual({ borrowShares: 0n, collateral: 0n });
    expect(await balanceOf(MARKET_A.series.pt, owner)).toBe(1_000n * 10n ** 6n);
    expect(await balanceOf(MARKET_A.series.yt, owner)).toBe(0n);
    expect((await balanceOf(TOKENS.USDC.address, owner)) - usdc0).toBeGreaterThan(100_000n * 10n ** 6n);
    expect(await client.readContract({ address: TOKENS.USDC.address, abi: erc20Abi, functionName: "allowance", args: [owner, MORPHO] })).toBe(0n);
  }, 300_000);
});
