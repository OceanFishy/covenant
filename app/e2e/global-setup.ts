import { spawn } from "node:child_process";
import { createPublicClient, encodeAbiParameters, http, keccak256, numberToHex, pad, parseAbi } from "viem";
import { OWNER, OWNER_B, RPC } from "./fixtures";

// Self-contained (Playwright's loader can't import the app's JSON modules).
const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const MARKET_A = "0xf8c5aa31ea6b2a068a9eddb46dd110cae57bf0f12be9583a3f9a818effecba89";
const YT_USD3 = "0x5cFfCc9DdEF0fDcf395e2eA24CA5ED5A12032706";
const YT_BALANCE_SLOT = 0n; // Pendle YT: mapping(address => uint256) balances at slot 0

/** Starts the fork on :8545 and gives the reference borrower YT matching their PT. */
export default async function globalSetup() {
  const rpc = process.env.MAINNET_RPC_URL;
  if (!rpc) throw new Error("MAINNET_RPC_URL is not set");
  const proc = spawn("npx", ["hardhat", "node", "--fork", rpc, "--port", "8545"], {
    cwd: new URL("../..", import.meta.url).pathname,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  await new Promise<void>((resolve, reject) => {
    proc.stdout!.on("data", (d: Buffer) => d.toString().includes("Started HTTP") && resolve());
    proc.on("exit", (code: number | null) => reject(new Error(`hardhat node exited (${code})`)));
    setTimeout(() => reject(new Error("hardhat node did not start")), 120_000);
  });

  const client = createPublicClient({ transport: http(RPC, { timeout: 180_000, retryCount: 0 }) });
  const req = client.request as (a: { method: string; params: unknown[] }) => Promise<unknown>;
  for (const who of [OWNER, OWNER_B]) {
    await req({ method: "hardhat_impersonateAccount", params: [who] });
    await req({ method: "hardhat_setBalance", params: [who, numberToHex(10n ** 20n)] });
  }
  const [, borrowShares, collateral] = await client.readContract({
    address: MORPHO,
    abi: parseAbi(["function position(bytes32,address) view returns (uint256,uint128,uint128)"]),
    functionName: "position",
    args: [MARKET_A, OWNER],
  });
  if (borrowShares === 0n) throw new Error("reference borrower has no market A position at this block");
  const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [OWNER, YT_BALANCE_SLOT]));
  await req({ method: "hardhat_setStorageAt", params: [YT_USD3, slot, pad(numberToHex(collateral), { size: 32 })] });

  return () => process.kill(-proc.pid!, "SIGTERM");
}
