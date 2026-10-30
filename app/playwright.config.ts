import { defineConfig } from "@playwright/test";

// E2E: the built app (vite preview) against a local mainnet fork (chain 31337) started in
// globalSetup, with a mock Rabby wallet. Run from app/: MAINNET_RPC_URL=... pnpm e2e
export default defineConfig({
  testDir: "e2e",
  timeout: 300_000,
  expect: { timeout: 60_000 },
  globalSetup: "./e2e/global-setup.ts",
  use: { baseURL: "http://127.0.0.1:4173", screenshot: "only-on-failure", viewport: { width: 1280, height: 900 } },
  webServer: {
    command: "vite build && vite preview",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
    timeout: 180_000,
    env: { VITE_DEV_FORK: "1", VITE_RPC_URL: "http://127.0.0.1:8545" },
  },
});
