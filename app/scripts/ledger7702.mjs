#!/usr/bin/env node
// Delegates an EOA to Covenant's EIP-7702 delegate (and runs initialize() in the same type-4
// transaction), revokes the delegation, or shows its status — signing on a Ledger through
// ../../ledger/apdu_bridge.py (ledgerblue). Run from app/: node scripts/ledger7702.mjs <cmd>.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import {
  bytesToHex,
  createPublicClient,
  encodeFunctionData,
  formatEther,
  formatGwei,
  getAddress,
  hexToBytes,
  http,
  isAddressEqual,
  keccak256,
  recoverTransactionAddress,
  serializeTransaction,
  zeroAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hashAuthorization, recoverAuthorizationAddress } from "viem/utils";
import * as lib from "./ledger7702-lib.mjs";

const HELP = `usage: node scripts/ledger7702.mjs <address|delegate|revoke|status> [options]

  address    show (and confirm on the device) the EOA at --path
  delegate   one type-4 tx from your EOA to itself: authorization -> Covenant delegate
             (delegate.json) + initialize(); then checks the code and configVersion()
  revoke     one type-4 tx: authorization -> address(0); then checks the code is empty
  status     your EOA's code (none / delegated to X / other) and configVersion()

options:
  --rpc <url>        JSON-RPC endpoint (default: $MAINNET_RPC_URL; e.g. node --env-file=../.env ...)
  --path <bip32>     derivation path (default ${lib.DEFAULT_PATH})
  --signer <s>       ledger (default) or key:<hex> (forks/tests only; refuses chain id 1
                     unless --i-know-this-is-a-hot-key)
  --gas <n>          gas limit instead of eth_estimateGas
  --dry-run          build and print the authorization, APDUs and transaction; sign nothing
  --yes              skip the typed confirmation

Ledger: sideload the "Covenant 7702" app with ledger/build-app.sh, open it, enable
Settings -> "EIP-7702" (and "Blind signing" for delegate), pip install ledgerblue.`;

const delegateArtifact = JSON.parse(readFileSync(new URL("../src/generated/delegate.json", import.meta.url), "utf8"));
const delegateAbi = delegateArtifact.abi;
const BRIDGE = new URL("../../ledger/apdu_bridge.py", import.meta.url).pathname;
const FALLBACK_GAS = { delegate: 3_000_000n, revoke: 100_000n };
const GAS_MARGIN_PCT = 20n;

class LedgerError extends Error {
  constructor(sw, op) {
    super(lib.swMessage(sw, op));
    this.sw = sw;
  }
}

/** Talks to apdu_bridge.py over JSON lines; one APDU in flight at a time. */
class Bridge {
  constructor() {
    this.stderr = "";
    this.waiting = [];
    this.proc = spawn(process.env.LEDGER_PYTHON ?? "python3", [BRIDGE], { stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stderr.on("data", (d) => (this.stderr += d.toString()));
    createInterface({ input: this.proc.stdout }).on("line", (line) => this.waiting.shift()?.resolve(JSON.parse(line)));
    this.proc.on("error", (e) => this.failAll(new Error(`cannot start ${BRIDGE}: ${e.message}`)));
    this.proc.on("exit", (code) => this.failAll(new Error(`apdu_bridge.py exited (${code}): ${this.stderr.trim() || "no output"}`)));
  }

  failAll(error) {
    this.dead = error;
    for (const w of this.waiting.splice(0)) w.reject(error);
  }

  /** Sends one APDU; resolves to the response data, throws LedgerError on a status word != 0x9000. */
  async exchange(apdu, op) {
    if (this.dead) throw this.dead;
    const res = await new Promise((resolve, reject) => {
      this.waiting.push({ resolve, reject });
      this.proc.stdin.write(`${JSON.stringify({ apdu: bytesToHex(apdu).slice(2) })}\n`);
    });
    if (res.sw === 0x9000) return hexToBytes(`0x${res.data}`);
    if (res.sw) throw new LedgerError(res.sw, op);
    throw new Error(`Ledger: ${res.error}`);
  }

  close() {
    this.proc.stdin.end();
  }
}

class LedgerSigner {
  constructor(path) {
    this.path = path;
    this.kind = "ledger";
    this.bridge = new Bridge();
  }

  async address(display = false) {
    if (display) console.log(`Confirm the address on the device (${this.path}) ...`);
    return lib.parseAddressResponse(await this.bridge.exchange(lib.getAddressApdu(this.path, display), "address"));
  }

  /** Sends all chunks; the last response carries the signature. */
  async sendChunks(chunks, op) {
    let data;
    for (const chunk of chunks) data = await this.bridge.exchange(chunk, op);
    return lib.parseSignatureResponse(data);
  }

  async signAuthorization(auth) {
    const op = isAddressEqual(auth.address, zeroAddress) ? "revocation" : "authorization";
    return this.sendChunks(lib.signAuthorizationApdus(this.path, auth), op);
  }

  async signTransaction(tx) {
    const unsigned = serializeTransaction(tx);
    return lib.assembleSignedTx(unsigned, await this.sendChunks(lib.signTxApdus(this.path, unsigned), "transaction"));
  }

  close() {
    this.bridge.close();
  }
}

class KeySigner {
  constructor(key) {
    this.kind = "key";
    this.account = privateKeyToAccount(key.startsWith("0x") ? key : `0x${key}`);
  }

  async address() {
    return this.account.address;
  }

  async signAuthorization(auth) {
    const { r, s, yParity } = await this.account.signAuthorization(auth);
    return { r, s, yParity };
  }

  async signTransaction(tx) {
    return this.account.signTransaction(tx);
  }

  close() {}
}

function confirm(word) {
  if (!process.stdin.isTTY) throw new Error("stdin is not a terminal: pass --yes to skip the confirmation");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(`Type "${word}" to continue: `, (answer) => {
      rl.close();
      if (answer.trim() !== word) {
        console.error("aborted");
        process.exit(1);
      }
      resolve();
    }),
  );
}

function makeClient(rpc) {
  // No retries: a retried eth_sendRawTransaction is harmless, but a retried estimate would mask errors.
  return createPublicClient({ transport: http(rpc, { retryCount: 0, timeout: 120_000 }) });
}

async function readConfigVersion(client, eoa) {
  try {
    return await client.readContract({ address: eoa, abi: delegateAbi, functionName: "configVersion" });
  } catch {
    return undefined;
  }
}

function codeLine(code, delegate) {
  const c = lib.describeCode(code);
  if (c.kind === "none") return "none (plain EOA)";
  if (c.kind === "other") return `contract code (${(code.length - 2) / 2} bytes), not an EIP-7702 delegation`;
  return `delegated to ${c.target}${isAddressEqual(c.target, delegate) ? " (Covenant delegate)" : " (NOT the current Covenant delegate)"}`;
}

async function status(client, eoa) {
  const delegate = getAddress(delegateArtifact.address);
  const [code, nonce, balance] = await Promise.all([
    client.getCode({ address: eoa }),
    client.getTransactionCount({ address: eoa }),
    client.getBalance({ address: eoa }),
  ]);
  console.log(`EOA:            ${eoa}`);
  console.log(`nonce:          ${nonce}`);
  console.log(`balance:        ${formatEther(balance)} ETH`);
  console.log(`code:           ${codeLine(code, delegate)}`);
  const c = lib.describeCode(code);
  if (c.kind === "delegated") {
    const version = await readConfigVersion(client, eoa);
    let expected;
    if (isAddressEqual(c.target, delegate)) {
      expected = await client.readContract({ address: delegate, abi: delegateAbi, functionName: "CONFIG_VERSION" });
    }
    const note = expected === undefined ? "" : version === expected ? " (current)" : ` (delegate has ${expected}; run delegate again to initialize)`;
    console.log(`configVersion:  ${version === undefined ? "n/a" : version}${note}`);
  }
}

/** One type-4 tx from the EOA to itself carrying an authorization to `target` (delegate or 0). */
async function authorizeAndSend({ client, signer, opts, eoa, chainId, target, data, kind }) {
  const [txNonce, block, priorityHex, balance, currentCode] = await Promise.all([
    client.getTransactionCount({ address: eoa, blockTag: "pending" }),
    client.getBlock(),
    client.request({ method: "eth_maxPriorityFeePerGas" }),
    client.getBalance({ address: eoa }),
    client.getCode({ address: eoa }),
  ]);
  if (block.baseFeePerGas == null) throw new Error("the chain has no EIP-1559 base fee");
  const fees = lib.feeCaps(block.baseFeePerGas, BigInt(priorityHex));
  // The sender is also the authority: its nonce is bumped before the authorization is applied.
  const auth = { chainId, address: target, nonce: txNonce + 1 };
  const isRevoke = kind === "revoke";

  console.log(`\n== ${isRevoke ? "Revoke EIP-7702 delegation" : "Delegate to Covenant + initialize()"} ==`);
  console.log(`EOA (sender, authority): ${eoa}`);
  console.log(`current code:            ${codeLine(currentCode, getAddress(delegateArtifact.address))}`);
  console.log(`authorization target:    ${target}${isRevoke ? " (address(0) = clear the delegation)" : ` (${delegateArtifact.contractName})`}`);
  console.log(`chain id:                ${chainId}`);
  console.log(`tx nonce:                ${txNonce}`);
  console.log(`authorization nonce:     ${auth.nonce} (tx nonce + 1)`);
  console.log(`tx:                      to ${eoa} (itself), value 0, data ${data === "0x" ? "empty" : `${data} (initialize())`}`);
  console.log(`fees:                    base ${formatGwei(block.baseFeePerGas)} gwei, maxPriorityFee ${formatGwei(fees.maxPriorityFeePerGas)} gwei, maxFee ${formatGwei(fees.maxFeePerGas)} gwei (2*base + priority)`);
  console.log(`gas limit:               ${opts.gas ? `${opts.gas} (--gas)` : "estimated after the authorization is signed (estimation needs the signed authorization)"}`);
  console.log(`balance:                 ${formatEther(balance)} ETH`);
  if (signer.kind === "ledger") {
    console.log("\nThe device will show two reviews:");
    console.log(
      isRevoke
        ? `  1. Revoke delegation: account ${eoa}, network chain ${chainId}, nonce ${auth.nonce}`
        : `  1. Authorization: account ${eoa}, delegate "Covenant", network chain ${chainId}, nonce ${auth.nonce}`,
    );
    console.log(`  2. Transaction: to ${eoa}, amount 0 ETH, max fees${isRevoke ? "" : `, a blind-signing warning (calldata ${data})`}`);
  }

  if (opts.dryRun) {
    const gas = opts.gas ?? FALLBACK_GAS[kind];
    const unsigned = serializeTransaction({
      type: "eip7702",
      chainId,
      nonce: txNonce,
      ...fees,
      gas,
      to: eoa,
      value: 0n,
      data,
      accessList: [],
      // Placeholder signature so the authorization list can be serialized; the real one comes from the signer.
      authorizationList: [{ ...auth, r: `0x${"00".repeat(32)}`, s: `0x${"00".repeat(32)}`, yParity: 0 }],
    });
    console.log("\n-- dry run: nothing signed or sent --");
    console.log(`authorization hash:  ${hashAuthorization(auth)}`);
    console.log(`authorization TLV:   ${bytesToHex(lib.authorizationTlv(auth))}`);
    console.log(`gas used below:      ${gas}${opts.gas ? " (--gas)" : " (fallback; the real run estimates it)"}`);
    console.log(`unsigned tx (zero placeholder authorization signature): ${unsigned}`);
    if (signer.kind === "ledger") {
      console.log("APDUs, SIGN EIP7702 AUTHORIZATION:");
      for (const a of lib.signAuthorizationApdus(opts.path, auth)) console.log(`  ${bytesToHex(a).slice(2)}`);
      console.log("APDUs, SIGN TX (with the placeholder authorization signature):");
      for (const a of lib.signTxApdus(opts.path, unsigned)) console.log(`  ${bytesToHex(a).slice(2)}`);
    }
    return;
  }
  if (!opts.yes) await confirm(kind);

  if (signer.kind === "ledger") console.log("\nReview the authorization on the device ...");
  const sig = await signer.signAuthorization(auth);
  const signedAuth = { ...auth, ...sig };
  const authSigner = await recoverAuthorizationAddress({ authorization: signedAuth });
  if (!isAddressEqual(authSigner, eoa)) throw new Error(`authorization signed by ${authSigner}, expected ${eoa}`);
  console.log(`authorization signed by ${authSigner} (verified)`);

  const baseTx = { type: "eip7702", chainId, nonce: txNonce, ...fees, to: eoa, value: 0n, data, accessList: [], authorizationList: [signedAuth] };
  let gas = opts.gas;
  if (gas === undefined) {
    try {
      const estimate = await client.estimateGas({ account: eoa, to: eoa, value: 0n, data, authorizationList: [signedAuth], ...fees });
      gas = (estimate * (100n + GAS_MARGIN_PCT)) / 100n;
      console.log(`gas limit: ${gas} (eth_estimateGas ${estimate} + ${GAS_MARGIN_PCT}%)`);
    } catch (e) {
      gas = FALLBACK_GAS[kind];
      console.log(`gas limit: ${gas} (fallback; eth_estimateGas failed: ${e.shortMessage ?? e.message})`);
    }
  }
  const maxCost = gas * fees.maxFeePerGas;
  console.log(`max cost:  ${formatEther(maxCost)} ETH (gas limit * maxFee)`);
  if (maxCost > balance) throw new Error(`balance ${formatEther(balance)} ETH is below the max cost`);

  if (signer.kind === "ledger") console.log("Review the transaction on the device ...");
  const signedTx = await signer.signTransaction({ ...baseTx, gas });
  const txSigner = await recoverTransactionAddress({ serializedTransaction: signedTx });
  if (!isAddressEqual(txSigner, eoa)) throw new Error(`transaction signed by ${txSigner}, expected ${eoa}`);
  console.log(`transaction signed by ${txSigner} (verified)`);

  const hash = await client.request({ method: "eth_sendRawTransaction", params: [signedTx] });
  if (hash !== keccak256(signedTx)) throw new Error(`node returned tx hash ${hash}, expected ${keccak256(signedTx)}`);
  console.log(`sent ${hash}; waiting for the receipt ...`);
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 600_000 });
  console.log(`mined in block ${receipt.blockNumber}, status ${receipt.status}, gas used ${receipt.gasUsed}`);
  if (receipt.status !== "success") throw new Error("the transaction reverted");
}

async function main() {
  const { cmd, opts } = lib.parseArgs(process.argv.slice(2));
  if (cmd === undefined || cmd === "help") {
    console.log(HELP);
    process.exit(cmd === "help" ? 0 : 1);
  }
  if (!["address", "delegate", "revoke", "status"].includes(cmd)) throw new Error(`unknown command "${cmd}"\n\n${HELP}`);

  const signer = opts.signer === "ledger" ? new LedgerSigner(opts.path) : new KeySigner(opts.signer.slice(4));
  try {
    if (cmd === "address") {
      console.log(await signer.address(true));
      return;
    }
    const rpc = opts.rpc ?? process.env.MAINNET_RPC_URL;
    if (!rpc) throw new Error("no RPC: pass --rpc <url> or set MAINNET_RPC_URL (e.g. node --env-file=../.env scripts/ledger7702.mjs ...)");
    const client = makeClient(rpc);
    const chainId = await client.getChainId();
    if (signer.kind === "key" && chainId === 1 && !opts.hotKey) {
      throw new Error("refusing to use a key: signer on chain id 1 (mainnet); it is meant for forks with another chain id (pass --i-know-this-is-a-hot-key to override)");
    }
    const eoa = await signer.address();
    if (cmd === "status") return await status(client, eoa);

    const delegate = getAddress(delegateArtifact.address);
    if (cmd === "delegate") {
      const delegateCode = await client.getCode({ address: delegate });
      if (!delegateCode || delegateCode === "0x") {
        const msg = `no code at the Covenant delegate ${delegate} on chain ${chainId}: deploy it from Covenant's Setup page first`;
        if (!opts.dryRun) throw new Error(msg);
        console.warn(`warning: ${msg}`);
      }
      if (signer.kind === "ledger" && chainId !== 1) {
        console.warn(`warning: the patched Ledger app whitelists the delegate for chain id 1 only; the device will refuse chain id ${chainId}`);
      }
      const data = encodeFunctionData({ abi: delegateAbi, functionName: "initialize" });
      await authorizeAndSend({ client, signer, opts, eoa, chainId, target: delegate, data, kind: "delegate" });
      if (opts.dryRun) return;

      const [code, version, expected] = await Promise.all([
        client.getCode({ address: eoa }),
        readConfigVersion(client, eoa),
        client.readContract({ address: delegate, abi: delegateAbi, functionName: "CONFIG_VERSION" }),
      ]);
      const want = lib.designator(delegate);
      if ((code ?? "0x").toLowerCase() !== want) throw new Error(`EOA code is ${code ?? "0x"}, expected ${want}`);
      console.log(`code:          ${code} (delegated to ${delegate})`);
      if (version !== expected) throw new Error(`configVersion() on the EOA is ${version}, CONFIG_VERSION() is ${expected}`);
      console.log(`configVersion: ${version} == CONFIG_VERSION ${expected}`);
      console.log("done: your EOA is delegated to Covenant and initialized");
    } else {
      await authorizeAndSend({ client, signer, opts, eoa, chainId, target: zeroAddress, data: "0x", kind: "revoke" });
      if (opts.dryRun) return;
      const code = await client.getCode({ address: eoa });
      if (code && code !== "0x") throw new Error(`EOA code is still ${code}`);
      console.log("done: delegation revoked, the EOA has no code");
    }
  } finally {
    signer.close();
  }
}

main().catch((e) => {
  console.error(`error: ${e.shortMessage ?? e.message}`);
  process.exit(1);
});
