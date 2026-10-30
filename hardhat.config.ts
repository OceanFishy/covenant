import { configVariable, defineConfig } from "hardhat/config";

const forking = { rpcEndpoints: { mainnet: configVariable("MAINNET_RPC_URL") } };

export default defineConfig({
  solidity: {
    version: "0.8.28",
    // No metadata hash: the 7702 delegate's CREATE2 address (and the Ledger whitelist entry
    // built from it) then only changes when the code does, not when a comment does.
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun", metadata: { bytecodeHash: "none" } },
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
