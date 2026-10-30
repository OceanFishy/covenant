import {
  concatHex,
  encodeDeployData,
  encodeFunctionData,
  getAddress,
  maxUint256,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  aaveDebtTokenAbi,
  aaveV4SpokeAbi,
  aaveV4TakerAbi,
  DELEGATE,
  DELEGATE_FACTORY,
  DELEGATE_SALT,
  delegateAbi,
  erc20Abi,
  executorAbi,
  loadDelegateBytecode,
  loadExecutorBytecode,
  morphoAbi,
  type ExecutorBytecode,
} from "./abis";
import { AAVE_POOL, AAVE_RESERVES, AAVE_V4, AAVE_V4_RESERVES, KYBER_ROUTER, MORPHO, SERIES, TOKENS, ZEROX_ALLOWANCE_HOLDER, label } from "./registry";

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

/** Runtime bytecode with immutable slots (owner, morpho, aavePool) zeroed, for comparison. */
function maskImmutables(code: Hex, refsByName: ExecutorBytecode["immutableReferences"]): string {
  const bytes = code.slice(2).split("");
  for (const refs of Object.values(refsByName)) {
    for (const { start, length } of refs) {
      for (let i = start * 2; i < (start + length) * 2; i++) bytes[i] = "0";
    }
  }
  return bytes.join("");
}

export type Verification = { ok: true } | { ok: false; reason: string };

/**
 * Checks that `address` runs exactly the compiled CovenantExecutorMainnet code (immutables
 * aside), is owned by `owner`, and points at Morpho Blue and the Aave v3 Pool. Prevents using a
 * look-alike contract. `address == owner` means EIP-7702 mode: see {verifyDelegation}.
 */
export async function verifyExecutor(client: PublicClient, address: Address, owner: Address): Promise<Verification> {
  if (address.toLowerCase() === owner.toLowerCase()) return verifyDelegation(client, owner);
  const code = await client.getCode({ address });
  if (!code || code === "0x") return { ok: false, reason: "no contract at this address" };
  const compiled = await loadExecutorBytecode();
  const refs = compiled.immutableReferences;
  if (maskImmutables(code, refs) !== maskImmutables(compiled.deployedBytecode, refs)) {
    return { ok: false, reason: "bytecode does not match CovenantExecutorMainnet (wrong contract or different build)" };
  }
  const [o, m, a] = await Promise.all([
    client.readContract({ address, abi: executorAbi, functionName: "owner" }) as Promise<Address>,
    client.readContract({ address, abi: executorAbi, functionName: "morpho" }) as Promise<Address>,
    client.readContract({ address, abi: executorAbi, functionName: "aavePool" }) as Promise<Address>,
  ]);
  if (o.toLowerCase() !== owner.toLowerCase()) return { ok: false, reason: `owned by ${o}, not your account` };
  if (m.toLowerCase() !== MORPHO.toLowerCase()) return { ok: false, reason: "not pointed at Morpho Blue" };
  if (a.toLowerCase() !== AAVE_POOL.toLowerCase()) return { ok: false, reason: "not pointed at the Aave v3 Pool" };
  return { ok: true };
}

// ---------------------------------------------------------------- EIP-7702 mode

/** What the owner's EOA code says: nothing, a delegation to the Covenant delegate, or something else. */
export type Delegation =
  | { kind: "none" }
  | { kind: "covenant"; configVersion: bigint; expected: bigint }
  | { kind: "other"; delegate: Address };

const DESIGNATOR = "0xef0100";

export async function readDelegation(client: PublicClient, owner: Address): Promise<Delegation> {
  const code = (await client.getCode({ address: owner }))?.toLowerCase();
  if (!code || code === "0x") return { kind: "none" };
  const delegate = code.startsWith(DESIGNATOR) && code.length === 48 ? getAddress(`0x${code.slice(8)}`) : undefined;
  if (delegate !== DELEGATE) return { kind: "other", delegate: delegate ?? owner };
  const [configVersion, expected] = await Promise.all([
    client.readContract({ address: owner, abi: delegateAbi, functionName: "configVersion" }) as Promise<bigint>,
    client.readContract({ address: DELEGATE, abi: delegateAbi, functionName: "CONFIG_VERSION" }) as Promise<bigint>,
  ]);
  return { kind: "covenant", configVersion, expected };
}

/**
 * EIP-7702 mode: the owner's EOA is delegated to the Covenant delegate, the delegate runs exactly
 * the compiled CovenantDelegateMainnet code (immutables = Morpho Blue and the Aave Pool), and its
 * allowlist in the EOA's storage is the current version.
 */
export async function verifyDelegation(client: PublicClient, owner: Address): Promise<Verification> {
  const d = await readDelegation(client, owner);
  if (d.kind === "none") return { ok: false, reason: "your account is not delegated (EIP-7702)" };
  if (d.kind === "other") return { ok: false, reason: `your account delegates to ${d.delegate}, not the Covenant delegate` };
  const code = await client.getCode({ address: DELEGATE });
  const compiled = await loadDelegateBytecode();
  const refs = compiled.immutableReferences;
  if (!code || maskImmutables(code, refs) !== maskImmutables(compiled.deployedBytecode, refs)) {
    return { ok: false, reason: "the delegate's bytecode does not match CovenantDelegateMainnet" };
  }
  const [m, a] = await Promise.all([
    client.readContract({ address: DELEGATE, abi: delegateAbi, functionName: "morpho" }) as Promise<Address>,
    client.readContract({ address: DELEGATE, abi: delegateAbi, functionName: "aavePool" }) as Promise<Address>,
  ]);
  if (m.toLowerCase() !== MORPHO.toLowerCase() || a.toLowerCase() !== AAVE_POOL.toLowerCase()) {
    return { ok: false, reason: "the delegate is not pointed at Morpho Blue and the Aave v3 Pool" };
  }
  if (d.configVersion !== d.expected) {
    return { ok: false, reason: `allowlist version ${d.configVersion} in your account, ${d.expected} expected: update it in Setup` };
  }
  return { ok: true };
}

/** One-time, by anyone: deploy the shared delegate through the deterministic deployment proxy. */
export async function deployDelegateTx(): Promise<{ to: Address; data: Hex }> {
  const { bytecode } = await loadDelegateBytecode();
  return { to: DELEGATE_FACTORY, data: concatHex([DELEGATE_SALT, bytecode]) };
}

/** Writes (or updates) the allowlist in your account: a transaction to your own address. */
export function initializeTx(owner: Address): { to: Address; data: Hex } {
  return { to: owner, data: encodeFunctionData({ abi: delegateAbi, functionName: "initialize" }) };
}

// ---------------------------------------------------------------- one-time setup (§9.1 Settings)

export type SetupStep = {
  id: string;
  title: string;
  /** Transaction to send from the owner (no `to` = contract deployment). */
  tx: { to?: Address; data: Hex };
  isDone: (client: PublicClient, owner: Address, executor: Address) => Promise<boolean>;
};

export async function deployData(owner: Address): Promise<Hex> {
  const { bytecode } = await loadExecutorBytecode();
  return encodeDeployData({ abi: executorAbi, bytecode, args: [owner] });
}

/** Approvals the plans need: each series' YT for every unwind, its tokenOut as entry equity. */
export const SETUP_APPROVALS: { token: Address; why: string }[] = [
  { token: SERIES["PT-USD3-17DEC2026"].yt, why: "pulled from your wallet to redeem with your PT on every PT-USD3 unwind" },
  { token: TOKENS.USDC.address, why: "your equity when entering a PT-USD3 loop (skip if you only unwind)" },
  { token: SERIES["PT-reUSD-10DEC2026"].yt, why: "pulled from your wallet to redeem with your PT on every PT-reUSD unwind (skip without PT-reUSD loops)" },
  { token: TOKENS.reUSD.address, why: "your equity when entering a PT-reUSD loop (skip if you only unwind)" },
];

/**
 * Aggregator recipients for reUSD (PT-reUSD exits and entries). Executors deployed from this
 * build allow them already; earlier ones need the owner to add them once.
 */
const REUSD_SWAP_RECIPIENTS = [ZEROX_ALLOWANCE_HOLDER, KYBER_ROUTER];

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
        title: `Approve ${label(token)} to the Executor — ${why}`,
        tx: { to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [executor, maxUint256] }) },
        isDone: async (c, owner, ex) =>
          (await c.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, ex] })) > 0n,
      }),
    ),
    ...REUSD_SWAP_RECIPIENTS.map(
      (spender): SetupStep => ({
        id: `recipient-reusd-${spender}`,
        title: `Let your Executor approve reUSD to the ${label(spender)} (PT-reUSD swaps; Executors deployed before reUSD support only)`,
        tx: { to: executor, data: encodeFunctionData({ abi: executorAbi, functionName: "setRecipient", args: [TOKENS.reUSD.address, spender, true] }) },
        isDone: (c, _owner, ex) =>
          c.readContract({ address: ex, abi: executorAbi, functionName: "allowedRecipient", args: [TOKENS.reUSD.address, spender] }) as Promise<boolean>,
      }),
    ),
  ];
}

/**
 * Optional, only for the Aave blocks: credit delegation lets the Executor borrow for you (Aave
 * sends the loan to the Executor, which hands it to you or uses it in the same plan); the aToken
 * approval lets it pull your supply to withdraw it. Supplying and repaying need neither.
 */
export function aaveSetupSteps(executor: Address): SetupStep[] {
  return AAVE_RESERVES.flatMap((r): SetupStep[] => [
    {
      id: `aave-delegate-${r.symbol}`,
      title: `Allow the Executor to borrow ${r.symbol} on Aave for you (approveDelegation on ${r.debtToken.symbol}) — for the Aave “Borrow” block`,
      tx: {
        to: r.debtToken.address,
        data: encodeFunctionData({ abi: aaveDebtTokenAbi, functionName: "approveDelegation", args: [executor, maxUint256] }),
      },
      isDone: async (c, owner, ex) =>
        (await c.readContract({ address: r.debtToken.address, abi: aaveDebtTokenAbi, functionName: "borrowAllowance", args: [owner, ex] })) > 0n,
    },
    {
      id: `aave-approve-${r.symbol}`,
      title: `Approve ${r.aToken.symbol} to the Executor — for the Aave “Withdraw” block (your supply is pulled, then withdrawn)`,
      tx: { to: r.aToken.address, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [executor, maxUint256] }) },
      isDone: async (c, owner, ex) =>
        (await c.readContract({ address: r.aToken.address, abi: erc20Abi, functionName: "allowance", args: [owner, ex] })) > 0n,
    },
  ]);
}

/**
 * Optional, only for the Aave v4 blocks. A v4 Spoke only lets you or a governance-activated
 * position manager act on your position. Under EIP-7702 (`executor` = `owner`) your account is the
 * caller, so it only needs a supply enabled as collateral to borrow against it. A deployed
 * Executor goes through Aave's own managers: approve the Giver (supply / repay) and the Taker
 * (withdraw / borrow) on the Main Spoke once, then give the Executor Taker allowances per reserve.
 */
export function aaveV4SetupSteps(owner: Address, executor: Address): SetupStep[] {
  const { spoke, giver, taker } = AAVE_V4;
  const collateral = (r: (typeof AAVE_V4_RESERVES)[number]): SetupStep => ({
    id: `aave4-collateral-${r.symbol}`,
    title: `Use your Aave v4 ${r.symbol} supply as collateral (setUsingAsCollateral) — needed to borrow against it`,
    tx: { to: spoke, data: encodeFunctionData({ abi: aaveV4SpokeAbi, functionName: "setUsingAsCollateral", args: [r.reserveId, true, owner] }) },
    isDone: async (c, o) => (await c.readContract({ address: spoke, abi: aaveV4SpokeAbi, functionName: "getUserReserveStatus", args: [r.reserveId, o] }))[0],
  });
  if (owner.toLowerCase() === executor.toLowerCase()) return AAVE_V4_RESERVES.map(collateral);
  const manager = (pm: Address, what: string): SetupStep => ({
    id: `aave4-pm-${pm}`,
    title: `Approve Aave's ${label(pm).replace("Aave v4 ", "")} as a position manager on the Aave v4 Main Spoke — ${what}`,
    tx: { to: spoke, data: encodeFunctionData({ abi: aaveV4SpokeAbi, functionName: "setUserPositionManager", args: [pm, true] }) },
    isDone: (c, o) => c.readContract({ address: spoke, abi: aaveV4SpokeAbi, functionName: "isPositionManager", args: [o, pm] }),
  });
  return [
    manager(giver, "lets the Executor supply and repay for you"),
    manager(taker, "lets the Executor withdraw and borrow within the allowances below"),
    ...AAVE_V4_RESERVES.flatMap((r): SetupStep[] => [
      collateral(r),
      ...(["Borrow", "Withdraw"] as const).map(
        (kind): SetupStep => ({
          id: `aave4-${kind.toLowerCase()}-${r.symbol}`,
          title: `Allow the Executor to ${kind.toLowerCase()} ${r.symbol} on Aave v4 for you (Taker approve${kind}) — for the Aave v4 “${kind}” block`,
          tx: {
            to: taker,
            data: encodeFunctionData({ abi: aaveV4TakerAbi, functionName: `approve${kind}`, args: [spoke, r.reserveId, executor, maxUint256] }),
          },
          isDone: async (c, o, ex) =>
            (await c.readContract({
              address: taker,
              abi: aaveV4TakerAbi,
              functionName: kind === "Borrow" ? "borrowAllowance" : "withdrawAllowance",
              args: [spoke, r.reserveId, o, ex],
            })) > 0n,
        }),
      ),
    ]),
  ];
}
