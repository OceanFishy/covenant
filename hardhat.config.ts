import { configVariable, defineConfig } from "hardhat/config";

export default defineConfig({
  solidity: {
    version: "0.8.28",
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
  },
  paths: { tests: { solidity: "test" } },
  test: {
    solidity: {
      forking: {
        rpcEndpoints: { mainnet: configVariable("MAINNET_RPC_URL") },
      },
    },
  },
});
