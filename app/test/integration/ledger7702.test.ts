// End-to-end check of scripts/ledger7702.mjs against an anvil mainnet fork: deploy the delegate
// through the deterministic deployment proxy, `delegate` (type-4 tx + initialize()) with a local
// key signer, then `revoke`. The fork runs with --chain-id 31337 so the CLI's key: signer guard
// (which refuses chain id 1 without --i-know-this-is-a-hot-key) stays on.
// Run from app/: MAINNET_RPC_URL=... npx vitest run test/integration/ledger7702.test.ts
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { concat, createPublicClient, getAddress, http, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { designator } from "../../scripts/ledger7702-lib.mjs";

const PORT = 8590;
const RPC = `http://127.0.0.1:${PORT}`;
const APP_DIR = new URL("../..", import.meta.url).pathname;
const delegateJson = JSON.parse(readFileSync(new URL("../../src/generated/delegate.json", import.meta.url), "utf8"));
const { bytecode } = JSON.parse(readFileSync(new URL("../../src/generated/delegate-bytecode.json", import.meta.url), "utf8"));
const DELEGATE = getAddress(delegateJson.address);
// anvil's default accounts: #0 deploys, #1 is the EOA that delegates.
const DEPLOYER = getAddress("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
const USER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const USER = privateKeyToAccount(USER_KEY).address;
const configAbi = delegateJson.abi;

let anvil: ChildProcess | undefined;
let client: PublicClient;

/** Runs the CLI with the anvil #1 key signer; `--rpc` defaults to the fork. */
function cli(args: string[], rpc = RPC): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const proc = spawn("node", ["scripts/ledger7702.mjs", ...args, "--rpc", rpc, "--signer", `key:${USER_KEY}`], { cwd: APP_DIR });
    let out = "";
    proc.stdout.on("data", (d: Buffer) => (out += d.toString()));
    proc.stderr.on("data", (d: Buffer) => (out += d.toString()));
    proc.on("close", (code) => {
      console.log(`$ node scripts/ledger7702.mjs ${args.join(" ")} --rpc ${rpc === RPC ? RPC : "<mainnet>"} --signer key:<anvil #1>\n${out}`);
      resolve({ code, out });
    });
  });
}

describe.skipIf(!process.env.MAINNET_RPC_URL)("ledger7702 CLI on an anvil fork", () => {
  beforeAll(async () => {
    anvil = spawn("anvil", ["--fork-url", process.env.MAINNET_RPC_URL!, "--port", String(PORT), "--chain-id", "31337"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("anvil did not start")), 120_000);
      anvil!.stdout!.on("data", (d: Buffer) => {
        if (d.toString().includes("Listening on")) {
          clearTimeout(timer);
          resolve();
        }
      });
      anvil!.on("exit", (code) => reject(new Error(`anvil exited (${code})`)));
    });
    client = createPublicClient({ transport: http(RPC, { timeout: 120_000, retryCount: 0 }) });
  }, 150_000);

  afterAll(() => {
    anvil?.kill("SIGTERM");
  });

  it("deploys the delegate at delegate.json's address via the factory", async () => {
    if ((await client.getCode({ address: DELEGATE })) === undefined) {
      const hash = (await client.request({
        method: "eth_sendTransaction" as never,
        params: [{ from: DEPLOYER, to: delegateJson.factory, data: concat([delegateJson.salt as Hex, bytecode as Hex]), gas: "0x1c9c380" }] as never,
      })) as Hex;
      expect((await client.waitForTransactionReceipt({ hash })).status).toBe("success");
    }
    const code = await client.getCode({ address: DELEGATE });
    expect(code && code.length > 2).toBe(true);
  }, 120_000);

  it("refuses a key: signer on chain id 1 without --i-know-this-is-a-hot-key", async () => {
    const { code, out } = await cli(["status"], process.env.MAINNET_RPC_URL!);
    expect(code).toBe(1);
    expect(out).toContain("refusing to use a key: signer on chain id 1");
  }, 60_000);

  it("shows status with a key: signer (fork chain id 31337, so the hot-key guard does not fire)", async () => {
    const { code, out } = await cli(["status"]);
    expect(code).toBe(0);
    expect(out).toContain(USER);
  }, 60_000);

  it("dry run signs and sends nothing", async () => {
    const nonce = await client.getTransactionCount({ address: USER });
    const { code, out } = await cli(["delegate", "--dry-run"]);
    expect(code, out).toBe(0);
    expect(out).toContain("dry run: nothing signed or sent");
    expect(out).toMatch(/unsigned tx \(zero placeholder authorization signature\): 0x04/);
    expect(await client.getTransactionCount({ address: USER })).toBe(nonce);
  }, 60_000);

  it("delegates and initializes in one type-4 transaction", async () => {
    const { code, out } = await cli(["delegate", "--yes"]);
    expect(code, out).toBe(0);
    expect((await client.getCode({ address: USER }))?.toLowerCase()).toBe(designator(DELEGATE));
    const version = await client.readContract({ address: USER as Address, abi: configAbi, functionName: "configVersion" });
    const expected = await client.readContract({ address: DELEGATE, abi: configAbi, functionName: "CONFIG_VERSION" });
    expect(version).toBe(expected);
    expect(out).toContain("done: your EOA is delegated to Covenant and initialized");
  }, 180_000);

  it("reports the delegation in status", async () => {
    const { code, out } = await cli(["status"]);
    expect(code).toBe(0);
    expect(out).toContain(`delegated to ${DELEGATE} (Covenant delegate)`);
  }, 60_000);

  it("revokes the delegation", async () => {
    const { code, out } = await cli(["revoke", "--yes"]);
    expect(code, out).toBe(0);
    expect(await client.getCode({ address: USER })).toBeUndefined();
  }, 180_000);
});
