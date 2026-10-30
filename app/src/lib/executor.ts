import {
  encodeDeployData,
  encodeFunctionData,
  getAddress,
  maxUint256,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  erc20Abi,
  executorAbi,
  executorBytecode,
  executorDeployedBytecode,
  executorImmutableReferences,
  morphoAbi,
} from "./abis";
import { MORPHO, TOKENS, SERIES } from "./registry";

// ---------------------------------------------------------------- local storage (per owner)

type Stored = { executors: { address: Address; addedAt: number }[] };

function key(owner: Address) {
  return `covenant.executors.${owner.toLowerCase()}`;
}

function load(owner: Address): Stored {
  try {
    const raw = localStorage.getItem(key(owner));
    if (raw) return JSON.parse(raw) as Stored;
  } catch {
    /* storage unavailable */
  }
  return { executors: [] };
}

/** Every Executor ever used by this owner in this browser; the last one is current. */
export function knownExecutors(owner: Address): Address[] {
  return load(owner).executors.map((e) => getAddress(e.address));
}

export function currentExecutor(owner: Address): Address | undefined {
  return knownExecutors(owner).at(-1);
}

export function rememberExecutor(owner: Address, address: Address) {
  const s = load(owner);
  const list = s.executors.filter((e) => e.address.toLowerCase() !== address.toLowerCase());
  list.push({ address: getAddress(address), addedAt: Date.now() });
  try {
    localStorage.setItem(key(owner), JSON.stringify({ executors: list }));
  } catch {
    /* storage unavailable: the address must be re-entered next time */
  }
}

// ---------------------------------------------------------------- verification

/** Runtime bytecode with immutable slots (owner, morpho) zeroed, for comparison. */
function maskImmutables(code: Hex): string {
  const bytes = code.slice(2).split("");
  for (const refs of Object.values(executorImmutableReferences)) {
    for (const { start, length } of refs) {
      for (let i = start * 2; i < (start + length) * 2; i++) bytes[i] = "0";
    }
  }
  return bytes.join("");
}

export type Verification = { ok: true } | { ok: false; reason: string };

/**
 * Checks that `address` runs exactly the compiled CovenantExecutorMainnet code (immutables
 * aside), is owned by `owner`, and points at Morpho Blue. Prevents using a look-alike contract.
 */
export async function verifyExecutor(client: PublicClient, address: Address, owner: Address): Promise<Verification> {
  const code = await client.getCode({ address });
  if (!code || code === "0x") return { ok: false, reason: "no contract at this address" };
  if (maskImmutables(code) !== maskImmutables(executorDeployedBytecode)) {
    return { ok: false, reason: "bytecode does not match CovenantExecutorMainnet (wrong contract or different build)" };
  }
  const [o, m] = await Promise.all([
    client.readContract({ address, abi: executorAbi, functionName: "owner" }) as Promise<Address>,
    client.readContract({ address, abi: executorAbi, functionName: "morpho" }) as Promise<Address>,
  ]);
  if (o.toLowerCase() !== owner.toLowerCase()) return { ok: false, reason: `owned by ${o}, not your account` };
  if (m.toLowerCase() !== MORPHO.toLowerCase()) return { ok: false, reason: "not pointed at Morpho Blue" };
  return { ok: true };
}

// ---------------------------------------------------------------- one-time setup (§9.1 Settings)

export type SetupStep = {
  id: string;
  title: string;
  /** Transaction to send from the owner (no `to` = contract deployment). */
  tx: { to?: Address; data: Hex };
  isDone: (client: PublicClient, owner: Address, executor: Address) => Promise<boolean>;
};

export function deployData(owner: Address): Hex {
  return encodeDeployData({ abi: executorAbi, bytecode: executorBytecode, args: [owner] });
}

/** Approvals the plans need: YT for every unwind, USDC as entry equity. */
export const SETUP_APPROVALS: { token: Address; why: string }[] = [
  { token: SERIES["PT-USD3-17DEC2026"].yt, why: "pulled from your wallet to redeem with your PT on every unwind" },
  { token: TOKENS.USDC.address, why: "your equity when entering a loop (skip if you only unwind)" },
];

export function setupSteps(executor: Address): SetupStep[] {
  return [
    {
      id: "authorize",
      title: "Allow the Executor to manage your Morpho positions (setAuthorization)",
      tx: { to: MORPHO, data: encodeFunctionData({ abi: morphoAbi, functionName: "setAuthorization", args: [executor, true] }) },
      isDone: (c, owner, ex) => c.readContract({ address: MORPHO, abi: morphoAbi, functionName: "isAuthorized", args: [owner, ex] }),
    },
    ...SETUP_APPROVALS.map(
      ({ token, why }): SetupStep => ({
        id: `approve-${token}`,
        title: `Approve ${token === TOKENS.USDC.address ? "USDC" : "YT-USD3"} to the Executor — ${why}`,
        tx: { to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [executor, maxUint256] }) },
        isDone: async (c, owner, ex) =>
          (await c.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, ex] })) > 0n,
      }),
    ),
  ];
}
