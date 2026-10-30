// Aave v3 Builder flows on a mainnet fork, end to end through the app's code: Setup (credit
// delegation + aToken approval), compileFlow, simulatePlan, Positions (readAave), Access + revoke.
// Every Aave v3 Ethereum reserve is frozen today, so the fork unfreezes USDC to open a position,
// then freezes it again and closes the position the way mainnet allows now (repay + withdraw).
// Run from app/: MAINNET_RPC_URL=... pnpm test:integration
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeFunctionData, getAddress, parseAbi, type Address, type PublicClient, type WalletClient } from "viem";
import { aavePoolAbi, erc20Abi } from "../../src/lib/abis";
import { readAave } from "../../src/lib/aave";
import { readAccess } from "../../src/lib/access";
import { compileFlow } from "../../src/lib/builder/compile";
import type { Block } from "../../src/lib/builder/types";
import { aaveSetupSteps, deployData, setupSteps, verifyExecutor } from "../../src/lib/executor";
import { AAVE_POOL, TOKENS, reserveOf } from "../../src/lib/registry";
import { simulatePlan } from "../../src/lib/simulate";
import { clients, impersonate, setTokenBalance, startForkNode } from "./forkNode";

const OWNER = getAddress("0x000000000000000000000000000000000000a11e");
const ADDRESSES_PROVIDER = getAddress("0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e");
const USDC = TOKENS.USDC.address;
const usdc = reserveOf(USDC);
const WAD = 10n ** 18n;
const quotes = { aggregator: "kyber" as const, zeroXBase: "", kyberBase: "" };
const configAbi = parseAbi([
  "function getPoolConfigurator() view returns (address)",
  "function setConfiguration(address asset, (uint256 data) configuration)",
]);

let node: { url: string; stop: () => void };
let client: PublicClient;
let walletFor: (a: Address) => WalletClient;

beforeAll(async () => {
  node = await startForkNode(8552);
  ({ client, walletFor } = clients(node.url));
}, 180_000);
afterAll(() => node?.stop());

async function sendAs(from: Address, tx: { to?: Address; data: `0x${string}` }) {
  const hash = await walletFor(from).sendTransaction({ account: from, chain: null, to: tx.to, data: tx.data });
  const receipt = await client.waitForTransactionReceipt({ hash });
  expect(receipt.status).toBe("success");
  return receipt;
}

/** Sets the reserve's configuration word as Aave's PoolConfigurator would. */
async function setConfig(asset: Address, data: bigint) {
  const configurator = await client.readContract({ address: ADDRESSES_PROVIDER, abi: configAbi, functionName: "getPoolConfigurator" });
  await impersonate(client, configurator);
  await sendAs(configurator, { to: AAVE_POOL, data: encodeFunctionData({ abi: configAbi, functionName: "setConfiguration", args: [asset, { data }] }) });
}

type NoId = Block extends infer B ? (B extends Block ? Omit<B, "id"> : never) : never;
let id = 0;
const blk = (b: NoId) => ({ ...b, id: `t${id++}` }) as Block;

describe("Aave v3 on a mainnet fork", () => {
  it("opens a position, then closes it while frozen with a flash loan sized to the Aave debt", async () => {
    const live = (await client.readContract({ address: AAVE_POOL, abi: aavePoolAbi, functionName: "getConfiguration", args: [USDC] })).data;
    expect((await readAave(client, OWNER)).reserves[0].frozen).toBe(true);
    await setConfig(USDC, (live & ~(1n << 57n) & ~0xffffn) | 7500n);

    await impersonate(client, OWNER);
    await setTokenBalance(client, USDC, OWNER, 100_000_000_000n);
    const executor = getAddress((await sendAs(OWNER, { data: await deployData(OWNER) })).contractAddress!);
    expect(await verifyExecutor(client, executor, OWNER)).toEqual({ ok: true });
    for (const s of [...setupSteps(executor), ...aaveSetupSteps(executor)]) {
      if (!(await s.isDone(client, OWNER, executor))) await sendAs(OWNER, s.tx);
      expect(await s.isDone(client, OWNER, executor)).toBe(true);
    }
    const ctx = { owner: OWNER, executor, client, quotes, headroomBps: 10 };

    // Open: supply 100k USDC, borrow 60k USDC, health ≥ 1.2.
    const open = await compileFlow(
      [
        blk({ type: "pull", token: USDC, amount: { kind: "fixed", value: "100000" } }),
        blk({ type: "aaveSupply", asset: USDC, amount: { kind: "balance" } }),
        blk({ type: "aaveBorrow", asset: USDC, amount: { kind: "fixed", value: "60000" } }),
        blk({ type: "guardAaveHealth", min: "1.2" }),
      ],
      ctx,
    );
    const openSim = await simulatePlan(client, open);
    if (!openSim.ok) throw new Error(openSim.error);
    expect(openSim.aaveHealthAfter).toBeGreaterThanOrEqual((12n * WAD) / 10n);
    const aDelta = openSim.changes.find((c) => c.token === usdc.aToken.address)!;
    expect(aDelta.after - aDelta.before).toBeGreaterThanOrEqual(99_999_999_990n);
    await sendAs(OWNER, { to: executor, data: open.data });

    const opened = await readAave(client, OWNER);
    expect(opened.reserves[0].debt).toBeGreaterThanOrEqual(60_000_000_000n);
    expect(opened.reserves[0].frozen).toBe(false);

    // A week later Aave has frozen USDC again (as on mainnet today).
    await setConfig(USDC, live);
    const req = client.request as (a: { method: string; params: unknown[] }) => Promise<unknown>;
    await req({ method: "evm_increaseTime", params: [7 * 86_400] });
    await req({ method: "evm_mine", params: [] });

    // Supplying is refused, and the simulation says why.
    const supply = await compileFlow(
      [
        blk({ type: "pull", token: USDC, amount: { kind: "fixed", value: "1000" } }),
        blk({ type: "aaveSupply", asset: USDC, amount: { kind: "balance" } }),
      ],
      ctx,
    );
    const refused = await simulatePlan(client, supply);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error).toContain("Aave: ReserveFrozen");

    // Close: flash-borrow exactly the live Aave debt from Morpho, repay all, withdraw all.
    const close = await compileFlow(
      [
        blk({
          type: "flashLoan",
          token: USDC,
          amount: { kind: "aaveDebt", asset: USDC, bps: 10_000 },
          children: [
            blk({ type: "aaveRepay", asset: USDC, amount: { kind: "allDebt" } }),
            blk({ type: "guardAaveNoDebt", asset: USDC }),
            blk({ type: "aaveWithdraw", asset: USDC, amount: { kind: "supplied" } }),
          ],
        }),
        blk({ type: "guardAaveHealth", min: "1" }),
      ],
      ctx,
    );
    const closeSim = await simulatePlan(client, close);
    if (!closeSim.ok) throw new Error(closeSim.error);
    expect(closeSim.aaveHealthAfter! > 10n ** 30n).toBe(true); // no debt left: max
    const before = await readAave(client, OWNER);
    const usdc0 = await client.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [OWNER] });
    await sendAs(OWNER, { to: executor, data: close.data });

    const closed = await readAave(client, OWNER);
    expect(closed.reserves[0].supplied).toBe(0n);
    expect(closed.reserves[0].debt).toBe(0n);
    const received = (await client.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [OWNER] })) - usdc0;
    // Equity = supply − debt, give or take a block of interest (read one block earlier).
    const equity = before.reserves[0].supplied - before.reserves[0].debt;
    expect(received > equity - 1_000_000n && received < equity + 1_000_000n).toBe(true);
    expect(await client.readContract({ address: usdc.aToken.address, abi: erc20Abi, functionName: "balanceOf", args: [executor] })).toBe(0n);

    // Access lists the Aave permissions, and revoking them all leaves nothing.
    const perms = await readAccess(client, OWNER, [executor]);
    expect(perms.filter((p) => p.kind === "aaveDelegation")).toHaveLength(2);
    for (const p of perms) await sendAs(OWNER, p.revoke);
    expect(await readAccess(client, OWNER, [executor])).toEqual([]);
  }, 600_000);
});
