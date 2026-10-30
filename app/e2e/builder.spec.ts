import { expect, test, type Page } from "@playwright/test";
import { createPublicClient, formatUnits, http, parseAbi } from "viem";
import { OWNER_B, RPC, installMockRabby } from "./fixtures";

const shots = "e2e/screenshots";
const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const MARKET_B_ID = "0xecabc12c73a97c766d0c6aeb4c15c635630d78158b2ac8370455a09efcc50837";
const MARKET_B = "PT-USD3-17DEC2026/USDC (B)";
const positionAbi = parseAbi(["function position(bytes32,address) view returns (uint256,uint128,uint128)"]);

async function positionB() {
  const client = createPublicClient({ transport: http(RPC) });
  const [, borrowShares, collateral] = await client.readContract({ address: MORPHO, abi: positionAbi, functionName: "position", args: [MARKET_B_ID, OWNER_B] });
  return { borrowShares, collateral };
}

async function setup(page: Page) {
  await page.goto("/#/setup");
  await page.getByRole("button", { name: "Connect Rabby" }).click();
  await page.getByTestId("mev-flashbots").click();
  await page.getByTestId("deploy").click();
  await expect(page.getByText("verified: CovenantExecutorMainnet, owned by you")).toBeVisible();
  const pending = page.locator('[data-testid^="setup-"]');
  for (let left = await pending.count(); left > 0; left--) {
    await pending.first().click();
    await expect(pending).toHaveCount(left - 1);
  }
}

/** Adds a block from the palette by searching and pressing Enter (the keyboard path). */
async function addBlock(page: Page, query: string) {
  const search = page.getByTestId("palette-search");
  await search.fill(query);
  await search.press("Enter");
}

test("build an unwind block by block from the palette, simulate and sign", async ({ page }) => {
  await installMockRabby(page, OWNER_B);
  await setup(page);
  const before = await positionB();
  expect(before.borrowShares).toBeGreaterThan(0n);

  await page.goto("/#/builder");
  await page.getByRole("button", { name: "Clear" }).click();
  const started = Date.now();

  // accrue → pull YT → flash loan { repay, withdraw, redeem PT+YT, redeem SY } → no-debt check
  await addBlock(page, "accrue");
  await page.getByTestId("block-accrueInterest").getByLabel("market").selectOption(MARKET_B);
  await addBlock(page, "pull");
  await page.getByTestId("block-pull").getByLabel("amount", { exact: true }).fill(formatUnits(before.collateral, 6));
  await page.getByTestId("palette-flashLoan").click(); // selected: next blocks go inside it
  const flash = page.getByTestId("block-flashLoan");
  await flash.locator("> .block-body").getByLabel("market").selectOption(MARKET_B);
  await addBlock(page, "repay");
  await flash.getByTestId("block-repay").getByLabel("market").selectOption(MARKET_B);
  await addBlock(page, "withdraw collateral");
  await flash.getByTestId("block-withdrawCollateral").getByLabel("market").selectOption(MARKET_B);
  await addBlock(page, "redeem pt");
  await addBlock(page, "redeem sy");
  await flash.locator("> .block-head").click(); // deselect: back to the top level
  await addBlock(page, "no debt");
  await page.getByTestId("block-guardNoDebt").last().getByLabel("market").selectOption(MARKET_B);
  await expect(page.getByTestId("issues")).toHaveCount(0);

  await page.getByTestId("simulate").click();
  await expect(page.getByTestId("balance-changes")).toBeVisible();
  const builtIn = (Date.now() - started) / 1000;
  console.log(`flow built and simulated in ${builtIn.toFixed(1)}s (automated)`);
  expect(builtIn).toBeLessThan(60);
  await expect(page.getByText(/USDC · B after: 0 PT-USD3-17DEC2026 collateral, no debt/)).toBeVisible();
  await page.screenshot({ path: `${shots}/6-builder.png`, fullPage: true });

  await page.getByTestId("sign").click();
  await expect(page.getByText("Done.")).toBeVisible();
  expect(await positionB()).toEqual({ borrowShares: 0n, collateral: 0n });
});
