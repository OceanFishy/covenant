import { expect, test } from "@playwright/test";
import { installMockRabby } from "./fixtures";

const shots = "e2e/screenshots";

test("setup → unwind a real loop in one transaction → revoke", async ({ page }) => {
  await installMockRabby(page);
  await page.goto("/");

  await page.getByRole("button", { name: "Connect Rabby" }).click();
  await expect(page.getByText("0xa95d…12c4")).toBeVisible();
  await expect(page.getByTestId("positions")).toContainText("PT-USD3 / USDC · A");
  await page.screenshot({ path: `${shots}/1-positions-before.png`, fullPage: true });

  // One-time setup: MEV RPC, deploy (bytecode-verified), authorize + approvals.
  await page.goto("/#/setup");
  await page.getByTestId("mev-flashbots").click();
  await page.getByTestId("deploy").click();
  await expect(page.getByText("verified: CovenantExecutorMainnet, owned by you")).toBeVisible();
  const pending = page.locator('[data-testid^="setup-"]');
  for (let left = await pending.count(); left > 0; left--) {
    await pending.first().click();
    await expect(pending).toHaveCount(left - 1);
  }
  // Authorize, four approvals (YT + equity for each series), two reUSD aggregator recipients
  // that a freshly deployed Executor already allows, and the four optional Aave steps (credit
  // delegation + aToken approval for USDC and USDT).
  await expect(page.locator(".steps .pill.ok")).toHaveCount(11);
  await expect(page.getByTestId("access-badge")).toHaveText("Executor access: ON (9)");
  await page.screenshot({ path: `${shots}/2-setup-done.png`, fullPage: true });

  // Unwind: review shows simulated balance changes and the step list, then sign.
  await page.goto("/");
  await page.getByTestId("unwind-PT-USD3-17DEC2026/USDC (A)").click();
  await expect(page.getByTestId("balance-changes")).toBeVisible();
  await expect(page.getByTestId("plan-steps")).toContainText("Flash-borrow the whole debt");
  await expect(page.getByText(/collateral, no debt/)).toBeVisible();
  await page.screenshot({ path: `${shots}/3-review.png`, fullPage: true });
  await page.getByTestId("sign").click();
  await expect(page.getByText("Done.")).toBeVisible();
  await page.screenshot({ path: `${shots}/4-signed.png`, fullPage: true });

  await page.goto("/");
  await expect(page.getByText("No open PT loops")).toBeVisible();

  // Revoke everything, straight from the wallet.
  await page.goto("/#/revoke");
  await page.getByTestId("revoke-all").click();
  await expect(page.getByText("Executor access is OFF")).toBeVisible();
  await expect(page.getByTestId("access-badge")).toHaveText("Executor access: OFF");
  await page.screenshot({ path: `${shots}/5-revoked.png`, fullPage: true });
});
