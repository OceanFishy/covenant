// The production simulation path: eth_simulateV1 against live mainnet (read-only, nothing is
// sent). The Executor isn't deployed on mainnet, so state overrides place its code and the
// one-time setup (Morpho authorization, YT balance + allowance) for a real borrower.
// Run from app/: MAINNET_RPC_URL=... pnpm test:integration
import { describe, expect, it } from "vitest";
import {
  createPublicClient,
  encodeAbiParameters,
  getAddress,
  http,
  keccak256,
  numberToHex,
  pad,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { mainnet } from "viem/chains";
import { parseEventLogs } from "viem";
import { erc20Abi, executorAbi, executorDeployedBytecode, executorImmutableReferences } from "../../src/lib/abis";
import { deployData } from "../../src/lib/executor";
import { buildUnwind } from "../../src/lib/planner";
import { readPosition } from "../../src/lib/positions";
import { MARKETS, MORPHO } from "../../src/lib/registry";
import { simulatePlan, type StateOverrides } from "../../src/lib/simulate";

const client = createPublicClient({ chain: mainnet, transport: http(process.env.MAINNET_RPC_URL) }) as PublicClient;
const OWNER = getAddress("0xa95d6286853320487cB0897304ad8A210F8D12c4");
const EXECUTOR = getAddress("0x00000000000000000000000000000000c0ffee01");
const MARKET_A = MARKETS[0];

const word = (v: bigint | Address) => pad(typeof v === "bigint" ? numberToHex(v) : v, { size: 32 });
const mapSlot = (key: Address, slot: bigint | Hex) =>
  keccak256(encodeAbiParameters([{ type: "address" }, { type: typeof slot === "bigint" ? "uint256" : "bytes32" }], [key, slot as never]));

/** Runtime code with the immutables (owner, morpho) filled in, as the constructor would. */
function runtimeCode(owner: Address): Hex {
  const refs = Object.values(executorImmutableReferences);
  let hex = executorDeployedBytecode.slice(2);
  // Immutables are assigned in declaration order: owner, then morpho.
  [owner, MORPHO].forEach((value, i) => {
    for (const { start, length } of refs[i]) {
      hex = hex.slice(0, start * 2) + word(value).slice(2) + hex.slice((start + length) * 2);
    }
  });
  return `0x${hex}`;
}

/**
 * The constructor's storage (rules at slot 0, allowedRecipient at slot 1), rebuilt from the
 * RuleSet / RecipientSet events of a simulated deployment.
 */
async function constructorStorage(owner: Address): Promise<Record<Hex, Hex>> {
  const res = (await client.request({
    method: "eth_simulateV1" as never,
    params: [{ blockStateCalls: [{ calls: [{ from: owner, data: deployData(owner) }] }] }, "latest"] as never,
  })) as { calls: { status: Hex; logs: { address: Address; topics: [Hex, ...Hex[]]; data: Hex }[] }[] }[];
  const logs = parseEventLogs({ abi: executorAbi, logs: res[0].calls[0].logs as never });
  const diff: Record<Hex, Hex> = {};
  for (const l of logs as unknown as { eventName: string; address: Address; args: Record<string, unknown> }[]) {
    if (l.eventName === "RuleSet") {
      const { selector, rule } = l.args as { selector: Hex; rule: bigint };
      // Guard rules target the contract itself: remap from the simulated deploy address.
      const t = l.args.target as Address;
      const target = t.toLowerCase() === l.address.toLowerCase() ? EXECUTOR : t;
      const inner = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [target, 0n]));
      const key = keccak256(encodeAbiParameters([{ type: "bytes4" }, { type: "bytes32" }], [selector, inner]));
      diff[key] = word(rule);
    } else if (l.eventName === "RecipientSet") {
      const { token, recipient } = l.args as { token: Address; recipient: Address };
      diff[mapSlot(recipient, mapSlot(token, 1n))] = word(1n);
    }
  }
  return diff;
}

describe("eth_simulateV1 on mainnet", () => {
  it("simulates a full unwind of a real position with exact balance changes", async () => {
    const pos = await readPosition(client, MARKET_A, OWNER);
    if (pos.borrowShares === 0n) return; // reference position gone
    const yt = MARKET_A.series.yt;
    const overrides: StateOverrides = {
      [EXECUTOR]: { code: runtimeCode(OWNER), stateDiff: await constructorStorage(OWNER) },
      // Morpho Blue: isAuthorized is mapping(address => mapping(address => bool)) at slot 6.
      [MORPHO]: { stateDiff: { [mapSlot(EXECUTOR, mapSlot(OWNER, 6n))]: word(1n) } },
      // Pendle YT: balances at slot 0, allowances at slot 1.
      [yt]: {
        stateDiff: {
          [mapSlot(OWNER, 0n)]: word(pos.collateral),
          [mapSlot(EXECUTOR, mapSlot(OWNER, 1n))]: word(pos.collateral),
        },
      },
    };
    // Sanity-check the guessed YT allowance slot through a plain eth_call with the same override.
    const allowance = await client.readContract({
      address: yt,
      abi: erc20Abi,
      functionName: "allowance",
      args: [OWNER, EXECUTOR],
      stateOverride: [{ address: yt, stateDiff: Object.entries(overrides[yt].stateDiff!).map(([slot, value]) => ({ slot: slot as Hex, value })) }],
    });
    expect(allowance).toBe(pos.collateral);

    const plan = await buildUnwind(client, { ...pos, ytBalance: pos.collateral, matched: pos.collateral }, {
      owner: OWNER,
      executor: EXECUTOR,
      quotes: { aggregator: "kyber", zeroXBase: "", kyberBase: "" },
      headroomBps: 10,
      minReceive: 0n,
    });
    const sim = await simulatePlan(client, plan, overrides);
    if (!sim.ok) throw new Error(sim.error);
    expect(sim.method).toBe("eth_simulateV1");
    expect(sim.borrowSharesAfter).toBe(0n);
    expect(sim.collateralAfter).toBe(0n);
    const usdc = sim.changes.find((c) => c.symbol === "USDC")!;
    expect(usdc.after - usdc.before).toBeGreaterThan(100_000n * 10n ** 6n);
    const ytChange = sim.changes.find((c) => c.token === yt)!;
    expect(ytChange.before - ytChange.after).toBe(pos.collateral);
  }, 120_000);
});
