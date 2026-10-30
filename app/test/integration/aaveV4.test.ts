// Aave v4 Builder flows on a mainnet fork, end to end through the app's code: Setup (position
// managers, collateral, Taker allowances), compileFlow, simulatePlan, Positions (readAaveV4),
// Access + revoke. Every Main Spoke reserve is frozen today, so the fork unfreezes USDC/USDT to
// open a position, freezes them again and closes the position the way mainnet allows now.
// Run from app/: MAINNET_RPC_URL=... pnpm test:integration
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeFunctionData, getAddress, parseAbi, type Address, type PublicClient, type WalletClient } from "viem";
import { aaveV4SpokeAbi, erc20Abi } from "../../src/lib/abis";
import { readAaveV4 } from "../../src/lib/aave";
import { readAccess } from "../../src/lib/access";
import { compileFlow } from "../../src/lib/builder/compile";
import type { Block } from "../../src/lib/builder/types";
import { DELEGATE } from "../../src/lib/abis";
import { aaveV4SetupSteps, deployData, deployDelegateTx, initializeTx, setupSteps, verifyExecutor } from "../../src/lib/executor";
import { AAVE_V4, AAVE_V4_RESERVES, TOKENS } from "../../src/lib/registry";
import { simulatePlan } from "../../src/lib/simulate";
import { clients, impersonate, setTokenBalance, startForkNode } from "./forkNode";

const OWNER = getAddress("0x000000000000000000000000000000000000a114");
const SPOKE_CONFIGURATOR = getAddress("0x9BFFf48BFb5A7AE70c348d4d4cb97E8DEFa5389a"); // holds the AccessManager role
const USDC = TOKENS.USDC.address;
const WAD = 10n ** 18n;
const quotes = { aggregator: "kyber" as const, zeroXBase: "", kyberBase: "" };
const adminAbi = parseAbi([
  "function updateReserveConfig(uint256 reserveId, (uint24 collateralRisk, bool paused, bool frozen, bool borrowable, bool receiveSharesEnabled) config)",
]);

let node: { url: string; stop: () => void };
let client: PublicClient;
let walletFor: (a: Address) => WalletClient;

beforeAll(async () => {
  node = await startForkNode(8553);
  ({ client, walletFor } = clients(node.url));
}, 180_000);
afterAll(() => node?.stop());

async function sendAs(from: Address, tx: { to?: Address; data: `0x${string}` }) {
  const hash = await walletFor(from).sendTransaction({ account: from, chain: null, to: tx.to, data: tx.data });
  const receipt = await client.waitForTransactionReceipt({ hash });
  expect(receipt.status).toBe("success");
  return receipt;
}

/** Freezes / unfreezes every supported Main Spoke reserve, as Aave's SpokeConfigurator would. */
async function setFrozen(frozen: boolean) {
  await impersonate(client, SPOKE_CONFIGURATOR);
  for (const r of AAVE_V4_RESERVES) {
    const config = await client.readContract({ address: AAVE_V4.spoke, abi: aaveV4SpokeAbi, functionName: "getReserveConfig", args: [r.reserveId] });
    await sendAs(SPOKE_CONFIGURATOR, {
      to: AAVE_V4.spoke,
      data: encodeFunctionData({ abi: adminAbi, functionName: "updateReserveConfig", args: [r.reserveId, { ...config, frozen }] }),
    });
  }
}

type NoId = Block extends infer B ? (B extends Block ? Omit<B, "id"> : never) : never;
let id = 0;
const blk = (b: NoId) => ({ ...b, id: `t${id++}` }) as Block;

describe("Aave v4 on a mainnet fork", () => {
  it("opens a Main Spoke position, then closes it while frozen with a flash loan sized to the v4 debt", async () => {
    expect((await readAaveV4(client, OWNER)).reserves[0].frozen).toBe(true);
    await setFrozen(false);

    await impersonate(client, OWNER);
    await setTokenBalance(client, USDC, OWNER, 100_000_000_000n);
    const executor = getAddress((await sendAs(OWNER, { data: await deployData(OWNER) })).contractAddress!);
    expect(await verifyExecutor(client, executor, OWNER)).toEqual({ ok: true });
    for (const s of [...setupSteps(executor), ...aaveV4SetupSteps(OWNER, executor)]) {
      if (!(await s.isDone(client, OWNER, executor))) await sendAs(OWNER, s.tx);
      expect(await s.isDone(client, OWNER, executor)).toBe(true);
    }
    const ctx = { owner: OWNER, executor, client, quotes, headroomBps: 10 };

    // Open: supply 100k USDC, borrow 60k USDC, health ≥ 1.2.
    const open = await compileFlow(
      [
        blk({ type: "pull", token: USDC, amount: { kind: "fixed", value: "100000" } }),
        blk({ type: "aaveV4Supply", asset: USDC, amount: { kind: "balance" } }),
        blk({ type: "aaveV4Borrow", asset: USDC, amount: { kind: "fixed", value: "60000" } }),
        blk({ type: "guardAaveV4Health", min: "1.2" }),
      ],
      ctx,
    );
    const openSim = await simulatePlan(client, open);
    if (!openSim.ok) throw new Error(openSim.error);
    expect(openSim.aaveV4After!.health).toBeGreaterThanOrEqual((12n * WAD) / 10n);
    expect(openSim.aaveV4After!.reserves[0].debt).toBeGreaterThanOrEqual(60_000_000_000n);
    await sendAs(OWNER, { to: executor, data: open.data });
    expect((await readAaveV4(client, OWNER)).reserves[0].supplied).toBeGreaterThanOrEqual(99_999_999_990n);

    // A week later Aave has frozen the reserves again (as on mainnet today).
    await setFrozen(true);
    const req = client.request as (a: { method: string; params: unknown[] }) => Promise<unknown>;
    await req({ method: "evm_increaseTime", params: [7 * 86_400] });
    await req({ method: "evm_mine", params: [] });

    // Supplying is refused, and the simulation says why.
    const supply = await compileFlow(
      [blk({ type: "pull", token: USDC, amount: { kind: "fixed", value: "1000" } }), blk({ type: "aaveV4Supply", asset: USDC, amount: { kind: "balance" } })],
      ctx,
    );
    const refused = await simulatePlan(client, supply);
    expect(!refused.ok && refused.error).toContain("ReserveFrozen");

    // Close: flash-borrow exactly the live v4 debt from Morpho, repay all, withdraw all.
    const close = await compileFlow(
      [
        blk({
          type: "flashLoan",
          token: USDC,
          amount: { kind: "aaveV4Debt", asset: USDC, bps: 10_000 },
          children: [
            blk({ type: "aaveV4Repay", asset: USDC, amount: { kind: "allDebt" } }),
            blk({ type: "guardAaveV4NoDebt", asset: USDC }),
            blk({ type: "aaveV4Withdraw", asset: USDC, amount: { kind: "supplied" } }),
          ],
        }),
        blk({ type: "guardAaveV4Health", min: "1" }),
      ],
      ctx,
    );
    const closeSim = await simulatePlan(client, close);
    if (!closeSim.ok) throw new Error(closeSim.error);
    expect(closeSim.aaveV4After!.health > 10n ** 30n).toBe(true); // no debt left: max
    expect(closeSim.aaveV4After!.reserves[0]).toMatchObject({ supplied: 0n, debt: 0n });
    const before = await readAaveV4(client, OWNER);
    const usdc0 = await client.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [OWNER] });
    await sendAs(OWNER, { to: executor, data: close.data });

    const closed = await readAaveV4(client, OWNER);
    expect(closed.reserves[0]).toMatchObject({ supplied: 0n, debt: 0n });
    const received = (await client.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [OWNER] })) - usdc0;
    // Equity = supply − debt, give or take a block of interest (read one block earlier).
    const equity = before.reserves[0].supplied - before.reserves[0].debt;
    expect(received > equity - 1_000_000n && received < equity + 1_000_000n).toBe(true);

    // Access lists the Taker allowances (borrow + withdraw per reserve); revoking all leaves nothing.
    const perms = await readAccess(client, OWNER, [executor]);
    expect(perms.filter((p) => p.kind === "aaveV4Borrow" || p.kind === "aaveV4Withdraw")).toHaveLength(4);
    for (const p of perms) await sendAs(OWNER, p.revoke);
    expect(await readAccess(client, OWNER, [executor])).toEqual([]);
  }, 600_000);

  it("EIP-7702: your account opens and closes a v4 position on the Spoke itself (no Giver / Taker)", async () => {
    const owner = getAddress("0x000000000000000000000000000000000000a115");
    await setFrozen(false);
    await impersonate(client, owner);
    const delegateCode = await client.getCode({ address: DELEGATE });
    if (!delegateCode || delegateCode === "0x") await sendAs(owner, await deployDelegateTx());
    const req = client.request as (a: { method: string; params: unknown[] }) => Promise<unknown>;
    await req({ method: "hardhat_setCode", params: [owner, `0xef0100${DELEGATE.slice(2).toLowerCase()}`] });
    await sendAs(owner, initializeTx(owner));
    expect(await verifyExecutor(client, owner, owner)).toEqual({ ok: true });
    // Only collateral setup: no position managers, no allowances.
    const steps = aaveV4SetupSteps(owner, owner);
    expect(steps.map((s) => s.id)).toEqual(AAVE_V4_RESERVES.map((r) => `aave4-collateral-${r.symbol}`));
    for (const s of steps) await sendAs(owner, s.tx);
    await setTokenBalance(client, USDC, owner, 105_000_000_000n); // 100k for the loop + 5k savings
    const ctx = { owner, executor: owner, client, quotes, headroomBps: 10 };

    const open = await compileFlow(
      [
        blk({ type: "pull", token: USDC, amount: { kind: "fixed", value: "100000" } }),
        blk({ type: "aaveV4Supply", asset: USDC, amount: { kind: "balance" } }),
        blk({ type: "aaveV4Borrow", asset: USDC, amount: { kind: "fixed", value: "60000" } }),
        blk({ type: "guardAaveV4Health", min: "1.2" }),
      ],
      ctx,
    );
    expect(open.calls.every((c) => c.target !== AAVE_V4.giver && c.target !== AAVE_V4.taker)).toBe(true);
    const openSim = await simulatePlan(client, open);
    if (!openSim.ok) throw new Error(openSim.error);
    expect(openSim.aaveV4After!.reserves[0].debt).toBeGreaterThanOrEqual(60_000_000_000n);
    await sendAs(owner, { to: owner, data: open.data });
    expect(await client.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [owner] })).toBe(65_000_000_000n);

    await setFrozen(true);
    await req({ method: "evm_increaseTime", params: [7 * 86_400] });
    await req({ method: "evm_mine", params: [] });

    const close = await compileFlow(
      [
        blk({
          type: "flashLoan",
          token: USDC,
          amount: { kind: "aaveV4Debt", asset: USDC, bps: 10_000 },
          children: [
            blk({ type: "aaveV4Repay", asset: USDC, amount: { kind: "allDebt" } }),
            blk({ type: "guardAaveV4NoDebt", asset: USDC }),
            blk({ type: "aaveV4Withdraw", asset: USDC, amount: { kind: "supplied" } }),
          ],
        }),
      ],
      ctx,
    );
    const closeSim = await simulatePlan(client, close);
    if (!closeSim.ok) throw new Error(closeSim.error);
    const before = await readAaveV4(client, owner);
    const usdc0 = await client.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
    await sendAs(owner, { to: owner, data: close.data });

    expect((await readAaveV4(client, owner)).reserves[0]).toMatchObject({ supplied: 0n, debt: 0n });
    const received = (await client.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [owner] })) - usdc0;
    const equity = before.reserves[0].supplied - before.reserves[0].debt;
    expect(received > equity - 1_000_000n && received < equity + 1_000_000n).toBe(true);
    expect(await client.readContract({ address: USDC, abi: erc20Abi, functionName: "allowance", args: [owner, AAVE_V4.spoke] })).toBe(0n);
  }, 600_000);
});
