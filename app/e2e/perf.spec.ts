import { expect, test, type Page, type Request } from "@playwright/test";
import { OWNER, RPC, installMockRabby } from "./fixtures";

/**
 * Performance budgets for the local app. Runs against the local fork, so absolute times include
 * Hardhat fetching cold mainnet state; request counts and bundle size are exact.
 */
type Metrics = { positionsMs: number; rpcOnLoad: number; rpcIdlePerMin: number; jsKB: number };

function countRpc(page: Page) {
  const reqs: Request[] = [];
  page.on("request", (r) => r.url().startsWith(RPC) && reqs.push(r));
  return reqs;
}

async function measure(page: Page): Promise<Metrics> {
  await installMockRabby(page, OWNER, true); // already approved: the app reconnects silently
  const rpc = countRpc(page);
  let jsBytes = 0;
  page.on("response", async (r) => {
    if (r.url().endsWith(".js") && r.url().startsWith("http://127.0.0.1:4173")) jsBytes += (await r.body()).length;
  });

  const t0 = Date.now();
  await page.goto("/");
  await expect(page.getByTestId("positions")).toBeVisible();
  const positionsMs = Date.now() - t0;
  const rpcOnLoad = rpc.length;

  const idleStart = rpc.length;
  await page.waitForTimeout(30_000);
  const rpcIdlePerMin = (rpc.length - idleStart) * 2;
  return { positionsMs, rpcOnLoad, rpcIdlePerMin, jsKB: Math.round(jsBytes / 1024) };
}

test("positions page load and idle RPC budget", async ({ page }) => {
  await measure(page); // warm the fork's state cache
  const m = await measure(page);
  console.log("PERF", JSON.stringify(m));
  // Budgets (measured after batching: ~180-250 ms, 5 requests, 12/min, 505 KB; before: 958 ms,
  // 24 requests, 84/min, 598 KB). Time is against a warm local fork, so it's generous.
  expect(m.positionsMs).toBeLessThan(2_000);
  expect(m.rpcOnLoad).toBeLessThanOrEqual(8);
  expect(m.rpcIdlePerMin).toBeLessThanOrEqual(20);
  expect(m.jsKB).toBeLessThanOrEqual(560);
});
