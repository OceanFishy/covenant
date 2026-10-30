import { spawn, type ChildProcess } from "node:child_process";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  http,
  keccak256,
  numberToHex,
  pad,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { erc20Abi } from "../../src/lib/abis";
import { devFork } from "../../src/lib/chain";

/** Starts `hardhat node --fork` (chain id 31337) from the repo root. */
export async function startForkNode(port: number): Promise<{ url: string; stop: () => void }> {
  const rpc = process.env.MAINNET_RPC_URL;
  if (!rpc) throw new Error("MAINNET_RPC_URL is not set");
  const proc: ChildProcess = spawn("npx", ["hardhat", "node", "--fork", rpc, "--port", String(port)], {
    cwd: new URL("../../..", import.meta.url).pathname,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // own process group, so stop() also kills the node npx spawned
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("hardhat node did not start")), 120_000);
    proc.stdout!.on("data", (d: Buffer) => {
      if (d.toString().includes("Started HTTP")) {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.on("exit", (code: number | null) => reject(new Error(`hardhat node exited (${code})`)));
  });
  return { url: `http://127.0.0.1:${port}`, stop: () => process.kill(-proc.pid!, "SIGTERM") };
}

export function clients(url: string): { client: PublicClient; walletFor: (a: Address) => WalletClient } {
  const chain = { ...devFork, rpcUrls: { default: { http: [url] } } };
  // No retries: a retried eth_sendTransaction would execute twice (see chain.ts).
  const transport = http(url, { timeout: 180_000, retryCount: 0 });
  const client = createPublicClient({ chain, transport }) as PublicClient;
  const walletFor = (account: Address) => createWalletClient({ account, chain, transport });
  return { client, walletFor };
}

export async function impersonate(client: PublicClient, who: Address) {
  const req = client.request as (a: { method: string; params: unknown[] }) => Promise<unknown>;
  await req({ method: "hardhat_impersonateAccount", params: [who] });
  await req({ method: "hardhat_setBalance", params: [who, numberToHex(10n ** 20n)] });
}

const slotCache = new Map<string, bigint>();

/** OpenZeppelin ERC20Upgradeable's ERC-7201 storage base (balances mapping first), e.g. reUSD. */
const OZ_ERC20_7201 = 0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00n;

/** Sets an ERC-20 balance by finding the `mapping(address => uint256)` balance slot. */
export async function setTokenBalance(client: PublicClient, token: Address, who: Address, amount: bigint) {
  const req = client.request as (a: { method: string; params: unknown[] }) => Promise<unknown>;
  const at = (slot: bigint) =>
    keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [who, slot]));
  const write = (slot: bigint, v: bigint) =>
    req({ method: "hardhat_setStorageAt", params: [token, at(slot), pad(numberToHex(v), { size: 32 })] });
  const read = () => client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] });

  const cached = slotCache.get(token.toLowerCase());
  if (cached !== undefined) return void (await write(cached, amount));
  for (const slot of [...Array.from({ length: 200 }, (_, i) => BigInt(i)), OZ_ERC20_7201]) {
    const original = (await req({ method: "eth_getStorageAt", params: [token, at(slot), "latest"] })) as Hex;
    await write(slot, amount);
    if ((await read()) === amount) {
      slotCache.set(token.toLowerCase(), slot);
      return;
    }
    await req({ method: "hardhat_setStorageAt", params: [token, at(slot), pad(original, { size: 32 })] });
  }
  throw new Error(`balance slot not found for ${token}`);
}
