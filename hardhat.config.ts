import { configVariable, defineConfig } from "hardhat/config";

const forking = { rpcEndpoints: { mainnet: configVariable("MAINNET_RPC_URL") } };

export default defineConfig({
  solidity: {
    version: "0.8.28",
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
  },
  paths: { tests: { solidity: "test" } },
  test: {
    solidity: {
      profiles: {
        default: { forking },
        // USDT-loop tests fetch live aggregator routes through scripts/quote.mjs (vm.ffi).
        // ffi stays off everywhere else.
        aggregator: { forking, ffi: true },
      },
    },
  },
});
