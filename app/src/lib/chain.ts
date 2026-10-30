import { createPublicClient, defineChain, http, type PublicClient } from "viem";
import { mainnet } from "viem/chains";

/** RPC for reads and simulation (VITE_RPC_URL in ../.env). */
export const RPC_URL: string = import.meta.env.VITE_RPC_URL || "https://ethereum-rpc.publicnode.com";

/**
 * Local Hardhat fork for dry runs (VITE_DEV_FORK=1): mainnet state on chain id 31337, so a
 * transaction signed for it can never be replayed on mainnet (docs/SPEC.md §12).
 */
export const DEV_FORK = import.meta.env.VITE_DEV_FORK === "1";

export const devFork = defineChain({
  id: 31337,
  name: "Mainnet fork (local)",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  // Same Multicall3 as mainnet (the fork has mainnet state).
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

export const chain = DEV_FORK ? devFork : mainnet;

/**
 * On the dev fork, simulation mines a real (then reverted) transaction, and a cold fork can take
 * longer than viem's 10s default to execute it. Never retry there: a retried eth_sendTransaction
 * runs the plan twice.
 */
export const transportOptions = DEV_FORK ? { timeout: 180_000, retryCount: 0 } : {};

/**
 * Concurrent contract reads are merged into one Multicall3 eth_call, and other concurrent RPC
 * calls go out as one JSON-RPC batch: a full positions refresh is ~2 HTTP requests.
 */
export const publicClient: PublicClient = createPublicClient({
  chain,
  batch: { multicall: { wait: 0 } },
  transport: http(RPC_URL, { ...transportOptions, batch: { wait: 0 } }),
}) as PublicClient;

export const EXPLORER = "https://etherscan.io";

/**
 * Dev-fork simulation mines a transaction inside evm_snapshot / evm_revert. If a real
 * transaction landed in between, the revert would silently undo it, so every dev-fork
 * simulation and every send hold this lock (a no-op cost on mainnet, where simulation is
 * the stateless eth_simulateV1).
 */
let lock: Promise<unknown> = Promise.resolve();
export function withChainLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn, fn);
  lock = run.catch(() => undefined);
  return run;
}
