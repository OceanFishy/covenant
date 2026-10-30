#!/usr/bin/env node
// Fetches an aggregator route for a fixed sell amount and prints it ABI-encoded as
// (address spender, address target, bytes data, uint256 buyAmount) — the format the fork
// tests read through `vm.ffi`. The taker and recipient are always `taker` (the Executor).
//
// Usage: node scripts/quote.mjs <sellToken> <buyToken> <sellAmount> <taker> [0x|kyber]
// The aggregator defaults to 0x when ZEROX_API_KEY is set, otherwise KyberSwap.
import { encodeAbiParameters, getAddress, isAddress } from "viem";

const SLIPPAGE_BPS = 30;
const [sellToken, buyToken, sellAmount, taker, which] = process.argv.slice(2);
if (![sellToken, buyToken, taker].every((a) => a && isAddress(a)) || !/^\d+$/.test(sellAmount ?? "")) {
  console.error("usage: quote.mjs <sellToken> <buyToken> <sellAmount> <taker> [0x|kyber]");
  process.exit(1);
}
const aggregator = which ?? (process.env.ZEROX_API_KEY ? "0x" : "kyber");

async function getJson(url, init) {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

async function zeroX() {
  const key = process.env.ZEROX_API_KEY;
  if (!key) throw new Error("ZEROX_API_KEY is not set");
  const q = new URLSearchParams({ chainId: "1", sellToken, buyToken, sellAmount, taker, slippageBps: String(SLIPPAGE_BPS) });
  const d = await getJson(`https://api.0x.org/swap/allowance-holder/quote?${q}`, {
    headers: { "0x-api-key": key, "0x-version": "v2" },
  });
  if (!d.transaction) throw new Error(`0x: no route ${JSON.stringify(d).slice(0, 300)}`);
  // AllowanceHolder flow: approve and call the same contract.
  return { spender: d.transaction.to, target: d.transaction.to, data: d.transaction.data, buyAmount: d.buyAmount };
}

async function kyber() {
  const base = "https://aggregator-api.kyberswap.com/ethereum/api/v1";
  const headers = { "x-client-id": "covenant" };
  const q = new URLSearchParams({ tokenIn: sellToken, tokenOut: buyToken, amountIn: sellAmount });
  const route = (await getJson(`${base}/routes?${q}`, { headers })).data;
  const built = (
    await getJson(`${base}/route/build`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ routeSummary: route.routeSummary, sender: taker, recipient: taker, slippageTolerance: SLIPPAGE_BPS }),
    })
  ).data;
  return { spender: built.routerAddress, target: built.routerAddress, data: built.data, buyAmount: built.amountOut };
}

const r = aggregator === "0x" ? await zeroX() : await kyber();
process.stdout.write(
  encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "bytes" }, { type: "uint256" }],
    [getAddress(r.spender), getAddress(r.target), r.data, BigInt(r.buyAmount)],
  ),
);
