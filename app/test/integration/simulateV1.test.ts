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
import { DELEGATE, delegateAbi, erc20Abi, executorAbi, loadDelegateBytecode } from "../../src/lib/abis";
import { deployData, initializeTx } from "../../src/lib/executor";
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

/** Runtime code exactly as the constructor leaves it (immutables filled): a deployment's eth_call result. */
async function runtimeCode(owner: Address): Promise<Hex> {
  const { data } = await client.call({ account: owner, data: await deployData(owner) });
  if (!data) throw new Error("simulated deployment returned no code");
  return data;
}

/**
 * The constructor's storage (rules at slot 0, allowedRecipient at slot 1), rebuilt from the
 * RuleSet / RecipientSet events of a simulated deployment.
 */
async function constructorStorage(owner: Address): Promise<Record<Hex, Hex>> {
  const res = (await client.request({
    method: "eth_simulateV1" as never,
    params: [{ blockStateCalls: [{ calls: [{ from: owner, data: await deployData(owner) }] }] }, "latest"] as never,
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
      [EXECUTOR]: { code: await runtimeCode(OWNER), stateDiff: await constructorStorage(OWNER) },
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

  it("simulates the same unwind run by the delegated EOA itself (EIP-7702 mode)", async () => {
    const pos = await readPosition(client, MARKET_A, OWNER);
    if (pos.borrowShares === 0n) return; // reference position gone
    const yt = MARKET_A.series.yt;
    // The delegate isn't deployed on mainnet yet: its runtime code from a simulated deploy.
    const { bytecode } = await loadDelegateBytecode();
    const delegateCode = (await client.call({ data: bytecode })).data!;
    const designator = `0xef0100${DELEGATE.slice(2).toLowerCase()}` as Hex;

    // The allowlist initialize() writes into the EOA's storage (ERC-7201 layout: rules, recipients, configVersion).
    const init = (await client.request({
      method: "eth_simulateV1" as never,
      params: [
        {
          blockStateCalls: [
            {
              calls: [{ from: OWNER, to: OWNER, data: initializeTx(OWNER).data }],
              stateOverrides: { [DELEGATE]: { code: delegateCode }, [OWNER]: { code: designator } },
            },
          ],
          validation: false,
        },
        "latest",
      ] as never,
    })) as { calls: { status: Hex; logs: { address: Address; topics: [Hex, ...Hex[]]; data: Hex }[] }[] }[];
    expect(init[0].calls[0].status).toBe("0x1");
    const LAYOUT = 0x7742a91c428d5f4d0ae4f71fc9890b6a2b35ca8734e78b55f6c273de2642f600n;
    const storage: Record<Hex, Hex> = { [word(LAYOUT + 2n)]: word(1n) };
    for (const l of parseEventLogs({ abi: delegateAbi, logs: init[0].calls[0].logs as never }) as unknown as { eventName: string; args: Record<string, unknown> }[]) {
      if (l.eventName === "RuleSet") {
        const { target, selector, rule } = l.args as { target: Address; selector: Hex; rule: bigint };
        const inner = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [target, LAYOUT]));
        storage[keccak256(encodeAbiParameters([{ type: "bytes4" }, { type: "bytes32" }], [selector, inner]))] = word(rule);
      } else if (l.eventName === "RecipientSet") {
        const { token, recipient } = l.args as { token: Address; recipient: Address };
        storage[mapSlot(recipient, mapSlot(token, LAYOUT + 1n))] = word(1n);
      }
    }

    const overrides: StateOverrides = {
      [DELEGATE]: { code: delegateCode },
      [OWNER]: { code: designator, stateDiff: storage },
      [yt]: { stateDiff: { [mapSlot(OWNER, 0n)]: word(pos.collateral) } },
    };
    const plan = await buildUnwind(client, { ...pos, ytBalance: pos.collateral, matched: pos.collateral }, {
      owner: OWNER,
      executor: OWNER,
      quotes: { aggregator: "kyber", zeroXBase: "", kyberBase: "" },
      headroomBps: 10,
      minReceive: 0n,
    });
    const sim = await simulatePlan(client, plan, overrides);
    if (!sim.ok) throw new Error(sim.error);
    expect(sim.borrowSharesAfter).toBe(0n);
    expect(sim.collateralAfter).toBe(0n);
    const usdc = sim.changes.find((c) => c.symbol === "USDC")!;
    expect(usdc.after - usdc.before).toBeGreaterThan(100_000n * 10n ** 6n);
    const ytChange = sim.changes.find((c) => c.token === yt)!;
    expect(ytChange.before - ytChange.after).toBe(pos.collateral);
  }, 120_000);
});
